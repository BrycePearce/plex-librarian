import { isIP } from 'node:net';
import type { ServiceStorageEndpoint } from '../../../../shared/serviceStorage.ts';

export type DiscoveryAddresses = Record<string, string[]>;
const normalize = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '');

/** Resolve configured hosts, never decode an IP-looking hostname (including plex.direct).
 * No DNS cache: every dependent host refresh must notice changed/failed resolution.
 */
export async function resolveDiscoveryAddresses(
  endpoints: readonly ServiceStorageEndpoint[],
  knownAddresses: readonly string[],
  lookup: (hostname: string, type: 'A' | 'AAAA') => Promise<string[]> = (hostname, type) =>
    Deno.resolveDns(hostname, type, { signal: AbortSignal.timeout(3_000) }),
): Promise<DiscoveryAddresses> {
  const result: DiscoveryAddresses = {};
  const known = new Set(knownAddresses.map(normalize));
  const hosts = new Set(
    endpoints.filter((e) => e.supportedMedia !== false).map((e) =>
      normalize(e.connectionHost ?? '')
    ),
  );
  // At most two in-flight DNS requests; repeated Plex libraries reuse one answer.
  for (const hostname of hosts) {
    if (!hostname || isIP(hostname) || known.has(hostname) || hostname === 'localhost') continue;
    const answers = await Promise.allSettled([lookup(hostname, 'A'), lookup(hostname, 'AAAA')]);
    const failed = answers.some((answer) =>
      answer.status === 'rejected' && !(answer.reason instanceof Deno.errors.NotFound)
    );
    result[hostname] = failed
      ? []
      : [...new Set(answers.flatMap((answer) => answer.status === 'fulfilled' ? answer.value : []))]
        .sort();
    if (result[hostname].some((address) => !isIP(address)) || result[hostname].length > 100) {
      result[hostname] = [];
    }
  }
  return result;
}
