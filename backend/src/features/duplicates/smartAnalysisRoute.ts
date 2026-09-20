import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { mediaVersionReservations } from '../../db/schema.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';

import type { ActiveServerVariables } from '../../middleware/activeServer.ts';

import { hasAnyIncompleteRelocationBarrier } from '../deletionOperations/relocation/relocation.ts';
import { mediaRatingKeyIsPlaying } from '../mediaDeletion/activePlayback.ts';
import { buildSmartDuplicateAnalysis } from './smartAnalysis.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();

router.post('/smart-analysis', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const movies = body.movies !== false;
  const tv = body.tv !== false;
  if (!movies && !tv) return c.json({ error: 'select movies, TV, or both' }, 400);
  const activeServer = await resolveActiveServer().catch(() => null);
  if (activeServer === null) {
    return c.json({ analyzedGroups: 0, protectedGroups: 0, candidates: [] });
  }
  const serverId = activeServer.serverId;
  if (hasAnyIncompleteRelocationBarrier(serverId)) {
    return c.json({
      error:
        'A targeted library sync is required to finish retained-version relocation before smart analysis',
    }, 409);
  }
  try {
    const [analysis, sessions, reservations] = await Promise.all([
      buildSmartDuplicateAnalysis(serverId, { movies, tv }),
      activeServer.client.activeSessions(),
      db.select({
        mediaKind: mediaVersionReservations.mediaKind,
        ratingKey: mediaVersionReservations.ratingKey,
      }).from(mediaVersionReservations).where(eq(mediaVersionReservations.serverId, serverId)),
    ]);
    const reservedGroups = new Set(
      reservations.map((reservation) => `${reservation.mediaKind}:${reservation.ratingKey}`),
    );
    const unreservedCandidates = analysis.candidates.filter((candidate) =>
      !reservedGroups.has(
        `${candidate.mediaType === 'movie' ? 'movie' : 'episode'}:${candidate.ratingKey}`,
      )
    );
    const candidates = unreservedCandidates.filter((candidate) =>
      !mediaRatingKeyIsPlaying(candidate.ratingKey, sessions)
    );
    const reservedCount = analysis.candidates.length - unreservedCandidates.length;
    const activeCount = unreservedCandidates.length - candidates.length;
    return c.json({
      ...analysis,
      protectedGroups: analysis.protectedGroups + reservedCount + activeCount,
      candidates,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not analyze duplicate versions',
    }, 502);
  }
});

export default router;
