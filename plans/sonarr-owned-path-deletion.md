# Sonarr-owned path deletion

## Status

Draft

## Problem

Selecting Sonarr currently authorizes the Sonarr operation, but verified historical import
hardlinks are still controlled by a separate cleanup selection. That selection may not be offered,
so an operation can remove the Sonarr-managed media while leaving the historical links—and all
physical data—behind.

The Sonarr checkbox should mean: perform the shown Sonarr action and automatically remove verified
historical Sonarr import links within that action's scope, unless an unselected live qBittorrent job
owns them.

## Scope

Apply one shared Sonarr path-ownership decision to the four existing TV deletion flows that expose
a Sonarr choice:

| Flow | Authorized Sonarr scope |
| --- | --- |
| Stale whole show | The series and all of its Sonarr-managed episode files. |
| Stale season | Only the selected season and its planned EpisodeFiles. |
| Duplicate episode version | Only the selected version, subject to the existing retained-version and Sonarr-reassignment rules. |
| Duplicate season | Only the redundant versions authorized by the existing season plan. |

Each existing planner continues to choose the series, season, episodes, versions, retained
candidates, and Sonarr mutation. The shared ownership logic may classify paths only inside that
pre-authorized scope.

Radarr, movies, Plex-only deletion, qBittorrent-only deletion, and a separate redesign of
quick/smart cleanup are out of scope.

## Ownership behavior

| Selected destinations | Matching live qBittorrent owner | Behavior |
| --- | --- | --- |
| Sonarr | No | Perform the scoped Sonarr action and unlink its verified historical import entries automatically. |
| Sonarr | Yes | Perform the scoped Sonarr action but retain entries owned by the unselected live qBittorrent job. |
| Sonarr + qBittorrent | Yes | Use the existing exact job/payload authorization, delete the selected job data, and complete the scoped Sonarr action. |

A configured qBittorrent connection is not ownership. Ownership requires a successfully discovered
live job whose complete manifest owns the exact historical entry. Check all effective qBittorrent
clients whose configured download mappings can cover a proposed historical unlink, including jobs
whose hash differs from Sonarr's historical download ID.

If an applicable client cannot be inspected completely, do not unlink that historical entry.
Continue the Sonarr action only when retaining the entry is safe. If a live job owns the exact same
directory entry that Sonarr itself would remove, stop before mutation and explain the conflict;
supporting an alternate Sonarr mutation for this unusual overlap is out of scope.

## Deletion authority

A historical entry may be unlinked only when all existing checks succeed:

- A supported, unambiguous Sonarr `downloadFolderImported` record supplies a valid BitTorrent
  v1/v2 download ID and exact source/imported paths.
- The entry is inside the configured download root and the corresponding EpisodeFile is inside the
  configured library root.
- The mappings are disjoint; canonical containment, no-symlink, distinct-entry, root/mount,
  device, inode, and size checks pass.
- The source entry and current in-scope Sonarr EpisodeFile resolve to the same filesystem object.
- No unselected live qBittorrent job owns the exact source entry.

Sonarr-managed library paths remain evidence and expected postconditions. Never unlink them
directly; remove them only through the existing flow-specific Sonarr API operation.

Preserve the existing exact-two-link Sonarr proof: one accepted historical entry plus one in-scope
managed entry with an initial link count of two. Do not broaden unlink authority or add generalized
inode-group accounting for more complex link sets.

## Implementation

### 1. Add a shared Sonarr ownership classification

Create a small result for proposed historical entries:

- `delete`: exact Sonarr/filesystem proof and no unselected live qBittorrent owner.
- `retain_live_qbittorrent`: an unselected live job owns the exact entry.
- `unverified`: provenance, mapping, identity, or ownership inspection is incomplete.

The existing whole-show, stale-season, duplicate-version, and duplicate-season planners supply the
authorized EpisodeFile/version scope and consume this classification. Do not replace their current
identity, season-membership, retained-version, reassignment, active-playback, or fail-closed checks.

### 2. Bind automatic paths to the Sonarr action

- When the backend accepts a valid Sonarr action, automatically include every `delete` historical
  entry inside that action's scope.
- Remove the separate **Verified hardlink cleanup** choice when Sonarr is selected.
- Keep qBittorrent independently selectable only for a verified live job.
- Keep the existing `cleanupDownloads` wire field for compatibility and treat it only as the
  existing qBittorrent job/payload intent in the affected flows. It must not enable or disable
  automatic Sonarr historical-link handling.
- For duplicate episode versions, bind ownership to the backend-accepted Sonarr
  coordination/reassignment decision; do not trust or silently discard a frontend-only selection.

### 3. Reuse the durable infrastructure

- Extend the existing preview fingerprint and target snapshot with the exact automatic historical
  paths, proof, ownership disposition, selected qBittorrent jobs, Sonarr scope, mappings, and
  relevant service identities.
- Reuse the existing worker phases and attempt tables.
- Add operation-specific attempt/confirmation markers only for the newly automatic historical
  unlinks. Do not redesign recovery for existing qBittorrent, Sonarr, reassignment, monitoring, or
  managed-file mutations.
- An absent historical entry counts as this operation's completed unlink only after its own durable
  attempt marker. Retry only the exact snapshotted paths and never discover replacement authority.

Submission returns `409` when the accepted preview fingerprint changes. At execution, revalidate
the exact paths and query applicable qBittorrent ownership immediately before each unattempted
unlink. Newly discovered ownership may only downgrade `delete` to retained/unverified; it can
never add a deletion target. If that downgrade makes the Sonarr action unsafe, stop before further
mutation.

### 4. Execute in the existing safe order

1. Complete the flow's existing pre-mutation identity, playback, retained-media, season, and
   reassignment checks.
2. Revalidate the accepted ownership plan.
3. If qBittorrent is selected, run its existing exact job/payload deletion.
4. Unlink the remaining accepted historical entries, recording attempt and confirmation for each.
5. Run the existing scoped Sonarr action; Sonarr removes its managed paths.
6. Reconcile Plex and record the outcome.

Partial execution remains recoverable through the durable worker. A retry may finish only remaining
accepted work and must not expand the deletion set.

### 5. Make the preview and outcome explicit

- Sonarr copy: “Applies the shown Sonarr change and removes its verified historical import links.
  Active qBittorrent payloads are retained unless qBittorrent is also selected.”
- Show automatic historical entries, retained live-job entries, and unverified candidates with
  exact reasons. Do not hide unavailable historical cleanup.
- Use logical-media wording for the headline size. A preview may show expected reclamation but
  cannot claim completed physical removal.
- Record logical media removal, confirmed historical unlinking, and verified final-link removal as
  distinct outcomes.
- Remove `cleanup_unselected` from this Sonarr path. When an entry is retained or unverified,
  persist the actual reason.

## Verification

Add shared ownership tests for:

- No configured qBittorrent client.
- A reachable applicable client with no owning job.
- A selected and an unselected owning job.
- A different-hash job whose complete manifest owns the exact path.
- An unreachable/incomplete applicable client, without allowing an unrelated unmapped client to
  block the path.
- Identity, mapping, or Sonarr provenance failure.
- Ownership appearing at final execution revalidation.
- Retry after an attempted unlink versus an unexplained absent path.
- `nlink > 2` remains unverified and is not unlinked.

Add one integration regression for each flow:

- Stale whole-show Sonarr deletion removes a verified two-link historical entry and then the
  Sonarr-managed entry.
- Stale season deletion removes only that season's authorized files/links.
- Duplicate episode-version deletion preserves/reassigns a retained version while removing only
  the selected version's authorized link.
- Duplicate-season deletion applies the policy only to versions authorized by the season plan.

Exercise Sonarr-only retention for an unselected live job and Sonarr + qBittorrent deletion where
the planner wiring differs. Preserve the existing complete-payload and shared-job tests rather than
duplicating them.

Add shared frontend destination-state coverage plus one wiring assertion for each dialog. Sonarr
must always imply automatic verified historical paths, qBittorrent remains separately selectable,
and the preview distinguishes deleted, retained, and unverified entries.

## Completion criteria

- Every visible Sonarr checkbox in the four scoped flows has the same ownership meaning.
- With no live qBittorrent owner, selecting Sonarr automatically removes an in-scope historical
  entry that passes the existing Sonarr/filesystem identity checks.
- With an unselected live owner, its exact entry is retained.
- With both destinations selected, existing qBittorrent authorization controls payload deletion.
- The backend, not frontend state timing, persists the decision.
- No successful Sonarr operation reports “cleanup was not selected.”
- Radarr and unrelated deletion/recovery contracts remain unchanged.
