import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import { users } from '../../db/schema.ts';
import type { PlexClient, PlexHistoryEntry, PlexLibrary } from '../../integrations/plex/index.ts';

function nonNegativeInteger(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 0 ? number : null;
}

export function historySeasonNumber(entry: PlexHistoryEntry): number | null {
  if (!entry.grandparentKey) return null;
  const seasonNumber = nonNegativeInteger(entry.parentIndex);
  if (seasonNumber === null) {
    throw new Error(
      `Plex omitted the season number for episode history entry ${entry.ratingKey}`,
    );
  }
  return seasonNumber;
}

// Walks /status/sessions/history/all?librarySectionID=<key> to get cross-user play history
// for the entire library in one paginated stream instead of one request per item.
// For episodes the play is attributed to the show (grandparentRatingKey); for movies the
// movie ratingKey is used directly. Artist libraries have no useful play history here.
export async function syncLibraryHistory(
  plex: PlexClient,
  lib: PlexLibrary,
  serverId: number,
): Promise<void> {
  if (lib.type === 'artist') return;

  const roster = await db.select({
    accountId: users.accountId,
    localAccountId: users.localAccountId,
  }).from(users).where(and(eq(users.serverId, serverId), isNotNull(users.localAccountId)));
  const localToGlobal = new Map<number, number | null>();
  for (const user of roster) {
    const localId = user.localAccountId as number;
    const existing = localToGlobal.get(localId);
    localToGlobal.set(
      localId,
      existing === undefined || existing === user.accountId ? user.accountId : null,
    );
  }

  // Item and season facts are flushed page-by-page. Only per-account maxima cross page
  // boundaries, so memory is bounded by the roster rather than library/history size.
  // Keyed by the history entry's PMS-LOCAL accountID (see
  // PlexHistoryEntry.accountID in integrations/plex/types.ts) — bounded by unique users, not play count.
  // Written to users.last_viewed_at via local_account_id, which syncUsers() is expected
  // to have already reconciled for every currently-known local account by the time this
  // runs (see runSync's call ordering) — an entry for a not-yet-reconciled account
  // simply matches zero rows below and is picked up on the next sync instead.
  const maxViewedAtByAccount = new Map<number, number>();

  for await (const page of plex.libraryHistory(lib.key)) {
    const pageMaxViewedAt = new Map<string, number>();
    const pageActivity = new Map<string, {
      accountId: number;
      ratingKey: string;
      firstViewedAt: number;
      lastViewedAt: number;
    }>();
    const pageSeasonActivity = new Map<string, {
      accountId: number;
      showRatingKey: string;
      seasonNumber: number;
      firstViewedAt: number;
      lastViewedAt: number;
    }>();
    for (const entry of page) {
      if (!entry.viewedAt) continue;
      // Episodes carry grandparentKey ("/library/metadata/76749") — extract trailing numeric ID.
      // If grandparentKey exists but has no numeric match (malformed path), skip rather than
      // falling back to the episode ratingKey, which is never stored in items for TV libraries.
      const key = entry.grandparentKey
        ? entry.grandparentKey.match(/(\d+)\/?$/)?.[1]
        : entry.ratingKey;
      if (key) {
        const cur = pageMaxViewedAt.get(key);
        if (!cur || entry.viewedAt > cur) pageMaxViewedAt.set(key, entry.viewedAt);
      }
      if (entry.accountID != null) {
        const curAcct = maxViewedAtByAccount.get(entry.accountID);
        if (!curAcct || entry.viewedAt > curAcct) {
          maxViewedAtByAccount.set(entry.accountID, entry.viewedAt);
        }
        const accountId = localToGlobal.get(entry.accountID);
        if (accountId && key) {
          const pairKey = `${accountId}:${key}`;
          const current = pageActivity.get(pairKey);
          if (!current) {
            pageActivity.set(pairKey, {
              accountId,
              ratingKey: key,
              firstViewedAt: entry.viewedAt,
              lastViewedAt: entry.viewedAt,
            });
          } else {
            current.firstViewedAt = Math.min(current.firstViewedAt, entry.viewedAt);
            current.lastViewedAt = Math.max(current.lastViewedAt, entry.viewedAt);
          }

          // Season-scoped request attribution cannot safely fall back to show-wide
          // activity. Abort the library history sync if Plex omits this field for a
          // currently matched user; service.ts will leave historySyncedAt null.
          const seasonNumber = historySeasonNumber(entry);
          if (seasonNumber !== null) {
            const seasonPairKey = `${accountId}:${key}:${seasonNumber}`;
            const currentSeason = pageSeasonActivity.get(seasonPairKey);
            if (!currentSeason) {
              pageSeasonActivity.set(seasonPairKey, {
                accountId,
                showRatingKey: key,
                seasonNumber,
                firstViewedAt: entry.viewedAt,
                lastViewedAt: entry.viewedAt,
              });
            } else {
              currentSeason.firstViewedAt = Math.min(
                currentSeason.firstViewedAt,
                entry.viewedAt,
              );
              currentSeason.lastViewedAt = Math.max(
                currentSeason.lastViewedAt,
                entry.viewedAt,
              );
            }
          }
        }
      }
    }

    // Write each history page immediately. Replaying a full sync is idempotent because
    // first/last timestamps use min/max rather than accumulating play counts.
    if (pageMaxViewedAt.size > 0 || pageActivity.size > 0 || pageSeasonActivity.size > 0) {
      withTransaction((client) => {
        const itemViewStmt = client.prepare(
          `UPDATE items SET last_viewed_at = ?
           WHERE server_id = ? AND rating_key = ? AND library_key = ?
             AND (last_viewed_at IS NULL OR last_viewed_at < ?)`,
        );
        for (const [ratingKey, viewedAt] of pageMaxViewedAt) {
          itemViewStmt.run(viewedAt, serverId, ratingKey, lib.key, viewedAt);
        }
        itemViewStmt.finalize();

        const itemStmt = client.prepare(
          `INSERT INTO user_item_activity
             (server_id, account_id, rating_key, first_viewed_at, last_viewed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(server_id, account_id, rating_key) DO UPDATE SET
             first_viewed_at = min(first_viewed_at, excluded.first_viewed_at),
             last_viewed_at = max(last_viewed_at, excluded.last_viewed_at)`,
        );
        for (const activity of pageActivity.values()) {
          itemStmt.run(
            serverId,
            activity.accountId,
            activity.ratingKey,
            activity.firstViewedAt,
            activity.lastViewedAt,
          );
        }
        itemStmt.finalize();

        const seasonStmt = client.prepare(
          `INSERT INTO user_season_activity
             (server_id, account_id, show_rating_key, season_number,
              first_viewed_at, last_viewed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(server_id, account_id, show_rating_key, season_number) DO UPDATE SET
             first_viewed_at = min(first_viewed_at, excluded.first_viewed_at),
             last_viewed_at = max(last_viewed_at, excluded.last_viewed_at)`,
        );
        for (const activity of pageSeasonActivity.values()) {
          seasonStmt.run(
            serverId,
            activity.accountId,
            activity.showRatingKey,
            activity.seasonNumber,
            activity.firstViewedAt,
            activity.lastViewedAt,
          );
        }
        seasonStmt.finalize();
      });
    }
  }

  // A local_account_id shared by more than one roster row (e.g. two accounts both
  // falling back to accounts.ts's UNKNOWN_USERNAME_PLACEHOLDER) must not have this
  // history activity blindly applied to every row that shares it — same "ambiguous
  // match behaves like no match" rule webhook.ts enforces when resolving a single
  // event to a unique row before writing to it. Resolved before entering the
  // transaction below since withTransaction's callback runs synchronously and can't
  // await this query itself.
  const ambiguousLocalIds = maxViewedAtByAccount.size > 0
    ? new Set(
      (await db.select({ localAccountId: users.localAccountId })
        .from(users)
        .where(and(eq(users.serverId, serverId), isNotNull(users.localAccountId)))
        .groupBy(users.localAccountId)
        .having(sql`count(*) > 1`))
        .map((r) => r.localAccountId as number),
    )
    : null;

  // Item maxima were already applied page-by-page; finish the roster-level aggregate.
  if (maxViewedAtByAccount.size > 0) {
    withTransaction((client) => {
      const stmt = client.prepare(
        `UPDATE users SET last_viewed_at = ?
         WHERE server_id = ? AND local_account_id = ?
           AND (last_viewed_at IS NULL OR last_viewed_at < ?)`,
      );
      for (const [localAccountId, viewedAt] of maxViewedAtByAccount) {
        if (ambiguousLocalIds!.has(localAccountId)) continue;
        stmt.run(viewedAt, serverId, localAccountId, viewedAt);
      }
      stmt.finalize();
    });
  }
}
