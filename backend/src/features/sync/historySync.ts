import { and, eq, isNotNull } from 'drizzle-orm';
import { db, type SqliteClient, withTransaction } from '../../db/index.ts';
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

interface UserHistoryMaximum {
  accountId: number;
  localAccountId: number;
  viewedAt: number;
}

export function applyUserHistoryMaxima(
  client: SqliteClient,
  serverId: number,
  maxima: Iterable<UserHistoryMaximum>,
): void {
  const stmt = client.prepare(
    `UPDATE users SET last_viewed_at = ?
     WHERE server_id = ? AND account_id = ? AND local_account_id = ?
       AND (last_viewed_at IS NULL OR last_viewed_at < ?)`,
  );
  for (const maximum of maxima) {
    stmt.run(
      maximum.viewedAt,
      serverId,
      maximum.accountId,
      maximum.localAccountId,
      maximum.viewedAt,
    );
  }
  stmt.finalize();
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
  // Keyed by the history entry's PMS SystemAccount accountID (see
  // PlexHistoryEntry.accountID in integrations/plex/types.ts), so it is bounded by
  // unique users rather than play count. syncUsers() confirms those numeric ids before
  // this runs; a not-yet-confirmed account simply matches no row and is picked up by a
  // later sync.
  const maxViewedAtByAccount = new Map<number, UserHistoryMaximum>();

  for await (const page of plex.libraryHistory(lib.key)) {
    const pageMaxViewedAt = new Map<string, number>();
    const pageActivity = new Map<string, {
      accountId: number;
      localAccountId: number;
      ratingKey: string;
      firstViewedAt: number;
      lastViewedAt: number;
    }>();
    const pageSeasonActivity = new Map<string, {
      accountId: number;
      localAccountId: number;
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
        const accountId = localToGlobal.get(entry.accountID);
        if (accountId) {
          const currentMaximum = maxViewedAtByAccount.get(entry.accountID);
          if (!currentMaximum || entry.viewedAt > currentMaximum.viewedAt) {
            maxViewedAtByAccount.set(entry.accountID, {
              accountId,
              localAccountId: entry.accountID,
              viewedAt: entry.viewedAt,
            });
          }
        }
        if (accountId && key) {
          const pairKey = `${accountId}:${key}`;
          const current = pageActivity.get(pairKey);
          if (!current) {
            pageActivity.set(pairKey, {
              accountId,
              localAccountId: entry.accountID,
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
                localAccountId: entry.accountID,
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
        // A different library sync can reconcile identities while this long history
        // walk is in flight. Re-check the exact mapping inside the write transaction:
        // activity written before a mapping change is cleared by reconciliation, and
        // activity reaching this point afterward is skipped instead of resurrected.
        const mappingStmt = client.prepare(
          `SELECT 1 FROM users
           WHERE server_id = ? AND account_id = ? AND local_account_id = ?`,
        );
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
          if (!mappingStmt.get(serverId, activity.accountId, activity.localAccountId)) continue;
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
          if (!mappingStmt.get(serverId, activity.accountId, activity.localAccountId)) continue;
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
        mappingStmt.finalize();
      });
    }
  }

  // Item maxima were already applied page-by-page; finish the roster-level aggregate.
  // Re-check the exact mapping in the write transaction, just like the page-level
  // activity writes above. A reconciliation that cleared or reassigned a local id while
  // this history walk was running must not resurrect or transfer the old attribution.
  if (maxViewedAtByAccount.size > 0) {
    withTransaction((client) =>
      applyUserHistoryMaxima(client, serverId, maxViewedAtByAccount.values())
    );
  }
}
