import { Hono } from 'hono';
import type {
  ServiceDeletionChoices,
  ServiceDeletionPreview,
} from '../../../../shared/serviceOwnedDeletion.ts';
import { CURRENT_LOCATION_POLICY_VERSION } from '../../../../shared/deletionPolicy.ts';
import {
  parseStaleQuickCleanupDays,
  validateStaleQuickCleanupSelection,
} from '../libraries/quickCleanup.ts';
import { withTransaction } from '../../db/index.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { getDownloadClientTargets } from '../mediaDeletion/targets.ts';
import { activeWholeItemRatingKeys } from '../mediaDeletion/activePlayback.ts';
import { evidenceFingerprint, serviceEndpoints } from '../mediaDeletion/serviceStorage.ts';
import {
  buildServiceOwnedPlan,
  serviceOwnedDecisionExplanation,
} from '../mediaDeletion/serviceOwnedPlanning.ts';
import { relatedServiceOwnedPlexItems } from '../mediaDeletion/serviceOwnedPlexScope.ts';
import { assertRelocationWorkflowClear } from './relocation/relocation.ts';
import {
  DeletionConflictError,
  enqueueDeletionOperation,
  type NewDeletionTarget,
  repeatedDeletionOperation,
} from './service.ts';
import { type DurableTargetSnapshot, validateLiveDeletionIdentity } from './core/validation.ts';
import {
  SERVICE_PREVIEW_TOTAL_FILE_LIMIT,
  serviceOwnedDisplayFiles,
} from './serviceOwnedDisplay.ts';

export function parseServiceDeletionChoices(value: unknown): ServiceDeletionChoices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid deletion selection');
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.libraryKey !== 'string' || !input.libraryKey ||
    typeof input.arrSelected !== 'boolean' || typeof input.qbSelected !== 'boolean' ||
    !Array.isArray(input.targets) || !input.targets.length || input.targets.length > 200
  ) {
    throw new Error(
      'A library, bounded target selection and explicit destination choices are required',
    );
  }
  const keys = new Set<string>();
  const targets = input.targets.map((raw) => {
    if (
      !raw || typeof raw !== 'object' || Array.isArray(raw) ||
      typeof raw.ratingKey !== 'string' || !raw.ratingKey ||
      Object.keys(raw).some((key) => !['ratingKey', 'mediaId'].includes(key)) ||
      raw.mediaId !== undefined && (!Number.isSafeInteger(raw.mediaId) || raw.mediaId <= 0)
    ) {
      throw new Error('Invalid service target');
    }
    const target = {
      ratingKey: raw.ratingKey,
      ...(raw.mediaId === undefined ? {} : { mediaId: raw.mediaId as number }),
    };
    const key = JSON.stringify(target);
    if (keys.has(key)) throw new Error('Duplicate service target');
    keys.add(key);
    return target;
  });
  if (
    targets.some((a) =>
      targets.some((b) =>
        a.ratingKey === b.ratingKey && (a.mediaId === undefined) !== (b.mediaId === undefined)
      )
    )
  ) {
    throw new Error('Whole-item and version selections cannot overlap');
  }
  const quickDays = input.quickCleanupThresholdDays === undefined
    ? undefined
    : parseStaleQuickCleanupDays(input.quickCleanupThresholdDays);
  if (
    quickDays === null || quickDays !== undefined && targets.some((t) => t.mediaId !== undefined)
  ) throw new Error('Invalid quick cleanup selection');
  return {
    libraryKey: input.libraryKey,
    targets,
    arrSelected: input.arrSelected,
    qbSelected: input.qbSelected,
    ...(quickDays === undefined ? {} : { quickCleanupThresholdDays: quickDays }),
  };
}

async function prepare(
  choices: ServiceDeletionChoices,
  active: Awaited<ReturnType<typeof resolveActiveServer>>,
) {
  const { serverId, client: plex } = active;
  const { libraryKey } = choices;
  const quick = choices.quickCleanupThresholdDays === undefined
    ? null
    : validateStaleQuickCleanupSelection(
      serverId,
      libraryKey,
      choices.quickCleanupThresholdDays,
      choices.targets.map((t) => t.ratingKey),
    );
  if (choices.quickCleanupThresholdDays !== undefined && !quick) {
    throw new Error('Quick cleanup eligibility changed');
  }
  assertRelocationWorkflowClear(serverId, libraryKey, choices.targets.map((t) => t.ratingKey));
  const [arrTargets, downloadTargets, connections, machineIdentifier, sessions] = await Promise.all(
    [
      getArrDeleteTargets(serverId, libraryKey),
      getDownloadClientTargets(serverId),
      serviceEndpoints(serverId),
      plex.identity(),
      plex.activeSessions(),
    ],
  );
  const targets: NewDeletionTarget[] = [];
  const previews: ServiceDeletionPreview['targets'] = [];
  const plans = [];
  let remainingDisplayFiles = SERVICE_PREVIEW_TOTAL_FILE_LIMIT;
  for (const requested of choices.targets) {
    const live = await plex.metadataIdentity(requested.ratingKey);
    if (
      !live || live.librarySectionId !== libraryKey ||
      !['movie', 'show', 'season', 'episode'].includes(live.type)
    ) {
      throw new Error('Selected media was not found in this library');
    }
    if (
      requested.mediaId !== undefined && !['movie', 'episode'].includes(live.type) ||
      requested.mediaId === undefined && live.type === 'episode'
    ) throw new Error('Unsupported deletion unit');
    if (
      quick &&
      (live.type === 'movie' && live.media.length >= 2 ||
        live.type === 'show' && await plex.showHasMultiVersionEpisodes(live.ratingKey))
    ) throw new Error('Quick cleanup version scope changed');
    const kind = requested.mediaId === undefined
      ? 'whole_item'
      : live.type === 'movie'
      ? 'movie_version'
      : 'episode_version';
    const showKey = live.type === 'season'
      ? live.parentRatingKey
      : live.type === 'episode'
      ? live.grandparentRatingKey
      : null;
    if (
      activeWholeItemRatingKeys(
        new Set([requested.ratingKey, showKey ?? requested.ratingKey]),
        sessions,
      ).size
    ) {
      throw new Error('Selected media is playing');
    }
    const show = showKey ? await plex.metadataIdentity(showKey) : null;
    const local = withTransaction((db) => {
      const owner = showKey ?? requested.ratingKey;
      if (
        db.prepare('SELECT 1 FROM ignored_content WHERE server_id=? AND rating_key=?').value(
          serverId,
          owner,
        )
      ) return null;
      if (kind === 'whole_item' && live.type === 'season') {
        return db.prepare(
          'SELECT title, file_size, duration FROM seasons WHERE server_id=? AND library_key=? AND rating_key=? AND show_rating_key=?',
        )
          .value<[string, number | null, number | null]>(
            serverId,
            libraryKey,
            requested.ratingKey,
            owner,
          );
      }
      if (kind === 'whole_item') {
        return db.prepare(
          'SELECT title, file_size, duration FROM items WHERE server_id=? AND library_key=? AND rating_key=?',
        )
          .value<[string, number | null, number | null]>(serverId, libraryKey, requested.ratingKey);
      }
      if (kind === 'movie_version') {
        return db.prepare(
          'SELECT i.title, v.file_size, 0 FROM item_media_versions v JOIN items i ON i.server_id=v.server_id AND i.rating_key=v.item_rating_key WHERE v.server_id=? AND v.library_key=? AND v.item_rating_key=? AND v.media_id=?',
        )
          .value<[string, number | null, number]>(
            serverId,
            libraryKey,
            requested.ratingKey,
            requested.mediaId!,
          );
      }
      return db.prepare(
        'SELECT episode_title, file_size, 0 FROM episode_media_versions WHERE server_id=? AND library_key=? AND episode_rating_key=? AND media_id=?',
      )
        .value<[string, number | null, number]>(
          serverId,
          libraryKey,
          requested.ratingKey,
          requested.mediaId!,
        );
    });
    if (!local || local[0] !== live.title) {
      throw new Error('Local selection changed; sync and preview again');
    }
    const operationMediaIds = choices.targets.filter((t) => t.ratingKey === requested.ratingKey)
      .flatMap((t) => t.mediaId === undefined ? [] : [t.mediaId]);
    if (
      requested.mediaId !== undefined &&
      (!live.media.some((m) => m.mediaId === requested.mediaId) ||
        !live.media.some((m) => !operationMediaIds.includes(m.mediaId)))
    ) throw new Error('At least one unselected Plex version must remain');
    const selection = {
      ...requested,
      title: live.title,
      type: live.type as 'movie' | 'show' | 'season' | 'episode',
      tmdbId: live.tmdbId,
      tvdbId: show?.tvdbId ?? live.tvdbId,
      ...(showKey ? { showRatingKey: showKey } : {}),
      ...(live.type === 'season' ? { seasonIndex: live.index! } : {}),
      ...(live.type === 'episode'
        ? { seasonIndex: live.seasonIndex!, episodeIndex: live.index! }
        : {}),
    };
    const plan = await buildServiceOwnedPlan({
      relatedPlexItems: () => relatedServiceOwnedPlexItems(serverId, selection),
      serverId,
      libraryKey,
      selection,
      plex,
      arrTargets,
      downloadTargets,
      connections,
      arrSelected: choices.arrSelected,
      qbSelected: choices.qbSelected,
    });
    plans.push(plan);
    const episodes = live.type === 'season'
      ? await plex.seasonDeletionEpisodes(requested.ratingKey)
      : undefined;
    const snapshot = {
      currentLocationPolicyVersion: CURRENT_LOCATION_POLICY_VERSION,
      machineIdentifier,
      serverUrl: plex.serverUrl,
      libraryKey,
      ...selection,
      mode: choices.arrSelected ? 'coordinated' : 'plex-only',
      cleanupDownloads: choices.qbSelected,
      fileSize: local[1],
      serviceOwnedPlan: plan,
      ...(quick
        ? {
          quickCleanupEvidence: {
            thresholdDays: choices.quickCleanupThresholdDays,
            reason: quick.get(live.ratingKey)!.reason,
            lastViewedAt: quick.get(live.ratingKey)!.lastViewedAt,
            addedAt: quick.get(live.ratingKey)!.addedAt,
          },
        }
        : {}),
      ...(show ? { showTitle: show.title } : {}),
      ...(live.type === 'episode'
        ? { episodeTitle: live.title, seasonRatingKey: live.parentRatingKey }
        : {}),
      ...(episodes
        ? {
          seasonRatingKey: live.ratingKey,
          wholeSeasonDuration: local[2],
          wholeSeasonRemoval: {
            plexEpisodes: episodes,
            episodeRatingKeys: episodes.map((e) => e.ratingKey),
            sonarrTargets: [],
          },
        }
        : {}),
      ...(requested.mediaId === undefined
        ? {}
        : { operationMediaIds, selectedMediaIds: operationMediaIds }),
    };
    await validateLiveDeletionIdentity(
      plex,
      kind,
      snapshot as unknown as DurableTargetSnapshot,
      live,
    );
    targets.push({
      kind,
      key: requested.mediaId === undefined
        ? requested.ratingKey
        : `${requested.ratingKey}:${requested.mediaId}`,
      title: live.title,
      logicalSize: local[1],
      snapshot,
      ...(requested.mediaId === undefined ? {} : {
        reservation: {
          mediaKind: live.type === 'movie' ? 'movie' as const : 'episode' as const,
          mediaId: requested.mediaId,
          ratingKey: requested.ratingKey,
        },
      }),
    });
    const displayFiles = serviceOwnedDisplayFiles(plan.actions, remainingDisplayFiles);
    remainingDisplayFiles -= displayFiles.files.length;
    previews.push({
      ...requested,
      ...displayFiles,
      linkedExtrasIncluded: plan.actions.some((action) => action.associatedExtras !== undefined),
      title: live.title,
      ...(show ? { showTitle: show.title } : {}),
      seasonIndex: live.seasonIndex,
      episodeIndex: live.type === 'episode' ? live.index : undefined,
      fileSize: local[1],
      videoResolution: live.media.find((media) => media.mediaId === requested.mediaId)
        ?.videoResolution,
      fileName: requested.mediaId === undefined
        ? undefined
        : plan.plexFiles[0]?.path.split(/[\\/]/).at(-1),
      decisions: plan.retention.decisions.map((d) => ({
        ...d,
        presence: plan.actions.find((a) => a.id === d.actionId)?.presence,
        matchedToSelection: plan.actions.find((a) => a.id === d.actionId)?.matchedToSelection,
        reason: serviceOwnedDecisionExplanation(plan.actions.find((a) => a.id === d.actionId), d),
      })),
    });
  }
  if (new Set(targets.map((t) => t.kind)).size !== 1) {
    throw new Error('Review whole items, movie versions and episode versions separately');
  }
  if (
    choices.quickCleanupThresholdDays !== undefined &&
    !validateStaleQuickCleanupSelection(
      serverId,
      libraryKey,
      choices.quickCleanupThresholdDays,
      choices.targets.map((t) => t.ratingKey),
    )
  ) throw new Error('Quick cleanup eligibility changed');
  const preview: ServiceDeletionPreview = {
    fingerprint: evidenceFingerprint({
      choices,
      plans: plans.map((p) => p.fingerprint),
      machineIdentifier,
    }),
    arrConfigured: arrTargets.length > 0,
    qbConfigured: downloadTargets.length > 0,
    canConfirm: previews.some((t) =>
      t.decisions.some((d) => d.requested && (d.state === 'delete_candidate' || d.state === 'kept'))
    ),
    targets: previews,
  };
  return { preview, targets };
}

const router = new Hono();
router.post('/preview', async (c) => {
  try {
    const choices = parseServiceDeletionChoices(await c.req.json());
    const { preview } = await prepare(choices, await resolveActiveServer());
    return c.json(preview);
  } catch {
    return c.json({
      error:
        'Current service evidence could not be verified. Refresh the selection and check service connections.',
    }, 409);
  }
});
router.post('/', async (c) => {
  let body;
  let choices: ServiceDeletionChoices;
  try {
    body = await c.req.json();
    choices = parseServiceDeletionChoices(body);
  } catch {
    return c.json({ error: 'Invalid deletion selection' }, 400);
  }
  try {
    if (
      typeof body.clientRequestId !== 'string' || !body.clientRequestId ||
      typeof body.previewFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewFingerprint)
    ) {
      return c.json(
        { error: 'Request identity and current preview fingerprint are required' },
        400,
      );
    }
    const active = await resolveActiveServer();
    const payload = { ...choices, previewFingerprint: body.previewFingerprint, serviceOwned: 4 };
    const repeated = await repeatedDeletionOperation(
      active.serverId,
      body.clientRequestId,
      payload,
    );
    if (repeated) return c.json(repeated, 202);
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(choices, active);
    } catch {
      // This attempt has not enqueued anything. The client must still preserve
      // the same request identity if a previous submission had an unknown result.
      return c.json({
        error: 'Current service evidence could not be verified. Refresh the preview.',
      }, 409);
    }
    const { preview, targets } = prepared;
    if (!preview.canConfirm || preview.fingerprint !== body.previewFingerprint) {
      return c.json({
        error: 'Service evidence changed or remains unavailable. Review the current preview.',
        preview,
      }, 409);
    }
    const result = await enqueueDeletionOperation({
      clientRequestId: body.clientRequestId,
      serverId: active.serverId,
      libraryKey: choices.libraryKey,
      kind: targets[0].kind,
      payload,
      targets,
    });
    return c.json(result, 202);
  } catch (error) {
    if (error instanceof DeletionConflictError) {
      return c.json({ error: error.message }, 409);
    }
    // Resolution, idempotency lookup or enqueue may have failed after a prior
    // submission was accepted. Never represent an unknown result as rejection.
    return c.json({
      error: 'The submission outcome could not be verified. Retry the same request.',
    }, 503);
  }
});
export default router;
