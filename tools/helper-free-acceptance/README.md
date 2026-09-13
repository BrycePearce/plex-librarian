# Disposable native acceptance bootstrap

These tools bootstrap disposable native fixtures, not production discovery. They
generate playable synthetic media and private trackerless torrents, then import
them through native Arr/QB workflows. They do not automatically execute the full
acceptance matrix. Recorded observations and limits are in the
[native acceptance report](../../docs/helper-free-native-acceptance-20260913.md).
Do not use these tools against a production engine.

## Start only on a dedicated test engine

Use an explicitly selected, isolated Linux Docker engine with Compose v2, image
pull access, a local repository checkout, and available loopback ports 18288,
18989, 17878, 18080 and 32499. The bind-mounted seed files require a local engine;
for a dedicated remote host, copy this checkout there and run locally on that host.
Do not reuse service configs, Plex tokens, downloaded media or production mounts.
Do not start Docker Desktop without checking whether existing containers would
automatically start. These scripts never start an engine.

From the repository root, generate fixture configuration:

```powershell
deno run --allow-read=tools/helper-free-acceptance --allow-write=tools/helper-free-acceptance/.runtime tools/helper-free-acceptance/bootstrap.ts
$testContext = 'YOUR-DEDICATED-TEST-CONTEXT'
docker context inspect $testContext
docker --context $testContext info --format '{{.OSType}}'
docker --context $testContext ps -a --format '{{.Names}}'
docker --context $testContext compose -f tools/helper-free-acceptance/compose.yaml config --quiet
```

Verify that the endpoint is the dedicated engine, the OS is `linux`, and no
existing `librarian-helper-free-acceptance` containers/volumes belong to an earlier
run you need to preserve. Then an operator may run:

```powershell
docker --context $testContext compose -f tools/helper-free-acceptance/compose.yaml up -d --build
docker --context $testContext compose -f tools/helper-free-acceptance/compose.yaml ps -a
docker --context $testContext compose -f tools/helper-free-acceptance/compose.yaml logs initialize
```

Image tags are bootstrap defaults. Record resolved image digests, service versions,
and the tested Git revision/index before reporting results; pin those digests for
any reproducible acceptance run. Native image configuration references:
[Sonarr](https://docs.linuxserver.io/images/docker-sonarr/),
[Radarr](https://docs.linuxserver.io/images/docker-radarr/),
[QB](https://docs.linuxserver.io/images/docker-qbittorrent/), and
[Plex](https://docs.linuxserver.io/images/docker-plex/).

All declared published ports bind to loopback. The base test network is internal, so services
cannot access production hosts or external trackers. No torrenting port is
published. Initialization runs without networking. Librarian receives only its
fresh database volume; it has no media, discovery or Docker socket mount.

Docker Desktop did not expose usable host ports for internal-network-only
containers in the recorded run. Metadata lookup also needs provisioning egress.
For a fresh test stack, explicitly add `-f
tools/helper-free-acceptance/provisioning.compose.yaml` to the Compose commands
above. This adds a separate ordinary bridge only to the new test services. It
allows outbound metadata requests and host-port access; do not configure public
trackers or production service addresses. Initialization remains networkless.
The recorded run attached an equivalent dedicated provisioning bridge manually.

| Service | Browser URL | URL from Librarian | Fixture media root |
| --- | --- | --- | --- |
| Librarian | `http://127.0.0.1:18288` | — | None |
| Sonarr | `http://127.0.0.1:18989` | `http://sonarr:8989` | `/arr-vault` |
| Radarr | `http://127.0.0.1:17878` | `http://radarr:7878` | `/movie-vault` |
| QB | `http://127.0.0.1:18080` | `http://qb:8080` | `/downloads-root` |
| Plex | `http://127.0.0.1:32499/web` | `http://plex:32400` | `/plex-library` |

Arr API keys are generated in ignored `.runtime/credentials.json`. Arr uses
external authentication only within this isolated test environment. QB's username
is `acceptance`; current native images generate an initial temporary password in
their startup log when no password is configured. Set a new disposable password
in its UI and do not publish service logs containing credentials. Startup/readiness
and this behavior must be checked against the actual image version.

## Generate and import fixtures

After bootstrap, with `ffmpeg` available:

```powershell
deno run --allow-read=tools/helper-free-acceptance/.runtime --allow-write=tools/helper-free-acceptance/.runtime --allow-run=ffmpeg tools/helper-free-acceptance/generate-fixtures.ts
```

`provision-sonarr-qb.ts` copies those generated payloads and creates the initial
Sonarr/QB fixtures. `provision-radarr.ts` imports the movie fixture.
`provision-tracked-season.ts 4` (or `5`) creates a real tracked season with native
download history. Run them with read/write access limited to `.runtime`,
`--allow-run=docker`, and loopback-only network access. They check exact Docker
Desktop project/container/volume ownership, refuse conflicting fixture state,
and keep credentials out of their output. They intentionally target the local
`desktop-linux` fixture context; adapting to a dedicated remote host requires
reviewing these guards, not changing a URL to an existing media server.

Native tracked import overrides the short synthetic video's sample rejection.
Untracked manual imports can legitimately have a null download ID; never invent
that association. The recorded native tracked lookup needed the uppercase hash.

Fresh unclaimed Plex can require loopback initialization. The optional
`plex-loopback-proxy.ts` runs **only in the disposable Plex network namespace**,
forwarding to native PMS on loopback. It is not part of Librarian or release
packaging and does not mock service results. Its opt-in `--inject-response-loss`
mode reads `/fixture-fault.json` (`{"deletePath":"/library/metadata/TEST_ID"}`),
forwards that DELETE, and once native success arrives substitutes a gateway 502.
Sanitized logs count native calls. This tests durable ambiguity, not claimed Plex
authentication. Do not inject faults into a production service.

## Provisioning and acceptance checklist for a new run

1. Establish fresh disposable Plex authentication and library setup. The internal
   network deliberately blocks Plex claim/OAuth and Arr metadata lookup. If these
   require Internet, arrange narrowly controlled test-only egress or prepare fresh
   fixture metadata in a separate dedicated provisioning environment. Do not
   casually remove isolation or borrow a production token/configuration.
2. Generate tiny synthetic playable video files and local private torrents with
   no public trackers. Import them through real Arr workflows to create native
   import provenance. Do not fake database history and call it native evidence.
   Create distinct hardlink names and independent copies in the fixture volume.
   The bootstrap's text probe validates volume hardlink capability only.
3. Configure test service connections and library assignments in Librarian, then
   exercise real preview/enqueue/worker/UI outcomes. Different root strings above
   are intentional; they are not Librarian path mappings. Use additional fixtures
   for identical native paths and retained-owner overlap.
4. Extend the cases and documented gaps in
   [the native acceptance report](../../docs/helper-free-native-acceptance-20260913.md),
   covering whole shows, seasons, Radarr, duplicate versions, sidecars, retained
   QB/Plex, absent versus failed reads, partial/empty Plex metadata, late imports,
   lost responses and process restart. A booted stack is not a passed matrix.
5. Use separate fresh test database fixtures for legacy queued/uncertain-operation
   upgrade checks; preserve attempts/reservations and prove there is no replay.

For each case record the selected IDs and paths, preview decisions, operation ID,
native request observations, final catalog state, and independent file existence
and hardlink-name observations. Keep API success separate from filesystem proof
and never equate selected bytes with measured reclaimed storage. Redact tokens,
cookies and passwords from reports. Record blocked or unrun rows explicitly.

Stop only the test stack when finished:

```powershell
docker --context $testContext compose -f tools/helper-free-acceptance/compose.yaml stop
```

No automatic cleanup command is provided. Keep named volumes and ignored seed
credentials while reviewing evidence; only remove them after verifying their exact
test-project ownership. Never use global prune, production compose files, or the
older demo scripts that reference an existing server.
