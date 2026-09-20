/** Pure retention policy. Callers still own identity, playback, scope and execution validation. */
export type ServiceOwnedService = 'plex' | 'sonarr' | 'radarr' | 'qb';

export interface ServiceOwnedEntry {
  /** Unique within this evidence revision; identifies an observed directory entry, not an inode. */
  id: string;
  path: string;
}

export interface ServiceOwnedAction {
  id: string;
  service: ServiceOwnedService;
  /** Service instance plus service-local target ID/hash, never a translated delete path. */
  targetId: string;
  selected?: boolean;
  presence: 'current' | 'absent' | 'unknown';
  /** Observed atomic-effect entries and concrete overlap risks; native linked extras may be implicit. */
  entries: readonly ServiceOwnedEntry[];
  /** Required evidence for the accepted service-local action boundary was successfully verified. */
  effectsComplete: boolean;
  /** Arr metadata-only removal, explicitly deleteFiles=false with no filesystem effects. */
  catalogOnly?: true;
  /** Complete atomic effects include known or possible owners outside the authorized selection. */
  retainedOwnership?: true;
  /** QB association read failed independently of its successfully read ownership inventory. */
  associationUnavailable?: true;
}

export interface ServiceOwnedRelationship {
  leftEntryId: string;
  rightEntryId: string;
  relation: 'same' | 'distinct' | 'unknown';
  /** Reference to concrete relationship evidence, including a relevant unresolved overlap. */
  evidenceId: string;
  evidenceRevision: string;
}

export interface ServiceOwnedRetentionInput {
  evidenceRevision: string;
  actions: readonly ServiceOwnedAction[];
  retainedEntries: readonly ServiceOwnedEntry[];
  qbInventory: 'unconfigured' | 'complete' | 'incomplete' | 'failed';
  relationships?: readonly ServiceOwnedRelationship[];
  /** Bound computation explicitly; exceeding the budget fails without returning a partial plan. */
  comparisonBudget?: number;
}

export type ServiceOwnedDecisionState = 'delete_candidate' | 'kept' | 'held' | 'not_applicable';
export type ServiceOwnedDecisionReason =
  | 'eligible'
  | 'not_selected'
  | 'target_absent'
  | 'target_unknown'
  | 'effects_incomplete'
  | 'qb_inventory_unavailable'
  | 'retained_entry'
  | 'relationship_unknown';

export interface ServiceOwnedDecision {
  actionId: string;
  targetId: string;
  service: ServiceOwnedService;
  requested: boolean;
  state: ServiceOwnedDecisionState;
  reason: ServiceOwnedDecisionReason;
  evidenceRevision: string;
}

function nonempty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function validateEntry(entry: ServiceOwnedEntry): void {
  nonempty(entry.id, 'Entry ID');
  const windows = /^[A-Za-z]:\\/.test(entry.path) || entry.path.startsWith('\\\\');
  const relative = windows
    ? entry.path.slice(entry.path.startsWith('\\\\') ? 2 : 3)
    : entry.path.slice(1);
  if (
    (!windows && !entry.path.startsWith('/')) ||
    (windows ? entry.path.includes('/') : entry.path.includes('\\')) ||
    relative.split(windows ? '\\' : '/').some((p) => !p || p === '.' || p === '..') ||
    (entry.path.startsWith('\\\\') && relative.split('\\').length < 3) ||
    [...entry.path].some((c) => c.charCodeAt(0) < 32)
  ) throw new Error('Expected a canonical absolute service file path');
}

function comparisonPath(entry: ServiceOwnedEntry): string {
  return entry.path.startsWith('/') ? entry.path : entry.path.toLowerCase();
}

/**
 * Produces candidates, never standalone deletion authorization. Under the practical confidence
 * policy, differing canonical file paths are treated as distinct unless concrete relationship
 * evidence says otherwise. Equal paths and explicit aliases conservatively veto deletion;
 * explicitly unresolved relationships hold affected actions. Inode equality is not entry equality.
 * Service target association, full effects and failed-read checks remain caller obligations.
 */
export function planServiceOwnedRetention(input: ServiceOwnedRetentionInput) {
  nonempty(input.evidenceRevision, 'Evidence revision');
  const budget = input.comparisonBudget ?? 1_000_000;
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Invalid comparison budget');
  const entries = new Map<string, ServiceOwnedEntry>();
  const actionIds = new Set<string>();
  for (const action of input.actions) {
    nonempty(action.id, 'Action ID');
    nonempty(action.targetId, 'Target ID');
    if (actionIds.has(action.id)) throw new Error('Duplicate action ID');
    actionIds.add(action.id);
    if (
      action.associationUnavailable && (action.service !== 'qb' || action.presence !== 'unknown' ||
        action.entries.length || action.effectsComplete)
    ) {
      throw new Error('Unavailable association must be an unknown QB marker without file effects');
    }
    if (
      action.catalogOnly &&
      (action.service !== 'sonarr' && action.service !== 'radarr' || action.entries.length)
    ) {
      throw new Error('Catalog-only scope must be an Arr action without file effects');
    }
    if (action.presence === 'absent' && action.entries.length) {
      throw new Error('Absent target cannot have current effects');
    }
    if (
      action.service === 'qb' && action.presence === 'current' &&
      input.qbInventory === 'unconfigured'
    ) {
      throw new Error('Current QB target requires a configured inventory');
    }
  }
  for (const entry of [...input.actions.flatMap((a) => [...a.entries]), ...input.retainedEntries]) {
    validateEntry(entry);
    const previous = entries.get(entry.id);
    if (previous && previous.path !== entry.path) throw new Error('Conflicting entry identity');
    entries.set(entry.id, entry);
  }
  const pairKey = (left: string, right: string) => JSON.stringify([left, right].sort());
  const parents = new Map([...entries.keys()].map((id) => [id, id]));
  const component = (id: string): string => {
    let root = id;
    while (parents.get(root) !== root) root = parents.get(root)!;
    while (id !== root) {
      const next = parents.get(id)!;
      parents.set(id, root);
      id = next;
    }
    return root;
  };
  // Equal paths already veto deletion across services. Include that equivalence
  // in alias components so explicit aliases and unknown relationships propagate
  // through another service's observation of the same path too.
  const pathOwners = new Map<string, string>();
  for (const entry of entries.values()) {
    const path = comparisonPath(entry);
    const previous = pathOwners.get(path);
    if (previous) parents.set(component(entry.id), component(previous));
    else pathOwners.set(path, entry.id);
  }
  const relationships = new Map<string, ServiceOwnedRelationship['relation']>();
  for (const relationship of input.relationships ?? []) {
    nonempty(relationship.evidenceId, 'Relationship evidence ID');
    if (relationship.evidenceRevision !== input.evidenceRevision) {
      throw new Error('Stale relationship evidence');
    }
    const left = entries.get(relationship.leftEntryId);
    const right = entries.get(relationship.rightEntryId);
    if (!left || !right) throw new Error('Relationship references an unknown entry');
    if (comparisonPath(left) === comparisonPath(right) && relationship.relation === 'distinct') {
      throw new Error('Distinct relationship contradicts conservative equal-path retention');
    }
    const key = pairKey(left.id, right.id);
    const previous = relationships.get(key);
    if (previous && previous !== relationship.relation) {
      throw new Error('Conflicting relationships');
    }
    relationships.set(key, relationship.relation);
    if (relationship.relation === 'same') parents.set(component(left.id), component(right.id));
  }
  const distinctComponents = new Set<string>();
  const unknownComponents = new Map<string, Set<string>>();
  for (const relationship of input.relationships ?? []) {
    if (relationship.relation === 'same') continue;
    const left = component(relationship.leftEntryId);
    const right = component(relationship.rightEntryId);
    if (relationship.relation === 'distinct') {
      if (left === right) {
        throw new Error('Distinct evidence contradicts transitive alias evidence');
      }
      distinctComponents.add(pairKey(left, right));
    } else if (left !== right) {
      for (const [a, b] of [[left, right], [right, left]]) {
        const others = unknownComponents.get(a) ?? new Set<string>();
        others.add(b);
        unknownComponents.set(a, others);
      }
    }
  }
  for (const [left, others] of unknownComponents) {
    if ([...others].some((right) => distinctComponents.has(pairKey(left, right)))) {
      throw new Error('Conflicting relationships between alias components');
    }
  }
  const unknownQb = input.qbInventory === 'failed' || input.qbInventory === 'incomplete' ||
    input.actions.some((a) =>
      a.service === 'qb' && !a.associationUnavailable && (a.presence === 'unknown' ||
        a.presence === 'current' && (!a.effectsComplete || !a.entries.length))
    );
  const decisions: ServiceOwnedDecision[] = input.actions.map((action) => {
    const requested = action.service === 'plex' || action.selected === true;
    let state: ServiceOwnedDecisionState = 'delete_candidate';
    let reason: ServiceOwnedDecisionReason = 'eligible';
    if (action.presence === 'absent') {
      state = 'not_applicable';
      reason = 'target_absent';
    } else if (action.service === 'qb' && unknownQb) {
      state = 'held';
      reason = 'qb_inventory_unavailable';
    } else if (action.associationUnavailable) {
      state = 'held';
      reason = 'target_unknown';
    } else if (!requested) {
      state = 'kept';
      reason = 'not_selected';
    } else if (action.presence === 'unknown') {
      state = 'held';
      reason = 'target_unknown';
    } else if (unknownQb && !action.catalogOnly) {
      state = 'held';
      reason = 'qb_inventory_unavailable';
    } else if (!action.effectsComplete || !action.entries.length && !action.catalogOnly) {
      state = 'held';
      reason = 'effects_incomplete';
    } else if (action.retainedOwnership) {
      state = 'kept';
      reason = 'retained_entry';
    }
    return {
      actionId: action.id,
      targetId: action.targetId,
      service: action.service,
      requested,
      state,
      reason,
      evidenceRevision: input.evidenceRevision,
    };
  });
  const retained = new Map<string, ServiceOwnedEntry>(input.retainedEntries.map((e) => [e.id, e]));
  for (const [index, decision] of decisions.entries()) {
    if (
      decision.state === 'held' || decision.state === 'kept' &&
        (decision.service === 'qb' || input.actions[index].retainedOwnership)
    ) {
      for (const entry of input.actions[index].entries) retained.set(entry.id, entry);
    }
  }
  let comparisons = 0;
  const chargeComparison = () => {
    if (++comparisons > budget) throw new Error('Retention comparison budget exceeded');
  };
  const indexInventory = (inventory: Iterable<ServiceOwnedEntry>) => {
    const paths = new Set<string>(), components = new Set<string>();
    for (const entry of inventory) {
      chargeComparison();
      paths.add(comparisonPath(entry));
      components.add(component(entry.id));
    }
    return { paths, components };
  };
  const conflict = (action: ServiceOwnedAction, inventory: ReturnType<typeof indexInventory>) => {
    let unknown = false;
    for (const entry of action.entries) {
      chargeComparison();
      const ownComponent = component(entry.id);
      if (inventory.paths.has(comparisonPath(entry)) || inventory.components.has(ownComponent)) {
        return 'same';
      }
      for (const otherComponent of unknownComponents.get(ownComponent) ?? []) {
        chargeComparison();
        unknown ||= inventory.components.has(otherComponent);
      }
    }
    return unknown ? 'unknown' : 'distinct';
  };
  // Propagate in synchronous rounds. Keep known conflicts separate from unknown relationships:
  // circular effects of held actions must never turn uncertainty into intentional retention.
  const blocked = new Set<number>();
  const knownBlocked = new Set<number>();
  const knownRetained = new Map(retained);
  let rounds = 0;
  while (true) {
    const knownIndex = indexInventory(knownRetained.values());
    const retainedIndex = indexInventory(retained.values());
    const additions: number[] = [];
    const knownAdditions: number[] = [];
    for (const [index, decision] of decisions.entries()) {
      if (decision.state !== 'delete_candidate' || knownBlocked.has(index)) continue;
      if (conflict(input.actions[index], knownIndex) === 'same') {
        knownAdditions.push(index);
        additions.push(index);
      } else if (
        !blocked.has(index) && conflict(input.actions[index], retainedIndex) !== 'distinct'
      ) {
        additions.push(index);
      }
    }
    if (!additions.length) break;
    for (const index of additions) {
      blocked.add(index);
      for (const entry of input.actions[index].entries) retained.set(entry.id, entry);
    }
    for (const index of knownAdditions) {
      knownBlocked.add(index);
      for (const entry of input.actions[index].entries) knownRetained.set(entry.id, entry);
    }
    rounds++;
  }
  for (const index of blocked) {
    decisions[index].state = knownBlocked.has(index) ? 'kept' : 'held';
    decisions[index].reason = knownBlocked.has(index) ? 'retained_entry' : 'relationship_unknown';
  }
  return {
    authorizesDeletion: false as const,
    evidenceRevision: input.evidenceRevision,
    decisions,
    rounds,
  };
}

export type ServiceOwnedRetentionPlan = ReturnType<typeof planServiceOwnedRetention>;
