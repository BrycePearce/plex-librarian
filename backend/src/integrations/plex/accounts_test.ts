import { assertRejects } from '@std/assert';
import {
  fetchServerRoster,
  parsePendingInvitationsXml,
  resolvePendingInvitationServer,
} from './accounts.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test('pending invitations are scoped by server name and sorted oldest first', () => {
  const result = parsePendingInvitationsXml(
    `<MediaContainer>
      <Invite id="2" username="newer" email="newer@example.com" server="1"
        createdAt="2026-07-01T00:00:00Z"><Server name="Main" numLibraries="3"/></Invite>
      <Invite id="1" friendlyName="older" server="1"
        createdAt="1767225600"><Server name="Main" numLibraries="2"/></Invite>
      <Invite id="3" username="other" server="1"
        createdAt="2025-01-01T00:00:00Z"><Server name="Other" numLibraries="1"/></Invite>
    </MediaContainer>`,
    'Main',
  );
  assert(result.length === 2, 'only invitations for the active server should be returned');
  assert(result[0].inviteId === 1 && result[1].inviteId === 2, 'oldest should sort first');
  assert(result[0].username === 'older', 'friendlyName should be the username fallback');
  assert(result[1].libraryCount === 3, 'library count should be parsed');
});

Deno.test('server resolution refuses duplicate owned server names', () => {
  const resources = [
    { name: 'Main', provides: 'server', owned: true, clientIdentifier: 'active' },
    { name: 'Main', provides: 'server', owned: true, clientIdentifier: 'other' },
  ];
  assert(
    resolvePendingInvitationServer(resources, 'active').serverMatch === 'ambiguous',
    'duplicate names must not be guessed',
  );
});

Deno.test('server resolution ignores unowned and non-server resources', () => {
  const resources = [
    { name: 'Main', provides: 'server', owned: true, clientIdentifier: 'active' },
    { name: 'Main', provides: 'server', owned: false, clientIdentifier: 'shared' },
    { name: 'Main', provides: 'client', owned: true, clientIdentifier: 'client' },
  ];
  const result = resolvePendingInvitationServer(resources, 'active');
  assert(result.serverMatch === 'matched' && result.serverName === 'Main', 'match should be safe');
});

async function withRosterResponses(
  owner: unknown,
  friendsXml: string,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(
      String(input).includes('/api/v2/user')
        ? Response.json(owner)
        : new Response(friendsXml, { status: 200 }),
    )) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test('roster rejects a malformed owner account id', async () => {
  await withRosterResponses(
    { id: -1, username: 'owner' },
    '<MediaContainer size="0"/>',
    async () => {
      await assertRejects(
        () => fetchServerRoster('client', 'token', 'machine'),
        Error,
        'owner profile contained an invalid account id',
      );
    },
  );
});

Deno.test('roster rejects a malformed target-server friend instead of pruning it', async () => {
  await withRosterResponses(
    { id: 700, username: 'owner' },
    `<MediaContainer size="1">
      <User id="not-a-number" username="friend">
        <Server id="12" machineIdentifier="machine"/>
      </User>
    </MediaContainer>`,
    async () => {
      await assertRejects(
        () => fetchServerRoster('client', 'token', 'machine'),
        Error,
        'friends response contained an invalid account id',
      );
    },
  );
});

Deno.test('roster rejects an incomplete declared account collection', async () => {
  await withRosterResponses(
    { id: 700, username: 'owner' },
    `<MediaContainer size="2">
      <User id="701" username="friend">
        <Server id="12" machineIdentifier="machine"/>
      </User>
    </MediaContainer>`,
    async () => {
      await assertRejects(
        () => fetchServerRoster('client', 'token', 'machine'),
        Error,
        'incomplete account collection',
      );
    },
  );
});

Deno.test('roster rejects a structurally truncated account collection', async () => {
  await withRosterResponses(
    { id: 700, username: 'owner' },
    `<MediaContainer size="1">
      <User id="701" username="friend">
        <Server id="12" machineIdentifier="machine"/>
      </User>`,
    async () => {
      await assertRejects(
        () => fetchServerRoster('client', 'token', 'machine'),
        Error,
        'incomplete account collection',
      );
    },
  );
});

Deno.test('roster rejects duplicate target-server account ids', async () => {
  await withRosterResponses(
    { id: 700, username: 'owner' },
    `<MediaContainer size="2">
      <User id="701" username="first">
        <Server id="12" machineIdentifier="machine"/>
      </User>
      <User id="701" username="conflicting">
        <Server id="13" machineIdentifier="machine"/>
      </User>
    </MediaContainer>`,
    async () => {
      await assertRejects(
        () => fetchServerRoster('client', 'token', 'machine'),
        Error,
        'duplicate account id',
      );
    },
  );
});
