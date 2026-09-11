/** Read-only feasibility prototype. Not imported by the application or an authorization API.
 * Accepts sanitized service-configuration fixtures; never reads credentials or live settings.
 * Returns explicit, uniquely matched translation candidates, NOT storage authority.
 * Plex notification settings describe scan destinations, which can be separate copies.
 */
import { storageContains, storagePath } from '../shared/serviceStorage.ts';

export interface ConnectionRecord {
  implementation: string;
  fields: Array<{ name: string; value: unknown }>;
}
export interface ConnectionSnapshot {
  plexUrl: string;
  qbUrl: string;
  notifications: ConnectionRecord[];
  downloadClients: ConnectionRecord[];
  remoteMappings: Array<{ host: string; remotePath: string; localPath: string }>;
}

function fields(record: ConnectionRecord) {
  if (new Set(record.fields.map((f) => f.name)).size !== record.fields.length) return undefined;
  return Object.fromEntries(record.fields.map((f) => [f.name, f.value]));
}
function matches(record: ConnectionRecord, expected: string): boolean {
  const f = fields(record), url = new URL(expected);
  if (
    !f || typeof f.host !== 'string' || !Number.isInteger(f.port) || typeof f.useSsl !== 'boolean'
  ) return false;
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  return f.host.toLowerCase() === url.hostname.toLowerCase() &&
    f.port === Number(url.port || (url.protocol === 'https:' ? 443 : 80)) &&
    f.useSsl === (url.protocol === 'https:') &&
    String(f.urlBase ?? '').replace(/^\/+|\/+$/g, '') === url.pathname.replace(/^\/+|\/+$/g, '');
}

export function discoverCandidateTranslations(
  snapshot: ConnectionSnapshot,
  currentArrRoot: string,
  currentQbRoot: string,
) {
  const plexMatches = snapshot.notifications.filter((r) =>
    r.implementation === 'PlexServer' && matches(r, snapshot.plexUrl)
  );
  const qbMatches = snapshot.downloadClients.filter((r) =>
    r.implementation === 'QBittorrent' && matches(r, snapshot.qbUrl)
  );
  let plex: { arrPrefix: string; plexPrefix: string } | undefined;
  let qb: { arrPrefix: string; qbPrefix: string } | undefined;
  if (plexMatches.length === 1) {
    const f = fields(plexMatches[0])!;
    if (typeof f.mapFrom === 'string' && f.mapFrom && typeof f.mapTo === 'string' && f.mapTo) {
      const from = storagePath(f.mapFrom), to = storagePath(f.mapTo);
      if (storageContains(from, currentArrRoot)) plex = { arrPrefix: from, plexPrefix: to };
    }
  }
  if (qbMatches.length === 1) {
    const host = fields(qbMatches[0])!.host as string;
    const candidates = snapshot.remoteMappings.filter((r) =>
      r.host.toLowerCase() === host.toLowerCase() && storageContains(r.remotePath, currentQbRoot)
    );
    if (candidates.length === 1) {
      qb = {
        arrPrefix: storagePath(candidates[0].localPath),
        qbPrefix: storagePath(candidates[0].remotePath),
      };
    }
  }
  return { plex, qb };
}
