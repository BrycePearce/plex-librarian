import { assertEquals } from '@std/assert';
import { loadPlexPathPreviews } from './plexPathPreview.ts';

Deno.test('Plex path preview aborts active lookups and falls back when its batch deadline expires', async () => {
  let calls = 0;
  let aborted = 0;
  const client = {
    mediaPathPreview(
      _ratingKey: string,
      _itemType: string,
      _limit?: number,
      signal?: AbortSignal,
    ): Promise<{ paths: string[]; truncated: boolean }> {
      calls++;
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => {
          aborted++;
          reject(signal!.reason);
        }, { once: true });
      });
    },
  };
  const items = Array.from({ length: 4 }, (_, index) => ({
    ratingKey: String(index),
    type: 'movie',
  }));

  const previews = await loadPlexPathPreviews(items, () => Promise.resolve(client), 10);

  assertEquals(calls, 3);
  assertEquals(aborted, 3);
  assertEquals(
    [...previews.values()],
    items.map(() => ({
      plexPaths: [],
      plexPathStatus: 'unavailable',
      plexPathReason: 'Plex path preview timed out; deletion can continue without it',
      plexPathsTruncated: false,
    })),
  );
});
