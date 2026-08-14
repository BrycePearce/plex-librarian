import { and, eq, inArray, not, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { episodeMediaVersions, items } from '../../db/schema.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { PlexMediaVersionPathPreview } from '../../integrations/plex/types.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { arrPathIsWithin, resolveArrPath } from '../mediaDeletion/arrPaths.ts';
import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';
import { activeWholeItemRatingKeys } from '../mediaDeletion/activePlayback.ts';
import { episodeRootIsWorkflowOwned } from '../deletionOperations/core/ownership.ts';
import type {
  SeasonDeletionMemberPreview,
  SeasonDeletionOutcome,
  SeasonDeletionPreviewResponse,
  SeasonDeletionSelection,
} from '@plex-librarian/shared/types.ts';
import {
  seasonDeletionPreviewExpiry,
  seasonDeletionPreviewIsFresh,
} from './seasonDeletionFingerprint.ts';
import { SMART_CLEANUP_DELETE_IDS_LIMIT } from './smartAnalysis.ts';

const MAX_EPISODES = 500;
const PLEX_VALIDATION_CONCURRENCY = 4;
const MAX_VERSIONS_PER_EPISODE = SMART_CLEANUP_DELETE_IDS_LIMIT + 1;

export interface PlannedMediaEvidence {
  mediaId: number;
  path: string;
  arrPath: string;
  byteSize: number;
  logicalSize: number | null;
}

export interface PlannedSeasonChild {
  schemaVersion: 1;
  episodeRatingKey: string;
  selectedMedia: PlannedMediaEvidence[];
  retainedMedia: PlannedMediaEvidence[];
  sonarrEpisodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  originalMonitored: boolean;
  intendedMonitored: boolean;
  episodeFileId: number | null;
  episodeFilePath: string | null;
  episodeFileSize: number | null;
  episodeFileOwners: number[];
  outcome: SeasonDeletionOutcome;
}

export interface PlannedManagedSeasonGroup {
  arrInstanceId: number;
  seriesId: number;
  seriesPath: string;
  configurationUpdatedAt: number;
  mappingIdentity: string;
  sonarrVersion: string;
  children: PlannedSeasonChild[];
}

export interface AuthoritativeSeasonPlan {
  serverId: number;
  machineIdentifier: string;
  serverUrl: string;
  libraryKey: string;
  showRatingKey: string;
  seasonRatingKey: string;
  showTitle: string;
  completeEpisodeRatingKeys: string[];
  selections: SeasonDeletionSelection[];
  plexOnlyChildren: Array<{
    episodeRatingKey: string;
    episodeTitle: string;
    selectedMedia: PlannedMediaEvidence[];
    retainedMedia: PlannedMediaEvidence[];
    seasonNumber: number;
    episodeNumber: number;
  }>;
  managedGroups: PlannedManagedSeasonGroup[];
  preview: SeasonDeletionPreviewResponse;
}

type PreparedTargetPlan = {
  target: ArrDeleteTarget;
  seriesId: number;
  seriesPath: string;
  version: string;
  snapshot: Awaited<ReturnType<ArrDeleteTarget['client']['sonarrSeriesSnapshot']>>;
};

type PreparedSeasonSelection =
  | {
    kind: 'plex_only';
    child: AuthoritativeSeasonPlan['plexOnlyChildren'][number];
    member: SeasonDeletionMemberPreview;
  }
  | {
    kind: 'managed';
    selection: SeasonDeletionSelection;
    plan: PreparedTargetPlan;
    episode: PreparedTargetPlan['snapshot']['episodes'][number];
    file: PreparedTargetPlan['snapshot']['files'][number];
    selectedMedia: PlannedMediaEvidence[];
    retainedMedia: PlannedMediaEvidence[];
    retainedCandidate: PlannedMediaEvidence;
    seasonNumber: number;
    episodeNumber: number;
  };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, child],
      ) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')
    }}`;
  }
  return JSON.stringify(value);
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function exactPath(version: PlexMediaVersionPathPreview, label: string): string {
  if (
    version.truncated || version.paths.length !== 1 || !normalizeRemoteAbsolute(version.paths[0]!)
  ) {
    throw new Error(`${label} Plex version is multipart, truncated, or has no exact absolute path`);
  }
  return version.paths[0]!;
}

function mediaEvidence(
  version: PlexMediaVersionPathPreview,
  logicalSize: number | null,
  target: ArrDeleteTarget | null,
  label: string,
): PlannedMediaEvidence {
  const path = exactPath(version, label);
  const byteSize = Number(version.fileSize);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
    throw new Error(`${label} Plex version has no exact positive byte size`);
  }
  const arrPath = target ? resolveArrPath(path, 'library', target.pathMappings) : path;
  if (!arrPath) throw new Error(`${label} Plex path is not covered by one exact Sonarr mapping`);
  return { mediaId: version.mediaId, path, arrPath, byteSize, logicalSize };
}

export async function buildAuthoritativeSeasonPlan(input: {
  serverId: number;
  machineIdentifier: string;
  plexClient: PlexClient;
  seasonRatingKey: string;
  selections: readonly SeasonDeletionSelection[];
}): Promise<AuthoritativeSeasonPlan> {
  const eligibleEpisodes = await db.select({
    episodeRatingKey: episodeMediaVersions.episodeRatingKey,
  }).from(episodeMediaVersions).where(and(
    eq(episodeMediaVersions.serverId, input.serverId),
    eq(episodeMediaVersions.seasonRatingKey, input.seasonRatingKey),
    not(episodeRootIsWorkflowOwned(
      input.serverId,
      sql`${episodeMediaVersions.libraryKey}`,
      sql`${episodeMediaVersions.episodeRatingKey}`,
      sql`${episodeMediaVersions.showRatingKey}`,
    )),
  )).groupBy(episodeMediaVersions.episodeRatingKey).having(sql`count(*) >= 2`).limit(
    MAX_EPISODES + 1,
  );
  if (eligibleEpisodes.length === 0) {
    throw new Error('no eligible duplicate episodes remain in this season');
  }
  if (eligibleEpisodes.length > MAX_EPISODES) {
    throw new Error(
      `this season exceeds the supported safety limit of ${MAX_EPISODES} eligible duplicate episodes and cannot be processed as one cleanup`,
    );
  }
  const eligibleKeys = eligibleEpisodes.map((entry) => entry.episodeRatingKey);
  const rows = await db.select().from(episodeMediaVersions).where(and(
    eq(episodeMediaVersions.serverId, input.serverId),
    eq(episodeMediaVersions.seasonRatingKey, input.seasonRatingKey),
    inArray(episodeMediaVersions.episodeRatingKey, eligibleKeys),
    not(episodeRootIsWorkflowOwned(
      input.serverId,
      sql`${episodeMediaVersions.libraryKey}`,
      sql`${episodeMediaVersions.episodeRatingKey}`,
      sql`${episodeMediaVersions.showRatingKey}`,
    )),
  )).limit(MAX_EPISODES * MAX_VERSIONS_PER_EPISODE + 1);
  if (rows.length > MAX_EPISODES * MAX_VERSIONS_PER_EPISODE) {
    throw new Error('the season exceeds the supported per-episode version limit');
  }
  const byEpisode = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byEpisode.get(row.episodeRatingKey) ?? [];
    group.push(row);
    byEpisode.set(row.episodeRatingKey, group);
  }
  for (const [key, group] of byEpisode) {
    if (group.length < 2) byEpisode.delete(key);
    else if (group.length > MAX_VERSIONS_PER_EPISODE) {
      throw new Error('an episode exceeds the supported media-version limit');
    }
  }
  if (byEpisode.size !== eligibleKeys.length) {
    throw new Error('season identity changed during planning');
  }
  const first = [...byEpisode.values()][0]![0]!;
  if (
    rows.some((row) =>
      row.libraryKey !== first.libraryKey || row.showRatingKey !== first.showRatingKey
    )
  ) {
    throw new Error('season identity is ambiguous');
  }
  const normalizedSelections = input.selections.map((selection) => ({
    episodeRatingKey: selection.episodeRatingKey,
    mediaIds: [...new Set(selection.mediaIds)].sort((a, b) => a - b),
  })).sort((a, b) => a.episodeRatingKey.localeCompare(b.episodeRatingKey));
  if (
    normalizedSelections.length === 0 || normalizedSelections.length > MAX_EPISODES ||
    new Set(normalizedSelections.map((entry) => entry.episodeRatingKey)).size !==
      normalizedSelections.length ||
    normalizedSelections.some((entry) => entry.mediaIds.length === 0)
  ) {
    throw new Error('season deletion selections are invalid');
  }
  const selectedEpisodeKeys = new Set(normalizedSelections.map((entry) => entry.episodeRatingKey));
  const activePlayback = activeWholeItemRatingKeys(
    selectedEpisodeKeys,
    await input.plexClient.activeSessions(),
  );
  if (activePlayback.size > 0) {
    throw new Error(
      `active playback blocks season cleanup for ${[...activePlayback].sort().join(', ')}`,
    );
  }
  const [show] = await db.select({ title: items.title, tvdbId: items.tvdbId }).from(items).where(
    and(
      eq(items.serverId, input.serverId),
      eq(items.ratingKey, first.showRatingKey),
    ),
  ).limit(1);
  if (!show) throw new Error('the Plex show identity is unavailable');
  const targets = (await getArrDeleteTargets(input.serverId, first.libraryKey)).filter((entry) =>
    entry.instanceType === 'sonarr'
  );
  if (targets.length > 0 && (!Number.isSafeInteger(show.tvdbId) || show.tvdbId! <= 0)) {
    throw new Error('the Plex show has no exact TVDB identity for Sonarr coordination');
  }
  const targetPlans: PreparedTargetPlan[] = [];
  for (const target of targets) {
    const capabilities = await target.client.sonarrSeasonCoordinationCapabilities();
    if (!capabilities.available || !capabilities.version) {
      throw new Error(capabilities.reason ?? 'Sonarr v4 coordination is unavailable');
    }
    const series = await target.client.lookup(show.tvdbId!);
    if (!series) continue;
    if (!series.path) throw new Error('Sonarr series path is unavailable');
    const [snapshot, activity] = await Promise.all([
      target.client.sonarrSeriesSnapshot(series.id),
      target.client.sonarrSeriesActivity(series.id),
    ]);
    if (!activity.quiet) {
      throw new Error(
        `Sonarr has conflicting series activity: ${
          activity.blocking.map((entry) => entry.name).join(', ')
        }`,
      );
    }
    targetPlans.push({
      target,
      seriesId: series.id,
      seriesPath: series.path,
      version: capabilities.version,
      snapshot,
    });
  }
  const plexOnlyChildren: AuthoritativeSeasonPlan['plexOnlyChildren'] = [];
  const managedGroups = new Map<string, PlannedManagedSeasonGroup>();
  const members: SeasonDeletionMemberPreview[] = [];
  const preparedSelections = await mapWithConcurrency(
    normalizedSelections,
    PLEX_VALIDATION_CONCURRENCY,
    async (selection): Promise<PreparedSeasonSelection> => {
      const local = byEpisode.get(selection.episodeRatingKey);
      if (!local) throw new Error('a selected episode is not in the complete eligible season set');
      const ids = new Set(local.map((row) => row.mediaId));
      if (selection.mediaIds.some((id) => !ids.has(id)) || selection.mediaIds.length >= ids.size) {
        throw new Error('selected media identities changed or would remove every episode version');
      }
      const [identity, live] = await Promise.all([
        input.plexClient.metadataIdentity(selection.episodeRatingKey),
        input.plexClient.mediaVersionPathPreviews(selection.episodeRatingKey),
      ]);
      if (
        !identity || identity.type !== 'episode' ||
        identity.librarySectionId !== first.libraryKey ||
        identity.parentRatingKey !== input.seasonRatingKey ||
        identity.grandparentRatingKey !== first.showRatingKey ||
        identity.seasonIndex !== first.seasonIndex || identity.index !== local[0]!.episodeIndex
      ) {
        throw new Error('live Plex episode ancestry no longer matches the accepted season');
      }
      const liveIds = new Set(live.map((entry) => entry.mediaId));
      if (liveIds.size !== ids.size || [...ids].some((id) => !liveIds.has(id))) {
        throw new Error(
          'live Plex media identities differ from the complete synced episode versions',
        );
      }
      const alignedOwners: Array<{
        plan: typeof targetPlans[number];
        episode: typeof targetPlans[number]['snapshot']['episodes'][number];
        file: typeof targetPlans[number]['snapshot']['files'][number];
        mediaId: number;
      }> = [];
      for (const plan of targetPlans) {
        const episode = plan.snapshot.episodes.find((entry) =>
          entry.seasonNumber === first.seasonIndex && entry.episodeNumber === local[0]!.episodeIndex
        );
        if (!episode || episode.episodeFileId === 0) continue;
        const file = plan.snapshot.files.find((entry) => entry.id === episode.episodeFileId);
        if (!file) throw new Error('Sonarr episode references a missing EpisodeFile');
        const filePath = normalizeRemoteAbsolute(file.path)?.comparison;
        const matchingMediaIds = live.flatMap((version) => {
          const arrPath = resolveArrPath(
            exactPath(
              version,
              selection.mediaIds.includes(version.mediaId) ? 'selected' : 'retained',
            ),
            'library',
            plan.target.pathMappings,
          );
          return arrPath && normalizeRemoteAbsolute(arrPath)?.comparison === filePath
            ? [version.mediaId]
            : [];
        });
        if (matchingMediaIds.length !== 1) {
          throw new Error(
            matchingMediaIds.length === 0
              ? 'Sonarr EpisodeFile ownership could not be aligned to one Plex version'
              : 'Sonarr EpisodeFile path matches multiple Plex versions',
          );
        }
        alignedOwners.push({ plan, episode, file, mediaId: matchingMediaIds[0]! });
      }
      if (alignedOwners.length > 1) {
        throw new Error('the selected episode is managed by multiple Sonarr instances');
      }
      const match = alignedOwners.find((owner) => selection.mediaIds.includes(owner.mediaId));
      if (!match) {
        const selectedMedia = selection.mediaIds.map((id) =>
          mediaEvidence(
            live.find((entry) => entry.mediaId === id)!,
            local.find((row) => row.mediaId === id)!.fileSize,
            null,
            'selected',
          )
        );
        const retainedMedia = local.filter((row) => !selection.mediaIds.includes(row.mediaId)).map((
          row,
        ) =>
          mediaEvidence(
            live.find((entry) => entry.mediaId === row.mediaId)!,
            row.fileSize,
            null,
            'retained',
          )
        );
        return {
          kind: 'plex_only',
          child: {
            episodeRatingKey: selection.episodeRatingKey,
            episodeTitle: local[0]!.episodeTitle,
            selectedMedia,
            retainedMedia,
            seasonNumber: first.seasonIndex,
            episodeNumber: local[0]!.episodeIndex,
          },
          member: {
            episodeRatingKey: selection.episodeRatingKey,
            selectedMediaIds: selection.mediaIds,
            retainedMediaIds: retainedMedia.map((entry) => entry.mediaId),
            outcome: 'plex_only',
            sonarrInstanceId: null,
            reason: null,
          },
        };
      }
      if (match.file.episodeIds.length !== 1 || match.file.episodeIds[0] !== match.episode.id) {
        throw new Error('shared or multi-episode Sonarr EpisodeFiles are not supported');
      }
      const selectedMedia = selection.mediaIds.map((id) =>
        mediaEvidence(
          live.find((entry) => entry.mediaId === id)!,
          local.find((row) => row.mediaId === id)!.fileSize,
          match.plan.target,
          'selected',
        )
      );
      const retainedMedia = local.filter((row) => !selection.mediaIds.includes(row.mediaId)).map((
        row,
      ) =>
        mediaEvidence(
          live.find((entry) => entry.mediaId === row.mediaId)!,
          row.fileSize,
          match.plan.target,
          'retained',
        )
      );
      const managedPath = normalizeRemoteAbsolute(match.file.path)?.comparison;
      if (
        !selectedMedia.some((entry) =>
          normalizeRemoteAbsolute(entry.arrPath)?.comparison === managedPath
        )
      ) {
        throw new Error('the selected Plex path does not exactly own the Sonarr EpisodeFile');
      }
      const adoptable = retainedMedia.filter((entry) =>
        arrPathIsWithin(entry.arrPath, match.plan.seriesPath)
      );
      if (adoptable.length !== 1 || retainedMedia.length !== 1) {
        throw new Error(
          'the established episode workflow requires one deterministic retained version inside the Sonarr series path',
        );
      }

      return {
        kind: 'managed',
        selection,
        plan: match.plan,
        episode: match.episode,
        file: match.file,
        selectedMedia,
        retainedMedia,
        retainedCandidate: adoptable[0]!,
        seasonNumber: first.seasonIndex,
        episodeNumber: local[0]!.episodeIndex,
      };
    },
  );

  const managedSelections = new Map<
    string,
    Extract<PreparedSeasonSelection, { kind: 'managed' }>[]
  >();
  for (const prepared of preparedSelections) {
    if (prepared.kind === 'plex_only') {
      plexOnlyChildren.push(prepared.child);
      members.push(prepared.member);
      continue;
    }
    const key = `${prepared.plan.target.instanceId}:${prepared.plan.seriesId}`;
    const group = managedSelections.get(key) ?? [];
    group.push(prepared);
    managedSelections.set(key, group);
  }

  for (const [key, group] of managedSelections) {
    const firstPrepared = group[0]!;
    const preflight = await firstPrepared.plan.target.client.sonarrManualImportPreflight(
      group.map((prepared) => ({
        path: prepared.retainedCandidate.arrPath,
        seriesId: prepared.plan.seriesId,
        seasonNumber: prepared.seasonNumber,
        episodeIds: [prepared.episode.id],
      })),
    );
    const managedGroup: PlannedManagedSeasonGroup = {
      arrInstanceId: firstPrepared.plan.target.instanceId,
      seriesId: firstPrepared.plan.seriesId,
      seriesPath: firstPrepared.plan.seriesPath,
      configurationUpdatedAt: firstPrepared.plan.target.configurationUpdatedAt,
      mappingIdentity: firstPrepared.plan.target.mappingIdentity,
      sonarrVersion: firstPrepared.plan.version,
      children: [],
    };
    for (let index = 0; index < group.length; index++) {
      const prepared = group[index]!;
      const result = preflight[index]!;
      if (
        result.rejectionReasons.length > 0 || result.episodeIds.length !== 1 ||
        result.episodeIds[0] !== prepared.episode.id
      ) {
        throw new Error('Sonarr retained-file adoption preflight did not prove the exact episode');
      }
      const outcome: SeasonDeletionOutcome = 'automatic_adoption';
      managedGroup.children.push({
        schemaVersion: 1,
        episodeRatingKey: prepared.selection.episodeRatingKey,
        selectedMedia: prepared.selectedMedia,
        retainedMedia: prepared.retainedMedia,
        sonarrEpisodeId: prepared.episode.id,
        seasonNumber: prepared.seasonNumber,
        episodeNumber: prepared.episodeNumber,
        originalMonitored: prepared.episode.monitored,
        intendedMonitored: prepared.episode.monitored,
        episodeFileId: prepared.file.id,
        episodeFilePath: prepared.file.path,
        episodeFileSize: prepared.file.size,
        episodeFileOwners: prepared.file.episodeIds,
        outcome,
      });
      members.push({
        episodeRatingKey: prepared.selection.episodeRatingKey,
        selectedMediaIds: prepared.selection.mediaIds,
        retainedMediaIds: prepared.retainedMedia.map((entry) => entry.mediaId),
        outcome,
        sonarrInstanceId: prepared.plan.target.instanceId,
        reason: null,
      });
    }
    managedGroups.set(key, managedGroup);
  }
  const evidence = {
    serverId: input.serverId,
    machineIdentifier: input.machineIdentifier,
    serverUrl: input.plexClient.serverUrl,
    libraryKey: first.libraryKey,
    showRatingKey: first.showRatingKey,
    seasonRatingKey: input.seasonRatingKey,
    activePlaybackRatingKeys: [],
    completeEpisodeRatingKeys: [...byEpisode.keys()].sort(),
    selections: normalizedSelections,
    plexOnlyChildren,
    managedGroups: [...managedGroups.values()].map((entry) => ({
      ...entry,
      children: [...entry.children].sort((a, b) =>
        a.episodeRatingKey.localeCompare(b.episodeRatingKey)
      ),
    })),
  };
  const planFingerprint = await fingerprint(evidence);
  const selectedVersionCount = normalizedSelections.reduce(
    (sum, entry) => sum + entry.mediaIds.length,
    0,
  );
  const preview: SeasonDeletionPreviewResponse = {
    seasonRatingKey: input.seasonRatingKey,
    completeEpisodeCount: byEpisode.size,
    selectedEpisodeCount: normalizedSelections.length,
    selectedVersionCount,
    plexOnlyCount: members.filter((entry) => entry.outcome === 'plex_only').length,
    automaticAdoptionCount:
      members.filter((entry) => entry.outcome === 'automatic_adoption').length,
    blockers: [],
    members,
    sonarrAvailable: managedGroups.size > 0,
    fingerprint: planFingerprint,
    expiresAt: seasonDeletionPreviewExpiry(),
  };
  return { ...evidence, showTitle: show.title, preview };
}

export function assertSeasonPreviewFresh(expiresAt: number): void {
  if (!seasonDeletionPreviewIsFresh(expiresAt)) {
    throw new Error('the season deletion preview expired');
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await map(values[index]!);
      }
    }),
  );
  return results;
}
