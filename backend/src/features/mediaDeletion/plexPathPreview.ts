import type { DownloadCleanupPreviewResponse } from '@plex-librarian/shared/types.ts';
import {
  createPlexClient,
  MAX_PREVIEW_MEDIA_PATHS,
  type PlexClient,
} from '../../integrations/plex/index.ts';

type PlexPathPreview = Pick<
  DownloadCleanupPreviewResponse['items'][number],
  'plexPaths' | 'plexPathStatus' | 'plexPathReason' | 'plexPathsTruncated'
>;

type PlexPathClient = Pick<PlexClient, 'mediaPathPreview'>;

export const PLEX_PATH_PREVIEW_DEADLINE_MS = 5_000;
const PLEX_PATH_PREVIEW_TIMEOUT_REASON =
  'Plex path preview timed out; deletion can continue without it';

function missingPlexPathPreview(
  reason: string,
  status: 'unavailable' | 'error',
): PlexPathPreview {
  return {
    plexPaths: [],
    plexPathStatus: status,
    plexPathReason: reason,
    plexPathsTruncated: false,
  };
}

/**
 * Loads informational Plex paths with one response-wide budget. These paths are
 * confirmation text only and must never be used as filesystem authority.
 */
export async function loadPlexPathPreviews(
  selectedItems: Array<{ ratingKey: string; type: string }>,
  clientFactory: () => Promise<PlexPathClient> = createPlexClient,
  deadlineMs = PLEX_PATH_PREVIEW_DEADLINE_MS,
): Promise<Map<string, PlexPathPreview>> {
  const result = new Map<string, PlexPathPreview>();
  if (selectedItems.length === 0) return result;

  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new DOMException('Plex path preview deadline exceeded', 'TimeoutError')),
    deadlineMs,
  );
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
      once: true,
    });
  });

  let client: PlexPathClient;
  try {
    // In env-configured installs client creation may itself require a live identity
    // lookup, so the batch deadline covers the factory and metadata requests.
    client = await Promise.race([clientFactory(), deadlinePromise]);
  } catch {
    clearTimeout(deadline);
    const reason = controller.signal.aborted
      ? PLEX_PATH_PREVIEW_TIMEOUT_REASON
      : 'Could not connect to Plex to load current media paths';
    for (const item of selectedItems) {
      result.set(
        item.ratingKey,
        missingPlexPathPreview(reason, controller.signal.aborted ? 'unavailable' : 'error'),
      );
    }
    return result;
  }

  let nextIndex = 0;
  // This is a batch-wide response budget, not 2,000 paths per selected item.
  const perItemPathLimit = Math.max(
    1,
    Math.floor(MAX_PREVIEW_MEDIA_PATHS / selectedItems.length),
  );
  const workers = Array.from({ length: Math.min(3, selectedItems.length) }, async () => {
    while (!controller.signal.aborted && nextIndex < selectedItems.length) {
      const item = selectedItems[nextIndex++];
      try {
        const preview = await client.mediaPathPreview(
          item.ratingKey,
          item.type,
          perItemPathLimit,
          controller.signal,
        );
        result.set(item.ratingKey, {
          plexPaths: preview.paths,
          plexPathStatus: preview.paths.length > 0 ? 'resolved' : 'unavailable',
          plexPathReason: preview.paths.length > 0
            ? undefined
            : preview.truncated
            ? 'Plex did not return a path within the bounded preview scan; additional media was not inspected'
            : 'Plex did not return an underlying media path',
          plexPathsTruncated: preview.truncated,
        });
      } catch {
        if (controller.signal.aborted) break;
        result.set(
          item.ratingKey,
          missingPlexPathPreview('Could not load current media paths from Plex', 'error'),
        );
      }
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    clearTimeout(deadline);
  }

  for (const item of selectedItems) {
    if (!result.has(item.ratingKey)) {
      result.set(
        item.ratingKey,
        missingPlexPathPreview(PLEX_PATH_PREVIEW_TIMEOUT_REASON, 'unavailable'),
      );
    }
  }
  return result;
}
