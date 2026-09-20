# Durable deletion architecture

All new deletion work uses service-owned policy 4. The backend never deletes media
through local filesystem access, host discovery, retained-version adoption, or the
retired route adapters.

## Lifecycle

1. POST /api/service-deletions/preview collects current title-scoped Plex, Arr and
   qBittorrent evidence through mediaDeletion/serviceOwnedPlanning.ts.
2. The client reviews exact service decisions and submits the fingerprint, explicit
   destination choices and a clientRequestId to POST /api/service-deletions.
3. serviceOwnedRoute.ts rechecks the preview and snapshots ordered durable targets.
4. service.ts claims a target. workflow/targetWorkflow.ts accepts only current
   service-owned evidence and acquires the library operation lock.
5. workflow/serviceOwnedWorkflow.ts revalidates ownership, records intent before
   mutation, and verifies service-specific completion without replaying uncertainty.
6. workflow/plexReconciliation.ts preserves retained Plex catalog entries and only
   records removal accounting supported by confirmed outcomes.

Duplicate Quick Cleanup uses these same endpoints and review, in bounded batches.
Old mutation and preview URLs return 410 so stale clients must obtain a new review.

## Safety and stored history

- Plex is selected by default. Arr and qBittorrent are explicit optional choices.
- Retained qBittorrent ownership vetoes overlapping actions, including Plex.
- Failed reads are never absence. Request acceptance is not completion.
- A retry must preserve immutable accepted evidence and never replay an uncertain
  destructive attempt. Current playback, identity and remaining versions are checked.
- Pre-policy-4 unfinished snapshots remain held for manual recovery. Attempt records,
  reservations, schema and historical outcome readers are retained; executable legacy
  deletion and adoption implementations are removed. Only work with no external or
  uncertain attempt evidence can be cancelled through the upgrade hold.
- Migration files describe existing installations and must remain intact.

Current API, worker, retention and integration tests cover service-owned execution;
upgrade-policy tests cover refusal to execute old persisted requests.
