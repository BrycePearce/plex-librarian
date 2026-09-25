import { assertEquals } from '@std/assert';
Deno.env.set('DB_PATH', ':memory:');
const { completeHistoricalConfigurationChange } = await import('./historicalSetupMutation.ts');

Deno.test('successful connection writes invalidate before setup and do not race legacy discovery', async () => {
  const events: string[] = [];
  await completeHistoricalConfigurationChange(1, { serverId: 1, instanceIds: [8, 8, 9] }, {
    invalidate: (server) => {
      events.push(`invalidate:${server}`);
    },
    setup: (server, id) => {
      events.push(`setup:${server}:${id}`);
      return Promise.resolve();
    },
    legacy: (server) => {
      events.push(`legacy:${server}`);
      return Promise.resolve();
    },
  });
  assertEquals(events, ['invalidate:1', 'setup:1:8', 'setup:1:9']);
});

Deno.test('other configuration mutations retain legacy access checks without probing new setup', async () => {
  const events: string[] = [];
  await completeHistoricalConfigurationChange(2, undefined, {
    invalidate: (server) => {
      events.push(`invalidate:${server}`);
    },
    setup: () => {
      events.push('setup');
      return Promise.resolve();
    },
    legacy: (server) => {
      events.push(`legacy:${server}`);
      return Promise.resolve();
    },
  });
  assertEquals(events, ['invalidate:2', 'legacy:2']);
});
