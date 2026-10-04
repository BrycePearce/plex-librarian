import { assertEquals, assertRejects, assertStrictEquals } from '@std/assert';
import type { IntegrationCompatibilityCheck } from '@plex-librarian/shared/types.ts';
import { CompatibilityCache } from './cache.ts';

const check: IntegrationCompatibilityCheck = {
  key: 'sonarr:1',
  kind: 'sonarr',
  instanceId: 1,
  name: 'Sonarr',
  status: 'compatible',
  version: '4.0.19.2979',
  apiVersion: 'v3',
  message: null,
};

Deno.test('compatibility cache shares in-flight probes and expires from completion time', async () => {
  let now = 0;
  const cache = new CompatibilityCache(() => now);
  let calls = 0;
  let complete!: (value: IntegrationCompatibilityCheck) => void;
  const probe = () => {
    calls++;
    return new Promise<IntegrationCompatibilityCheck>((resolve) => complete = resolve);
  };
  const first = cache.get(1, check.key, ['url', 'credential'], probe);
  await Promise.resolve();
  now = 400_000;
  assertStrictEquals(cache.get(1, check.key, ['url', 'credential'], probe), first);
  assertEquals(calls, 1);
  complete(check);
  assertEquals(await first, { check, checkedAt: 400 });
  now = 699_999;
  assertStrictEquals(cache.get(1, check.key, ['url', 'credential'], probe), first);
  now = 700_000;
  const fresh = cache.get(1, check.key, ['url', 'credential'], () => Promise.resolve(check));
  assertEquals((await fresh).checkedAt, 700);
});

Deno.test('compatibility cache isolates servers, connections, and exact configurations', async () => {
  const cache = new CompatibilityCache();
  let calls = 0;
  const probe = () => {
    calls++;
    return Promise.resolve(check);
  };
  await cache.get(1, check.key, ['url', 'old-credential', 'name'], probe);
  await cache.get(1, check.key, ['url', 'old-credential', 'name'], probe);
  await cache.get(2, check.key, ['url', 'old-credential', 'name'], probe);
  await cache.get(1, 'sonarr:2', ['url', 'old-credential', 'name'], probe);
  await cache.get(1, check.key, ['url', 'new-credential', 'name'], probe);
  await cache.get(1, check.key, ['new-url', 'new-credential', 'name'], probe);
  await cache.get(1, check.key, ['new-url', 'new-credential', 'new-name'], probe);
  assertEquals(calls, 6);
});

Deno.test('unreachable compatibility results expire after thirty seconds', async () => {
  let now = 0;
  let calls = 0;
  const cache = new CompatibilityCache(() => now);
  const probe = () => {
    calls++;
    return Promise.resolve({ ...check, status: 'unreachable' as const });
  };
  await cache.get(1, check.key, [], probe);
  now = 29_999;
  await cache.get(1, check.key, [], probe);
  assertEquals(calls, 1);
  now = 30_000;
  await cache.get(1, check.key, [], probe);
  assertEquals(calls, 2);
});

Deno.test('explicit invalidation cannot be undone by an older in-flight probe', async () => {
  const cache = new CompatibilityCache();
  let complete!: (value: IntegrationCompatibilityCheck) => void;
  const old = cache.get(1, check.key, [], () => new Promise((resolve) => complete = resolve));
  await Promise.resolve();
  cache.invalidate(1, check.key);
  const changed = { ...check, version: '4.1.0.0' };
  const fresh = cache.get(1, check.key, [], () => Promise.resolve(changed));
  await fresh;
  complete(check);
  await old;
  assertStrictEquals(cache.get(1, check.key, [], () => Promise.resolve(check)), fresh);
});

Deno.test('configuration changes during probes cannot restore old results', async () => {
  const cache = new CompatibilityCache();
  let complete!: (value: IntegrationCompatibilityCheck) => void;
  const old = cache.get(1, check.key, ['old'], () => new Promise((resolve) => complete = resolve));
  await Promise.resolve();
  const fresh = cache.get(1, check.key, ['new'], () => Promise.resolve(check));
  await fresh;
  complete(check);
  await old;
  assertStrictEquals(cache.get(1, check.key, ['new'], () => Promise.resolve(check)), fresh);
});

Deno.test('compatibility cache evicts least recently used entries at its bound', async () => {
  const cache = new CompatibilityCache(Date.now, 2);
  const probe = () => Promise.resolve(check);
  const first = cache.get(1, 'first', [], probe);
  await first;
  await cache.get(1, 'second', [], probe);
  assertStrictEquals(cache.get(1, 'first', [], probe), first);
  await cache.get(1, 'third', [], probe);
  let calls = 0;
  await cache.get(1, 'second', [], () => {
    calls++;
    return Promise.resolve(check);
  });
  assertEquals(calls, 1);
});

Deno.test('unexpected probe failures are evicted and can be retried', async () => {
  const cache = new CompatibilityCache();
  await assertRejects(() => cache.get(1, check.key, [], () => Promise.reject(new Error('failed'))));
  assertEquals((await cache.get(1, check.key, [], () => Promise.resolve(check))).check, check);
});
