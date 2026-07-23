import type { PlexRosterUser } from '../../integrations/plex/accounts.ts';
import type { PlexLocalAccount } from '../../integrations/plex/index.ts';

// Plex uses the plex.tv/Home user id as the PMS SystemAccount/history accountID for
// non-owners. The server owner is deliberately stored as local id 1 so ownership can
// move between Plex accounts without losing the server-admin watch state.
//
// PlexAPI follows the same rule directly:
// https://github.com/pushingkarmaorg/python-plexapi/blob/610ffc354e8f705babba0b8c058a1c1c9aab9f9d/plexapi/myplex.py#L891-L903
// https://github.com/pushingkarmaorg/python-plexapi/blob/610ffc354e8f705babba0b8c058a1c1c9aab9f9d/plexapi/myplex.py#L1350-L1417
// Plex confirmed the owner's id=1 exception is intentional:
// https://forums.plex.tv/t/webhook-account-id-property-for-server-owners-always-set-to-1/746551
export function resolveRosterLocalAccountIds(
  roster: PlexRosterUser[],
  accounts: PlexLocalAccount[],
): Map<number, number | null> {
  const knownLocalIds = new Set(accounts.map((account) => account.id));
  const result = new Map<number, number | null>();
  for (const user of roster) {
    if (user.isOwner) {
      result.set(user.accountId, 1);
      continue;
    }
    result.set(
      user.accountId,
      user.accountId !== 1 && knownLocalIds.has(user.accountId) ? user.accountId : null,
    );
  }
  return result;
}

export function reconciledLocalAccountId(
  previous: number | null | undefined,
  resolved: number | null,
  coverageComplete: boolean,
): number | null {
  return coverageComplete ? resolved : resolved ?? previous ?? null;
}

export function mappingRequiresActivityInvalidation(
  previous: number | null | undefined,
  next: number | null,
): boolean {
  return previous != null && previous !== next;
}
