/** Isolated parser throughput fixture. No network, database, or real library reads.
 * Run: deno run backend/src/features/missingContent/stream_performance.ts [scale]
 * Fixture allocation is outside the measured parser time; this is not a memory benchmark.
 */
import { objectArray } from './stream.ts';

const scale = Number(Deno.args[0] ?? 1);
if (!Number.isInteger(scale) || scale < 1 || scale > 10) {
  throw new Error('Scale must be an integer from 1 to 10');
}
const count = 2899 * scale;
const record = JSON.stringify({
  id: 123,
  title: 'Fixture 電影',
  overview: 'A movie synopsis. '.repeat(150),
  images: [{ url: 'http://example.invalid/poster.jpg' }],
  nested: { arr: [1, 2, 3] },
  path: '/movies/Fixture (2024)/Fixture.mkv',
});
const payload = new TextEncoder().encode('[' + Array(count).fill(record).join(',') + ']');
const results = [];
for (const chunkBytes of [65536, 8192]) {
  const samplesMs = [];
  for (let run = 0; run < 4; run++) {
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === payload.length) controller.close();
        else {
          const end = Math.min(offset + chunkBytes, payload.length);
          controller.enqueue(payload.subarray(offset, end));
          offset = end;
        }
      },
    });
    let seen = 0;
    const started = performance.now();
    for await (const _ of objectArray(body)) seen++;
    const duration = performance.now() - started;
    if (seen !== count) throw new Error(`Expected ${count} records; parsed ${seen}`);
    if (run > 0) samplesMs.push(Math.round(duration * 100) / 100);
  }
  results.push({ chunkBytes, samplesMs });
}
console.log(JSON.stringify({ count, responseBytes: payload.length, results }, null, 2));
