import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { plexPathMappings } from '../../db/schema.ts';
import type {
  DirectPlexPathEvidence,
  ResolvedCleanupItem,
  ResolvedDownloadJob,
} from '../mediaDeletion/cleanup.ts';
import {
  type DownloadClientTarget,
  type DownloadDiscoveryCandidate,
  type DownloadJob,
  downloadJobManifestFingerprint,
  downloadJobSummaryFingerprint,
} from '../mediaDeletion/downloadClient.ts';
import { appendRemotePath } from '../mediaDeletion/ownership.ts';
import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';
import { lstatChain, resolvePlexToLocal } from '../mediaDeletion/pathNamespace.ts';

export interface DirectDiscoverySelection {
  plexPath: string;
  size: number;
}

export interface DirectLocalIdentity {
  path: string;
  size: number;
  canonical: string;
  device: string;
  inode: string;
}

function within(path: string, root: string, caseSensitive: boolean): boolean {
  const candidate = caseSensitive ? path : path.toLocaleLowerCase('en-US');
  const prefix = caseSensitive ? root : root.toLocaleLowerCase('en-US');
  const separator = prefix.includes('\\') ? '\\' : '/';
  return candidate === prefix || candidate.startsWith(`${prefix}${separator}`);
}

function resolveDownloadPath(
  remotePath: string,
  mappings: NonNullable<DownloadClientTarget['pathMappings']>,
): string | null {
  const remote = normalizeRemoteAbsolute(remotePath);
  if (!remote) return null;
  const candidates = mappings.flatMap((mapping) => {
    const root = normalizeRemoteAbsolute(mapping.qbittorrentPath);
    if (
      !root || root.separator !== remote.separator ||
      !within(remote.path, root.path, mapping.caseSensitive)
    ) return [];
    const relative = remote.path.slice(root.path.length).replace(/^[\\/]+/, '')
      .replaceAll('\\', '/');
    return [`${mapping.localPath}${relative ? `/${relative}` : ''}`];
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

function normalizeLocal(path: string): string | null {
  const value = path.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (!value || (!value.startsWith('/') && !/^[A-Za-z]:\//.test(value))) return null;
  const parts = value.replace(/^[A-Za-z]:\//, '').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return value;
}

export function directDiscoveryCandidates(
  localPaths: readonly string[],
  mappings: NonNullable<DownloadClientTarget['pathMappings']>,
): DownloadDiscoveryCandidate[] {
  const candidates = localPaths.flatMap((localPath) => {
    const local = normalizeLocal(localPath);
    if (!local) return [];
    const matches = mappings.flatMap((mapping) => {
      const localRoot = normalizeLocal(mapping.localPath);
      const remoteRoot = normalizeRemoteAbsolute(mapping.qbittorrentPath);
      if (
        !localRoot || !remoteRoot ||
        !within(local, localRoot, Deno.build.os !== 'windows')
      ) return [];
      const relative = local.slice(localRoot.length).replace(/^\/+/, '');
      const path = relative
        ? `${remoteRoot.path}${remoteRoot.separator}${
          relative.replaceAll('/', remoteRoot.separator)
        }`
        : remoteRoot.path;
      return [{ path, caseSensitive: mapping.caseSensitive }];
    });
    if (matches.length > 1) {
      throw new Error('A selected Plex path has multiple qBittorrent namespace mappings');
    }
    return matches;
  });
  return [...new Map(candidates.map((candidate) => [
    `${candidate.caseSensitive}:${candidate.path}`,
    candidate,
  ])).values()];
}

async function exactLocalIdentity(path: string, size: number): Promise<DirectLocalIdentity> {
  const [info, canonical] = await Promise.all([lstatChain(path), Deno.realPath(path)]);
  if (
    !info.isFile || info.isSymlink || info.size !== size || info.dev === null || info.ino === null
  ) {
    throw new Error(
      'Direct qBittorrent path is missing, linked, or has no exact filesystem identity',
    );
  }
  return { path, size, canonical, device: String(info.dev), inode: String(info.ino) };
}

export function directManifestSelection(
  local: DirectLocalIdentity,
  selected: readonly { plexPath: string; local: DirectLocalIdentity }[],
  retained: readonly { plexPath: string; local: DirectLocalIdentity }[],
): { plexPath: string; local: DirectLocalIdentity } | null {
  const retainedConflict = retained.some((candidate) =>
    candidate.local.canonical === local.canonical ||
    candidate.local.device === local.device && candidate.local.inode === local.inode
  );
  if (retainedConflict) {
    throw new Error(
      'A qBittorrent payload aliases an unselected retained Plex version',
    );
  }
  return selected.find((candidate) =>
    candidate.local.canonical === local.canonical ||
    candidate.local.device === local.device && candidate.local.inode === local.inode &&
      candidate.local.size === local.size
  ) ?? null;
}

type DirectManifestMatch = { plexPath: string; local: DirectLocalIdentity };

export function completeDirectManifestSelection(
  localFiles: readonly (DirectLocalIdentity | null)[],
  selected: readonly DirectManifestMatch[],
  retained: readonly DirectManifestMatch[],
): DirectManifestMatch[] | null {
  const matched = localFiles.map((local) =>
    local === null ? null : directManifestSelection(local, selected, retained)
  );
  if (matched.every((candidate) => candidate === null)) return null;
  if (matched.some((candidate) => candidate === null)) {
    throw new Error(
      'A matching qBittorrent payload contains an unselected or unverifiable file',
    );
  }
  return matched as DirectManifestMatch[];
}

export function directManifestRemotePaths(job: DownloadJob): string[] {
  const content = normalizeRemoteAbsolute(job.contentPath);
  const save = normalizeRemoteAbsolute(job.savePath);
  if (
    !content || !save || job.manifestFiles.length === 0 ||
    job.fileCount !== job.manifestFiles.length ||
    job.manifestFiles.reduce((total, file) => total + (file.size ?? 0), 0) !== job.size
  ) {
    throw new Error('qBittorrent returned an incomplete direct-discovery manifest');
  }
  return job.manifestFiles.map((file) => {
    if (!Number.isSafeInteger(file.size) || file.size! <= 0) {
      throw new Error('qBittorrent manifest has no exact positive file size');
    }
    const path = appendRemotePath(save.path, file.path);
    const normalized = path ? normalizeRemoteAbsolute(path) : null;
    const contentMatches = job.fileCount === 1
      ? normalized?.comparison === content.comparison
      : normalized !== null && within(normalized.comparison, content.comparison, true) &&
        normalized.comparison !== content.comparison;
    if (!normalized || normalized.separator !== content.separator || !contentMatches) {
      throw new Error('qBittorrent manifest path disagrees with content_path');
    }
    return normalized.path;
  });
}

export async function resolveDirectQbittorrentCleanup(
  serverId: number,
  libraryKey: string,
  ratingKey: string,
  selections: readonly DirectDiscoverySelection[],
  retainedSelections: readonly DirectDiscoverySelection[],
  targets: readonly DownloadClientTarget[],
): Promise<ResolvedCleanupItem> {
  const rows = await db.select().from(plexPathMappings).where(and(
    eq(plexPathMappings.serverId, serverId),
    eq(plexPathMappings.libraryKey, libraryKey),
  ));
  const selected = await Promise.all(selections.map(async (selection) => {
    const mapped = resolvePlexToLocal(selection.plexPath, rows);
    if (!mapped) throw new Error('The selected Plex path has no single validated local mapping');
    return {
      ...selection,
      local: await exactLocalIdentity(mapped.path, selection.size),
      mapping: mapped.mapping,
    };
  }));
  const directPlexPathEvidence: DirectPlexPathEvidence[] = selected.map((selection) => ({
    serverId,
    libraryKey,
    plexPath: selection.plexPath,
    localPath: selection.local.path,
    mappingId: selection.mapping.id,
    mappingRevision: selection.mapping.revision,
    mappingPlexPath: selection.mapping.plexPath,
    mappingLocalPath: selection.mapping.localPath,
    mappingCaseSensitive: selection.mapping.caseSensitive,
  }));
  const retained = await Promise.all(retainedSelections.map(async (selection) => {
    const mapped = resolvePlexToLocal(selection.plexPath, rows);
    if (!mapped) throw new Error('A retained Plex path has no single validated local mapping');
    return {
      ...selection,
      local: await exactLocalIdentity(mapped.path, selection.size),
      mapping: mapped.mapping,
    };
  }));
  const directRetainedPathEvidence = retained.map((selection) => ({
    serverId,
    libraryKey,
    plexPath: selection.plexPath,
    localPath: selection.local.path,
    size: selection.local.size,
    device: selection.local.device,
    inode: selection.local.inode,
    canonicalPath: selection.local.canonical,
    mappingId: selection.mapping.id,
    mappingRevision: selection.mapping.revision,
    mappingPlexPath: selection.mapping.plexPath,
    mappingLocalPath: selection.mapping.localPath,
    mappingCaseSensitive: selection.mapping.caseSensitive,
  }));
  const jobs: ResolvedDownloadJob[] = [];
  const sources: ResolvedCleanupItem['sources'] = [];
  const selectedOwners = new Map<string, string[]>();
  for (const target of targets) {
    if (!target.client.discoverJobs || !target.pathMappings?.length) continue;
    const discoveryCandidates = directDiscoveryCandidates(
      selected.map((selection) => selection.local.path),
      target.pathMappings,
    );
    if (discoveryCandidates.length === 0) continue;
    const discovered = await target.client.discoverJobs(discoveryCandidates);
    for (const job of discovered.jobs) {
      const remotePaths = directManifestRemotePaths(job);
      const localFiles = await Promise.all(remotePaths.map((remotePath, index) => {
        const localPath = resolveDownloadPath(remotePath, target.pathMappings!);
        if (!localPath) return null;
        return exactLocalIdentity(localPath, job.manifestFiles[index]!.size!).catch(() => null);
      }));
      const matched = completeDirectManifestSelection(localFiles, selected, retained);
      if (matched === null) continue;
      const verifiedLocalFiles = localFiles.filter((local): local is DirectLocalIdentity =>
        local !== null
      );
      if (verifiedLocalFiles.length !== localFiles.length) {
        throw new Error(
          'A matching qBittorrent payload contains an unselected or unverifiable file',
        );
      }
      for (const candidate of matched) {
        const owners = selectedOwners.get(candidate.plexPath) ?? [];
        owners.push(`${target.instanceKey}:${job.id}`);
        selectedOwners.set(candidate.plexPath, owners);
      }
      const authorizedSourcePaths = [...remotePaths].sort();
      jobs.push({
        ...job,
        provider: target.provider,
        jobId: job.id,
        instanceKey: target.instanceKey,
        instanceName: target.instanceName,
        sourcePath: authorizedSourcePaths[0] ?? null,
        authorizedSourcePaths,
        target,
        directPathEvidence: verifiedLocalFiles.map((local, index) => ({
          remotePath: remotePaths[index]!,
          localPath: local.path,
          size: local.size,
          device: local.device,
          inode: local.inode,
          canonicalPath: local.canonical,
        })),
        directPlexPathEvidence,
        directRetainedPathEvidence,
        provenance: 'direct_manifest',
        discoverySummaryFingerprint: discovered.summaryFingerprint,
        ownershipSummaryFingerprint: await downloadJobSummaryFingerprint(job),
        manifestFingerprint: await downloadJobManifestFingerprint(job),
        directDiscoveryCandidates: discoveryCandidates,
        directPathMappings: target.pathMappings.map((mapping) => ({ ...mapping })),
      });
      matched.forEach((candidate, index) =>
        sources.push({
          instanceName: target.instanceName,
          downloadId: job.id,
          path: remotePaths[index]!,
          importedPath: candidate.plexPath,
          verification: 'hardlink',
          localPath: verifiedLocalFiles[index]!.path,
        })
      );
    }
  }
  for (const selection of selected) {
    const owners = selectedOwners.get(selection.plexPath) ?? [];
    if (owners.length !== 1) {
      return {
        ratingKey,
        status: 'unavailable',
        downloadJobs: [],
        reason: owners.length === 0
          ? 'No qBittorrent manifest owns the selected Plex file exactly'
          : 'Multiple qBittorrent jobs own the selected Plex file',
        arrStatus: 'unavailable',
        arrReason: 'Direct qBittorrent provenance was used without Arr history',
        arrTargets: [],
        sources: [],
        orphanFiles: [],
        retainedPaths: [],
      };
    }
  }
  if (jobs.length === 0) {
    return {
      ratingKey,
      status: 'unavailable',
      downloadJobs: [],
      reason: 'No exact qBittorrent ownership proof is available',
      arrStatus: 'unavailable',
      arrReason: 'Direct qBittorrent provenance was used without Arr history',
      arrTargets: [],
      sources: [],
      orphanFiles: [],
      retainedPaths: [],
    };
  }
  return {
    ratingKey,
    status: 'resolved',
    downloadJobs: jobs,
    arrStatus: 'unavailable',
    arrReason: 'Download ownership was proven directly from qBittorrent manifests',
    arrTargets: [],
    sources,
    orphanFiles: [],
    retainedPaths: [],
    observedDownloadJobKeys: new Set(jobs.map((job) => `${job.instanceKey}:${job.jobId}`)),
  };
}
