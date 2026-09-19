# Service-owned deletion validation cost

The isolated worker fixture reproduces the reported whole-show shape: one Plex show,
N individually managed Sonarr episode files, Plex and Sonarr selected, and no QB
job. Fetch is intercepted and the database is temporary. No production operation
was read or changed. Counts below cover execution only, after preview/enqueue.

| Episode files | Before Plex GET | Before Sonarr GET | After Plex GET | After Sonarr GET | DELETEs, unchanged |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 82 | 95 | 70 | 72 | 6 |
| 12 | 290 | 387 | 158 | 176 | 14 |
| 24 | 842 | 1,185 | 290 | 332 | 26 |
| 148 | 23,410 | 34,727 | 1,654 | 1,944 | 150 |

At 148 files this reduces execution GETs from 58,137 to 3,598 (93.8%).
Destructive requests remain sequential: N file DELETEs, one Sonarr catalog DELETE
with `deleteFiles=false`, and one Plex DELETE. These are fixture measurements,
not measurements or latency predictions for the live operation.

## Validation boundaries

- **Preview, enqueue, first execution and restart:** full accepted-evidence
  collection/comparison. Persisted accepted or reconciled actions are freshly
  observed on every resumed invocation. An unacknowledged attempt holds the work;
  it never becomes permission to replay a request.
- **Before each Sonarr file deletion:** refresh server/configuration, two complete
  Sonarr episode/file snapshots, two Plex path inventories, current title and
  related retained-title evidence, and configured QB ownership discovery. Refresh
  the pending file's native owner endpoint and its Plex episode identities. All
  pending effects and retention decisions still compare against immutable consent.
  New files, paths, managers, retained overlaps, and config changes cannot widen it.
  Check active playback after collecting evidence, before mutation.
- **Other individual files:** their ownership remains in the two fresh native
  snapshots, but their individual owner endpoints are not queried again until
  they become pending or a full checkpoint runs. For a whole show, unrelated Plex
  episode coordinates can be reused only when the fresh path inventory contains
  the exact accepted ratingKey/mediaId/path/size tuple. They are matching hints,
  not deletion authority. The pending action's coordinates are always read live;
  new or changed tuples fall back to live metadata reads and fail comparison.
- **Completed actions during uninterrupted execution:** observe each native result
  once and run its monitoring follow-up once. Fresh native snapshots still detect
  reappeared Sonarr files before further file deletion. Full boundary checks
  freshly observe prior effects before using them to explain changed Plex scope.
  A cross-service absence reconciliation independently rereads its exact sources.
- **Catalog cleanup:** the last completed record file triggers the record's
  original cleanup checkpoint. Keep full revalidation, playback protection, and
  the complete native Sonarr file/episode inventory check immediately before
  removing management. Newly imported files prevent cleanup. Cleanup requests
  and responses remain durably recorded; restart only verifies accepted cleanup.
- **Plex and QB mutations:** retain full collection, including retained paths and
  remaining-version invariants. No focused shortcut applies to their mutations.
- **Failed/delayed reads:** existing unavailable-evidence holds and bounded
  automatic convergence retries remain. Only successful reads establish absence.

The only invocation-local completion cache is bookkeeping for follow-ups already
performed in that uninterrupted run. It is discarded on restart. Accepted tuples
come from fingerprint-verified durable consent; service configuration and assertions
of "no retained overlap" are refreshed rather than cached across requests.

## Progress

Execution advances the durable phase to download cleanup, Arr coordination, or
Plex reconciliation when that service's request begins. Older snapshots still
marked validating display "Service deletion" when request evidence exists.
Service-owned holds are excluded from the legacy sync-triggered Plex retry path,
so the more accurate phase cannot bypass bounded convergence retries or uncertain
request holds.
The compact summary reports requests accepted, service removals confirmed, and
pending actions separately. Native file absence can be confirmed while catalog
cleanup or episode monitoring remains pending; acceptance alone is never shown
as removal. Reconciled absence does not invent an accepted request. Service
inventory absence is not a measurement of physical disk space reclaimed.

## Regression coverage and limits

The multi-episode integration fixture enforces linear HTTP budgets at 4, 12, 24,
and 148 files, unchanged DELETE counts, and truthful progress between requests.
The workflow fixture enforces one observation/follow-up per uninterrupted action
and fresh verification without replay on resume. Expanded show/season drift cases
cover changed coordinates, newly retained shared paths and QB overlap, changed
configuration, playback, and a lost native file response. Existing cases continue
covering additions, renames, reappeared sources, remaining versions, partial/empty
Plex refreshes, delayed or failed inventories, retry exhaustion, and restart.

This is near-linear **HTTP request growth for the measured fixture**, not a claim
of linear total work. Complete snapshots and path inventories are still read per
pending file to discover new retained/shared ownership; response volume and local
comparison work remain superlinear. Absence-source matching can also revisit many
accepted files. Large paginated inventories, many related titles/QB candidates,
repeated restarts, and service convergence delays add requests. Broader caching
would require service revision tokens or equally fresh scoped overlap discovery.
The change does not increase timeouts, parallelize mutations, or relax consent.

Validation: the backend/frontend suite passed 970 tests (16 steps), with 18 ignored.
The final sync-requeue guard passed the expanded show/season regression again after
that suite. Workspace type-check, lint, frontend production build, changed-source
format checks, and `git diff --check` passed. Independent review ran 19 workflow
tests and the final expanded show/season regression; its sync-requeue finding was
fixed and it reported no remaining blockers. Native-service acceptance and real
network latency were not tested; production was not deployed or modified.
