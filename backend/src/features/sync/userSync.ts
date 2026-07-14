import { and, eq, lt, sql } from 'drizzle-orm';
import { sqliteWriteBatches } from '../../db/batch.ts';
import { db } from '../../db/index.ts';
import { servers, users } from '../../db/schema.ts';
import { fetchServerRoster } from '../../integrations/plex/accounts.ts';
import { getActiveServer, type PlexClient } from '../../integrations/plex/index.ts';

const excl = (column: { name: string }) => sql.raw(`excluded.${column.name}`);

// Below this, a roster refresh that just ran is considered fresh enough to skip —
// covers back-to-back per-library resyncs of the same server, which each call syncUsers
// but have nothing new to reconcile seconds apart.
const USERS_SYNC_STALENESS_WINDOW_SEC = 60;
// Dedupes concurrent syncUsers() calls for the same server onto a single in-flight
// execution. Two per-library resyncs on the same server are NOT mutually exclusive
// (manager.ts's conflict check only blocks same-library or full-sync collisions), so
// without this, independent concurrent calls would race: each resets usersSyncedAt to
// null, fetches its own roster snapshot, and upserts/prunes with its own `now` — whichever
// commits last can regress usersSyncedAt backward or resurrect a row the other call had
// just correctly pruned.
const syncUsersInFlight = new Map<number, Promise<void>>();

// Refreshes the per-server user roster (owner + friends/Home members actually shared to
// this server) and reconciles each against the PMS's own local account ids so
// webhook/history activity (which reports local ids) can be joined to the roster (which
// is keyed by global plex.tv ids) — see users.localAccountId in schema.ts. Swallows all
// failures: a roster-fetch failure (network blip, token-scope issue) must never fail the
// library sync it's bundled into, same philosophy as logEvents. Called once per server
// from both runSync() (before the per-library worker pool starts) and runLibrarySync()
// (before its single syncLibrary call), so any sync pass — full or per-library — sees
// already-reconciled local ids by the time its own syncLibraryHistory call runs.
export function syncUsers(plex: PlexClient, serverId: number, now: number): Promise<void> {
  const existing = syncUsersInFlight.get(serverId);
  if (existing) return existing;
  const promise = syncUsersOnce(plex, serverId, now).finally(() => {
    syncUsersInFlight.delete(serverId);
  });
  syncUsersInFlight.set(serverId, promise);
  return promise;
}

async function syncUsersOnce(plex: PlexClient, serverId: number, now: number): Promise<void> {
  try {
    const active = await getActiveServer();
    // A server switch raced this sync — bail rather than write another server's roster
    // under this serverId. Self-heals: the next sync resolves against whatever server is
    // active by then.
    if (!active || active.serverId !== serverId) return;

    const [server] = await db.select({ usersSyncedAt: servers.usersSyncedAt })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (
      server?.usersSyncedAt != null &&
      now - server.usersSyncedAt < USERS_SYNC_STALENESS_WINDOW_SEC
    ) {
      return;
    }

    await db.update(servers).set({ usersSyncedAt: null }).where(eq(servers.id, serverId));

    const roster = await fetchServerRoster(
      active.clientId,
      active.accessToken,
      active.machineIdentifier,
    );
    // The PMS's own /accounts endpoint is a separate, less reliable source than plex.tv
    // (the PMS itself can be mid-restart while plex.tv is fine) — tolerate its failure
    // rather than discarding an already-successful roster fetch. Local ids simply stay
    // unreconciled this cycle and self-heal on the next successful sync or webhook.
    let localAccounts: Awaited<ReturnType<typeof plex.localAccounts>> = [];
    try {
      localAccounts = await plex.localAccounts();
    } catch (err) {
      console.error(
        `syncUsers: failed to fetch local accounts for server ${serverId}, skipping local id reconciliation this cycle:`,
        err,
      );
    }
    // Ambiguous names (two PMS-local accounts sharing one) are dropped rather than
    // letting the later one silently win — an unresolvable match should behave the
    // same as no match, not a coin flip between two real accounts.
    const localIdByUsername = new Map<string, number>();
    const ambiguousUsernames = new Set<string>();
    for (const a of localAccounts) {
      if (localIdByUsername.has(a.name)) {
        ambiguousUsernames.add(a.name);
      } else {
        localIdByUsername.set(a.name, a.id);
      }
    }

    if (roster.length > 0) {
      for (const batch of sqliteWriteBatches(roster)) {
        await db.insert(users)
          .values(
            batch.map((u) => ({
              serverId,
              accountId: u.accountId,
              // The PMS's local account id 1 is always the server owner (see
              // PlexLocalAccount in integrations/plex/types.ts) — resolved directly rather than through
              // username matching, which is fragile if the owner's plex.tv username
              // differs from the display name the PMS's own /accounts reports for them.
              localAccountId: u.isOwner
                ? 1
                : ambiguousUsernames.has(u.username)
                ? null
                : localIdByUsername.get(u.username) ?? null,
              username: u.username,
              email: u.email,
              thumb: u.thumb,
              isOwner: u.isOwner,
              sharedServerId: u.sharedServerId,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [users.serverId, users.accountId],
            set: {
              // A null resolved id this cycle (no /accounts match this time, or an
              // ambiguous name) must not erase a localAccountId already reconciled by
              // an earlier sync or self-healed by a webhook — only overwrite when this
              // sync actually resolved a value.
              localAccountId: sql`coalesce(${excl(users.localAccountId)}, ${users.localAccountId})`,
              username: excl(users.username),
              email: excl(users.email),
              thumb: excl(users.thumb),
              isOwner: excl(users.isOwner),
              sharedServerId: excl(users.sharedServerId),
              updatedAt: excl(users.updatedAt),
            },
          });
      }
      // Accounts no longer in the roster (access revoked, friendship removed) — hard
      // delete matches every other table's prune-on-full-sync pattern (items/libraries/
      // seasons). No data loss risk: lastViewedAt rebuilds itself from full history on
      // re-add, same as items.
      await db.delete(users).where(and(eq(users.serverId, serverId), lt(users.updatedAt, now)));
    }

    await db.update(servers).set({ usersSyncedAt: now }).where(eq(servers.id, serverId));
  } catch (err) {
    console.error(`syncUsers failed for server ${serverId}:`, err);
  }
}
