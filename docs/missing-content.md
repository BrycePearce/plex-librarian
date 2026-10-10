# Missing Content (Radarr movies)

Open **Tools → Missing Content** (below Episode Gaps). Configure Radarr and its movie-library
mappings in Settings → Sonarr / Radarr, then use the existing manual or scheduled sync. The page
reads saved, server-scoped findings in pages of 50. Filtering, expanding evidence, and opening
service links do not request provider inventories. There is no additional scheduler or background
polling loop.

## Interpretation

- **Missing from expected Plex catalog**: a complete expected-library inventory contains neither an
  exact trusted managed path nor a matching external identifier. This describes the catalog
  snapshot, not physical files or playback.
- **Metadata disagreement**: trusted path or external-identity evidence connects the records, but
  identifiers conflict, or an exact-path Plex record lacks an identifier supplied by Radarr. The
  explanation distinguishes missing IDs from conflicting IDs. Neither service is automatically
  treated as the authoritative metadata source.
- **Expected managed version not verified**: an external identifier establishes title presence, but
  does not establish the exact Radarr-managed copy. Another library/instance or HD copy never
  silently satisfies a 4K scope.
- **Unable to verify**: incomplete file identity, missing import time, ambiguous identity,
  recent/pending import, or insufficient trusted path evidence. These are not missing-content
  claims.

Radarr must report `hasFile` and an embedded managed file whose ID agrees with `movieFileId` (and
whose movie ownership agrees when supplied). Monitored-only and download-only movies are excluded.
Modern `Guid[]` TMDB/IMDb IDs and legacy Plex TMDB/IMDb agent GUIDs are recognized. Titles and years
are display context, never matching keys; no fuzzy-title search is implemented.

The fixed grace period is **24 hours from Radarr's managed-file `dateAdded`**. There is no new
setting. Pending queue records suppress actionable absence. Unknown import times stay unable to
verify. A malformed/incomplete queue, including unknown movie ownership, invalidates the instance's
audit rather than treating the queue as empty. Healthy path/identity matches can still establish
presence while an upgrade is pending.

## Path trust and scope

Only existing explicit **Arr library path mappings** (`arr_path_mappings`, kind `library`) and
**validated Plex library path mappings** (`plex_path_mappings`) connect the two services through
Librarian's local namespace. Paths are compared only within their configured server, Radarr
instance, and expected Plex library. Overlapping mappings, traversal segments, unmapped paths, and
missing required path evidence remain unverified. Explicit Plex mapping case-sensitivity is honored.
No host/container translations, equal-looking namespaces, basenames, hardlinks, or aliases are
guessed. This feature does not require filesystem access and never stats media files.

Without these mappings, external IDs can still establish title presence and produce an
unverified-version result. Even equal raw path strings do not prove a common namespace. Generic
service-storage roots and download-client remote-path hints are not used by this first release. No
additional path-configuration UI was introduced.

Each instance/library mapping is an independent expected scope. If one instance maps to two
libraries, it is fetched once and evaluated separately against both. Mapping multiple libraries does
not declare them interchangeable. A per-library sync updates only that library's mapped scopes. A
full sync can publish completed independent scopes while retaining stale results for failed scopes.

## Freshness, publication, and dismissals

The sync manager starts a durable audit attempt before Plex reads. Existing findings immediately
become stale/incomplete. A single PMS identity GET checks the actual machine identifier against the
captured server. Raw GUIDs and paths are staged from the **existing** paged sync stream; no second
Plex scan or new per-candidate detail reads are added. Existing duplicate-detail reconciliation
elsewhere in sync is unchanged.

Plex pages must have a valid stable total and exactly the expected item count. SQLite primary keys
reject repeated rating keys across pages without a library-sized in-memory set. Only a successfully
completed movie-library sync can publish. Radarr's entire movie array and queue must also finish
successfully. Finding upserts, resolution, and the scope's completed marker are committed atomically
in one transaction.

Before publication, check that the sync is still pending, the active server still matches, the
configuration fingerprint is unchanged, and the scope still belongs to this sync ID. The fingerprint
covers credentials by hash, server connection identity, mappings, path sensitivity, and Plex path
validation revisions; secrets are never stored in findings or returned by this API. Failed reads,
watchdog cancellation, malformed/oversized responses, server switches, and changed configuration
cannot resolve previous findings. Configuration changes also make previously saved results stale at
read time. A crashed attempt remains incomplete after restart.

The dashboard's existing sync success describes Plex sync success; Radarr audit failures are
reported separately under **Audit coverage**. A successful saved audit is a snapshot at its
displayed time, not an ongoing availability guarantee. Coverage is conservative: a history-phase
failure also leaves the library audit incomplete. Cross-service snapshots are not transactional;
concurrent imports/renames can still require a later sync to settle.

Existing ignored Plex content is excluded at read time, based on matched rating keys. **Dismiss
finding** is a local preference keyed by server + Radarr instance + expected library + Radarr movie
ID, so it works for Radarr-only titles. **Include dismissed / ignored** shows hidden findings;
**Restore finding** reverses a local dismissal. Existing Plex ignores remain managed by their
existing controls. A changed finding type or a finding that resolves and later recurs clears its
dismissal.

## Resource bounds and retention

- Radarr instances run serially: one `/movie` GET and one queue walk per instance per sync. Queue
  pages contain 200 records, capped at 100 pages and 2 MiB decoded text per page. No candidate
  request fan-out.
- The movie response is streamed into reduced records; no whole response text or parsed movie array
  is retained. Maximum response: 512 MiB decoded bytes; record text: 512K UTF-16 code units
  (approximately 1 MiB); record count: one million. Exceeding a limit fails coverage rather than
  publishing partial results.
- Radarr requests have 25-second deadlines; the whole instance audit has a 120-second deadline and
  observes sync cancellation. Slow/unavailable integrations leave previous findings stale and allow
  other instances to proceed.
- Reduced Radarr writes and matching use batches of 100 and yield to the event loop between batches.
  Each path/TMDB/IMDb probe uses the full staging-key composite index. Candidate sets are capped at
  31 per identity probe; more than 30 combined matches is ambiguous. Display evidence retains at
  most 30 matching records and 30 observed paths per record.
- Plex's existing page size and bounded concurrency remain in use; inventory responses now have an 8
  MiB/page cap, stable-count validation, and bounded page-start batches. This validation applies to
  the shared metadata pager (including episode/track inventory), so an oversized or partial response
  now fails those syncs too.
- Successful scopes resolve findings absent from the new complete audit. Resolved rows are retained
  for 30 days, pruned on the next sync. Active/dismissed findings retain one row per movie/scope.
  Removed mappings retain stale findings for investigation; deleting their Radarr instance or server
  cascades those findings. Scope rows deliberately do not cascade on library removal, preserving
  failure evidence.
- Staging rows are cleared after each attempt; abandoned rows are reclaimed on a subsequent sync
  once their sync log is no longer pending. SQLite may retain freed pages for reuse; these are not
  immediately returned to the filesystem. No automatic VACUUM is added.

## Initial measurements (before the performance pass)

See [Performance pass](performance-pass.md) for the optimized implementation and concurrent HTTP
measurements.

Measured October 9, 2026 (America/Los_Angeles).

Reproduce synthetic measurements from the repository root:

```powershell
deno run -A backend/src/features/missingContent/performance.ts
deno run -A backend/src/features/missingContent/performance.ts 10
```

The harness runs the real `runLibrarySync` projection/history path on temporary SQLite databases,
with generated 300-item Plex pages and streamed Radarr responses. Movie counts mirror the
feasibility report; generated records include padded metadata, not private movie records. History is
empty and network latency is zero. Three alternating baseline/audit runs share a process; no forced
garbage collection. Heap/RSS samples are approximately every 5 ms, not allocation accounting or
absolute peaks.

| Fixture                                      | Baseline median | With audit median | Added median | Radarr body | DB allocated after runs |
| -------------------------------------------- | --------------: | ----------------: | -----------: | ----------: | ----------------------: |
| 2,775 Plex / 2,899 Radarr / 2,636 managed    |         0.326 s |           1.726 s |      1.400 s |    18.01 MB |                 2.67 MB |
| 27,750 Plex / 28,990 Radarr / 26,360 managed |         2.991 s |          17.250 s |     14.259 s |   180.34 MB |                21.08 MB |

At normal scale, sampled baseline heap peaks were 40.9–84.3 MiB and audit peaks 68.9–100.0 MiB. At
tenfold scale, baseline peaks were 99.5–123.9 MiB and audit peaks 118.1–124.9 MiB; audit process RSS
peaked at 299–317 MiB. These values include Deno, Drizzle, fixture generation, SQLite, and previous
runs; subtracting them does not isolate audit allocations. Both scales produced the intended 39
metadata disagreements and 8 version findings, with no missing titles. Plex pages remained 10/93
respectively; each audit used two Radarr requests plus one PMS identity check. See
`missing-content-performance.json` for raw samples.

A separate **live read-only Radarr reader validation** used the stored active-server configuration,
opening the app database read-only. It completed 2 GETs, 16,514,339 body bytes, 2,899 movies, 2,636
managed files, and 3 queue entries in **1.792 seconds**. Sampled reader heap rose from 5.77 MiB to a
peak of **23.27 MiB**; process RSS peaked at 121.17 MiB. This measured the streamed reader without
SQLite matching, not an end-to-end live sync. It performed no writes to services or the application
database and exported no credentials or private title/path details.

The prior Python feasibility run's 113.2 MiB allocation peak is a different runtime/measurement and
is not directly comparable to Deno heap or RSS. Full live feature publication, slow-network deadline
behavior, million-movie inventories, and real HD/4K multi-instance deployments were not measured.
Failures, cancellation, multi-instance isolation, and separate-library behavior are covered by
fixtures. Synthetic timings are not latency guarantees.

## Endpoint investigation and limitations

Radarr's
[MovieController](https://github.com/Radarr/Radarr/blob/develop/src/Radarr.Api.V3/Movies/MovieController.cs)
exposes an unpaged full movie list (or a TMDB-filtered lookup), not a smaller paged inventory with
the needed identity/file/import evidence. Its
[MovieFileController](https://github.com/Radarr/Radarr/blob/develop/src/Radarr.Api.V3/MovieFiles/MovieFileController.cs)
serves file-oriented data and does not replace the movie identities/managed-state join without extra
reads. The implementation therefore streams the existing supported bulk movie endpoint. No
undocumented projections or provider-version-specific smaller response are assumed.

**Catalog ghosts are deferred.** The supplied real-data report found omitted
`Part.exists`/`Part.accessible` flags in the checked responses. Missing flags mean unknown, and
inspecting every item separately would defeat this release's request budget. This release does not
classify missing/inaccessible parts, multipart availability, healthy alternate versions, physical
deletion, or playback reliability. Radarr's managed-file record also does not establish physical
existence. **Sonarr episode matching is not included.** No repair, search, rescan, deletion, import,
or download action is implemented.

Migration `0061_low_pandemic` is applied through the normal startup migration runner. Tests apply
the full migration chain to disposable databases; implementation and validation do not migrate the
user's production database.

## Verification

- `deno task test`: 844 passed, 10 ignored; no failures (includes backend, frontend, and tools).
- Final focused Missing Content suite: 21 passed, including additional case-sensitivity,
  configuration revision, overlapping publication, provider-free page reads, and contradictory
  library ownership tests.
- Plex client regression suite passes, including truncated pages, changing totals, and the page-size
  byte cap.
- `deno task fmt:check`, `deno lint`, production frontend build, and a type check of every
  non-ignored source file pass.
- The umbrella `deno task verify` reaches its type-check stage and fails on three pre-existing
  errors in ignored local file `tools/helper-free-acceptance/.runtime/production-restore-probe.ts`:
  two imports of retired restore-seeding modules and a removed `restoreStatus` method. The feature's
  tracked code type-checks successfully. That local probe was left untouched.
- Browser fixture inspection confirmed the rendered page, metadata filter, expandable identity/path
  evidence, service links, and separate stale integration coverage. Fixture UI checks did not use
  real provider data.

### Setup guidance

The results page provides connection setup actions for Plex, Radarr, and unmapped Radarr libraries.
The requirements disclosure lists the credentials or library selection needed. File comparison
requires trusted Arr/Plex path mappings; this build does not expose a mapping setup screen.
Identity-matched version records without a comparable path are treated as a page-level limitation
and excluded before result counts and pagination. Other findings remain visible, including stale
evidence from failed audits.
