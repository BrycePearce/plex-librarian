# Deletion operations

Durable deletion is split by responsibility:

- `middleware.ts` snapshots accepted HTTP deletion requests and enqueues durable work.
- `service.ts` owns queue persistence, worker scheduling, retries, and operation queries.
- `route.ts` exposes operation inspection and control.
- `core/` contains lifecycle state, validation, recovery, coordination, ownership, and policy.
- `arr/` contains Radarr/Sonarr ownership, reassignment, and removal workflows.
- `relocation/` contains retained-version relocation state and resolution.
- `workflow/` orchestrates a target and reconciles its final Plex state.

`worker_integration_test.ts` stays at the feature root because it exercises these boundaries
end-to-end. Narrow tests live beside the modules they cover.
