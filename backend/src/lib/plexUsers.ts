import { buildPlexHeaders, PLEX_TV } from './plex.ts';

// The synthetic username assigned when Plex's friends XML gives us neither a username
// nor a title for an account (rare, but real — see parseFriendsXml/fetchServerRoster
// below). Multiple such accounts can legitimately collide on this exact string, so it
// must never be treated as an identifying value for matching purposes elsewhere (see
// webhook.ts's username-fallback resolution, which excludes it explicitly).
export const UNKNOWN_USERNAME_PLACEHOLDER = 'Plex user';

// One row per Plex account with access to a specific server — the roster returned by
// fetchServerRoster. Keyed by the GLOBAL plex.tv account id (see users.accountId in
// schema.ts for why: it's the only id guaranteed to exist for a user who has access but
// has never connected, which is exactly the case this feature needs to surface).
export interface PlexRosterUser {
  accountId: number;
  username: string;
  email: string | null;
  thumb: string | null;
  isOwner: boolean;
  // Plex's own id for this specific friend/server share (the nested <Server>'s own
  // `id` attribute, NOT accountId/machineIdentifier) — see users.sharedServerId in
  // schema.ts. Always null for the owner, who has no share to revoke.
  sharedServerId: number | null;
}

// Decodes the handful of XML entities that can legitimately appear in Plex's
// attribute values (usernames/emails are otherwise plain text). Not a general XML
// entity decoder — deliberately narrow, matching this module's narrow parsing scope.
function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (whole, ent: string) => {
    switch (ent) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

function parseAttrs(tagContents: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagContents))) {
    attrs[m[1]] = decodeXmlEntities(m[2]);
  }
  return attrs;
}

// Finds the <Server> child (of a <User> block) whose machineIdentifier matches ours,
// and returns its own `id` attribute — the per-share id needed to later revoke just
// this server's access (see users.sharedServerId in schema.ts). A friend can have
// <Server> entries for multiple servers if the owner has more than one; each carries
// its own distinct `id`, so this must match on machineIdentifier, not just take the
// first one.
function findSharedServerId(inner: string, machineIdentifier: string): number | null {
  // Matches both the self-closing form Plex is confirmed to emit today and a
  // open/close form, the same way userBlockRe below handles both <User> shapes —
  // an unmatched form here doesn't just lose the share id, it silently drops the
  // whole user from the roster (see the `continue` below), so it's worth being
  // permissive rather than assuming self-closing is the only shape Plex will ever send.
  const serverTagRe = /<Server\b([^>]*?)(?:\/>|>[\s\S]*?<\/Server>)/g;
  let m: RegExpExecArray | null;
  while ((m = serverTagRe.exec(inner))) {
    const attrs = parseAttrs(m[1]);
    if (attrs.machineIdentifier !== machineIdentifier) continue;
    const id = Number(attrs.id);
    return Number.isFinite(id) ? id : null;
  }
  return null;
}

// Plex's legacy plex.tv/api/users endpoint returns XML unconditionally, ignoring
// Accept: application/json (unlike /api/v2/user and the PMS's own endpoints, which do
// respect it) — confirmed empirically against a real account. Response shape is
// attribute-only, no mixed content:
//   <MediaContainer>
//     <User id=".." title=".." username=".." email=".." thumb="..">
//       <Server id=".." machineIdentifier=".." .../>   (one per server shared to them)
//     </User>
//   </MediaContainer>
// Filtering each <User>'s nested <Server> children to our own machineIdentifier gives
// the exact roster for this server directly — no separate shared_servers call needed.
function parseFriendsXml(xml: string, machineIdentifier: string): PlexRosterUser[] {
  const users: PlexRosterUser[] = [];
  const userBlockRe = /<User\b([^>]*?)(?:\/>|>([\s\S]*?)<\/User>)/g;
  let m: RegExpExecArray | null;
  while ((m = userBlockRe.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    const inner = m[2] ?? '';
    const sharedServerId = findSharedServerId(inner, machineIdentifier);
    if (sharedServerId === null) continue;

    const accountId = Number(attrs.id);
    if (!Number.isFinite(accountId)) continue;

    users.push({
      accountId,
      username: attrs.username || attrs.title || UNKNOWN_USERNAME_PLACEHOLDER,
      email: attrs.email || null,
      thumb: attrs.thumb || null,
      isOwner: false,
      sharedServerId,
    });
  }
  return users;
}

// Retries a plex.tv GET up to 3 times with exponential backoff on 429/5xx, mirroring
// PlexClient.get()'s retry behavior in plex.ts — that class is scoped to a single PMS
// server URL, so it isn't directly reusable here for plex.tv-wide calls. Without this,
// a transient plex.tv blip failed the entire roster sync outright, unlike every
// PMS-facing call path in this app.
async function fetchPlexTvWithRetry(url: string, headers: Record<string, string>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const base = 1000 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, base + Math.random() * base * 0.5));
    }
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') throw err;
      lastError = err;
      continue;
    }
    if (res.ok || (res.status !== 429 && res.status < 500)) return res;
    res.body?.cancel();
    lastError = new Error(`Plex ${res.status}: ${url}`);
  }
  throw lastError;
}

// Combines the owner's own profile with their friends/Home members who specifically
// have access to `machineIdentifier`, into a single per-server roster. Two plex.tv
// calls, no PMS calls — this is account-level data, not server-level. They're
// independent of each other (the owner's own id is only needed for the dedupe below,
// after both have already resolved), so they run concurrently. Throws on failure;
// callers (syncUsers) are expected to swallow errors so a roster-fetch failure never
// fails an entire sync, matching the "never let secondary enrichment fail the caller"
// precedent set by logEvents.
export async function fetchServerRoster(
  clientId: string,
  accessToken: string,
  machineIdentifier: string,
): Promise<PlexRosterUser[]> {
  const headers = buildPlexHeaders(clientId, accessToken);

  const [ownerRes, friendsRes] = await Promise.all([
    fetchPlexTvWithRetry(`${PLEX_TV}/api/v2/user`, headers),
    fetchPlexTvWithRetry(`${PLEX_TV}/api/users`, headers),
  ]);

  if (!ownerRes.ok) {
    ownerRes.body?.cancel();
    throw new Error(`Plex ${ownerRes.status} fetching owner profile`);
  }
  const owner = await ownerRes.json() as {
    id: number;
    username?: string;
    title?: string;
    email?: string;
    thumb?: string;
  };

  if (!friendsRes.ok) {
    friendsRes.body?.cancel();
    throw new Error(`Plex ${friendsRes.status} fetching friends list`);
  }
  const friends = parseFriendsXml(await friendsRes.text(), machineIdentifier);

  return [
    {
      accountId: owner.id,
      username: owner.username || owner.title || UNKNOWN_USERNAME_PLACEHOLDER,
      email: owner.email ?? null,
      thumb: owner.thumb ?? null,
      isOwner: true,
      sharedServerId: null,
    },
    // The owner's own account can legitimately show up in their friends list's XML
    // (e.g. as a Home member) — dedupe so they're never double-counted.
    ...friends.filter((f) => f.accountId !== owner.id),
  ];
}

// Revokes a friend's access to just THIS server — DELETE /api/servers/{machineIdentifier}
// /shared_servers/{sharedServerId}, not the "unfriend everywhere" endpoint
// (DELETE /api/v2/sharings/{userId}), which would also drop their access to any other
// server the owner has shared with them. Genuinely destructive and irreversible short of
// re-inviting them through Plex — callers must not retry this blindly. A 404 means Plex
// already has no record of this share (most likely removed already, e.g. by a previous
// request or directly in Plex) — callers should treat that as success, same precedent as
// PlexClient.deleteMedia's 404 handling in duplicates.ts.
export class PlexRemoveUserError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'PlexRemoveUserError';
  }
}

export async function removeUserAccess(
  clientId: string,
  accessToken: string,
  machineIdentifier: string,
  sharedServerId: number,
): Promise<void> {
  const res = await fetch(
    `${PLEX_TV}/api/servers/${machineIdentifier}/shared_servers/${sharedServerId}`,
    {
      method: 'DELETE',
      headers: buildPlexHeaders(clientId, accessToken),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    res.body?.cancel();
    throw new PlexRemoveUserError(
      res.status,
      `Plex ${res.status} removing shared server ${sharedServerId}`,
    );
  }
  res.body?.cancel();
}
