# Performance pass — October 9, 2026

This pass measured Missing Content queries, movie-sync audit overhead, concurrent localhost HTTP responses, season-history writes, and artist rollups. All fixtures used generated data and isolated SQLite databases. No production database or providers were changed.

## Changes

- Missing Content uses bound equality filters and a JSON-first ignored-content anti-join. Servers with no ignored content skip evidence parsing entirely. Migration `0062_peaceful_ravenous.sql` adds a covering title-order index, avoiding a full result sort.
- The streamed Radarr parser slices complete record fragments instead of concatenating every character. Byte/record bounds, fragmented UTF-8, reader cleanup, and strict JSON validation remain covered by tests.
- Audit SQL statements reuse the existing bounded statement cache (64 statements per database). Audit staging/matching yields between transactions on a 20ms elapsed-time budget instead of an unconditional timer after every 100 records. This is a scheduling budget, not a maximum stall guarantee.
- Season-history updates use the existing show index. This prevents SQLite choosing a library-wide scan for each season without planner statistics.
- Artist rollups write in 500-row transactions with cooperative yielding, skip unchanged sizes, and finalize native statements. The complete track stream is still required before updating totals. Batching adds no second library-sized array. Existing show-audit statements now also finalize explicitly.

## Measured results

### Findings query

Median of three serial samples: count plus first 50 rows and evidence decoding, one Plex match per finding, file-backed temporary SQLite. These are **saved findings**, not total catalog movies. Full HTTP/auth overhead is excluded. Before and after return identical totals.

| Findings | Ignored titles | Before | After |
| ---: | ---: | ---: | ---: |
| 3,000 | 0 | 4.03 ms | 0.98 ms |
| 3,000 | 100 | 890 ms | 11.14 ms |
| 30,000 | 0 | 43.62 ms | 2.46 ms |
| 30,000 | 100 | 9,930 ms | 91.94 ms |
| 100,000 | 0 | 499 ms | 7.62 ms |
| 100,000 | 100 | 33,074 ms | 332.42 ms |

Raw samples and methodology: [query results](missing-content-query-performance.json).

### Movie sync and responsiveness

| Fixture | Initial audit-enabled median | Optimized audit-enabled median | Optimized audit-disabled median |
| --- | ---: | ---: | ---: |
| 2,775 Plex / 2,899 Radarr movies | 1.726 s | 0.837 s | 0.327 s |
| 27,750 Plex / 28,990 Radarr movies | 17.250 s | 8.161 s | 3.110 s |

The initial figures are the saved pre-pass measurements in [initial results](missing-content-performance.json). The optimized harness additionally runs concurrent HTTP probes, so this is an indicative throughput comparison, not a perfectly identical load. Both return exactly 39 metadata and 8 version findings, use the same 10/93 Plex pages, and make two Radarr requests plus the PMS identity check per audit. Audit overhead is now approximately 0.51s at normal size and 5.05s at tenfold size.

For the tenfold audit-enabled runs, real Missing Content route HTTP p95 ranged **91–124ms**, with **217–283ms** maximum observations and zero errors (107–122 request pairs per run). A separate worker schedules concurrent health/findings requests so main-thread SQLite stalls are included. The server mounts the real feature router and a trivial health handler, not the entire application middleware. These sync fixtures contain only 47 findings; high finding counts are measured separately above. This does not demonstrate simultaneous 100k-finding queries during full live sync.

The 5ms heartbeat's largest observed gap during those runs was 119–123ms. Heap samples peaked at 119–128MiB and process RSS at 342–354MiB; RSS includes the probe worker, SQLite, and runtime, and is not isolated feature memory. Normal-size runs are too short for stable tail percentiles. Real network/large history/multi-library contention remains unmeasured.

Raw final samples: [sync and HTTP results](performance-pass-sync.json).

### Parser and other sync writes

- Parser: 28,990 records / 79.46MiB, three serial samples after warmup, excluding generation. Median **2,285→733ms** with 64KiB chunks, **2,310→836ms** with 8KiB chunks.
- Season history: 1,000 updates across 50,000 seasons, equivalent starting data and actual index definitions: **5,251→7ms**. This fixes a bad query plan; deployed planner statistics can affect whether the old plan occurred.
- 100,000 unchanged artist totals: **515→420ms** overall. Largest individual transaction **515→2.9ms**. The cooperative yield budget remains 50ms; transaction duration is not the overall event-loop stall measurement. At 10,000 artists, overall time was **59.85→47.47ms**.

## Reproduce

Run from the repository root; each command uses synthetic data. Run benchmarks serially to avoid CPU contention. The query benchmark's old 100k-row/ignored-title case intentionally takes tens of seconds per sample.

```powershell
deno run -A backend/src/features/missingContent/performance.ts 1
deno run -A backend/src/features/missingContent/performance.ts 10
deno run -A backend/src/features/missingContent/queryPerformance.ts 3000 3
deno run -A backend/src/features/missingContent/queryPerformance.ts 30000 3
deno run -A backend/src/features/missingContent/queryPerformance.ts 100000 3
deno run -A backend/src/features/missingContent/stream_performance.ts 10
deno run -A tools/performance/sync-writes.ts
```

The query and sync-write harnesses include both old/new query shapes. The parser and sync harnesses measure the current implementation; their pre-pass numbers above are recorded comparison runs.

## Remaining limits and rollout

- With ignored content, the exact findings count still scans active finding evidence. At 100,000 findings this remains ~332ms of synchronous work. Deep OFFSET pages remain linear. Normalizing match keys or changing pagination/count behavior would be a separate design change.
- SQLite is still synchronous in the server process. Cooperative yields reduce long work bursts but do not interrupt individual SQL statements or guarantee latency. Atomic audit publication remains one transaction.
- Provider network latency, full live syncs, millions of movies, large real watch histories, and simultaneous heavy endpoints were not benchmarked here. This is a focused pass, not an app-wide latency guarantee.
- The new index is included as migration 0062 and will be applied through the normal migration/startup path. This pass did not migrate the live database.

Regression checks cover filter/server/dismissal equivalence, immediate ignored-content changes, query plans, audit publication/cancellation, parser boundaries/cleanup, season scoping/maxima, and multi-batch artist updates including incomplete input streams.

## Validation

`deno task test`: 857 passed (6 steps), 0 failed, 10 ignored. Full configured formatting and lint checks passed. Typecheck covers non-ignored backend/frontend/shared/tools TypeScript sources; the pre-existing ignored restore probe described in the feature notes is not part of that source set.
