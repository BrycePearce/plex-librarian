import { assertEquals } from '@std/assert';
import { createDownloadCleanupPreviewRouter } from './previewRoute.ts';

const app = createDownloadCleanupPreviewRouter(async (c, next) => {
  c.set('activeServerId', 1);
  await next();
});

Deno.test('download cleanup preview rejects empty and oversized selections at the HTTP boundary', async () => {
  for (const ratingKeys of [[], Array.from({ length: 201 }, (_, index) => String(index))]) {
    const response = await app.request('/movies/items/download-cleanup-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratingKeys }),
    });
    assertEquals(response.status, 400);
    assertEquals(await response.json(), {
      error: 'ratingKeys must contain between 1 and 200 strings',
    });
  }
});

Deno.test('download cleanup preview rejects malformed JSON input', async () => {
  const response = await app.request('/movies/items/download-cleanup-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assertEquals(response.status, 400);
});
