import {
  serviceOwnedFingerprint,
  type ServiceOwnedPlan,
  serviceOwnedPlanFingerprint,
  type ServiceOwnedPlannedAction,
} from './serviceOwnedPlanning.ts';

/** Compare native effects, not verification evidence. Fresh ownership may only narrow consent. */
export function serviceOwnedEffectScope(action: ServiceOwnedPlannedAction) {
  const {
    id,
    service,
    serviceKey,
    instanceId,
    instanceKey,
    recordId,
    fileId,
    hash,
    ratingKey,
    mediaId,
    files,
    plexParts,
    episodeIds,
    episodes,
    catalogOnly,
    recordCleanup,
    associatedExtras,
  } = action;
  return {
    id,
    service,
    serviceKey,
    instanceId,
    instanceKey,
    recordId,
    fileId,
    hash,
    ratingKey,
    mediaId,
    files,
    plexParts,
    episodeIds,
    episodes,
    catalogOnly,
    recordCleanup,
    associatedExtras,
  };
}

export function boundServiceOwnedConsent(
  approved: ServiceOwnedPlan,
  verified: ServiceOwnedPlan,
): ServiceOwnedPlan {
  if (
    serviceOwnedFingerprint(approved.connections) !== serviceOwnedFingerprint(verified.connections)
  ) throw new Error('Service configuration changed after confirmation');
  const narrowed = new Set<string>();
  for (const decision of verified.retention.decisions) {
    const action = verified.actions.find((a) => a.id === decision.actionId)!;
    const accepted = approved.actions.find((a) => a.id === action.id);
    const requested = accepted?.selected === true;
    const unchanged = accepted &&
      serviceOwnedFingerprint(serviceOwnedEffectScope(accepted)) ===
        serviceOwnedFingerprint(serviceOwnedEffectScope(action));
    if (decision.state === 'delete_candidate' && (!requested || !unchanged)) {
      narrowed.add(decision.actionId);
      decision.state = 'held';
      decision.reason = 'effects_incomplete';
      action.unavailableReason =
        'The current service effect was not included in the reviewed scope; fresh review is required';
    }
    // A newly observed ownership-only action must remain protective evidence.
    if (!requested && !action.selected) decision.requested = false;
  }
  // Narrowing an atomic action retains its effects, which must veto overlapping
  // candidates in other services too. Iterate until no new retained action appears.
  let changed: boolean;
  do {
    changed = false;
    const canonical = (path: string) => path.includes('\\') ? path.toLowerCase() : path;
    const retained = new Set(
      verified.retention.decisions.filter((d) => narrowed.has(d.actionId)).flatMap((d) =>
        verified.actions.find((a) => a.id === d.actionId)!.entries.map((e) => canonical(e.path))
      ),
    );
    for (const decision of verified.retention.decisions) {
      if (decision.state !== 'delete_candidate') continue;
      if (
        verified.actions.find((a) => a.id === decision.actionId)!.entries.some((e) =>
          retained.has(canonical(e.path))
        )
      ) {
        narrowed.add(decision.actionId);
        decision.state = 'kept';
        decision.reason = 'retained_entry';
        changed = true;
      }
    }
  } while (changed);
  verified.fingerprint = serviceOwnedPlanFingerprint(verified);
  return verified;
}
