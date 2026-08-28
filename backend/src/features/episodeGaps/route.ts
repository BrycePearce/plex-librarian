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
  EpisodeGapsScope,
  EpisodeGapsSort,
  EpisodeGapsStatusFilter,
} from '@plex-librarian/shared/types.ts';
import { decodeEpisodeGapProjection, decodeSeasonGapProjection } from './projection.ts';
import { contentIsNotIgnored } from '../../db/scope.ts';

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
const validSeasonNormal = sql`(
  ${items.seasonAuditStatus} in ('ok', 'gaps')
  and ${items.seasonFirstIndex} between 1 and 10000
  and ${items.seasonLastIndex} between ${items.seasonFirstIndex} and 10000
  and ${items.seasonPresentCount} > 0
  and ${items.seasonGapCount} >= 0
  and ${items.seasonLastIndex} - ${items.seasonFirstIndex} + 1 =
      ${items.seasonPresentCount} + ${items.seasonGapCount}
  and json_valid(${items.seasonGapRangesJson})
  and json_type(${items.seasonGapRangesJson}) = 'array'
  and json_array_length(${items.seasonGapRangesJson}) <= 256
  and not exists (
    select 1 from json_each(${items.seasonGapRangesJson}) r
    where json_type(r.value) <> 'object'
      or json_type(r.value, '$.start') <> 'integer'
      or json_type(r.value, '$.end') <> 'integer'
      or json_extract(r.value, '$.start') <= ${items.seasonFirstIndex}
      or json_extract(r.value, '$.end') >= ${items.seasonLastIndex}
      or json_extract(r.value, '$.end') < json_extract(r.value, '$.start')
      or (cast(r.key as integer) > 0 and json_extract(r.value, '$.start') <=
          json_extract(${items.seasonGapRangesJson}, '$[' || (cast(r.key as integer) - 1) || '].end'))
  )
  and coalesce((select sum(json_extract(r.value, '$.end') - json_extract(r.value, '$.start') + 1)
                from json_each(${items.seasonGapRangesJson}) r), 0) = ${items.seasonGapCount}
  and ((${items.seasonAuditStatus} = 'gaps' and ${items.seasonGapCount} > 0)
    or (${items.seasonAuditStatus} = 'ok' and ${items.seasonGapCount} = 0
        and json_array_length(${items.seasonGapRangesJson}) = 0))
)`;
const invalidSeasonNormal =
  sql`(${items.seasonAuditStatus} in ('ok', 'gaps') and not ${validSeasonNormal})`;
const unexpectedSeasonStatus = sql`(
  ${items.seasonAuditStatus} is not null
  and ${items.seasonAuditStatus} not in ('ok', 'gaps', 'irregular', 'excluded')
)`;

router.get('/', async (c) => {
  const rawScope = c.req.query('scope') ?? 'episode';
  if (rawScope !== 'episode' && rawScope !== 'season') {
    return c.json({ error: 'invalid scope' }, 400);
  }
  const gapScope = rawScope as EpisodeGapsScope;
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
  if (gapScope === 'season' && sort === 'seasonIndex') {
    return c.json({ error: 'seasonIndex sort is only valid for episode scope' }, 400);
  }
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
  if (serverId === null) return c.json(emptyResponse(gapScope, limit, offset));
  if (gapScope === 'season') {
    return c.json(
      await seasonResponse(serverId, libraryKey, search, status, sort, rawOrder, limit, offset),
    );
  }

  const scope = [
    eq(seasons.serverId, serverId),
    contentIsNotIgnored(serverId, seasons.showRatingKey),
  ];
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
      scope: 'episode',
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

async function seasonResponse(
  serverId: number,
  libraryKey: string | undefined,
  search: string,
  status: EpisodeGapsStatusFilter,
  sort: EpisodeGapsSort,
  rawOrder: string,
  limit: number,
  offset: number,
): Promise<EpisodeGapsResponse> {
  const scope = [
    eq(items.serverId, serverId),
    eq(items.type, 'show'),
    contentIsNotIgnored(serverId, items.ratingKey),
  ];
  if (libraryKey) scope.push(eq(items.libraryKey, libraryKey));
  if (search) scope.push(sql`instr(lower(${items.title}), lower(${search})) > 0`);
  const statusCondition = status === 'gaps'
    ? and(eq(items.seasonAuditStatus, 'gaps'), validSeasonNormal)
    : status === 'irregular'
    ? or(eq(items.seasonAuditStatus, 'irregular'), invalidSeasonNormal, unexpectedSeasonStatus)
    : or(
      sql`${items.seasonAuditStatus} in ('ok', 'gaps', 'irregular')`,
      unexpectedSeasonStatus,
    );
  const where = and(...scope, statusCondition);
  const direction = rawOrder === 'asc' ? asc : desc;
  const primary = sort === 'title'
    ? items.title
    : sort === 'auditSyncedAt'
    ? libraries.episodeAuditSyncedAt
    : items.seasonGapCount;
  const base = db.select({
    libraryKey: items.libraryKey,
    libraryTitle: libraries.title,
    showRatingKey: items.ratingKey,
    showTitle: items.title,
    showThumb: items.thumb,
    firstSeasonIndex: items.seasonFirstIndex,
    lastSeasonIndex: items.seasonLastIndex,
    presentCount: items.seasonPresentCount,
    missingCount: items.seasonGapCount,
    missingRangesJson: items.seasonGapRangesJson,
    status: items.seasonAuditStatus,
    reason: items.seasonAuditReason,
    episodeAuditSyncedAt: libraries.episodeAuditSyncedAt,
  }).from(items).innerJoin(
    libraries,
    and(eq(libraries.serverId, items.serverId), eq(libraries.key, items.libraryKey)),
  );
  const rows = await base.where(where).orderBy(direction(primary), asc(items.title)).limit(limit)
    .offset(offset);
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(items).innerJoin(
    libraries,
    and(eq(libraries.serverId, items.serverId), eq(libraries.key, items.libraryKey)),
  ).where(where);
  const [summary] = await db.select({
    gapShowCount: sql<
      number
    >`sum(case when ${items.seasonAuditStatus} = 'gaps' and ${validSeasonNormal} then 1 else 0 end)`,
    missingSeasonCount: sql<
      string
    >`cast(coalesce(sum(case when ${items.seasonAuditStatus} = 'gaps' and ${validSeasonNormal} then ${items.seasonGapCount} else 0 end), 0) as text)`,
    irregularShowCount: sql<
      number
    >`sum(case when ${items.seasonAuditStatus} = 'irregular' or ${invalidSeasonNormal} or ${unexpectedSeasonStatus} then 1 else 0 end)`,
  }).from(items).where(and(...scope));
  const libraryAudits = await db.select({
    libraryKey: libraries.key,
    libraryTitle: libraries.title,
    episodeAuditSyncedAt: libraries.episodeAuditSyncedAt,
  }).from(libraries).where(and(
    eq(libraries.serverId, serverId),
    eq(libraries.type, 'show'),
    libraryKey ? eq(libraries.key, libraryKey) : undefined,
  )).orderBy(asc(libraries.title));
  return {
    scope: 'season',
    summary: {
      gapShowCount: summary?.gapShowCount ?? 0,
      missingSeasonCount: Number(summary?.missingSeasonCount ?? 0),
      checkedLibraryCount:
        libraryAudits.filter((audit) => audit.episodeAuditSyncedAt !== null).length,
      irregularShowCount: summary?.irregularShowCount ?? 0,
    },
    total: total ?? 0,
    limit,
    offset,
    libraryAudits,
    rows: rows.map(decodeSeasonGapProjection),
  };
}

function emptyResponse(
  scope: EpisodeGapsScope,
  limit: number,
  offset: number,
): EpisodeGapsResponse {
  const common = { total: 0, limit, offset, libraryAudits: [], rows: [] };
  return scope === 'episode'
    ? {
      scope: 'episode',
      summary: {
        gapSeasonCount: 0,
        missingEpisodeCount: 0,
        checkedLibraryCount: 0,
        irregularSeasonCount: 0,
      },
      ...common,
    }
    : {
      scope: 'season',
      summary: {
        gapShowCount: 0,
        missingSeasonCount: 0,
        checkedLibraryCount: 0,
        irregularShowCount: 0,
      },
      ...common,
    };
}

export default router;
