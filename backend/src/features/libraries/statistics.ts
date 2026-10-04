import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { ignoredContent, items } from '../../db/schema.ts';
import { contentIsNotIgnored } from '../../db/scope.ts';

export interface LibraryStatistics {
  libraryKey: string;
  itemCount: number;
  totalFileSize: string | null;
}

// Tiny requested sets should probe exclusions locally, even if another library
// has many ignored items. The extra row lookups stay bounded by this threshold.
const LOCAL_EXCLUSION_LOOKUP_LIMIT = 1024;

export async function readLibraryStatistics(
  serverId: number,
  libraryKeys: string[],
): Promise<LibraryStatistics[]> {
  if (libraryKeys.length === 0) return [];

  try {
    // The existing size index covers this full-library pass. Subtract exclusions
    // separately so we don't fetch every item's row and probe ignored_content for
    // every item. CROSS JOIN enforces each branch's join order. Its leading gate
    // produces zero rows for the disabled branch, avoiding that branch's scan.
    // The repeatedly referenced totals CTE is materialized once by SQLite.
    // One statement preserves a consistent snapshot and exact integer arithmetic.
    const totals = db.$with('totals').as(
      db.select({
        libraryKey: items.libraryKey,
        itemCount: count().as('item_count'),
        totalSize: sql<number>`coalesce(sum(${items.fileSize}), 0)`.as('total_size'),
      }).from(items).where(and(
        eq(items.serverId, serverId),
        inArray(items.libraryKey, libraryKeys),
      )).groupBy(items.libraryKey),
    );
    return await db.with(totals).select({
      libraryKey: totals.libraryKey,
      itemCount: sql<number>`totals.item_count - coalesce(ignored.item_count, 0)`,
      totalFileSize: sql<string>`cast(
        totals.total_size - coalesce(ignored.total_size, 0) as text
      )`,
    }).from(totals).leftJoin(
      sql`(
      select ${items.libraryKey} as library_key, count(*) as item_count,
        coalesce(sum(${items.fileSize}), 0) as total_size
      from (select count(*) from ${totals}
        having sum(${totals.itemCount}) > ${LOCAL_EXCLUSION_LOOKUP_LIMIT}) gate
      cross join ${ignoredContent} cross join ${items}
      where ${ignoredContent.serverId} = ${serverId}
        and ${items.serverId} = ${ignoredContent.serverId}
        and ${items.ratingKey} = ${ignoredContent.ratingKey}
        and ${inArray(items.libraryKey, libraryKeys)}
      group by ${items.libraryKey}
      union all
      select ${items.libraryKey} as library_key, count(*) as item_count,
        coalesce(sum(${items.fileSize}), 0) as total_size
      from (select count(*) from ${totals}
        having sum(${totals.itemCount}) <= ${LOCAL_EXCLUSION_LOOKUP_LIMIT}) gate
      cross join ${items}
      where ${items.serverId} = ${serverId}
        and ${inArray(items.libraryKey, libraryKeys)}
        and not (${contentIsNotIgnored(serverId, items.ratingKey)})
      group by ${items.libraryKey}
    ) ignored`,
      sql`totals.library_key = ignored.library_key`,
    );
  } catch (error) {
    // A hypothetical total above SQLite's signed 64-bit range might include
    // excluded sizes, while the visible subset still fits. Preserve the original
    // subset-only sum in that case instead of losing precision with REAL/JS sums.
    const nativeError = error instanceof Error && error.cause instanceof Error
      ? error.cause
      : error;
    if (!(nativeError instanceof Error) || nativeError.message !== 'integer overflow') throw error;
    return await db.select({
      libraryKey: items.libraryKey,
      itemCount: count(),
      totalFileSize: sql<string | null>`cast(sum(${items.fileSize}) as text)`,
    }).from(items).where(and(
      eq(items.serverId, serverId),
      inArray(items.libraryKey, libraryKeys),
      contentIsNotIgnored(serverId, items.ratingKey),
    )).groupBy(items.libraryKey);
  }
}
