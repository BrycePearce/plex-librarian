import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { items, libraries, seasons } from '../../db/schema.ts';
import {
  contentIsNotIgnored,
  itemByRatingKey,
  libraryByKey,
  seasonsByShow,
} from '../../db/scope.ts';
import type { ActiveServerVariables } from '../../middleware/activeServer.ts';
import type { MovieDetail, ShowDetail } from '@plex-librarian/shared/types.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();

router.get('/:key/shows/:ratingKey', async (c) => {
  const key = c.req.param('key');
  const ratingKey = c.req.param('ratingKey');

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'show not found' }, 404);

  const [show] = await db
    .select()
    .from(items)
    .where(and(
      itemByRatingKey(serverId, ratingKey),
      eq(items.libraryKey, key),
      contentIsNotIgnored(serverId, items.ratingKey),
    ))
    .limit(1);
  if (!show) return c.json({ error: 'show not found' }, 404);

  const [showSeasons, [library]] = await Promise.all([
    db
      .select()
      .from(seasons)
      .where(and(seasonsByShow(serverId, ratingKey), eq(seasons.libraryKey, key)))
      .orderBy(asc(seasons.seasonIndex)),
    db.select({ historySyncedAt: libraries.historySyncedAt })
      .from(libraries)
      .where(libraryByKey(serverId, key))
      .limit(1),
  ]);

  return c.json(
    {
      show,
      seasons: showSeasons,
      historySyncedAt: library?.historySyncedAt ?? null,
    } satisfies ShowDetail,
  );
});

router.get('/:key/movies/:ratingKey', async (c) => {
  const key = c.req.param('key');
  const ratingKey = c.req.param('ratingKey');

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'movie not found' }, 404);

  const [[movie], [library]] = await Promise.all([
    db
      .select()
      .from(items)
      .where(and(
        itemByRatingKey(serverId, ratingKey),
        eq(items.libraryKey, key),
        contentIsNotIgnored(serverId, items.ratingKey),
      ))
      .limit(1),
    db.select({ historySyncedAt: libraries.historySyncedAt })
      .from(libraries)
      .where(libraryByKey(serverId, key))
      .limit(1),
  ]);
  if (!movie) return c.json({ error: 'movie not found' }, 404);

  return c.json(
    {
      movie,
      historySyncedAt: library?.historySyncedAt ?? null,
    } satisfies MovieDetail,
  );
});

export default router;
