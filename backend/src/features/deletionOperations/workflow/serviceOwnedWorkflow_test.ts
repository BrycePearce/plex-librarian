import { assertEquals, assertThrows } from '@std/assert';
import type { DeletionWorkTarget } from '../core/types.ts';
import { assertRejects } from '@std/assert';
import { planServiceOwnedRetention } from '../../mediaDeletion/serviceOwnedRetention.ts';
import type { ServiceOwnedAction } from '../../mediaDeletion/serviceOwnedRetention.ts';
import { ArrClient } from '../../../integrations/arr/client.ts';

// Every imported DB consumer uses this process-local database. No service/network fixture.
Deno.env.set('DB_PATH', ':memory:');
const { withTransaction } = await import('../../../db/index.ts');
const { finalizeRetainedPlexTarget, markHeldServiceTarget } = await import(
  './plexReconciliation.ts'
);
const {
  executeServiceOwnedActions,
  assertServiceOwnedContinuation,
  collectStableServiceOwnedScope,
  ensureServiceOwnedEpisodeMonitoring,
  ensureServiceOwnedDeletion,
  serviceOwnedAbsenceSources,
  assertServiceOwnedCatalogEmpty,
} = await import(
  './serviceOwnedWorkflow.ts'
);
type Attempt = import('./serviceOwnedWorkflow.ts').ServiceOwnedAttempt;
type Plan = import('../../mediaDeletion/serviceOwnedPlanning.ts').ServiceOwnedPlan;

Deno.test('unavailable continuation reads settle without replaying service mutations', async () => {
  let reads = 0;
  const delays: number[] = [];
  const result = await collectStableServiceOwnedScope(
    () => Promise.resolve({ actions: [{ presence: ++reads < 3 ? 'unknown' : 'current' }] }),
    (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  );
  assertEquals(reads, 3);
  assertEquals(delays, [500, 1500]);
  assertEquals(result.actions[0].presence, 'current');
  reads = 0;
  const failed = await collectStableServiceOwnedScope(
    () => {
      reads++;
      return Promise.resolve({ actions: [{ presence: 'unknown' }] });
    },
    () => Promise.resolve(),
  );
  assertEquals(reads, 3);
  assertEquals(failed.actions[0].presence, 'unknown');
  reads = 0;
  await collectStableServiceOwnedScope(
    () => {
      reads++;
      return Promise.resolve({ actions: [{ presence: 'current', id: 'new-scope' }] });
    },
    () => {
      throw new Error('Real scope changes must not be retried');
    },
  );
  assertEquals(reads, 1);
});
type PlannedAction =
  import('../../mediaDeletion/serviceOwnedPlanning.ts').ServiceOwnedPlannedAction;

Deno.test('partial season membership coverage rejects legacy policy and unknown or unsafe sizes', async () => {
  const { assertWholeSeasonPlexMembership } = await import('../core/validation.ts');
  const client = {
    seasonEpisodeMembership: () => Promise.resolve([]),
  } as unknown as import('../../../integrations/plex/client.ts').PlexClient;
  for (const policyVersion of [3, 4]) {
    for (const byteSize of [null, 0, -1, Number.MAX_SAFE_INTEGER + 1, 10]) {
      const snapshot = {
        ratingKey: 'season',
        type: 'season',
        wholeSeasonRemoval: {
          plexEpisodes: [{
            ratingKey: 'episode',
            title: 'E1',
            showRatingKey: 'show',
            seasonRatingKey: 'season',
            seasonIndex: 1,
            episodeIndex: 1,
            media: [{ mediaId: 1, paths: [{ path: '/tv/e1.mkv', byteSize }] }],
          }],
        },
        serviceOwnedPlan: {
          policyVersion,
          actions: [{
            id: 'arr',
            service: 'sonarr',
            files: [{ path: '/tv/e1.mkv', size: byteSize }],
          }],
          retention: { decisions: [{ actionId: 'arr', state: 'delete_candidate' }] },
        },
        serviceOwnedAttempts: {
          arr: {
            response: { status: 'succeeded', httpStatus: 204 },
            outcome: { status: 'target_absent', observedAt: 1 },
          },
        },
      } as unknown as import('../core/validation.ts').DurableTargetSnapshot;
      if (policyVersion === 4 && byteSize === 10) {
        await assertWholeSeasonPlexMembership(client, snapshot);
      } else await assertRejects(() => assertWholeSeasonPlexMembership(client, snapshot));
    }
  }
});

Deno.test('completed Sonarr deletion cannot unmonitor a replacement imported before monitoring or its write', async () => {
  for (const importedDuringRevalidation of [false, true]) {
    let episodeFileId = importedDuringRevalidation ? 0 : 999;
    let writes = 0;
    const identity = { seriesId: 2, episodeId: 3, seasonNumber: 1, episodeNumber: 2 };
    const client = new ArrClient(
      'sonarr',
      'http://sonarr.invalid',
      'test',
      ((_input, init) => {
        if (init?.method === 'PUT') writes++;
        return Promise.resolve(Response.json({
          id: 3,
          seriesId: 2,
          seasonNumber: 1,
          episodeNumber: 2,
          monitored: true,
          episodeFileId,
        }));
      }) as typeof fetch,
    );
    const action: PlannedAction = {
      id: 'arr:1:file:10',
      service: 'sonarr',
      serviceKey: 'arr:1',
      targetId: '10',
      presence: 'current',
      selected: true,
      effectsComplete: true,
      entries: [],
      files: [],
      recordId: 2,
      fileId: 10,
      episodes: [{ id: 3, monitored: true, seasonNumber: 1, episodeNumber: 2 }],
    };
    await assertRejects(
      () =>
        ensureServiceOwnedEpisodeMonitoring(action, {
          startedAt: 1,
          response: { status: 'succeeded', httpStatus: 204 },
          outcome: { status: 'target_absent', observedAt: 2 },
        }, {
          save() {},
          revalidate() {
            episodeFileId = 999;
            return Promise.resolve();
          },
          async monitored() {
            return (await client.sonarrEpisodeMonitorTarget(identity, true)).monitored;
          },
          unmonitor: (_episode, record) =>
            client.setSonarrEpisodeMonitored(identity, false, record, true),
        }),
      Error,
      'monitoring is held',
    );
    assertEquals(writes, 0);
  }
});

Deno.test('catalog cleanup holds a newly imported Sonarr file after accepted file IDs disappeared', async () => {
  let cleanupRequests = 0;
  const cleanup = async (
    read: Parameters<typeof assertServiceOwnedCatalogEmpty>[0],
  ) => {
    await assertServiceOwnedCatalogEmpty(read);
    cleanupRequests++;
  };
  // The former accepted file may be absent while a different current ID exists.
  await assertRejects(
    () =>
      cleanup(() =>
        Promise.resolve({
          files: [{ id: 999 }],
          episodes: [{ episodeFileId: 999 }],
        })
      ),
    Error,
    'Managed files appeared',
  );
  // Also reject a file/episode inventory that has not converged yet.
  await assertRejects(
    () =>
      cleanup(() =>
        Promise.resolve({
          files: [],
          episodes: [{ episodeFileId: 999 }],
        })
      ),
    Error,
    'Managed files appeared',
  );
  await assertRejects(() => cleanup(() => Promise.reject(new Error('read unavailable'))));
  assertEquals(cleanupRequests, 0);
  await cleanup(() => Promise.resolve({ files: [], episodes: [{ episodeFileId: 0 }] }));
  assertEquals(cleanupRequests, 1);
});

Deno.test('service absence coverage requires recorded exact files and never covers a QB payload or catalog action', () => {
  const target: PlannedAction = {
    ...actionFixture().actions[0],
    serviceKey: 'plex',
    files: [{ path: '/media/a.mkv', size: 10 }, { path: '/media/b.mkv', size: 20 }],
  };
  const source: PlannedAction = {
    ...target,
    id: 'source',
    service: 'qb',
    serviceKey: 'qb',
  };
  const attempts: Record<string, Attempt> = {
    source: {
      startedAt: 1,
      response: { status: 'accepted', httpStatus: 200 },
      outcome: { status: 'target_absent', observedAt: 2 },
    },
  };
  const sources = (a = target, s = source, completed = new Set(['source'])) =>
    serviceOwnedAbsenceSources(a, [a, s], attempts, completed);
  assertEquals(sources(), ['source']);
  assertEquals(sources(target, { ...source, files: source.files.slice(0, 1) }), undefined);
  assertEquals(
    sources(target, {
      ...source,
      files: source.files.map((f) => ({ ...f, path: '/other' + f.path })),
    }),
    undefined,
  );
  assertEquals(sources({ ...target, files: [{ path: '/media/a.mkv', size: null }] }), undefined);
  assertEquals(sources({ ...target, catalogOnly: true }), undefined);
  assertEquals(sources({ ...target, service: 'qb' }), undefined);
  assertEquals(sources(target, { ...source, catalogOnly: true }), undefined);
  assertEquals(sources(target, source, new Set()), undefined);
  delete attempts.source.response;
  assertEquals(sources(), undefined);
});

Deno.test('earlier confidence snapshots remain held without rewriting uncertain attempts', async () => {
  const { serviceOwnedPlanFingerprint } = await import(
    '../../mediaDeletion/serviceOwnedPlanning.ts'
  );
  const fixture = actionFixture();
  const evidence = {
    ...fixture,
    policyVersion: 4 as const,
    serverId: 1,
    libraryKey: 'movies',
    selection: { ratingKey: '1', type: 'movie', title: 'Fixture', tmdbId: 1, tvdbId: null },
    arrSelected: false,
    qbSelected: false,
    connections: [],
    plexFiles: [],
    evidenceRevision: 'old',
    actions: fixture.actions.map((a) => ({ ...a, serviceKey: 'plex:movies', files: [] })),
  };
  const plan: Plan = { ...evidence, fingerprint: serviceOwnedPlanFingerprint(evidence) };
  for (const attempted of [false, true]) {
    const snapshot = {
      libraryKey: 'movies',
      ratingKey: '1',
      serviceOwnedPlan: plan,
      serviceOwnedAttempts: attempted ? { 'plex:1': { startedAt: 1, error: 'Lost response' } } : {},
    } as unknown as import('../core/validation.ts').DurableTargetSnapshot;
    const before = JSON.stringify(snapshot);
    await assertRejects(
      () => ensureServiceOwnedDeletion({ serverId: 1 } as DeletionWorkTarget, snapshot),
      Error,
      'Invalid accepted service-owned scope',
    );
    assertEquals(JSON.stringify(snapshot), before);
  }
});

Deno.test('post-file Sonarr unmonitoring persists responses and resumes without repeating writes', async () => {
  for (const mode of ['success', 'delayed', 'read-failure', 'lost']) {
    const action: PlannedAction = {
      id: 'arr:1:file:10',
      service: 'sonarr',
      serviceKey: 'arr:1',
      targetId: '10',
      presence: 'current',
      selected: true,
      effectsComplete: true,
      entries: [],
      files: [],
      recordId: 2,
      fileId: 10,
      episodes: [{ id: 3, monitored: true, seasonNumber: 1, episodeNumber: 2 }],
    };
    const attempt: Attempt = {
      startedAt: 1,
      response: { status: 'succeeded', httpStatus: 204 },
      outcome: { status: 'target_absent', observedAt: 2 },
    };
    let monitored = true, writes = 0, failedRead = false;
    const runtime = {
      save() {},
      async revalidate() {},
      monitored() {
        if (failedRead) return Promise.reject(new Error('read failed'));
        return Promise.resolve(monitored);
      },
      unmonitor(
        episode: { id: number },
        record: (r: { status: 'succeeded'; httpStatus: number }) => void,
      ) {
        assertEquals(episode.id, 3);
        assertEquals(attempt.monitoring?.['3'].response, undefined);
        writes++;
        if (mode !== 'delayed') monitored = false;
        if (mode === 'lost') return Promise.reject(new Error('lost PUT response'));
        record({ status: 'succeeded', httpStatus: 200 });
        if (mode === 'read-failure') failedRead = true;
        return Promise.resolve(true);
      },
    };
    if (mode === 'success') await ensureServiceOwnedEpisodeMonitoring(action, attempt, runtime);
    else await assertRejects(() => ensureServiceOwnedEpisodeMonitoring(action, attempt, runtime));
    failedRead = false;
    monitored = false;
    if (mode === 'lost') {
      await assertRejects(
        () => ensureServiceOwnedEpisodeMonitoring(action, attempt, runtime),
        Error,
        'uncertain',
      );
      assertEquals(attempt.monitoring?.['3'].observedAt, undefined);
    } else {
      await ensureServiceOwnedEpisodeMonitoring(action, attempt, runtime);
      assertEquals(typeof attempt.monitoring?.['3'].observedAt, 'number');
    }
    assertEquals(writes, 1);
  }
});

Deno.test('Sonarr monitoring cannot run for retained, failed, or catalog-only deletion', async () => {
  const action: PlannedAction = {
    id: 'arr:1',
    service: 'sonarr',
    serviceKey: 'arr:1',
    targetId: '1',
    presence: 'current',
    effectsComplete: true,
    files: [],
    entries: [],
    episodes: [{ id: 1, monitored: true, seasonNumber: 1, episodeNumber: 1 }],
  };
  const runtime = {
    save() {
      throw new Error('Unexpected save');
    },
    revalidate() {
      throw new Error('Unexpected validation');
    },
    monitored() {
      throw new Error('Unexpected read');
    },
    unmonitor() {
      throw new Error('Unexpected write');
    },
  };
  await assertRejects(
    () => ensureServiceOwnedEpisodeMonitoring(action, { startedAt: 1 }, runtime),
    Error,
    'not confirmed',
  );
  await ensureServiceOwnedEpisodeMonitoring(
    { ...action, catalogOnly: true },
    { startedAt: 1 },
    runtime,
  );
  await ensureServiceOwnedEpisodeMonitoring(
    { ...action, recordCleanup: { deleteFiles: false, addImportExclusion: false } },
    { startedAt: 1 },
    runtime,
  );
});

function actionFixture(retained = false) {
  const actions: ServiceOwnedAction[] = [{
    id: 'plex:1',
    service: 'plex',
    targetId: '1',
    presence: 'current',
    entries: [{ id: 'plex-file', path: '/media/a.mkv' }],
    effectsComplete: true,
  }];
  if (retained) {
    actions.push({
      id: 'qb:hash',
      service: 'qb',
      targetId: 'hash',
      presence: 'current',
      selected: false,
      entries: [{ id: 'qb-file', path: '/media/a.mkv' }],
      effectsComplete: true,
    });
  }
  return {
    actions,
    retention: planServiceOwnedRetention({
      actions,
      retainedEntries: [],
      evidenceRevision: 'test',
      qbInventory: retained ? 'complete' : 'unconfigured',
    }),
  };
}

Deno.test('partial Plex effects require exact recorded native coverage without accepting other scope changes', async () => {
  const files = [{ path: '/media/one.mkv', size: 10 }, { path: '/media/two.mkv', size: 20 }];
  const plex: PlannedAction = {
    ...actionFixture().actions[0],
    serviceKey: 'plex:1',
    files,
    entries: files.map((file) => ({ id: `plex:${file.path}`, path: file.path })),
  };
  const sonarr: PlannedAction = {
    ...plex,
    id: 'arr:1:file:1',
    service: 'sonarr',
    serviceKey: 'arr:1',
    targetId: '1',
    selected: true,
    files: [files[0]],
    entries: [{ id: 'arr:/media/one.mkv', path: files[0].path }],
  };
  const actions = [plex, sonarr];
  const accepted: Plan = {
    policyVersion: 4,
    serverId: 1,
    libraryKey: 'tv',
    selection: { ratingKey: '1', type: 'season', title: 'S1', tmdbId: null, tvdbId: 1 },
    arrSelected: true,
    qbSelected: false,
    connections: [],
    actions,
    retention: planServiceOwnedRetention({
      actions,
      retainedEntries: [],
      evidenceRevision: 'x',
      qbInventory: 'unconfigured',
    }),
    plexFiles: files,
    fingerprint: 'x',
    evidenceRevision: 'x',
  };
  const current = structuredClone(accepted);
  current.actions = [structuredClone(plex)];
  current.actions[0].files = [files[1]];
  current.actions[0].entries = [plex.entries[1]];
  const completed = new Set([sonarr.id]);
  const attempts: Record<string, Attempt> = {
    [sonarr.id]: {
      startedAt: 1,
      response: { status: 'succeeded', httpStatus: 204 },
      outcome: { status: 'target_absent', observedAt: 2 },
    },
  };
  await assertServiceOwnedContinuation(accepted, current, completed, attempts);
  const unavailableScope = structuredClone(current);
  unavailableScope.actions.push({
    ...sonarr,
    id: 'arr:1:selection:1',
    presence: 'unknown',
    unavailableReason: 'Stable inventory is unavailable',
  });
  await assertRejects(
    () => assertServiceOwnedContinuation(accepted, unavailableScope, completed, attempts),
    Error,
    'inventory could not be verified',
  );
  const addedScope = structuredClone(current);
  addedScope.actions.push({ ...sonarr, id: 'arr:1:file:new', presence: 'current' });
  await assertRejects(
    () => assertServiceOwnedContinuation(accepted, addedScope, completed, attempts),
    Error,
    'New service scope appeared after confirmation',
  );
  for (
    const change of [
      'response',
      'outcome',
      'completed',
      'coverage',
      'added',
      'rename',
      'size',
      'unexplained',
    ]
  ) {
    const altered = structuredClone(current), evidence = structuredClone(attempts);
    const original = structuredClone(accepted);
    if (change === 'response') delete evidence[sonarr.id].response;
    if (change === 'outcome') delete evidence[sonarr.id].outcome;
    if (change === 'coverage') original.actions[1].files = [{ ...files[0], size: 999 }];
    if (change === 'added') altered.actions[0].files.push({ path: '/media/new.mkv', size: 30 });
    if (change === 'rename') altered.actions[0].files[0].path = '/media/renamed.mkv';
    if (change === 'size') altered.actions[0].files[0].size = 999;
    if (change === 'unexplained') {
      altered.actions[0].files = [];
      altered.actions[0].entries = [];
    }
    await assertRejects(
      () =>
        assertServiceOwnedContinuation(
          original,
          altered,
          change === 'completed' ? new Set() : completed,
          evidence,
        ),
      Error,
      undefined,
      change,
    );
  }
  assertEquals(accepted.actions[0].files, files);

  // Both accepted files disappeared, but the original container still needs its
  // own native DELETE. Empty new previews remain held by the retention planner.
  const allCovered = structuredClone(accepted);
  allCovered.actions[1].files = structuredClone(files);
  const empty = structuredClone(current);
  empty.actions[0].files = [];
  empty.actions[0].entries = [];
  empty.retention = planServiceOwnedRetention({
    actions: empty.actions,
    retainedEntries: [],
    evidenceRevision: 'x',
    qbInventory: 'unconfigured',
  });
  assertEquals(empty.retention.decisions[0].state, 'held');
  await assertServiceOwnedContinuation(allCovered, empty, completed, attempts);
  for (const drift of ['qb', 'owner', 'response', 'incomplete', 'movie']) {
    const original = structuredClone(allCovered), changed = structuredClone(empty);
    const recorded = structuredClone(attempts);
    if (drift === 'qb') changed.retention.decisions[0].reason = 'qb_inventory_unavailable';
    if (drift === 'owner') changed.actions[0].retainedOwnership = true;
    if (drift === 'response') delete recorded[sonarr.id].response;
    if (drift === 'incomplete') changed.actions[0].effectsComplete = false;
    if (drift === 'movie') original.selection.type = 'movie';
    await assertRejects(() =>
      assertServiceOwnedContinuation(original, changed, completed, recorded)
    );
  }
});

Deno.test('service continuation rejects changed effects and new ownership without widening accepted scope', async () => {
  const fixture = actionFixture();
  const accepted: Plan = {
    ...fixture,
    policyVersion: 4,
    serverId: 1,
    libraryKey: 'movies',
    selection: { ratingKey: '1', type: 'movie', title: 'Fixture', tmdbId: 1, tvdbId: null },
    arrSelected: false,
    qbSelected: false,
    connections: [],
    plexFiles: [],
    fingerprint: 'test',
    evidenceRevision: 'test',
    actions: fixture.actions.map((a) => ({ ...a, serviceKey: 'plex:movies', files: [] })),
  };
  await assertServiceOwnedContinuation(accepted, structuredClone(accepted), new Set());
  for (const change of ['files', 'ownership', 'connection']) {
    const current = structuredClone(accepted);
    if (change === 'files') current.actions[0].files.push({ path: '/new/file', size: 1 });
    if (change === 'ownership') current.actions.push({ ...current.actions[0], id: 'other-owner' });
    if (change === 'connection') {
      current.connections.push({ key: 'qb:new', configurationIdentity: 'new' });
    }
    await assertRejects(() => assertServiceOwnedContinuation(accepted, current, new Set()));
  }
});

Deno.test('service action loop performs no deletion for retained Plex', async () => {
  let validations = 0;
  await executeServiceOwnedActions(actionFixture(true), {}, {
    save() {
      throw new Error('Unexpected checkpoint');
    },
    revalidate() {
      validations++;
      return Promise.resolve();
    },
    present() {
      throw new Error('Unexpected service read');
    },
    mutate() {
      throw new Error('Unexpected mutation');
    },
  });
  assertEquals(validations, 1);
});

Deno.test('service action loop cannot mutate held evidence or changed execution ownership', async () => {
  for (const held of [true, false]) {
    const plan = actionFixture();
    if (held) plan.retention.decisions[0].state = 'held';
    await assertRejects(
      () =>
        executeServiceOwnedActions(plan, {}, {
          save() {
            throw new Error('Unexpected checkpoint');
          },
          revalidate() {
            return Promise.reject(new Error('Ownership changed'));
          },
          present() {
            throw new Error('Unexpected service read');
          },
          mutate() {
            throw new Error('Unexpected mutation');
          },
        }),
      Error,
      'Ownership changed',
    );
  }
});

Deno.test('service action loop executes independent candidates while preserving held decisions', async () => {
  for (const heldService of ['plex', 'radarr'] as const) {
    const candidateService = heldService === 'plex' ? 'radarr' : 'plex';
    const actions: ServiceOwnedAction[] = [
      {
        id: 'held',
        targetId: 'held',
        service: heldService,
        presence: 'unknown',
        selected: true,
        entries: [],
        effectsComplete: false,
      },
      {
        id: 'eligible',
        targetId: 'eligible',
        service: candidateService,
        presence: 'current',
        selected: true,
        entries: [{ id: 'eligible-file', path: '/media/eligible' }],
        effectsComplete: true,
      },
    ];
    const plan = {
      actions,
      retention: planServiceOwnedRetention({
        actions,
        retainedEntries: [],
        evidenceRevision: 'test',
        qbInventory: 'unconfigured',
      }),
    };
    const attempts: Record<string, Attempt> = {};
    let exists = true;
    await executeServiceOwnedActions(plan, attempts, {
      save() {},
      async revalidate() {},
      present(action) {
        assertEquals(action.id, 'eligible');
        return Promise.resolve(exists);
      },
      mutate(action, record) {
        assertEquals(action.id, 'eligible');
        exists = false;
        record({ status: 'succeeded', httpStatus: 204 });
        return Promise.resolve();
      },
    });
    assertEquals(Object.keys(attempts), ['eligible']);
    assertEquals(plan.retention.decisions.find((d) => d.actionId === 'held')?.state, 'held');
  }
});

Deno.test('service action loop persists acceptance and resumes only after a fresh postcondition', async () => {
  const attempts: Record<string, Attempt> = {};
  let present = true, readsFail = false, deletes = 0, saves = 0;
  const runtime = {
    save() {
      saves++;
    },
    async revalidate() {},
    present() {
      if (readsFail) return Promise.reject(new Error('read failed'));
      return Promise.resolve(present);
    },
    mutate(
      _action: ServiceOwnedAction,
      record: (r: { status: 'accepted'; httpStatus: number }) => void,
    ) {
      assertEquals(attempts['plex:1'].response, undefined);
      deletes++;
      record({ status: 'accepted', httpStatus: 202 });
      return Promise.resolve();
    },
  };
  await assertRejects(() => executeServiceOwnedActions(actionFixture(), attempts, runtime));
  assertEquals(attempts['plex:1'].outcome, undefined);
  readsFail = true;
  await assertRejects(() => executeServiceOwnedActions(actionFixture(), attempts, runtime));
  readsFail = false;
  present = false;
  await executeServiceOwnedActions(actionFixture(), attempts, runtime);
  assertEquals(deletes, 1);
  assertEquals(attempts['plex:1'].outcome?.status, 'target_absent');
  assertEquals(saves, 3);
});

Deno.test('service action loop never replays a lost response or treats absence as its success', async () => {
  const attempts: Record<string, Attempt> = {};
  let deletes = 0;
  const runtime = {
    save() {},
    async revalidate() {},
    present() {
      return Promise.resolve(deletes === 0);
    },
    mutate() {
      deletes++;
      return Promise.reject(new Error('lost response'));
    },
  };
  await assertRejects(() => executeServiceOwnedActions(actionFixture(), attempts, runtime));
  await assertRejects(() => executeServiceOwnedActions(actionFixture(), attempts, runtime));
  assertEquals(deletes, 1);
  assertEquals(attempts['plex:1'].response, undefined);
  assertEquals(attempts['plex:1'].outcome, undefined);
});

Deno.test('shared-entry catalog absence reconciles separately without inventing a Plex response', async () => {
  const plan = actionFixture(true);
  plan.actions[1].selected = true;
  plan.retention = planServiceOwnedRetention({
    actions: plan.actions,
    retainedEntries: [],
    evidenceRevision: 'test',
    qbInventory: 'complete',
  });
  const attempts: Record<string, Attempt> = {};
  let deleted = false;
  const calls: string[] = [];
  const runtime = {
    save() {},
    async revalidate() {},
    present() {
      return Promise.resolve(!deleted);
    },
    mutate(
      action: ServiceOwnedAction,
      record: (r: { status: 'accepted'; httpStatus: number }) => void,
    ) {
      calls.push(action.id);
      deleted = true;
      record({ status: 'accepted', httpStatus: 200 });
      return Promise.resolve();
    },
    reconcileAbsent(action: ServiceOwnedAction, completed: ReadonlySet<string>) {
      return Promise.resolve(
        action.service === 'plex' && completed.has('qb:hash') ? ['qb:hash'] : undefined,
      );
    },
  };
  await executeServiceOwnedActions(plan, attempts, runtime);
  await executeServiceOwnedActions(plan, attempts, runtime);
  assertEquals(calls, ['qb:hash']);
  assertEquals(attempts['plex:1'].response, undefined);
  assertEquals(attempts['plex:1'].reconciliation?.sourceActionIds, ['qb:hash']);
  assertEquals(attempts['plex:1'].outcome?.status, 'target_absent');
});

Deno.test('retained Plex finalization preserves catalog and removal accounting while releasing reservations', () => {
  withTransaction((client) => {
    client.exec(`
      CREATE TABLE deletion_targets (
        id INTEGER PRIMARY KEY, status TEXT, phase TEXT, next_retry_at INTEGER,
        error TEXT, warning TEXT, storage_outcome TEXT, verified_hardlink_data_size INTEGER,
        storage_outcome_reasons TEXT, updated_at INTEGER, removal_confirmed_at INTEGER
      );
      CREATE TABLE media_version_reservations (target_id INTEGER);
      CREATE TABLE radarr_movie_reservations (target_id INTEGER);
      CREATE TABLE items (rating_key TEXT, file_size INTEGER);
      CREATE TABLE media_removals (target_key TEXT);
      INSERT INTO deletion_targets (id, status, phase) VALUES (1, 'running', 'validating');
      INSERT INTO media_version_reservations VALUES (1), (2);
      INSERT INTO radarr_movie_reservations VALUES (1), (2);
      INSERT INTO items VALUES ('selected', 100), ('sentinel', 200);
    `);
    const target = { id: 1 } as DeletionWorkTarget;
    finalizeRetainedPlexTarget(client, target);
    assertEquals(
      client.prepare(
        'SELECT status, phase, removal_confirmed_at, verified_hardlink_data_size FROM deletion_targets',
      ).values(),
      [['completed_with_warning', 'finalizing', null, 0]],
    );
    assertEquals(client.prepare('SELECT * FROM items').values(), [['selected', 100], [
      'sentinel',
      200,
    ]]);
    assertEquals(client.prepare('SELECT * FROM media_removals').values(), []);
    assertEquals(client.prepare('SELECT * FROM media_version_reservations').values(), [[2]]);
    assertEquals(client.prepare('SELECT * FROM radarr_movie_reservations').values(), [[2]]);
    assertThrows(() => finalizeRetainedPlexTarget(client, target));
    client.prepare(
      "INSERT INTO deletion_targets (id, status, phase) VALUES (2, 'running', 'validating')",
    ).run();
    markHeldServiceTarget(client, { id: 2 } as DeletionWorkTarget);
    assertEquals(
      client.prepare('SELECT status, removal_confirmed_at FROM deletion_targets WHERE id=2')
        .values(),
      [['needs_attention', null]],
    );
    assertEquals(client.prepare('SELECT * FROM items').values(), [['selected', 100], [
      'sentinel',
      200,
    ]]);
    assertEquals(client.prepare('SELECT * FROM media_removals').values(), []);
    assertEquals(client.prepare('SELECT * FROM media_version_reservations').values(), [[2]]);
  });
});
