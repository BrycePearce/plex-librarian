# Historical filesystem identity

The number-only identity guard correctly rejected unsafe JavaScript integers, but
that also excluded usable Linux filesystems with 64-bit inode IDs. Inspection
checks the download root first, then the source, then the parent. Operator-provided
production diagnostics confirm precision loss on all three objects: the root inode
is the first failing guard. Device ID is consistently `44`, valid and exactly
representable. These are positive, nonzero native IDs, not missing or signed IDs.

| Object | Deno numeric display | Deno bigint | Native inode |
| --- | --- | --- | --- |
| `/downloads` | 648799825613029800 | 648799825613029760 | 648799825613029714 |
| Manhattan S02 release directory | 649925725556682000 | 649925725556681984 | 649925725556681959 |
| Manhattan S02E10 source file | 649925721227816700 | 649925721227816704 | 649925721227816726 |

The numeric display is the shortest decimal representation of a rounded binary64
value; the bigint display exposes that same rounded integer. Their different
printed digits do not indicate recovered precision.

On Deno 2.9.5, a disposable Linux/DrvFS file's native inode was
`12666373953984439`, while both `Deno.lstat()` and Node-compatible
`lstat({ bigint: true })` returned `12666373953984440`. Bigint return types do not
preserve native precision in this runtime. Converting those values to strings or
BigInt cannot recover the lost bit. The subsequent operator-provided Unraid
diagnostics above confirm the same cause in production. The fix has **not** been
deployed or exercised on production: post-fix Unraid behavior remains unverified.

Historical inspection now reads GNU `/usr/bin/stat` with fixed arguments, no
shell, a three-second command timeout, and UTC/C-locale formatting. Coreutils is
already required for read-only access diagnostics; the Docker build asserts that
`stat` is present too. It does not dereference the final component. Existing
component-by-component symlink checks, mount/root/parent bindings, same-entry
aliases, owner checks, consent, and durable unlink handling remain in place.
No new host helper or privileges are needed. Stat only reads metadata.
Each full inspection makes three sequential metadata subprocess calls (root,
source, parent); an absence check makes two. Work is linear in inspected files,
with no subprocess per ancestor, shell, or per-file full service-plan rebuild.
The disposable 100-file season acceptance test passed in about 24 seconds,
including mocked service latency and multiple preview/execution scenarios.

Snapshot version 2 stores device/inode IDs as canonical unsigned decimal strings,
including root and parent identity keys. Zero devices are valid; zero inodes,
negative/signed IDs, missing IDs, malformed output and values beyond unsigned
64-bit range are rejected. Timestamps remain exact UTC text from the same native
observation as the source ID and size. JSON persistence and fingerprints never
convert identity strings to Number. Old numeric snapshots require a new preview
and explicit consent; they are never upgraded into deletion authority. Existing
interrupted intents still become uncertain and are never replayed.

This does not promise inode uniqueness forever, prevent pre-inspection replacement,
or eliminate the finite observation-to-unlink window. No name/size fallback is
used. Filesystems with absent or unstable native IDs remain unsuitable. Optional
cleanup failures do not block ordinary service deletion.

## Diagnostics and regression coverage

`tools/inspect_historical_identity.ts ROOT SOURCE` is read-only and reports root,
parent and source separately: Deno numbers, Node-compatible bigint results and
exact GNU stat output. It does not read media content or service credentials.
Use a source from the historical preview, not a guessed match by title.

Run `historicalNativeStat_test.ts` natively on Linux with `--allow-all`. Its default
fixture uses `/tmp`; setting `HISTORICAL_LARGE_ID_DIR` to a disposable-capable DrvFS
directory exercises real large odd inode IDs and the pinned runtime's precision
loss. Tests create and remove only their own `plex-native-identity-*` directory.
The existing `tools/run_historical_linux_gate.sh` exercises bind aliases, unmounts,
parent replacement, hardlinks, copies, symlinks and no-replay behavior in a private
mount namespace. Parser tests include distinct IDs that collide as Number,
unsigned 64-bit boundaries and unavailable identity; SQLite tests cover exact
serialization/fingerprints and old pending/interrupted evidence.

Earlier Linux fixtures used small inode IDs. They verified that unsafe numbers
were rejected, not that large native IDs could be read exactly. Exact production
values now cover parsing, JSON/SQLite persistence and fingerprint sensitivity for
root, parent and source. Native disposable tests cover revalidation and replacement.
The Dockerfile requires `/usr/bin/stat --version` to succeed in the runtime stage;
a full image build has not been run in this investigation. Production supplied
successful native stat results, but post-fix behavior there is still unverified.
