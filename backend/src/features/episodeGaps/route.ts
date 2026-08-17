import { Hono } from 'hono';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  arrInstances,
  arrLibraryMappings,
  items,
  libraries,
  seasons,
  servers,
} from '../../db/schema.ts';
import { ArrClient } from '../../integrations/arr/client.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import type {
  EpisodeGapsResponse,
  EpisodeGapsSort,
  EpisodeGapsStatusFilter,
} from '@plex-librarian/shared/types.ts';
import { decodeEpisodeGapProjection } from './projection.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

router.get('/open/plex/:showRatingKey', async (c) => {
  const serverId = c.get('activeServerId');
  const showRatingKey = c.req.param('showRatingKey');
  if (serverId === null || !showRatingKey || showRatingKey.length > 200) {
    return c.json({ error: 'Plex show not found' }, 404);
  }
  const [show] = await db.select({
    machineIdentifier: servers.machineIdentifier,
    serverUrl: servers.url,
  }).from(items).innerJoin(servers, eq(servers.id, items.serverId)).where(and(
    eq(items.serverId, serverId),
    eq(items.ratingKey, showRatingKey),
    eq(items.type, 'show'),
  )).limit(1);
  if (!show) return c.json({ error: 'Plex show not found' }, 404);

  const metadataKey = encodeURIComponent(`/library/metadata/${showRatingKey}`);
  const target = `${show.serverUrl.replace(/\/+$/, '')}/web/index.html#!/server/${
    encodeURIComponent(show.machineIdentifier)
  }/details?key=${metadataKey}`;
  return c.redirect(target, 302);
});

router.get('/open/sonarr/:instanceId/:showRatingKey', async (c) => {
  const serverId = c.get('activeServerId');
  const instanceId = Number(c.req.param('instanceId'));
  const showRatingKey = c.req.param('showRatingKey');
  if (
    serverId === null || !Number.isSafeInteger(instanceId) || instanceId <= 0 ||
    !showRatingKey || showRatingKey.length > 200
  ) {
    return c.json({ error: 'Sonarr show not found' }, 404);
  }
  const [target] = await db.select({
    tvdbId: items.tvdbId,
    instanceUrl: arrInstances.url,
    apiKey: arrInstances.apiKey,
  }).from(items)
    .innerJoin(
      arrLibraryMappings,
      and(
        eq(arrLibraryMappings.serverId, items.serverId),
        eq(arrLibraryMappings.libraryKey, items.libraryKey),
      ),
    )
    .innerJoin(
      arrInstances,
      and(
        eq(arrInstances.serverId, items.serverId),
        eq(arrInstances.id, arrLibraryMappings.arrInstanceId),
      ),
    )
    .where(and(
      eq(items.serverId, serverId),
      eq(items.ratingKey, showRatingKey),
      eq(items.type, 'show'),
      eq(arrInstances.id, instanceId),
      eq(arrInstances.type, 'sonarr'),
    )).limit(1);
  if (!target || !Number.isSafeInteger(target.tvdbId) || target.tvdbId! <= 0) {
    return c.json({ error: 'This show is not linked to the selected Sonarr instance' }, 404);
  }

  try {
    const series = await new ArrClient('sonarr', target.instanceUrl, target.apiKey).lookup(
      target.tvdbId!,
    );
    if (!series?.titleSlug) {
      return c.json({ error: 'This show is not managed by the selected Sonarr instance' }, 404);
    }
    return c.redirect(
      `${target.instanceUrl.replace(/\/+$/, '')}/series/${encodeURIComponent(series.titleSlug)}`,
      302,
    );
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Sonarr could not resolve this show',
    }, 502);
  }
});

const validNormal = sql`(
  ${seasons.episodeAuditStatus} in ('ok', 'gaps')
  and ${seasons.seasonIndex} between 1 and 10000
  and ${seasons.episodeFirstIndex} between 1 and 10000
  and ${seasons.episodeLastIndex} between ${seasons.episodeFirstIndex} and 10000
  and ${seasons.episodePresentCount} > 0
  and ${seasons.episodeGapCount} >= 0
  and ${seasons.episodeLastIndex} - ${seasons.episodeFirstIndex} + 1 =
      ${seasons.episodePresentCount} + ${seasons.episodeGapCount}
  and json_valid(${seasons.episodeGapRangesJson})
  and json_type(${seasons.episodeGapRangesJson}) = 'array'
  and json_array_length(${seasons.episodeGapRangesJson}) <= 256
  and not exists (
    select 1 from json_each(${seasons.episodeGapRangesJson}) r
    where json_type(r.value) <> 'object'
      or json_type(r.value, '$.start') <> 'integer'
      or json_type(r.value, '$.end') <> 'integer'
      or json_extract(r.value, '$.start') <= ${seasons.episodeFirstIndex}
      or json_extract(r.value, '$.end') >= ${seasons.episodeLastIndex}
      or json_extract(r.value, '$.end') < json_extract(r.value, '$.start')
      or (cast(r.key as integer) > 0 and json_extract(r.value, '$.start') <=
          json_extract(${seasons.episodeGapRangesJson}, '$[' || (cast(r.key as integer) - 1) || '].end'))
  )
  and coalesce((select sum(json_extract(r.value, '$.end') - json_extract(r.value, '$.start') + 1)
                from json_each(${seasons.episodeGapRangesJson}) r), 0) = ${seasons.episodeGapCount}
  and ((${seasons.episodeAuditStatus} = 'gaps' and ${seasons.episodeGapCount} > 0)
    or (${seasons.episodeAuditStatus} = 'ok' and ${seasons.episodeGapCount} = 0
        and json_array_length(${seasons.episodeGapRangesJson}) = 0))
)`;
const invalidNormal = sql`(${seasons.episodeAuditStatus} in ('ok', 'gaps') and not ${validNormal})`;

router.get('/', async (c) => {
  const libraryKey = c.req.query('libraryKey')?.trim() || undefined;
  const search = (c.req.query('search') ?? '').trim();
  if (search.length > 200) return c.json({ error: 'search must be 200 characters or fewer' }, 400);
  const rawStatus = c.req.query('status') ?? 'gaps';
  if (!['gaps', 'irregular', 'all'].includes(rawStatus)) {
    return c.json({ error: 'invalid status' }, 400);
  }
  const status = rawStatus as EpisodeGapsStatusFilter;
  const rawSort = c.req.query('sort') ?? 'missingCount';
  if (!['missingCount', 'title', 'seasonIndex', 'auditSyncedAt'].includes(rawSort)) {
    return c.json({ error: 'invalid sort' }, 400);
  }
  const sort = rawSort as EpisodeGapsSort;
  const rawOrder = c.req.query('order') ?? 'desc';
  if (rawOrder !== 'asc' && rawOrder !== 'desc') return c.json({ error: 'invalid order' }, 400);
  const limitValue = Number(c.req.query('limit') ?? 50);
  const offsetValue = Number(c.req.query('offset') ?? 0);
  if (
    !Number.isSafeInteger(limitValue) || limitValue <= 0 || !Number.isSafeInteger(offsetValue) ||
    offsetValue < 0
  ) {
    return c.json({ error: 'invalid pagination' }, 400);
  }
  const limit = Math.min(limitValue, 100);
  const offset = offsetValue;
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json(emptyResponse(limit, offset));

  const scope = [eq(seasons.serverId, serverId)];
  if (libraryKey) scope.push(eq(seasons.libraryKey, libraryKey));
  if (search) scope.push(sql`instr(lower(${items.title}), lower(${search})) > 0`);
  const statusCondition = status === 'gaps'
    ? and(eq(seasons.episodeAuditStatus, 'gaps'), validNormal)
    : status === 'irregular'
    ? or(eq(seasons.episodeAuditStatus, 'irregular'), invalidNormal)
    : sql`${seasons.episodeAuditStatus} in ('ok', 'gaps', 'irregular')`;
  const where = and(...scope, statusCondition);
  const baseJoin = db.select({
    libraryKey: seasons.libraryKey,
    libraryTitle: libraries.title,
    showRatingKey: seasons.showRatingKey,
    showTitle: items.title,
    showThumb: items.thumb,
    seasonRatingKey: seasons.ratingKey,
    seasonIndex: seasons.seasonIndex,
    seasonTitle: seasons.title,
    firstEpisodeIndex: seasons.episodeFirstIndex,
    lastEpisodeIndex: seasons.episodeLastIndex,
    presentCount: seasons.episodePresentCount,
    missingCount: seasons.episodeGapCount,
    missingRangesJson: seasons.episodeGapRangesJson,
    status: seasons.episodeAuditStatus,
    reason: seasons.episodeAuditReason,
    episodeAuditSyncedAt: libraries.episodeAuditSyncedAt,
  }).from(seasons)
    .innerJoin(
      libraries,
      and(eq(libraries.serverId, seasons.serverId), eq(libraries.key, seasons.libraryKey)),
    )
    .innerJoin(
      items,
      and(eq(items.serverId, seasons.serverId), eq(items.ratingKey, seasons.showRatingKey)),
    );

  const direction = rawOrder === 'asc' ? asc : desc;
  const primary = sort === 'title'
    ? items.title
    : sort === 'seasonIndex'
    ? seasons.seasonIndex
    : sort === 'auditSyncedAt'
    ? libraries.episodeAuditSyncedAt
    : seasons.episodeGapCount;
  const rows = await baseJoin.where(where)
    .orderBy(direction(primary), asc(items.title), asc(seasons.seasonIndex))
    .limit(limit).offset(offset);
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(seasons)
    .innerJoin(
      libraries,
      and(eq(libraries.serverId, seasons.serverId), eq(libraries.key, seasons.libraryKey)),
    )
    .innerJoin(
      items,
      and(eq(items.serverId, seasons.serverId), eq(items.ratingKey, seasons.showRatingKey)),
    )
    .where(where);

  const summaryScope = and(...scope);
  const [summary] = await db.select({
    gapSeasonCount: sql<
      number
    >`sum(case when ${seasons.episodeAuditStatus} = 'gaps' and ${validNormal} then 1 else 0 end)`,
    // Cast the potentially large aggregate to text because @db/sqlite's integer read
    // path truncates values outside the signed 32-bit range.
    missingEpisodeCount: sql<
      string
    >`cast(coalesce(sum(case when ${seasons.episodeAuditStatus} = 'gaps' and ${validNormal} then ${seasons.episodeGapCount} else 0 end), 0) as text)`,
    irregularSeasonCount: sql<
      number
    >`sum(case when ${seasons.episodeAuditStatus} = 'irregular' or ${invalidNormal} then 1 else 0 end)`,
  }).from(seasons)
    .innerJoin(
      items,
      and(eq(items.serverId, seasons.serverId), eq(items.ratingKey, seasons.showRatingKey)),
    )
    .where(summaryScope);
  const libraryScope = and(
    eq(libraries.serverId, serverId),
    eq(libraries.type, 'show'),
    libraryKey ? eq(libraries.key, libraryKey) : undefined,
  );
  const libraryAudits = await db.select({
    libraryKey: libraries.key,
    libraryTitle: libraries.title,
    episodeAuditSyncedAt: libraries.episodeAuditSyncedAt,
  }).from(libraries).where(libraryScope).orderBy(asc(libraries.title));
  const checkedLibraryCount = libraryAudits.filter((library) =>
    library.episodeAuditSyncedAt !== null
  ).length;

  return c.json(
    {
      summary: {
        gapSeasonCount: summary?.gapSeasonCount ?? 0,
        missingEpisodeCount: Number(summary?.missingEpisodeCount ?? 0),
        checkedLibraryCount,
        irregularSeasonCount: summary?.irregularSeasonCount ?? 0,
      },
      total: total ?? 0,
      limit,
      offset,
      libraryAudits,
      rows: rows.map(decodeEpisodeGapProjection),
    } satisfies EpisodeGapsResponse,
  );
});

function emptyResponse(limit: number, offset: number): EpisodeGapsResponse {
  return {
    summary: {
      gapSeasonCount: 0,
      missingEpisodeCount: 0,
      checkedLibraryCount: 0,
      irregularSeasonCount: 0,
    },
    total: 0,
    limit,
    offset,
    libraryAudits: [],
    rows: [],
  };
}

export default router;
