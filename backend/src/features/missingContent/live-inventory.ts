/** Optional read-only inventory validation; prints counts and resource metrics only. */
import { Database } from '@db/sqlite';
import { readInventory } from './inventory.ts';
const source = Deno.args[0];
if (!source) throw new Error('Pass an explicit database path to read');
const db = new Database(source, { readonly: true });
const stmt = db.prepare(
  "SELECT a.id,a.url,a.api_key FROM arr_instances a JOIN settings s ON s.active_server_id=a.server_id WHERE s.id=1 AND a.type='radarr'",
);
const instances = stmt.all<{ id: number; url: string; api_key: string }>();
stmt.finalize();
db.close();
for (const instance of instances) {
  let requests = 0, bytes = 0, movies = 0, managed = 0, queue = 0;
  const start = performance.now();
  const initial = Deno.memoryUsage();
  let peak = initial;
  const sample = () => {
    const m = Deno.memoryUsage();
    peak = { ...m, heapUsed: Math.max(m.heapUsed, peak.heapUsed), rss: Math.max(m.rss, peak.rss) };
  };
  const timer = setInterval(sample, 5);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    const response = await fetch(input, init);
    if (!response.body) return response;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          bytes += chunk.length;
          c.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, headers: response.headers });
  }) as typeof fetch;
  try {
    await readInventory(instance.url, instance.api_key, controller.signal, (movie) => {
      movies++;
      if (movie?.fileId) managed++;
      sample();
      return Promise.resolve();
    }, () => {
      queue++;
    }, fetcher);
    console.log(JSON.stringify({
      instanceId: instance.id,
      status: 'complete',
      requests,
      responseBytes: bytes,
      movies,
      managed,
      queue,
      elapsedMs: performance.now() - start,
      initialHeapMiB: initial.heapUsed / 1048576,
      peakHeapMiB: peak.heapUsed / 1048576,
      peakRssMiB: peak.rss / 1048576,
    }));
  } catch {
    console.log(
      JSON.stringify({
        instanceId: instance.id,
        status: 'incomplete',
        requests,
        responseBytes: bytes,
      }),
    );
    Deno.exitCode = 1;
  } finally {
    clearInterval(timer);
    clearTimeout(timeout);
    controller.abort();
  }
}
