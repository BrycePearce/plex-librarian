import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import { users } from '../../db/schema.ts';
import type { PlexClient, PlexLibrary } from '../../integrations/plex/index.ts';

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

  // Build ratingKey → max(viewedAt) across all users and all pages before writing.
  // The map is bounded by unique items in the library (not total play count).
  const maxViewedAt = new Map<string, number>();
  // Same idea, keyed by the history entry's PMS-LOCAL accountID (see
  // PlexHistoryEntry.accountID in integrations/plex/types.ts) — bounded by unique users, not play count.
  // Written to users.last_viewed_at via local_account_id, which syncUsers() is expected
  // to have already reconciled for every currently-known local account by the time this
  // runs (see runSync's call ordering) — an entry for a not-yet-reconciled account
  // simply matches zero rows below and is picked up on the next sync instead.
  const maxViewedAtByAccount = new Map<number, number>();

  for await (const page of plex.libraryHistory(lib.key)) {
    const pageActivity = new Map<string, {
      accountId: number;
      ratingKey: string;
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
        const cur = maxViewedAt.get(key);
        if (!cur || entry.viewedAt > cur) maxViewedAt.set(key, entry.viewedAt);
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
        }
      }
    }

    // Write each history page immediately. Replaying a full sync is idempotent because
    // first/last timestamps use min/max rather than accumulating play counts.
    if (pageActivity.size > 0) {
      withTransaction((client) => {
        const stmt = client.prepare(
          `INSERT INTO user_item_activity
             (server_id, account_id, rating_key, first_viewed_at, last_viewed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(server_id, account_id, rating_key) DO UPDATE SET
             first_viewed_at = min(first_viewed_at, excluded.first_viewed_at),
             last_viewed_at = max(last_viewed_at, excluded.last_viewed_at)`,
        );
        for (const activity of pageActivity.values()) {
          stmt.run(
            serverId,
            activity.accountId,
            activity.ratingKey,
            activity.firstViewedAt,
            activity.lastViewedAt,
          );
        }
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

  // Both UPDATEs run in the same transaction — one commit instead of two, so a crash
  // mid-sync can't leave item-level and per-account history backfills inconsistent
  // with each other.
  if (maxViewedAt.size > 0 || maxViewedAtByAccount.size > 0) {
    withTransaction((client) => {
      if (maxViewedAt.size > 0) {
        const stmt = client.prepare(
          `UPDATE items SET last_viewed_at = ?
           WHERE server_id = ? AND rating_key = ? AND library_key = ?
             AND (last_viewed_at IS NULL OR last_viewed_at < ?)`,
        );
        for (const [ratingKey, viewedAt] of maxViewedAt) {
          stmt.run(viewedAt, serverId, ratingKey, lib.key, viewedAt);
        }
      }

      if (maxViewedAtByAccount.size > 0) {
        const stmt = client.prepare(
          `UPDATE users SET last_viewed_at = ?
           WHERE server_id = ? AND local_account_id = ?
             AND (last_viewed_at IS NULL OR last_viewed_at < ?)`,
        );
        for (const [localAccountId, viewedAt] of maxViewedAtByAccount) {
          if (ambiguousLocalIds!.has(localAccountId)) continue;
          stmt.run(viewedAt, serverId, localAccountId, viewedAt);
        }
      }
    });
  }
}
