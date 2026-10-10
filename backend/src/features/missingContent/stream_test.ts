import { assertEquals, assertRejects } from '@std/assert';
import { objectArray } from './stream.ts';
function bytes(value: string, step = 1) {
  const data = new TextEncoder().encode(value);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(data.slice(offset, offset += step));
    },
  });
}
async function parse(value: string, step = 1, max = 10000, record = 10000) {
  const all = [];
  for await (const row of objectArray(bytes(value, step), max, record)) all.push(row);
  return all;
}
Deno.test('streaming parser handles byte fragmentation, nested arrays, Unicode and escaping', async () => {
  const rows = [{ id: 1, title: 'É電影 "{}[]\\', nested: [{ a: 2 }] }, { id: 2 }];
  for (const step of [1, 3, 16, 65536]) assertEquals(await parse(JSON.stringify(rows), step), rows);
  assertEquals(await parse('[]'), []);
});
Deno.test('truncated, trailing, non-array, oversized input fails coverage', async () => {
  for (const raw of ['[{"id":1}', '[{"id":1},]', '{}', '[1]', '[] trailing', '[{"id":1} {}]']) {
    await assertRejects(() => parse(raw));
  }
  await assertRejects(() => parse('[{"id":1}]', 1, 4));
  await assertRejects(() => parse('[{"id":123456789}]', 1, 100, 10));
});

Deno.test('record limits include fragments and UTF-16 surrogate pairs', async () => {
  const row = { title: '電影🎬'.repeat(100), nested: { value: '\\"{}[]' } };
  const raw = JSON.stringify(row);
  for (const step of [1, 7, 64, 65536]) {
    assertEquals(await parse(`[${raw},${raw}]`, step, 10000, raw.length * 2), [row, row]);
    await assertRejects(() => parse(`[${raw}]`, step, 10000, raw.length * 2 - 2));
  }
});

Deno.test('parser rejects non-JSON whitespace and malformed UTF-8', async () => {
  for (const raw of ['\u00a0[]', '[\u000b{}]', '[{},\u00a0{}]', '[]\u00a0']) {
    await assertRejects(() => parse(raw));
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([91, 123, 34, 97, 34, 58, 34, 0xc3, 34, 125, 93]));
      controller.close();
    },
  });
  await assertRejects(async () => {
    for await (const _ of objectArray(body)) { /* Drain validation. */ }
  });
  assertEquals(body.locked, false);
});

Deno.test('parser cancels and releases the reader on early return and invalid input', async () => {
  for (const raw of ['[{"id":1},{"id":2}]', '[invalid']) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
      },
      cancel() {
        cancelled = true;
      },
    });
    const consume = async () => {
      for await (const _ of objectArray(body)) break;
    };
    if (raw === '[invalid') await assertRejects(consume);
    else await consume();
    assertEquals(cancelled, true);
    assertEquals(body.locked, false);
  }
});
