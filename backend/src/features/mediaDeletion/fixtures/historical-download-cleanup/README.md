# Historical download cleanup fixtures

Data only; no cleanup implementation or deletion authority. Use with future Deno
tests beside `serviceOwnedPlanning_test.ts`. The records follow the small plain
object/array fixtures in that file and `integrations/arr/client_test.ts`; JSON keeps
the raw history string types visible. Load with `Deno.readTextFile(new URL(...,
import.meta.url))` and `JSON.parse`, or JSON imports. No service connection is needed.

## Provenance and shapes

Read-only source: a saved season verification bundle,
specifically `sonarr-import-history.json`, `season-2-before-preview.json` and
`remaining-download-correlation.csv`. No production identifiers are copied here.
Paths, title, dates, IDs, hashes and sizes are invented; relationships are preserved.

- `sonarr-history.json`: two reduced `downloadFolderImported` records. The source
  had 22 distinct exact dropped paths, one common download ID, string `data.fileId`
  and string `data.size`. All 22 matched the saved preview's Sonarr file ID,
  imported path and numeric size. Keep those types, the shared season-pack hash
  and distinct episode/file ownership; invented sizes above 32 bits exercise byte
  count handling. Unused quality/client metadata is omitted.
- `sonarr-current.json`: minimal **synthetic reconstruction**, not a captured raw
  Sonarr response. `episodes` is shaped for `/episode?seriesId=701`, `episodeFiles`
  for `/episodefile?seriesId=701`; `series` and `selections` are harness data.
  The saved preview corroborates file/path/size relationships, but does not prove
  a complete live episode-owner response. Monitored flags are synthetic.
- `synthetic-cases.json`: entirely synthetic shared-owner and negative cases.
  Each malformed array replaces the baseline history response for that case;
  pair it with baseline current inventory and absent QB inventory. Shared history
  uses its own `current` inventory. Wrappers/provenance/selections are harness
  metadata, not API response fields.
- `qb.json`: synthetic `DownloadJob` adapter objects matching
  `serviceOwnedPlanning_test.ts`, **not raw QB wire responses**. `snapshots.absent`
  is a successful empty summary inventory and implies null job lookup. The saved
  preview reported an absent QB target; it did not capture a complete empty QB
  inventory. `snapshots.overlappingCurrent` contains a different hash owning the
  first exact source file, while the historical hash remains absent. Manifest
  paths are relative to `savePath`. `newlyAppearing` names the ordered before/after
  snapshots; reuse them to model a job discovered on a later inventory refresh.

## Expected cases

These are expected lineage/ownership outcomes for future tests, not assertions
that fixtures alone authorize unlink. Filesystem access, stable identity, retained
entry checks, fresh ownership, accepted scope and explicit consent are still needed.

| Case | Expected eligibility / evidence under test |
| --- | --- |
| Baseline + `single` + absent QB | First source can qualify; second is outside selection. Exact source/import paths and current file/episode IDs agree. |
| Baseline + `season` + absent QB | Two distinct sources can qualify; both imports share one historical download ID. |
| Baseline + overlapping current QB | First source retained despite historical hash absence; a different current job owns its exact entry. Second source is unaffected by this job. |
| Baseline + newly appearing QB | First source initially has no QB claim; after refresh it is retained. Rereading only the historical hash would miss the new owner. |
| Shared + partial selection | Retain the source: episode 812 also owns current file 611 and is unselected. |
| Shared + complete selection | One source can qualify, with both import records/owners retained and one eventual candidate/attempt. |
| Missing exact dropped path | Skip: synthetic `sourcePath` is only a release directory; it must not substitute for `droppedPath`. |
| Conflicting sizes | Skip: two records for the same episode/file/source report different sizes; one disagrees with current size. Do not choose the convenient record. |
| Conflicting file IDs | Skip: synthetic `fileId` and `FileId` disagree; do not select one casing. |
| Malformed size | Skip: recorded size is not numeric; do not replace it with current size. |

Shared owners, missing paths, size/ID conflicts, malformed size, and QB overlaps or
transitions were not observed in the saved evidence. No local stat, inode, hardlink,
content identity or complete current ownership claim is inferred from the CSV's
equal-size correlation. These fixtures do not test filesystem behavior or the
cleanup algorithm.

Validation during preparation: all four JSON files parsed; baseline and shared
history references, owner sets, sizes and paths matched their current inventories;
selection references and QB manifest paths/sizes were consistent. Each negative
case was checked to contain its stated deliberate defect. No application imports,
service requests, database access or media operations were used.
