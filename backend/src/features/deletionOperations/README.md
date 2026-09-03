# Durable deletion architecture

Deletion is intentionally a workflow, not a route-side side effect. The HTTP layer proves and
snapshots an exact request, then the durable worker revalidates that evidence before each external
mutation. This directory owns the durable operation lifecycle; `../mediaDeletion/` owns preview,
path, download-client, and reclamation evidence used by that lifecycle.

## Lifecycle

1. A flow-specific preview resolves Plex, Arr, path-mapping, playback, and download evidence.
2. The client submits the preview fingerprint and a `clientRequestId`.
3. `middleware.ts` validates the request and snapshots ordered targets in one operation.
4. The worker claims one target and calls `workflow/targetWorkflow.ts`.
5. Execution revalidates the snapshot and writes an attempt marker before every destructive call.
6. Exact postconditions reconcile successful, failed, timed-out, and lost-response calls.
7. Only verified completion releases reservations and updates projections/accounting. Ambiguous
   outcomes remain visible as `needs_attention`.

Retries resume from durable evidence. They must never infer success merely because a path, Arr
record, download job, or Plex version is currently absent; the corresponding attempt and exact
postcondition must make that absence attributable.

## TV flows in scope

The Sonarr-owned historical-path behavior is deliberately limited to these four flows:

| Flow | Durable target | Planner / preview |
| --- | --- | --- |
| Whole show | whole item | `../mediaDeletion/previewRoute.ts`, `middleware.ts` |
| Stale season | whole season | `../libraries/seasonRemovalPlanner.ts` |
| Duplicate episode | media version | `../mediaDeletion/versionPlanning.ts` |
| Duplicate season | ordered media-version targets | `../duplicates/seasonDeletionPlanner.ts` |

Do not generalize the proof or silently enable it for movie/Radarr flows. Each flow retains its own
eligibility, remaining-version, season-membership, active-playback, and Arr-monitoring safeguards.

## Safety invariants

- A Sonarr historical path is unlinkable only with the exact two-link proof: the source path and
  Sonarr-managed path are distinct directory entries for the same inode, and the inode link count
  is exactly two at preview and execution.
- Accepted ownership is immutable evidence. Live revalidation may downgrade an accepted path to
  retained/unverified; it may not add a new destructive path.
- Plex, Sonarr, qBittorrent, and local/container paths are separate namespaces. Cross-namespace
  comparisons require the snapshotted mapping identities.
- A selected qBittorrent payload shared by season targets is coordinated once. Every sibling whose
  retained copy depends on it must be protected before payload deletion.
- Mutation order and attempt markers are correctness boundaries. Preserve them during refactors.
- Recovery guidance is not authorization. Manual recovery endpoints still revalidate exact state.

## Module map

- `core/` — durable state, validation, ownership policy, coordination, and recovery primitives.
- `arr/` — Sonarr/Radarr reassignment, removal, monitoring, rescan, and transition persistence.
- `workflow/` — target execution and Plex reconciliation orchestration.
- `recovery/` — explicit recovery workflows exposed for attention states.
- `relocation/` — durable Radarr relocation state and resolution.
- `middleware.ts` — destructive-route adapter, request validation, snapshotting, and enqueueing.
- `service.ts` — operation persistence, claiming, retry, cancellation, and finalization.
- `../mediaDeletion/cleanup/` — cleanup-domain types; `cleanup.ts` remains the stable public facade.
- `../mediaDeletion/sonarr/` — Sonarr inventory, season inspection, ownership classification, and
  season download-cleanup planning.
- `../mediaDeletion/hardlinks.ts` and `pathNamespace.ts` — filesystem identity and namespace proofs.

When changing a safety decision, add a focused unit test beside the deciding module and an
integration test covering the affected durable flow. Run `deno task verify` on Linux before merge.
