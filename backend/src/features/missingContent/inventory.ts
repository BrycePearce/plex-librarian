import { objectArray } from './stream.ts';
import { type MovieEvidence, movieEvidence } from './model.ts';
import { normalizeArrUrl } from '../../integrations/arr/client.ts';

/** One movie GET per instance, consumed one record at a time. No detail fan-out. */
export async function readInventory(
  url: string,
  apiKey: string,
  signal: AbortSignal,
  onMovie: (movie: MovieEvidence | null, id: number) => Promise<void>,
  onQueue: (id: number, movieId: number) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = normalizeArrUrl(url);
  const get = async (path: string) => {
    const response = await fetchImpl(`${base}/api/v3${path}`, {
      headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
      signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Radarr inventory read failed');
    }
    return response;
  };
  // Queue must complete before any findings are published. Snapshot is not transactional.
  let expected: number | null = null;
  let count = 0;
  for (let page = 1; page <= 100; page++) {
    const response = await get(`/queue?page=${page}&pageSize=200&includeUnknownMovieItems=true`);
    const reader = response.body!.getReader();
    let text = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
        if (text.length > 2 * 1024 * 1024) throw new Error('Radarr queue exceeds budget');
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const body = JSON.parse(text);
    if (
      !Number.isSafeInteger(body.totalRecords) || body.totalRecords < 0 ||
      !Array.isArray(body.records)
    ) throw new Error('Invalid Radarr queue');
    expected ??= body.totalRecords;
    if (
      expected !== body.totalRecords || body.records.length !== Math.min(200, expected! - count)
    ) throw new Error('Incomplete Radarr queue');
    for (const r of body.records) {
      if (!Number.isSafeInteger(r.id) || !Number.isSafeInteger(r.movieId) || r.movieId <= 0) {
        throw new Error('Unknown queue ownership');
      }
      onQueue(r.id, r.movieId);
    }
    count += body.records.length;
    if (count === expected) break;
    if (page === 100) throw new Error('Radarr queue exceeds record budget');
  }
  const response = await get('/movie');
  let records = 0;
  for await (const raw of objectArray(response.body!)) {
    signal.throwIfAborted();
    if (++records > 1_000_000) throw new Error('Radarr inventory exceeds record budget');
    const movie = movieEvidence(raw);
    await onMovie(movie, raw.id as number);
  }
}
