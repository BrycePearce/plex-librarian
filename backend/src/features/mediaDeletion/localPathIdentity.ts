import { dirname, resolve } from '@std/path';

interface Mount {
  device: string;
  root: string;
  path: string;
}

function key(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  return normalized;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function decode(value: string): string {
  return value.replace(
    /\\(040|011|012|134)/g,
    (_, code) => String.fromCharCode(Number.parseInt(code, 8)),
  );
}

export interface LocalPathIdentity {
  entry: string;
  /** Conservative comparison may veto, but must never authorize payload deletion. */
  possibleEntry: string;
  /** Also account for files under nested mounts when deleting a directory. */
  descendants: string[];
}

/** Resolve bind mounts by filesystem device and mount root, not mountpoint name.
 * realPath alone does not collapse Linux bind mounts. Missing suffixes are kept
 * relative to their nearest existing ancestor; inaccessible ancestors fail closed.
 */
export async function createLocalPathIdentityResolver(options: {
  mountInfo?: string | null;
  realPath?: (path: string) => Promise<string>;
} = {}): Promise<(path: string, requireExisting?: boolean) => Promise<LocalPathIdentity>> {
  const mountInfo = options.mountInfo !== undefined
    ? options.mountInfo
    : Deno.build.os === 'linux'
    ? await Deno.readTextFile('/proc/self/mountinfo')
    : null;
  const mounts: Mount[] = mountInfo === null ? [] : mountInfo.trim().split('\n').map((line) => {
    const fields = line.split(' ');
    if (fields.length < 10 || !fields.includes('-') || !/^\d+:\d+$/.test(fields[2]!)) {
      throw new Error('Could not verify filesystem mount identities');
    }
    return { device: fields[2]!, root: decode(fields[3]!), path: decode(fields[4]!) };
  });
  const realPath = options.realPath ?? Deno.realPath;
  function physical(path: string): string {
    if (mountInfo === null) return key(path);
    // Mount selection is case-sensitive: preserve Linux mountpoint identities.
    const mount = mounts.filter((entry) => within(path, entry.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!mount) throw new Error('Could not verify the filesystem containing a deletion path');
    if (
      mounts.some((other) =>
        other.path === mount.path &&
        (other.device !== mount.device || other.root !== mount.root)
      )
    ) {
      throw new Error('Could not verify an ambiguous stacked filesystem mount');
    }
    return `${mount.device}:${key(`${mount.root}/${path.slice(mount.path.length)}`)}`
      .replaceAll('//', '/');
  }
  return async (path, requireExisting = false) => {
    let ancestor = resolve(path);
    const suffix: string[] = [];
    let canonical: string;
    for (;;) {
      try {
        canonical = await realPath(ancestor);
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound) || requireExisting) throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        suffix.unshift(ancestor.slice(parent.length).replace(/^[\\/]+/, ''));
        ancestor = parent;
      }
    }
    canonical = `${canonical.replaceAll('\\', '/').replace(/\/+$/, '')}/${suffix.join('/')}`
      .replace(/\/+$/, '') || '/';
    const entry = physical(canonical);
    return {
      entry,
      possibleEntry: entry.toLowerCase(),
      descendants: [
        entry,
        ...mounts.filter((mount) => within(mount.path, canonical))
          .map((mount) => `${mount.device}:${key(mount.root)}`),
      ].map((value) => value.toLowerCase()),
    };
  };
}

export function identityContains(parent: LocalPathIdentity, child: LocalPathIdentity): boolean {
  return parent.descendants.some((root) => within(child.possibleEntry, root));
}
