import type { PlexClient } from '../../integrations/plex/client.ts';
import {
  configuredStoragePath,
  type ServicePathRoot,
  storageContains,
  storagePath,
} from '../../../../shared/serviceStorage.ts';
import type { OrdinarySelection } from './ordinaryPlanning.ts';

export interface OrdinaryStorageScope {
  path: string;
  directory: boolean;
}
export interface RetainedPlexScopeInput {
  plex: PlexClient;
  libraryKey: string;
  selection: OrdinarySelection;
  roots: ServicePathRoot[];
  scopes: OrdinaryStorageScope[];
  mapped: boolean;
}
export type RetainedPlexCheck = (input: RetainedPlexScopeInput) => Promise<void>;

function translatedPath(input: RetainedPlexScopeInput, raw: string): string {
  const path = storagePath(raw);
  if (!input.mapped) return path;
  const candidates = input.roots.filter((root) =>
    root.serviceKey.startsWith('plex:') &&
    storageContains(root.serviceRoot, path, root.caseSensitive)
  );
  if (!candidates.length) {
    throw new Error(
      'Storage relationship for retained Plex library is unresolved. Review Media connections before excluding its entries.',
    );
  }
  const paths = new Set(
    candidates.map((root) => configuredStoragePath([root], root.serviceKey, path)),
  );
  if (paths.size !== 1) {
    throw new Error('Plex storage relationships disagree about a retained entry');
  }
  return [...paths][0];
}

/** One streaming inspection for all destination choices, retaining only their errors.
 * Current complete section roots can exclude disjoint libraries. Discovery failures
 * fall back to the original complete entry inspection, never assume separation. */
export async function retainedPlexScopeErrors(
  inputs: readonly RetainedPlexScopeInput[],
): Promise<Array<string | undefined>> {
  if (!inputs.length) return [];
  const errors: Array<string | undefined> = inputs.map(() => undefined);
  const plex = inputs[0].plex;
  if (inputs.some((input) => input.plex !== plex)) {
    throw new Error('Retained inspection cannot combine Plex servers');
  }
  const libraries = await plex.libraries();
  for (const [i, input] of inputs.entries()) {
    if (!libraries.some((library) => library.key === input.libraryKey)) {
      errors[i] = 'The selected Plex library is absent from the current service inventory';
    }
  }
  for (
    const library of libraries.filter((library) =>
      library.type === 'movie' || library.type === 'show'
    )
  ) {
    let locations: string[] | undefined;
    try {
      locations = (await plex.libraryLocations(library.key)).locations.map((root) => root.path);
    } catch { /* Full streaming fallback below. */ }
    const relevant = inputs.map((input, index) => ({ input, index })).filter(({ input, index }) => {
      if (errors[index]) return false;
      if (!locations?.length) return true;
      try {
        // Saved roots also cover entries awaiting a Plex scan after a section-root edit.
        // A descendant relationship belonging to another library can change or conflict
        // with the inherited translation. Only entry inspection may exclude that case.
        const candidateRoots = [
          ...new Set([
            ...locations,
            ...input.roots.filter((root) => root.serviceKey === `plex:${library.key}`).map((root) =>
              root.serviceRoot
            ),
          ]),
        ];
        return candidateRoots.some((root) => {
          if (
            input.mapped && input.roots.some((mapping) =>
              mapping.serviceKey.startsWith('plex:') &&
              storagePath(mapping.serviceRoot) !== storagePath(root) &&
              storageContains(root, mapping.serviceRoot, false)
            )
          ) return true;
          const path = translatedPath(input, root);
          return input.scopes.some((scope) =>
            storageContains(path, scope.path, false) ||
            scope.directory && storageContains(scope.path, path, false)
          );
        });
      } catch {
        return true;
      }
    });
    if (!relevant.length) continue;
    for await (const page of plex.libraryFileEntries(library.key, library.type === 'show')) {
      for (const file of page) {
        for (const { input, index } of relevant) {
          if (errors[index]) continue;
          if (
            library.key === input.libraryKey &&
            (file.ratingKey === input.selection.ratingKey ||
              input.selection.type === 'show' && file.showRatingKey === input.selection.ratingKey ||
              input.selection.type === 'season' &&
                file.seasonRatingKey === input.selection.ratingKey)
          ) continue;
          try {
            const path = translatedPath(input, file.path);
            if (
              input.scopes.some((scope) =>
                scope.path.toLowerCase() === path.toLowerCase() ||
                scope.directory && storageContains(scope.path, path, false)
              )
            ) throw new Error('The requested file or folder contains media retained in Plex');
          } catch (error) {
            errors[index] = error instanceof Error
              ? error.message
              : 'Retained Plex scope is unavailable';
          }
        }
      }
      if (relevant.every(({ index }) => errors[index] !== undefined)) break;
    }
  }
  return errors;
}
export const assertRetainedPlexScope: RetainedPlexCheck = async (input) => {
  const [error] = await retainedPlexScopeErrors([input]);
  if (error) throw new Error(error);
};

/** Short-lived negative evidence for one execution batch. Never persisted or shared
 * between worker passes. Phase changes and expiry force a fresh retained inspection;
 * selected entries, playback, mappings and service ownership are still checked per action. */
export function retainedPlexBatchCheck(
  phase: () => string,
  now: () => number = Date.now,
): RetainedPlexCheck {
  let key: string | undefined, checkedAt = 0;
  return async (input) => {
    const current = JSON.stringify([
      phase(),
      input.libraryKey,
      input.selection,
      input.roots,
      input.scopes,
      input.mapped,
    ]);
    if (current === key && now() - checkedAt < 10_000) return;
    await assertRetainedPlexScope(input);
    key = current;
    checkedAt = now();
  };
}
