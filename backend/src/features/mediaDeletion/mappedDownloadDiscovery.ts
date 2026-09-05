import type {
  DiscoveredDownloadJobs,
  DownloadClientTarget,
  DownloadJob,
  DownloadJobSummary,
} from './downloadClient.ts';
import { createHash } from 'node:crypto';
import { normalizeRemoteAbsolute } from './hardlinks.ts';
import { appendRemotePath } from './ownership.ts';
import { createLocalPathIdentityResolver, identityContains } from './localPathIdentity.ts';

type Resolver = Awaited<ReturnType<typeof createLocalPathIdentityResolver>>;

function localKey(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized;
}

function mappedRemotePath(path: string, target: DownloadClientTarget): string {
  const content = normalizeRemoteAbsolute(path);
  if (!content) throw new Error(`${target.instanceName}: invalid live content path`);
  const mappings = (target.pathMappings ?? []).flatMap((mapping) => {
    const root = normalizeRemoteAbsolute(mapping.qbittorrentPath);
    if (!root || root.separator !== content.separator) return [];
    const value = mapping.caseSensitive ? content.path : content.path.toLowerCase();
    const prefix = mapping.caseSensitive ? root.path : root.path.toLowerCase();
    if (value !== prefix && !value.startsWith(`${prefix}${root.separator}`)) return [];
    const relative = content.path.slice(root.path.length).replace(/^[\\/]+/, '').replaceAll(
      '\\',
      '/',
    );
    return [localKey(`${mapping.localPath}/${relative}`)];
  });
  if (mappings.length !== 1) {
    throw new Error(
      `${target.instanceName}: Could not verify its live download path ${path}. Verify that qBittorrent path mapping in Settings → Media connections`,
    );
  }
  return mappings[0]!;
}

export async function localDownloadJobOwnedPaths(
  job: DownloadJob,
  entry: { path: string; directory?: boolean },
  target: DownloadClientTarget,
  resolveIdentity?: Resolver,
  exact = false,
): Promise<string[]> {
  const resolver = resolveIdentity ?? await createLocalPathIdentityResolver();
  const expected = await resolver(entry.path);
  const paths = [
    job.contentPath,
    ...job.manifestFiles.flatMap((file) => {
      const path = appendRemotePath(job.savePath, file.path);
      return path ? [path] : [];
    }),
  ];
  const owned: string[] = [];
  for (const path of new Set(paths)) {
    const local = await resolver(mappedRemotePath(path, target));
    if (
      (exact ? local.entry === expected.entry : local.possibleEntry === expected.possibleEntry) ||
      (entry.directory === true && identityContains(expected, local))
    ) owned.push(path);
  }
  return owned;
}

async function scan(
  target: DownloadClientTarget,
  visit: (summary: DownloadJobSummary) => Promise<void>,
): Promise<string> {
  if (target.client.scanJobSummaries) return await target.client.scanJobSummaries(visit);
  if (!target.client.listJobSummaries) {
    throw new Error(`${target.instanceName}: complete live ownership inspection is unavailable`);
  }
  const summaries = await target.client.listJobSummaries();
  const fingerprint = createHash('sha256');
  for (
    const { id, contentPath, savePath, size } of summaries.sort((a, b) => a.id.localeCompare(b.id))
  ) {
    const summary = { id, contentPath, savePath, size };
    fingerprint.update(JSON.stringify(summary) + '\n');
    await visit(summary);
  }
  return fingerprint.digest('hex');
}

/** Inspect QB's actual storage, not hypothetical QB equivalents of every library path.
 * Every live content path must map; only intersecting jobs need manifest reads.
 */
export async function discoverMappedDownloadJobs(
  target: DownloadClientTarget,
  paths: readonly { path: string; directory?: boolean; verifiedRoot?: string }[],
  resolveIdentity?: Resolver,
  requireExisting = false,
): Promise<DiscoveredDownloadJobs> {
  if (!target.client.discoverJobs) {
    throw new Error(`${target.instanceName}: complete live ownership inspection is unavailable`);
  }
  const resolver = resolveIdentity ?? await createLocalPathIdentityResolver();
  const selected = await Promise.all(
    paths.map(async (entry) => {
      // Only reconciliation of already-authorized removals supplies a root.
      // Historical proofs have their own durable existence/survivor checks.
      if (requireExisting && entry.verifiedRoot) await resolver(entry.verifiedRoot, true);
      return {
        ...entry,
        identity: await resolver(entry.path, requireExisting && !entry.verifiedRoot),
      };
    }),
  );
  const relevant: DownloadJobSummary[] = [];
  const first = await scan(target, async (summary) => {
    const mapped = await resolver(mappedRemotePath(summary.contentPath, target));
    if (
      selected.some((entry) =>
        identityContains(mapped, entry.identity) ||
        (entry.directory && identityContains(entry.identity, mapped))
      )
    ) {
      if (relevant.length >= 500) throw new Error('Too many intersecting qBittorrent jobs');
      relevant.push(summary);
    }
  });
  // Include a folder only when QB actually has a mapped job intersecting it.
  // Content roots also cover deletions of a parent folder outside the mapped prefix.
  const candidates = relevant.map((summary) => ({
    path: summary.contentPath,
    caseSensitive: true,
    directory: true,
  }));
  const discovery = candidates.length > 0
    ? await target.client.discoverJobs(candidates)
    : { jobs: [], summaryFingerprint: '' };
  const second = await scan(target, () => Promise.resolve());
  if (first !== second) {
    throw new Error(`${target.instanceName}: live downloads changed during ownership inspection`);
  }
  return {
    jobs: discovery.jobs,
    summaryFingerprint: first,
  };
}
