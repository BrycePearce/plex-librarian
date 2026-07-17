export type LibraryOperationKind = 'sync' | 'deletion';
export type ReleaseLibraryOperation = () => void;

interface Waiter {
  kind: LibraryOperationKind;
  resolve: (release: ReleaseLibraryOperation) => void;
}

interface LibraryOperationState {
  activeKind: LibraryOperationKind;
  waiters: Waiter[];
}

// Plex Librarian deliberately runs as one process in one container. This keyed queue
// serializes sync writes and destructive work for the same library while still allowing
// unrelated libraries to sync concurrently.
const operations = new Map<string, LibraryOperationState>();

function operationKey(serverId: number, libraryKey: string): string {
  return `${serverId}\0${libraryKey}`;
}

function releaseFor(key: string, state: LibraryOperationState): ReleaseLibraryOperation {
  let released = false;
  return () => {
    if (released) return;
    released = true;

    const next = state.waiters.shift();
    if (!next) {
      operations.delete(key);
      return;
    }
    state.activeKind = next.kind;
    next.resolve(releaseFor(key, state));
  };
}

export function tryAcquireLibraryOperation(
  serverId: number,
  libraryKey: string,
  kind: LibraryOperationKind,
): ReleaseLibraryOperation | null {
  const key = operationKey(serverId, libraryKey);
  if (operations.has(key)) return null;
  const state: LibraryOperationState = { activeKind: kind, waiters: [] };
  operations.set(key, state);
  return releaseFor(key, state);
}

export function acquireLibraryOperation(
  serverId: number,
  libraryKey: string,
  kind: LibraryOperationKind,
): Promise<ReleaseLibraryOperation> {
  const immediate = tryAcquireLibraryOperation(serverId, libraryKey, kind);
  if (immediate) return Promise.resolve(immediate);

  const state = operations.get(operationKey(serverId, libraryKey));
  if (!state) return acquireLibraryOperation(serverId, libraryKey, kind);
  return new Promise((resolve) => state.waiters.push({ kind, resolve }));
}

export async function withLibraryOperation<T>(
  serverId: number,
  libraryKey: string,
  kind: LibraryOperationKind,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireLibraryOperation(serverId, libraryKey, kind);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function activeLibraryOperation(
  serverId: number,
  libraryKey: string,
): LibraryOperationKind | null {
  return operations.get(operationKey(serverId, libraryKey))?.activeKind ?? null;
}
