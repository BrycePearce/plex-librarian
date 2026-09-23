import { posix } from 'node:path';
import type { HistoricalAccessStatus } from '../../../../shared/historicalDownloads.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { DownloadClientTarget, DownloadJob, DownloadJobSummary } from './downloadClient.ts';
import type { HistoricalImport } from '../../integrations/arr/historicalImports.ts';

export interface HistoricalQbMapping {
  remote: string;
  local: string;
  explicit?: boolean;
}
/** Shared only within one collection/checkpoint, never across fresh ownership checks. */
export type HistoricalQbWitnessCache = Map<string, {
  imports: Map<string, Promise<HistoricalImport[]>>;
  recentIds?: Promise<Set<string>>;
}>;
/** Translation witnesses do not need filesystem/unlink eligibility. */
export interface HistoricalTranslationContext {
  accessId: string;
  accessRevision: string;
  lineage: { imports: HistoricalImport[] };
  contexts?: HistoricalTranslationContext[];
}
const beneath = (path: string, root: string) => path === root || path.startsWith(root + '/');
const safe = (path: string) =>
  path.startsWith('/') && path !== '/' &&
  // deno-lint-ignore no-control-regex -- Reject control characters in remote paths.
  !path.includes('\\') && !/[\x00-\x1f]/.test(path) &&
  path.split('/').slice(1).every((p) => p !== '.' && p !== '..' && p !== '');

/** Phase-local evidence only. Never turns inference into a user-confirmed mapping.
 * Endpoint identity + Arr's declared host-scoped translation is authoritative.
 * Without that declaration, require a live matching hash and exact import path.
 */
export async function historicalQbTranslations(
  target: DownloadClientTarget,
  arr: readonly ArrDeleteTarget[],
  access: readonly HistoricalAccessStatus[],
  candidates: readonly HistoricalTranslationContext[],
  summaries: readonly DownloadJobSummary[],
  manifests: Map<string, DownloadJob>,
  witnesses: HistoricalQbWitnessCache = new Map(),
): Promise<HistoricalQbMapping[]> {
  const explicit = (target.pathMappings ?? []).map((m) => ({
    remote: m.qbittorrentPath,
    local: m.localPath,
    explicit: true,
  }));
  if (
    !candidates.length ||
    summaries.every((s) => explicit.some((m) => beneath(s.savePath, m.remote)))
  ) return explicit;
  if (!target.instanceUrl || target.provider !== 'qbittorrent') return explicit;
  const endpoint = new URL(target.instanceUrl);
  // A loopback hostname in two containers does not identify the same service.
  if (
    ['localhost', '::1', '[::1]', '0.0.0.0'].includes(endpoint.hostname) ||
    endpoint.hostname.startsWith('127.')
  ) return explicit;
  const inferred: HistoricalQbMapping[] = [];
  let manifestFiles = 0;
  for (const service of arr) {
    const roots = access.filter((a) =>
      a.instanceId === service.instanceId &&
      a.configuration.enabled && a.status === 'available' &&
      candidates.some((c) =>
        (c.contexts ?? [c]).some((o) => o.accessId === a.id && o.accessRevision === a.revision)
      )
    );
    if (!roots.length) continue;
    if (!(await service.client.qbittorrentEndpoints()).includes(endpoint.href.replace(/\/$/, ''))) {
      continue;
    }
    const hints = (await service.client.remotePathHints(true)).filter((h) =>
      h.host.toLowerCase() === endpoint.hostname.toLowerCase()
    ).map((h) => ({
      ...h,
      remotePath: h.remotePath.replace(/\/+$/, ''),
      localPath: h.localPath.replace(/\/+$/, ''),
    }));
    // Per service/QB pair and phase, shared across configured roots. We need one
    // positive live import witness, not a library scan or a surviving selected job.
    const pair = `${service.instanceId}:${target.instanceKey}`;
    const witness = witnesses.get(pair) ??
      { imports: new Map<string, Promise<HistoricalImport[]>>() };
    witnesses.set(pair, witness);
    let recentIds: Set<string> | undefined;
    for (const a of hints) {
      for (const b of hints) {
        if (
          beneath(a.remotePath, b.remotePath) &&
          a.localPath !== b.localPath + a.remotePath.slice(b.remotePath.length)
        ) {
          throw new Error(
            'Conflicting Arr remote path mappings for the configured qBittorrent host',
          );
        }
      }
    }
    for (const root of roots) {
      const { remoteRoot, localRoot } = root.configuration;
      if (!safe(remoteRoot)) continue;
      for (const hint of hints) {
        const remote = hint.remotePath.replace(/\/+$/, '');
        const local = hint.localPath.replace(/\/+$/, '');
        if (!safe(remote) || !safe(local)) {
          throw new Error('Arr download path mapping is unsafe');
        }
        if (beneath(local, remoteRoot)) {
          inferred.push({ remote, local: localRoot + local.slice(remoteRoot.length) });
        } else if (beneath(remoteRoot, local)) {
          inferred.push({ remote: remote + remoteRoot.slice(local.length), local: localRoot });
        }
      }
      // A declared mapping affecting this root precludes an implicit identity mapping.
      if (
        hints.some((h) =>
          beneath(remoteRoot, h.localPath.replace(/\/+$/, '')) ||
          beneath(h.localPath.replace(/\/+$/, ''), remoteRoot) ||
          beneath(remoteRoot, h.remotePath.replace(/\/+$/, '')) ||
          beneath(h.remotePath.replace(/\/+$/, ''), remoteRoot)
        )
      ) continue;
      const imports = candidates.flatMap((c) =>
        (c.contexts ?? [c])
          .filter((o) => o.accessId === root.id).flatMap((o) => o.lineage.imports)
      );
      const byId = new Map<string, typeof imports>();
      for (const record of imports) {
        if (!record.downloadId) continue;
        const id = record.downloadId.toLowerCase();
        const group = byId.get(id) ?? [];
        group.push(record);
        byId.set(id, group);
      }
      // Prefer known Arr imports so unrelated movie jobs cannot consume the
      // entire targeted-read budget. The recent page is only an ordering hint;
      // every candidate still needs fresh ID-filtered history and its manifest.
      if (
        !summaries.some((s) => byId.has(s.id.toLowerCase())) &&
        summaries.some((s) =>
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(s.id) &&
          (beneath(s.savePath, remoteRoot) || beneath(s.contentPath, remoteRoot))
        )
      ) {
        witness.recentIds ??= service.client.recentImportedDownloadIds().then((ids) =>
          new Set(ids)
        );
        recentIds = await witness.recentIds;
      }
      const priority = (s: DownloadJobSummary) =>
        byId.has(s.id.toLowerCase()) ? 0 : recentIds?.has(s.id.toLowerCase()) ? 1 : 2;
      for (const summary of [...summaries].sort((a, b) => priority(a) - priority(b))) {
        const hash = summary.id.toLowerCase();
        let records = byId.get(hash) ?? [];
        if (
          !records.length &&
          (beneath(summary.savePath, remoteRoot) || beneath(summary.contentPath, remoteRoot)) &&
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)
        ) {
          if (!witness.imports.has(hash) && witness.imports.size < 20) {
            witness.imports.set(hash, service.client.historicalImportsForDownload(hash));
          }
          records = await witness.imports.get(hash) ?? [];
        }
        records = records.filter((r) => beneath(r.droppedPath, remoteRoot));
        if (!records.length) continue;
        const key = `${target.instanceKey}:${summary.id}`;
        const job = manifests.get(key) ?? await target.client.findJob(summary.id);
        if (
          !job || job.id.toLowerCase() !== summary.id.toLowerCase() ||
          job.savePath !== summary.savePath ||
          job.filesTruncated || job.fileCount !== job.manifestFiles.length ||
          job.fileCount > 100_000
        ) throw new Error('Translation evidence changed or is incomplete');
        manifestFiles += job.fileCount;
        if (manifestFiles > 100_000) {
          throw new Error('Translation manifests exceed the evidence budget');
        }
        manifests.set(key, job);
        const exactFiles = new Set(
          job.manifestFiles.filter((f) => f.path && !f.path.startsWith('/') && safe('/' + f.path))
            .map((f) => posix.join(job.savePath, f.path)),
        );
        if (
          records.every((r) =>
            r.downloadId?.toLowerCase() === hash &&
            exactFiles.has(r.droppedPath)
          )
        ) {
          inferred.push({ remote: remoteRoot, local: localRoot });
          break;
        }
      }
    }
  }
  // Explicit applicable translations win, including more-specific configured roots.
  const derived = inferred.filter((m) => !explicit.some((e) => beneath(m.remote, e.remote)));
  for (const a of derived) {
    for (const b of derived) {
      if (beneath(a.remote, b.remote) && a.local !== b.local + a.remote.slice(b.remote.length)) {
        throw new Error(
          'Conflicting Arr evidence for the qBittorrent download folder; review Media connections and Arr remote path mappings',
        );
      }
    }
  }
  return [
    ...explicit,
    ...derived.filter((m, i) =>
      derived.findIndex((n) => n.remote === m.remote && n.local === m.local) === i
    ),
  ];
}
