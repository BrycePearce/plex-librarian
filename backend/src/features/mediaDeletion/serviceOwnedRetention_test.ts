import { deepStrictEqual as equal, throws } from 'node:assert/strict';
import {
  planServiceOwnedRetention,
  type ServiceOwnedAction,
  type ServiceOwnedEntry,
  type ServiceOwnedRetentionInput,
  summarizeServiceOwnedRetention,
} from './serviceOwnedRetention.ts';

const entry = (path: string, id = path): ServiceOwnedEntry => ({ id, path });
function action(
  id: string,
  service: ServiceOwnedAction['service'],
  paths = [`/${id}`],
  selected?: boolean,
): ServiceOwnedAction {
  return {
    id,
    service,
    targetId: `${service}:instance:${id}`,
    selected,
    presence: 'current',
    entries: paths.map((p) => entry(p)),
    effectsComplete: true,
  };
}
function plan(actions: ServiceOwnedAction[], extra: Partial<ServiceOwnedRetentionInput> = {}) {
  return planServiceOwnedRetention({
    evidenceRevision: 'revision-1',
    actions,
    retainedEntries: [],
    qbInventory: 'complete',
    ...extra,
  });
}
const states = (result: ReturnType<typeof plan>) =>
  Object.fromEntries(result.decisions.map((d) => [d.actionId, d.state]));

Deno.test('alias evidence propagates through equal paths observed by different services', () => {
  for (const relation of ['same', 'unknown'] as const) {
    const p = { ...action('p', 'plex'), entries: [entry('/shared', 'plex-entry')] };
    const a = { ...action('a', 'sonarr'), entries: [entry('/shared', 'arr-entry')] };
    const q = { ...action('q', 'qb'), entries: [entry('/download', 'qb-entry')] };
    equal(
      states(plan([p, a, q], {
        relationships: [{
          leftEntryId: 'arr-entry',
          rightEntryId: 'qb-entry',
          relation,
          evidenceId: 'observed-alias',
          evidenceRevision: 'revision-1',
        }],
      })),
      { p: relation === 'same' ? 'kept' : 'held', a: 'kept', q: 'kept' },
    );
  }
});
function distinct(leftEntryId: string, rightEntryId: string) {
  return {
    leftEntryId,
    rightEntryId,
    relation: 'distinct' as const,
    evidenceId: 'service-relationship-proof',
    evidenceRevision: 'revision-1',
  };
}

Deno.test('Plex defaults on and each optional destination defaults unchecked', () => {
  equal(
    states(
      plan([
        action('p', 'plex', ['/p'], false),
        action('s', 'sonarr'),
        action('r', 'radarr'),
        action('q', 'qb'),
      ], {
        relationships: [distinct('/p', '/q')],
      }),
    ),
    { p: 'delete_candidate', s: 'kept', r: 'kept', q: 'kept' },
  );
});

Deno.test('complete absent or unconfigured QB does not block selected Plex and Arr', () => {
  for (const qbInventory of ['complete', 'unconfigured'] as const) {
    const q = { ...action('q', 'qb', [], true), presence: 'absent' as const };
    const p = plan([action('p', 'plex'), action('s', 'sonarr', ['/s'], true), q], { qbInventory });
    equal(states(p), { p: 'delete_candidate', s: 'delete_candidate', q: 'not_applicable' });
    equal(
      summarizeServiceOwnedRetention(p, { p: 'succeeded', s: 'succeeded' }).status,
      'completed',
    );
  }
});

Deno.test('all selected destinations with complete effects are candidates', () => {
  equal(
    states(
      plan([
        action('p', 'plex'),
        action('s', 'sonarr', ['/s'], true),
        action('r', 'radarr', ['/r'], true),
        action('q', 'qb', ['/q'], true),
      ]),
    ),
    { p: 'delete_candidate', s: 'delete_candidate', r: 'delete_candidate', q: 'delete_candidate' },
  );
});

Deno.test('retained QB vetoes Plex and Sonarr and cannot produce removal accounting', () => {
  const p = plan([
    action('p', 'plex', ['/same']),
    action('s', 'sonarr', ['/same'], true),
    action('q', 'qb', ['/same']),
  ]);
  equal(states(p), { p: 'kept', s: 'kept', q: 'kept' });
  equal(summarizeServiceOwnedRetention(p, { p: 'succeeded', s: 'succeeded' }), {
    status: 'completed_with_retention',
    succeededActionIds: [],
    keptActionIds: ['p', 's', 'q'],
    plexRemovalActionIds: [],
  });
});

Deno.test('trusted distinct-entry evidence permits separate Plex while Arr stays retained', () => {
  const p = plan([action('p', 'plex'), action('s', 'sonarr', ['/q'], true), action('q', 'qb')], {
    relationships: [distinct('/p', '/q')],
  });
  equal(states(p), { p: 'delete_candidate', s: 'kept', q: 'kept' });
  equal(summarizeServiceOwnedRetention(p, { p: 'succeeded' }).plexRemovalActionIds, ['p']);
});

Deno.test('different retained file paths do not create a hypothetical alias hold', () => {
  const p = plan([action('p', 'plex'), action('q', 'qb')]);
  equal(states(p), { p: 'delete_candidate', q: 'kept' });
  equal(p.authorizesDeletion, false);
  equal(summarizeServiceOwnedRetention(p, { p: 'succeeded' }).status, 'completed_with_retention');
});

Deno.test('trusted alias relationship vetoes differently named Plex entry', () => {
  equal(
    states(plan([action('p', 'plex'), action('q', 'qb')], {
      relationships: [{ ...distinct('/p', '/q'), relation: 'same' }],
    })),
    { p: 'kept', q: 'kept' },
  );
});

Deno.test('whole jobs cascade retention to a fixed point in any action order', () => {
  const actions = [
    action('p', 'plex', ['/c']),
    action('q2', 'qb', ['/a', '/c'], true),
    action('q1', 'qb', ['/a', '/b'], true),
  ];
  for (const ordered of [actions, [...actions].reverse(), [actions[1], actions[0], actions[2]]]) {
    const p = plan(ordered, {
      retainedEntries: [entry('/b')],
      relationships: [distinct('/a', '/b'), distinct('/a', '/c'), distinct('/b', '/c')],
    });
    equal(p.decisions.every((d) => d.state === 'kept'), true);
    equal(p.rounds, 3);
  }
});

Deno.test('unknown aliases cascading into known overlaps classify independent of order', () => {
  const actions = [action('p', 'plex', ['/a']), action('s', 'sonarr', ['/a', '/b'], true)];
  for (const ordered of [actions, [...actions].reverse()]) {
    const p = plan(ordered, {
      retainedEntries: [entry('/c')],
      relationships: [{ ...distinct('/a', '/c'), relation: 'unknown' }],
    });
    equal(states(p), ordered === actions ? { p: 'held', s: 'held' } : { s: 'held', p: 'held' });
  }
});

Deno.test('one overlapping multipart or associated extra retains the whole atomic action', () => {
  for (const service of ['plex', 'sonarr', 'radarr'] as const) {
    const p = plan([action('a', service, ['/movie', '/subtitle'], true)], {
      retainedEntries: [entry('/subtitle')],
    });
    equal(states(p), { a: 'kept' });
  }
});

Deno.test('failed and incomplete QB inventory hold deletion; absence is never inferred', () => {
  for (const qbInventory of ['failed', 'incomplete'] as const) {
    equal(
      states(plan([action('p', 'plex'), action('r', 'radarr', ['/r'], true)], { qbInventory })),
      { p: 'held', r: 'held' },
    );
  }
});

Deno.test('incomplete or unknown QB scope holds even when its option is unchecked', () => {
  for (const selected of [false, true]) {
    for (const presence of ['current', 'unknown'] as const) {
      const q = { ...action('q', 'qb', [], selected), presence, effectsComplete: false };
      equal(states(plan([action('p', 'plex'), q])).p, 'held');
    }
  }
});

Deno.test('unknown target and incomplete selected action effects are explicit holds', () => {
  const p = plan([{ ...action('p', 'plex'), presence: 'unknown' }, {
    ...action('s', 'sonarr', ['/s'], true),
    effectsComplete: false,
  }]);
  equal(states(p), { p: 'held', s: 'held' });
});

Deno.test('held atomic actions retain their known effects and veto other actions', () => {
  const p = plan([action('p', 'plex', ['/same']), {
    ...action('s', 'sonarr', ['/same'], true),
    effectsComplete: false,
  }]);
  equal(states(p), { p: 'kept', s: 'held' });
  equal(summarizeServiceOwnedRetention(p, {}).status, 'needs_attention');
});

Deno.test('accepted and uncertain requests cannot report successful service deletion', () => {
  const p = plan([action('q', 'qb', ['/q'], true)]);
  for (const outcome of ['accepted', 'uncertain', 'failed'] as const) {
    const result = summarizeServiceOwnedRetention(p, { q: outcome });
    equal(result.status, outcome === 'accepted' ? 'pending' : 'needs_attention');
    equal(result.succeededActionIds, []);
  }
  equal(summarizeServiceOwnedRetention(p, {}).status, 'pending');
});

Deno.test('rejects stale, contradictory and dangling relationship evidence', () => {
  const actions = [action('p', 'plex'), action('q', 'qb')];
  throws(() =>
    plan(actions, { relationships: [{ ...distinct('/p', '/q'), evidenceRevision: 'old' }] })
  );
  throws(() => plan(actions, { relationships: [distinct('/p', '/missing')] }));
  throws(() =>
    plan(actions, {
      relationships: [distinct('/p', '/q'), { ...distinct('/q', '/p'), relation: 'same' }],
    })
  );
  throws(() => plan(actions, { relationships: [distinct('/p', '/p')] }));
});

Deno.test('rejects malformed effects and contradictory current ownership', () => {
  throws(() => plan([action('p', 'plex'), action('p', 'plex')]));
  throws(() => plan([action('p', 'plex', ['/a/../b'])]));
  throws(() => plan([{ ...action('p', 'plex'), presence: 'absent' }]));
  throws(() => plan([action('q', 'qb')], { qbInventory: 'unconfigured' }));
  throws(() => plan([action('p', 'plex')], { retainedEntries: [entry('/other', '/p')] }));
});

Deno.test('budget exhaustion fails without returning an executable partial decision', () => {
  throws(() =>
    plan([action('p', 'plex', ['/a', '/b'])], {
      retainedEntries: [entry('/c')],
      comparisonBudget: 1,
    }), /budget exceeded/);
});

Deno.test('policy preserves caller evidence and persists decision identifiers and revision', () => {
  const a = action('p', 'plex');
  const before = structuredClone(a);
  const p = plan([a]);
  equal(a, before);
  equal(p.decisions[0].targetId, 'plex:instance:p');
  equal(p.decisions[0].evidenceRevision, 'revision-1');
});

Deno.test('transitive aliases veto deletion and reject contradictory distinct evidence', () => {
  const actions = [action('p', 'plex', ['/a']), action('q', 'qb', ['/c'])];
  const same = (left: string, right: string) => ({
    ...distinct(left, right),
    relation: 'same' as const,
  });
  const relationships = [same('/a', '/b'), same('/b', '/c')];
  const extra = { retainedEntries: [entry('/b')], relationships };
  equal(states(plan(actions, extra)), { p: 'kept', q: 'kept' });
  for (const ordered of [relationships, [...relationships].reverse()]) {
    throws(
      () => plan(actions, { ...extra, relationships: [distinct('/a', '/c'), ...ordered] }),
      /transitive alias/,
    );
  }
});

Deno.test('canonical Windows drive and UNC paths conservatively compare case insensitively', () => {
  for (const path of ['C:\\Media\\Movie.mkv', '\\\\server\\share\\Movie.mkv']) {
    equal(
      states(plan([action('p', 'plex', [path])], {
        retainedEntries: [entry(path.toLowerCase(), 'retained')],
      })),
      { p: 'kept' },
    );
  }
});

Deno.test('unknown unchecked QB cannot summarize as completed retention', () => {
  const p = plan([{ ...action('q', 'qb', []), presence: 'unknown', effectsComplete: false }]);
  equal(states(p), { q: 'held' });
  equal(summarizeServiceOwnedRetention(p, {}).status, 'needs_attention');
});

Deno.test('Arr catalog-only actions have no file retention dependency', () => {
  const catalog = { ...action('r', 'radarr', [], true), catalogOnly: true as const };
  equal(states(plan([catalog], { qbInventory: 'failed' })), { r: 'delete_candidate' });
  throws(() => plan([{ ...catalog, service: 'plex' }]));
  throws(() => plan([{ ...catalog, entries: [entry('/file')] }]));
});

Deno.test('large unrelated retained library does not trigger quadratic comparison holds', () => {
  const retainedEntries = Array.from(
    { length: 10_000 },
    (_, i) => entry(`/library/Other ${i}/Other.mkv`),
  );
  const p = plan([
    action('p', 'plex', Array.from({ length: 50 }, (_, i) => `/library/Selected/Part ${i}.mkv`)),
  ], { retainedEntries, comparisonBudget: 25_000 });
  equal(states(p), { p: 'delete_candidate' });
});

Deno.test('explicit relevant unresolved relationship holds only the affected whole action', () => {
  const p = plan([
    action('p', 'plex', ['/tv/selected.mkv']),
    action('other', 'plex', ['/movies/other.mkv']),
  ], {
    retainedEntries: [entry('/downloads/selected.mkv')],
    relationships: [{
      ...distinct('/tv/selected.mkv', '/downloads/selected.mkv'),
      relation: 'unknown',
    }],
  });
  equal(states(p), { p: 'held', other: 'delete_candidate' });
});

Deno.test('separate hardlink names remain independent while equal sidecar conflict retains Arr', () => {
  const p = plan([
    action('p', 'plex', ['/library/Film.mkv']),
    action('arr', 'radarr', ['/library/Film.mkv', '/library/Film.en.srt'], true),
    action('qb', 'qb', ['/downloads/Film.mkv', '/library/Film.en.srt']),
  ]);
  equal(states(p), { p: 'kept', arr: 'kept', qb: 'kept' });
  const separate = plan([
    action('p', 'plex', ['/library/Film.mkv']),
    action('qb', 'qb', ['/downloads/Film.mkv']),
  ]);
  equal(states(separate), { p: 'delete_candidate', qb: 'kept' });
});

Deno.test('unresolved relationship follows an explicit alias component', () => {
  const p = plan([action('p', 'plex', ['/a']), action('alias', 'sonarr', ['/b'])], {
    retainedEntries: [entry('/c')],
    relationships: [{ ...distinct('/a', '/b'), relation: 'same' }, {
      ...distinct('/b', '/c'),
      relation: 'unknown',
    }],
  });
  equal(states(p), { p: 'held', alias: 'kept' });
});

Deno.test('complete mixed-owner torrent is kept without holding separate Plex deletion', () => {
  for (const selected of [false, true]) {
    const q = {
      ...action('q', 'qb', ['/downloads/selected.mkv', '/downloads/other.mkv'], selected),
      retainedOwnership: true as const,
    };
    const p = plan([action('p', 'plex', ['/library/selected.mkv']), q]);
    equal(states(p), { p: 'delete_candidate', q: 'kept' });
    equal(summarizeServiceOwnedRetention(p, { p: 'succeeded' }).status, 'completed_with_retention');
  }
});

Deno.test('kept complete mixed-owner action retains its whole overlapping atomic scope', () => {
  for (const service of ['qb', 'sonarr', 'radarr'] as const) {
    const mixed = {
      ...action('mixed', service, ['/selected.mkv', '/other.mkv'], true),
      retainedOwnership: true as const,
    };
    equal(states(plan([action('p', 'plex', ['/selected.mkv']), mixed])), {
      p: 'kept',
      mixed: 'kept',
    });
  }
});

Deno.test('retained owners never mask an actually failed or incomplete inventory', () => {
  const q = { ...action('q', 'qb', ['/downloads/a'], true), retainedOwnership: true as const };
  equal(states(plan([action('p', 'plex'), q], { qbInventory: 'failed' })), {
    p: 'held',
    q: 'held',
  });
  equal(states(plan([action('p', 'plex'), { ...q, effectsComplete: false }])), {
    p: 'held',
    q: 'held',
  });
});

Deno.test('unavailable QB association holds its decision without erasing complete inventory', () => {
  for (const selected of [false, true]) {
    const marker = {
      ...action('association', 'qb', [], selected),
      presence: 'unknown' as const,
      effectsComplete: false,
      associationUnavailable: true as const,
    };
    equal(states(plan([action('p', 'plex'), action('r', 'radarr', ['/r'], true), marker])), {
      p: 'delete_candidate',
      r: 'delete_candidate',
      association: 'held',
    });
    equal(states(plan([action('p', 'plex'), marker], { qbInventory: 'failed' })), {
      p: 'held',
      association: 'held',
    });
    equal(
      states(
        plan([action('p', 'plex'), marker, { ...action('job', 'qb', []), effectsComplete: false }]),
      ),
      { p: 'held', association: 'held', job: 'held' },
    );
  }
});

Deno.test('association marker cannot masquerade as a real incomplete manifest', () => {
  const marker = {
    ...action('q', 'qb', [], true),
    presence: 'unknown' as const,
    effectsComplete: false,
    associationUnavailable: true as const,
  };
  throws(() => plan([{ ...marker, service: 'plex' }]));
  throws(() => plan([{ ...marker, presence: 'current' }]));
  throws(() => plan([{ ...marker, entries: [entry('/a')] }]));
  throws(() => plan([{ ...marker, effectsComplete: true }]));
});
