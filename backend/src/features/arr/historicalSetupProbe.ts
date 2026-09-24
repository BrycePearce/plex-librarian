import { posix } from 'node:path';
import type { ArrPathMapping } from '../../../../shared/types.ts';
import type { HistoricalImport } from '../../integrations/arr/historicalImports.ts';
import { historicalNativeStat } from '../mediaDeletion/historicalNativeStat.ts';
import { lstatChain } from '../mediaDeletion/pathNamespace.ts';
import {
  boundedHistoricalInspection,
  inspectHistoricalAccessSample,
} from './historicalAccessInspection.ts';

export type SetupProposal = { remoteRoot: string; localRoot: string; sample: string };
const beneath = (path: string, root: string) => path.startsWith(root + '/');
const safe = (path: string) =>
  path.startsWith('/') && path !== '/' &&
  posix.normalize(path) === path && !path.includes('\\') &&
  ![...path].some((c) => c.charCodeAt(0) < 32);

async function sameFile(left: string, right: string) {
  if (!(await lstatChain(left)).isFile || !(await lstatChain(right)).isFile) return false;
  const a = await historicalNativeStat(left, 'download sample');
  const b = await historicalNativeStat(right, 'imported sample');
  return a.type === 0x8000 && b.type === 0x8000 && a.dev === b.dev && a.ino === b.ino;
}

/** At most four imports, two conventional mounts and eight source ancestors.
 * Existing explicit mappings are authoritative; inferred mappings need a hardlink
 * witness. A matching name/size or an accessible folder alone is never proof. */
export async function probeHistoricalSetup(
  records: readonly HistoricalImport[],
  mappings: readonly ArrPathMapping[],
  mounts: readonly string[],
  dependencies = { sameFile, inspect: inspectHistoricalAccessSample },
): Promise<SetupProposal | null> {
  const deadline = Date.now() + 15_000;
  const found = new Map<string, SetupProposal>();
  for (const record of records.slice(0, 4)) {
    if (!safe(record.droppedPath) || !safe(record.importedPath)) continue;
    const explicit = mappings.filter((m) =>
      m.kind === 'download' && beneath(record.droppedPath, m.arrPath)
    );
    if (explicit.length > 1) return null;
    const candidates = explicit.map((m) => ({ remoteRoot: m.arrPath, localRoot: m.localPath }));
    if (!explicit.length) {
      let root = posix.dirname(record.droppedPath);
      for (let depth = 0; depth < 8 && root !== '/'; depth++, root = posix.dirname(root)) {
        for (const localRoot of mounts.slice(0, 2)) {
          candidates.push({ remoteRoot: root, localRoot });
        }
      }
    }
    const library = mappings.filter((m) =>
      m.kind === 'library' && beneath(record.importedPath, m.arrPath)
    );
    if (library.length > 1) return null;
    const imported = library.length
      ? library[0].localPath + record.importedPath.slice(library[0].arrPath.length)
      : record.importedPath;
    for (const candidate of candidates) {
      if (Date.now() >= deadline) return null;
      if (!safe(candidate.localRoot) || !safe(candidate.remoteRoot)) continue;
      const local = candidate.localRoot + record.droppedPath.slice(candidate.remoteRoot.length);
      try {
        const valid = await boundedHistoricalInspection(
          (async () => {
            if (
              !explicit.length &&
              (local === imported || !await dependencies.sameFile(local, imported))
            ) return false;
            return await dependencies.inspect(candidate.localRoot, local) === null;
          })(),
          Math.max(1, deadline - Date.now()),
        );
        if (valid) {
          found.set(JSON.stringify(candidate), { ...candidate, sample: record.droppedPath });
        }
      } catch { /* Optional setup failure stays local and never authorizes cleanup. */ }
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}
