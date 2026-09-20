import { dirname, posix } from 'node:path';
import { lstatChain } from './pathNamespace.ts';
import { HistoricalUnlinkNotAttempted } from './historicalDownloadErrors.ts';

export interface HistoricalFileSnapshot {
  version: 1;
  path: string;
  root: string;
  entry: string;
  rootIdentity: string;
  parentIdentity: string;
  mount: string;
  device: number;
  inode: number;
  size: number;
  mtime: number | null;
  ctime: number | null;
}

export function stableFilesystemIdentity(info: Pick<Deno.FileInfo, 'dev' | 'ino'>): string {
  if (
    !Number.isSafeInteger(info.dev) || info.dev! < 0 ||
    !Number.isSafeInteger(info.ino) || info.ino! <= 0
  ) {
    throw new Error('Stable filesystem identity is unavailable');
  }
  return `${info.dev}:${info.ino}`;
}

function absolute(path: string): void {
  if (
    !path.startsWith('/') || path === '/' || posix.normalize(path) !== path ||
    // deno-lint-ignore no-control-regex -- Reject literal control characters in filesystem paths.
    path.includes('\\') || /[\x00-\x1f]/.test(path)
  ) throw new Error('Unsafe cleanup path');
}

function beneath(path: string, root: string): boolean {
  return path.startsWith(root + '/');
}

let parsedMountInventory: {
  content: string;
  entries: Array<{ mountpoint: string; line: string; fields: string[] }>;
} | undefined;

/** Mount metadata binds inspection to this namespace. Device plus filesystem-root
 * path identifies entries across bind aliases without conflating hardlink names. */
export function historicalMountEntry(
  path: string,
  content: string,
): { mount: string; entry: string } {
  if (content.length > 4 * 1024 * 1024) throw new Error('Mount inventory is oversized');
  if (parsedMountInventory?.content !== content) {
    const entries = content.trim().split('\n').map((line) => {
      const fields = line.split(' ');
      const mountpoint = fields[4]?.replace(
        /\\(\d{3})/g,
        (_, n) => String.fromCharCode(parseInt(n, 8)),
      );
      return { mountpoint, line, fields };
    }).filter((m) => m.mountpoint).sort((a, b) => b.mountpoint.length - a.mountpoint.length);
    // Cache parsing only, keyed by the complete freshly read mount inventory.
    // Never cache a filesystem observation or ignore namespace changes.
    parsedMountInventory = { content, entries };
  }
  const matches = parsedMountInventory.entries.filter((m) =>
    m.mountpoint && (path === m.mountpoint ||
      beneath(path, m.mountpoint === '/' ? '' : m.mountpoint))
  );
  if (!matches.length) throw new Error('Mount identity is unavailable');
  if (matches[1]?.mountpoint === matches[0].mountpoint) {
    throw new Error('Stacked mount identity is ambiguous');
  }
  const match = matches[0];
  const filesystemRoot = match.fields[3].replace(
    /\\(\d{3})/g,
    (_, n) => String.fromCharCode(parseInt(n, 8)),
  );
  const relative = path.slice(match.mountpoint === '/' ? 1 : match.mountpoint.length + 1);
  return { mount: match.line, entry: `${match.fields[2]}:${posix.join(filesystemRoot, relative)}` };
}

export async function inspectHistoricalFile(
  path: string,
  root: string,
  appDataRoot: string,
): Promise<HistoricalFileSnapshot> {
  if (Deno.build.os !== 'linux') {
    throw new Error('Historical cleanup requires verified Linux identity');
  }
  [path, root, appDataRoot].forEach(absolute);
  // A symlinked app-data root cannot be compared lexically to its storage alias.
  // Reject that unsupported configuration instead of authorizing app-data files.
  if (!(await lstatChain(appDataRoot)).isDirectory) throw new Error('App-data root is unavailable');
  if (
    !beneath(path, root) || path === appDataRoot || beneath(path, appDataRoot) ||
    root === appDataRoot || beneath(root, appDataRoot)
  ) throw new Error('Cleanup scope is unsafe');
  const rootInfo = await lstatChain(root);
  if (!rootInfo.isDirectory) throw new Error('Download root is not a directory');
  const info = await lstatChain(path);
  if (!info.isFile) throw new Error('Historical source is not a regular file');
  const parent = await lstatChain(dirname(path));
  const rootIdentity = stableFilesystemIdentity(rootInfo);
  stableFilesystemIdentity(info);
  const parentIdentity = stableFilesystemIdentity(parent);
  const mounts = await Deno.readTextFile('/proc/self/mountinfo');
  const physical = historicalMountEntry(path, mounts);
  const app = historicalMountEntry(appDataRoot, mounts).entry;
  if (physical.entry === app || beneath(physical.entry, app)) {
    throw new Error('App-data alias is unsafe');
  }
  return {
    version: 1,
    path,
    root,
    rootIdentity,
    parentIdentity,
    entry: physical.entry,
    mount: physical.mount,
    device: info.dev!,
    inode: info.ino!,
    size: info.size,
    mtime: info.mtime?.getTime() ?? null,
    ctime: info.ctime?.getTime() ?? null,
  };
}

export async function historicalFileUnchanged(
  snapshot: HistoricalFileSnapshot,
  appDataRoot: string,
) {
  const fresh = await inspectHistoricalFile(snapshot.path, snapshot.root, appDataRoot);
  return JSON.stringify(fresh) === JSON.stringify(snapshot);
}

/** Absence is meaningful only while the accepted root and source mount still exist. */
export async function historicalRootUnchanged(snapshot: HistoricalFileSnapshot): Promise<boolean> {
  const root = await lstatChain(snapshot.root);
  if (!root.isDirectory || stableFilesystemIdentity(root) !== snapshot.rootIdentity) return false;
  const parent = await lstatChain(dirname(snapshot.path));
  if (!parent.isDirectory || stableFilesystemIdentity(parent) !== snapshot.parentIdentity) {
    return false;
  }
  const physical = historicalMountEntry(
    snapshot.path,
    await Deno.readTextFile('/proc/self/mountinfo'),
  );
  return physical.mount === snapshot.mount && physical.entry === snapshot.entry;
}

/** Caller must persist intent and revalidate service ownership first. No directory pruning. */
export async function unlinkHistoricalFile(
  snapshot: HistoricalFileSnapshot,
  appDataRoot: string,
  beforeUnlink?: () => void,
) {
  try {
    if (!await historicalFileUnchanged(snapshot, appDataRoot)) {
      throw new HistoricalUnlinkNotAttempted('changed', 'Historical file changed');
    }
  } catch (error) {
    if (error instanceof HistoricalUnlinkNotAttempted) throw error;
    throw new HistoricalUnlinkNotAttempted(
      'skipped',
      `Final identity inspection unavailable: ${String(error)}`,
    );
  }
  beforeUnlink?.();
  await Deno.remove(snapshot.path);
}
