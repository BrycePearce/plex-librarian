import { Hono } from 'hono';
import type {
  SeasonCleanupRequest,
  SeasonCleanupResponse,
  SeasonDeletionIntent,
  SeasonDeletionPreviewResponse,
} from '@plex-librarian/shared/types.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import {
  DeletionConflictError,
  enqueueDeletionOperation,
  locallyActiveServerId,
  repeatedDeletionOperation,
} from '../deletionOperations/service.ts';
import {
  authoritativeSeasonTargets,
  buildAuthoritativeSeasonPlan,
} from './seasonDeletionPlanner.ts';
import { SMART_CLEANUP_DELETE_IDS_LIMIT, SMART_CLEANUP_GROUP_LIMIT } from './smartAnalysis.ts';

type ParsedSeasonCleanup = SeasonDeletionIntent & {
  seasonRatingKey: string;
  clientRequestId?: string;
  previewFingerprint?: string;
};

export class SeasonCleanupRequestError extends Error {}

function invalid(message: string): never {
  throw new SeasonCleanupRequestError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function exactIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

export function parseSeasonDeletionRequest(
  seasonRatingKey: string,
  body: unknown,
  command: boolean,
): ParsedSeasonCleanup {
  if (!exactIdentifier(seasonRatingKey) || !isPlainObject(body)) {
    invalid('exact season cleanup intent is required');
  }
  const expectedKeys = command
    ? [
      'cleanupDownloads',
      'clientRequestId',
      'coordinateSonarr',
      'previewFingerprint',
      'selections',
    ]
    : ['cleanupDownloads', 'coordinateSonarr', 'selections'];
  if (!exactKeys(body, expectedKeys)) invalid('season cleanup request fields are invalid');
  if (
    typeof body.coordinateSonarr !== 'boolean' || typeof body.cleanupDownloads !== 'boolean'
  ) invalid('destination choices must be booleans');
  if (
    !Array.isArray(body.selections) || body.selections.length === 0 ||
    body.selections.length > SMART_CLEANUP_GROUP_LIMIT
  ) {
    invalid(
      `selections must contain between 1 and ${SMART_CLEANUP_GROUP_LIMIT} episodes`,
    );
  }
  const seenEpisodes = new Set<string>();
  const selections = body.selections.map((selection) => {
    if (
      !isPlainObject(selection) ||
      !exactKeys(selection, ['episodeRatingKey', 'mediaIds']) ||
      !exactIdentifier(selection.episodeRatingKey) ||
      !Array.isArray(selection.mediaIds) || selection.mediaIds.length === 0 ||
      selection.mediaIds.length > SMART_CLEANUP_DELETE_IDS_LIMIT ||
      !selection.mediaIds.every((id) => Number.isSafeInteger(id) && Number(id) >= 0)
    ) invalid('one or more season cleanup selections are invalid');
    if (seenEpisodes.has(selection.episodeRatingKey)) {
      invalid('season cleanup selections must not repeat an episode');
    }
    seenEpisodes.add(selection.episodeRatingKey);
    const mediaIds = selection.mediaIds as number[];
    if (new Set(mediaIds).size !== mediaIds.length) {
      invalid('season cleanup selections must not repeat a media ID');
    }
    return {
      episodeRatingKey: selection.episodeRatingKey,
      mediaIds: [...mediaIds].sort((left, right) => left - right),
    };
  }).sort((left, right) => left.episodeRatingKey.localeCompare(right.episodeRatingKey));
  const parsed: ParsedSeasonCleanup = {
    seasonRatingKey,
    selections,
    coordinateSonarr: body.coordinateSonarr,
    cleanupDownloads: body.cleanupDownloads,
  };
  if (command) {
    if (
      typeof body.clientRequestId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(body.clientRequestId)
    ) {
      invalid('clientRequestId must be a non-empty string of at most 128 characters');
    }
    if (
      typeof body.previewFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.previewFingerprint)
    ) invalid('previewFingerprint must be a lowercase SHA-256 fingerprint');
    parsed.clientRequestId = body.clientRequestId;
    parsed.previewFingerprint = body.previewFingerprint;
  }
  return parsed;
}

export function canonicalSeasonDeletionIntent(input: ParsedSeasonCleanup): Record<string, unknown> {
  return {
    seasonRatingKey: input.seasonRatingKey,
    selections: input.selections,
    coordinateSonarr: input.coordinateSonarr,
    cleanupDownloads: input.cleanupDownloads,
  };
}

export function seasonCleanupConflictDetails(error: DeletionConflictError): {
  code?: 'REQUEST_ID_CONFLICT' | 'DELETION_CONFLICT';
  operationId?: string;
} {
  if (error.message.startsWith('clientRequestId was already used')) {
    return { code: 'REQUEST_ID_CONFLICT' };
  }
  if (error.operationId) {
    return { code: 'DELETION_CONFLICT', operationId: error.operationId };
  }
  return {};
}

export async function submitSeasonCleanup(
  seasonRatingKey: string,
  request: SeasonCleanupRequest,
): Promise<SeasonCleanupResponse | { changed: true; preview: SeasonDeletionPreviewResponse }> {
  const parsed = parseSeasonDeletionRequest(seasonRatingKey, request, true);
  let active: Awaited<ReturnType<typeof resolveActiveServer>> | null = null;
  const localServerId = locallyActiveServerId();
  if (localServerId === null) active = await resolveActiveServer();
  const serverId = localServerId ?? active!.serverId;
  const payload = canonicalSeasonDeletionIntent(parsed);
  const repeated = await repeatedDeletionOperation(serverId, parsed.clientRequestId!, payload);
  if (repeated) return repeated;

  active ??= await resolveActiveServer();
  if (active.serverId !== serverId) {
    throw new DeletionConflictError('the active Plex server changed during cleanup');
  }
  const plan = await buildAuthoritativeSeasonPlan({
    serverId,
    machineIdentifier: await active.client.identity(),
    plexClient: active.client,
    seasonRatingKey: parsed.seasonRatingKey,
    selections: parsed.selections,
    inspectSonarr: true,
    coordinateSonarr: parsed.coordinateSonarr,
    inspectDownloadCleanup: true,
    cleanupDownloads: parsed.cleanupDownloads,
  });
  if (plan.preview.fingerprint !== parsed.previewFingerprint) {
    return { changed: true, preview: plan.preview };
  }
  if (parsed.cleanupDownloads && plan.cleanupPlans.length === 0) {
    throw new DeletionConflictError(
      plan.preview.cleanupReason ?? 'no verified downloads can be cleaned up',
    );
  }
  const targets = authoritativeSeasonTargets(plan);
  const result = await enqueueDeletionOperation({
    clientRequestId: parsed.clientRequestId!,
    serverId,
    libraryKey: plan.libraryKey,
    kind: 'episode_version',
    payload,
    targets,
  });
  return { ...result, targetCount: targets.length };
}

const router = new Hono();

router.post('/seasons/:seasonRatingKey/cleanup', async (c) => {
  const body = await c.req.json().catch(() => null);
  try {
    const result = await submitSeasonCleanup(
      c.req.param('seasonRatingKey'),
      body as SeasonCleanupRequest,
    );
    if ('changed' in result) {
      return c.json({
        error: 'the authoritative season deletion preview changed',
        code: 'PREVIEW_CHANGED',
        preview: result.preview,
      }, 409);
    }
    return c.json(result satisfies SeasonCleanupResponse, 202);
  } catch (error) {
    if (error instanceof DeletionConflictError) {
      return c.json({
        error: error.message,
        ...seasonCleanupConflictDetails(error),
      }, error.status as 400 | 404 | 409);
    }
    return c.json({
      error: error instanceof Error ? error.message : 'season cleanup could not be validated',
    }, error instanceof SeasonCleanupRequestError ? 400 : 409);
  }
});

export default router;
