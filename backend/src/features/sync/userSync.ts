import { and, eq, sql } from 'drizzle-orm';
import { sqliteWriteBatches } from '../../db/batch.ts';
import { db, withTransaction } from '../../db/index.ts';
import { servers, users } from '../../db/schema.ts';
import { fetchServerRoster } from '../../integrations/plex/accounts.ts';
import { getActiveServer, type PlexClient } from '../../integrations/plex/index.ts';
import { reconciledLocalAccountId, resolveRosterLocalAccountIds } from './userIdentity.ts';
import { applyConfirmedIdentityMappings } from './userIdentityPersistence.ts';

const excl = (column: { name: string }) => sql.raw(`excluded.${column.name}`);

// Dedupes concurrent syncUsers() calls for the same server onto a single in-flight
// execution. The manager serializes user-triggered syncs per server, while this also
// protects direct callers from racing reconciliation.
const syncUsersInFlight = new Map<number, Promise<void>>();

// Refreshes the per-server user roster (owner + friends/Home members actually shared to
// this server) and confirms each against the PMS's SystemAccount ids so webhook/history
// activity can be joined to the roster while preserving the owner's local id=1 exception
// — see users.localAccountId in schema.ts. Swallows all
// failures: a roster-fetch failure (network blip, token-scope issue) must never fail the
// full sync it's bundled into, same philosophy as logEvents. Called once per server by
// runSync(), before the per-library worker pool starts, so every history walk in that
// generation sees the same already-reconciled local ids.
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
    let localAccountCoverageComplete = true;
    try {
      localAccounts = await plex.localAccounts();
    } catch (err) {
      localAccountCoverageComplete = false;
      console.error(
        `syncUsers: failed to fetch local accounts for server ${serverId}, skipping local id reconciliation this cycle:`,
        err,
      );
    }
    // PMS uses the roster's numeric account id directly for non-owners; names are
    // mutable display metadata and never participate in history attribution.
    const localAccountIds = resolveRosterLocalAccountIds(roster, localAccounts);
    const previousMappings = new Map(
      (await db.select({
        accountId: users.accountId,
        localAccountId: users.localAccountId,
      }).from(users).where(eq(users.serverId, serverId)))
        .map((user) => [user.accountId, user.localAccountId]),
    );
    const rosterAccountIds = new Set(roster.map((user) => user.accountId));
    const removedAccountIds = [...previousMappings.keys()].filter(
      (accountId) => !rosterAccountIds.has(accountId),
    );
    const nextMappings = new Map(
      roster.map((user) => {
        const resolved = localAccountIds.get(user.accountId) ?? null;
        return [
          user.accountId,
          reconciledLocalAccountId(
            previousMappings.get(user.accountId),
            resolved,
            localAccountCoverageComplete,
          ),
        ] as const;
      }),
    );

    if (roster.length > 0) {
      for (const batch of sqliteWriteBatches(roster)) {
        await db.insert(users)
          .values(
            batch.map((u) => ({
              serverId,
              accountId: u.accountId,
              // The PMS SystemAccount id equals accountId for non-owners. The owner is
              // always local id 1, regardless of the owner's plex.tv account id.
              localAccountId: nextMappings.get(u.accountId) ?? null,
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
              // Existing mappings are changed below in the same native transaction
              // that invalidates activity attributed through an obsolete mapping.
              username: excl(users.username),
              email: excl(users.email),
              thumb: excl(users.thumb),
              isOwner: excl(users.isOwner),
              sharedServerId: excl(users.sharedServerId),
              updatedAt: excl(users.updatedAt),
            },
          });
      }
      // Older releases could confirm a PMS id by mutable username. If authoritative
      // numeric reconciliation changes or clears that id, all activity attributed
      // through the obsolete mapping must fail closed as well. Keep invalidation and
      // publication of the replacement mapping atomic so live collectors see either
      // the old state (which is subsequently cleared) or the new state.
      withTransaction((client) => {
        applyConfirmedIdentityMappings(
          client,
          serverId,
          roster.flatMap((user) =>
            previousMappings.has(user.accountId)
              ? [{
                accountId: user.accountId,
                previous: previousMappings.get(user.accountId),
                next: nextMappings.get(user.accountId) ?? null,
              }]
              : []
          ),
        );
      });

      // Accounts no longer in the authoritative roster (access revoked, friendship
      // removed) are deleted by identity rather than an updatedAt generation marker.
      // Full syncs can legitimately finish within the same second, so timestamp pruning
      // could otherwise retain a removed account whose previous marker equals `now`.
      // Delete one bounded roster row at a time to avoid SQLite parameter limits.
      for (const accountId of removedAccountIds) {
        await db.delete(users).where(
          and(eq(users.serverId, serverId), eq(users.accountId, accountId)),
        );
      }
    }

    // The plex.tv roster is still useful when /accounts is temporarily unavailable, so
    // keep its upserts above. Do not publish complete identity coverage, though: history
    // entries use PMS SystemAccount ids and would otherwise be silently skipped and
    // classified as unwatched by request follow-through.
    if (localAccountCoverageComplete) {
      await db.update(servers).set({ usersSyncedAt: now }).where(eq(servers.id, serverId));
    }
  } catch (err) {
    console.error(`syncUsers failed for server ${serverId}:`, err);
  }
}
