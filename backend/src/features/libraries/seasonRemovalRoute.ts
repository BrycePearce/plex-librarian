import type { SeasonRemovalCreated, SeasonRemovalRequest } from '@plex-librarian/shared/types.ts';
import { Hono } from 'hono';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import {
  DeletionConflictError,
  enqueueDeletionOperation,
  repeatedDeletionOperation,
} from '../deletionOperations/service.ts';
import { buildWholeSeasonRemovalPlan } from './seasonRemovalPlanner.ts';

function deletionOptions(
  body: unknown,
  allowedKeys: readonly string[] = ['coordinated', 'cleanupDownloads'],
): { coordinated: boolean; cleanupDownloads: boolean } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return null;
  if (typeof value.coordinated !== 'boolean' || typeof value.cleanupDownloads !== 'boolean') {
    return null;
  }
  return { coordinated: value.coordinated, cleanupDownloads: value.cleanupDownloads };
}

function deletionRequest(body: unknown): SeasonRemovalRequest | null {
  const options = deletionOptions(body, [
    'clientRequestId',
    'previewFingerprint',
    'coordinated',
    'cleanupDownloads',
  ]);
  if (!options || !body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (
    typeof value.clientRequestId !== 'string' || !value.clientRequestId ||
    typeof value.previewFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.previewFingerprint)
  ) return null;
  return {
    ...options,
    clientRequestId: value.clientRequestId,
    previewFingerprint: value.previewFingerprint,
  };
}

const router = new Hono();

router.post('/:libraryKey/seasons/:seasonRatingKey/deletion-preview', async (c) => {
  const options = deletionOptions(await c.req.json().catch(() => null));
  if (!options) return c.json({ error: 'coordinated and cleanupDownloads must be booleans' }, 400);
  try {
    const active = await resolveActiveServer();
    const plan = await buildWholeSeasonRemovalPlan({
      serverId: active.serverId,
      machineIdentifier: await active.client.identity(),
      plexClient: active.client,
      libraryKey: c.req.param('libraryKey'),
      seasonRatingKey: c.req.param('seasonRatingKey'),
      ...options,
    });
    return c.json(plan.preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'could not build season preview';
    return c.json({ error: message }, message === 'season not found' ? 404 : 409);
  }
});

router.post('/:libraryKey/seasons/:seasonRatingKey/deletion', async (c) => {
  const request = deletionRequest(await c.req.json().catch(() => null));
  if (!request) return c.json({ error: 'invalid whole-season deletion request' }, 400);
  const payload = {
    libraryKey: c.req.param('libraryKey'),
    seasonRatingKey: c.req.param('seasonRatingKey'),
    ...request,
  };
  try {
    const active = await resolveActiveServer();
    const repeated = await repeatedDeletionOperation(
      active.serverId,
      request.clientRequestId,
      payload,
    );
    if (repeated) {
      return c.json({ ...repeated, targetCount: 1 } satisfies SeasonRemovalCreated, 202);
    }
    const plan = await buildWholeSeasonRemovalPlan({
      serverId: active.serverId,
      machineIdentifier: await active.client.identity(),
      plexClient: active.client,
      libraryKey: payload.libraryKey,
      seasonRatingKey: payload.seasonRatingKey,
      coordinated: request.coordinated,
      cleanupDownloads: request.cleanupDownloads,
    });
    if (plan.preview.blockers.length > 0) {
      return c.json({ error: plan.preview.blockers.join(' '), preview: plan.preview }, 409);
    }
    if (plan.preview.fingerprint !== request.previewFingerprint) {
      return c.json({
        error: 'season deletion preview changed',
        code: 'PREVIEW_CHANGED',
        preview: plan.preview,
      }, 409);
    }
    const result = await enqueueDeletionOperation({
      clientRequestId: request.clientRequestId,
      serverId: active.serverId,
      libraryKey: payload.libraryKey,
      kind: 'whole_item',
      payload,
      targets: [{
        kind: 'whole_item',
        key: payload.seasonRatingKey,
        title: `${plan.preview.showTitle} — ${plan.preview.seasonTitle}`,
        logicalSize: plan.logicalSize,
        snapshot: plan.snapshot,
      }],
    });
    return c.json({ ...result, targetCount: 1 } satisfies SeasonRemovalCreated, 202);
  } catch (error) {
    if (error instanceof DeletionConflictError) {
      return c.json(
        { error: error.message, operationId: error.operationId },
        error.status as 400 | 409,
      );
    }
    const message = error instanceof Error ? error.message : 'could not accept season deletion';
    return c.json({ error: message }, message === 'season not found' ? 404 : 409);
  }
});

export default router;
