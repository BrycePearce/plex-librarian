import type { DownloadJob } from './downloadClient.ts';
import { normalizeRemoteAbsolute } from './hardlinks.ts';

export function appendRemotePath(root: string, relative: string): string | null {
  const normalizedRoot = normalizeRemoteAbsolute(root);
  if (!normalizedRoot) return null;
  const absoluteRelative = normalizeRemoteAbsolute(relative);
  if (absoluteRelative) return null;
  const parts = relative.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return `${normalizedRoot.path}${normalizedRoot.separator}${parts.join(normalizedRoot.separator)}`;
}

export function downloadJobOwnsPath(
  job: Pick<DownloadJob, 'contentPath' | 'savePath' | 'manifestFiles'>,
  sourcePath: string,
): boolean {
  const source = normalizeRemoteAbsolute(sourcePath);
  if (!source) return false;
  const candidates = new Set<string>();
  const content = normalizeRemoteAbsolute(job.contentPath);
  if (content) candidates.add(content.comparison);
  for (const file of job.manifestFiles) {
    for (const root of [job.savePath, job.contentPath]) {
      const candidate = appendRemotePath(root, file.path);
      const normalized = candidate ? normalizeRemoteAbsolute(candidate) : null;
      if (normalized) candidates.add(normalized.comparison);
    }
  }
  return candidates.has(source.comparison);
}

export function downloadPayloadIsExclusivelyOwned(
  job: Pick<DownloadJob, 'contentPath' | 'savePath' | 'manifestFiles'>,
  sourcePaths: ReadonlySet<string>,
): boolean {
  if (job.manifestFiles.length === 0 || sourcePaths.size === 0) return false;
  const owned = new Set(
    [...sourcePaths].flatMap((path) => {
      const normalized = normalizeRemoteAbsolute(path);
      return normalized ? [normalized.comparison] : [];
    }),
  );
  return job.manifestFiles.every((file) => {
    for (const root of [job.savePath, job.contentPath]) {
      const candidate = appendRemotePath(root, file.path);
      const normalized = candidate ? normalizeRemoteAbsolute(candidate) : null;
      if (normalized && owned.has(normalized.comparison)) return true;
    }
    return false;
  });
}
