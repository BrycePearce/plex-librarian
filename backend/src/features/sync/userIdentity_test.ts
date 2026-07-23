import { assertEquals } from '@std/assert';
import type { PlexRosterUser } from '../../integrations/plex/accounts.ts';
import type { PlexLocalAccount } from '../../integrations/plex/index.ts';
import {
  mappingRequiresActivityInvalidation,
  reconciledLocalAccountId,
  resolveRosterLocalAccountIds,
} from './userIdentity.ts';

function rosterUser(
  accountId: number,
  username: string,
  isOwner = false,
): PlexRosterUser {
  return {
    accountId,
    username,
    email: null,
    thumb: null,
    isOwner,
    sharedServerId: isOwner ? null : accountId,
  };
}

Deno.test('a non-owner resolves by numeric Plex account id even when names differ', () => {
  const roster = [rosterUser(700, 'global-username')];
  const accounts: PlexLocalAccount[] = [{ id: 700, name: 'Local display name' }];

  assertEquals(resolveRosterLocalAccountIds(roster, accounts).get(700), 700);
});

Deno.test('a roster user unknown to PMS remains unresolved', () => {
  const roster = [rosterUser(700, 'global-username')];
  const accounts: PlexLocalAccount[] = [{ id: 800, name: 'global-username' }];

  assertEquals(resolveRosterLocalAccountIds(roster, accounts).get(700), null);
});

Deno.test('matching titles never override different numeric identities', () => {
  const roster = [
    rosterUser(700, 'first'),
    rosterUser(800, 'second'),
  ];
  const accounts: PlexLocalAccount[] = [
    { id: 700, name: 'Shared title' },
    { id: 800, name: 'Shared title' },
  ];

  assertEquals(
    [...resolveRosterLocalAccountIds(roster, accounts).entries()],
    [[700, 700], [800, 800]],
  );
});

Deno.test('the server owner always resolves to PMS local id 1', () => {
  const roster = [rosterUser(123, 'owner', true)];

  assertEquals(resolveRosterLocalAccountIds(roster, []).get(123), 1);
});

Deno.test('a non-owner can never claim the reserved owner local id', () => {
  const roster = [rosterUser(1, 'not-owner')];
  const accounts: PlexLocalAccount[] = [{ id: 1, name: 'Owner' }];

  assertEquals(resolveRosterLocalAccountIds(roster, accounts).get(1), null);
});

Deno.test('a failed snapshot preserves only a previously confirmed mapping', () => {
  assertEquals(reconciledLocalAccountId(700, null, false), 700);
  assertEquals(reconciledLocalAccountId(null, null, false), null);
  assertEquals(reconciledLocalAccountId(undefined, null, false), null);
});

Deno.test('an authoritative snapshot can clear a stale mapping', () => {
  assertEquals(reconciledLocalAccountId(800, null, true), null);
  assertEquals(mappingRequiresActivityInvalidation(800, null), true);
});

Deno.test('establishing a previously unresolved mapping preserves direct activity', () => {
  assertEquals(reconciledLocalAccountId(null, 700, true), 700);
  assertEquals(mappingRequiresActivityInvalidation(null, 700), false);
});

Deno.test('changing a confirmed mapping invalidates old attribution', () => {
  assertEquals(mappingRequiresActivityInvalidation(800, 700), true);
  assertEquals(mappingRequiresActivityInvalidation(700, 700), false);
});
