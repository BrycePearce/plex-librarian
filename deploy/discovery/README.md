# Optional host discovery — implementation validation

The supported target is one **native Linux Docker host**, including Unraid.
The complete acceptance matrix and one-step Unraid distribution remain unfinished;
no helper image has been published.
Docker Desktop can run transport fixtures but cannot certify declared native Linux storage. The
helper refuses Desktop/WSL.

## Access boundary and pairing

Only the helper mounts `/var/run/docker.sock`. **That socket gives the helper
host-administrator-equivalent Docker API access even when mounted read-only.** The fixed collector
uses read-only commands; socket mounting does not enforce that. The helper has host PID and network
namespaces so `docker top` and `ss` refer to the same processes. It needs `SYS_PTRACE` and
`DAC_READ_SEARCH` to inspect listener ownership. It has no media mounts, accepts no shell commands
or Docker requests, and exposes no TCP port.

Librarian mounts only a dedicated `/discovery` directory read-only. Do not share its database
directory, Docker socket, media trees, or the helper directory with other apps. The helper creates a
256-bit random key and Unix socket with mode 0600; both containers currently run as root. Use a
local filesystem supporting Unix sockets and permissions. Back up the key securely if maintaining
pairing through a helper reinstall. The key never appears in browser URLs or API responses.

**Enable host discovery** pins the key hash and daemon identity to the active Plex server. Each
request uses authentication plus a fresh random challenge; responses are HMAC-bound to that
challenge. Local socket permissions protect transit. Only allowlisted container identity, mount
overrides, networks, ports, listener ports, daemon identity and collection time cross the socket.
Environment, labels, commands, process details, volume options and service credentials are excluded.
Responses are limited to 2 MB, collection to 25 seconds, requests to 30 seconds, and four
authenticated concurrent requests share one collection. Evidence older than 60 seconds or more than
five seconds in the future is rejected.

Configured hostnames, including Plex OAuth `plex.direct` addresses, are resolved automatically when
they are not literal Docker network addresses. Each dependent refresh repeats the DNS lookup
(three-second timeout per A/AAAA query, at most two queries in flight). Every returned address and
the configured port must identify the same container. Changed or unavailable DNS cannot reuse cached
mapping authority; hostname text is never decoded into an assumed IP address.

No pairing authorizes deletion. Both destinations remain unchecked. A changed key or daemon requires
**Advanced → Disable host discovery**, then explicit re-enablement. Old automatic mappings remain
unavailable until freshly identified; they are never silently promoted to manual mappings. Manual
overrides require explicit editing or removal in Advanced.

## Release installation (prepared, not published)

The release workflow now prepares application and helper images for AMD64 and ARM64, with
separate digest artifacts and matching version tags. These changes have not been pushed or run in
GitHub Actions. The image references below are release targets, not a claim that the helper can
already be downloaded. Do not advertise installation until the images and Unraid listing are available.

For a **new** Linux Docker installation, `compose.release.yaml` contains the whole Librarian stack,
including the helper and private transport volume. After publication, the installation command is:

```sh
docker compose -f compose.release.yaml up -d
```

Open Librarian on port 8288, sign in with Plex, connect services, then choose **Enable host discovery**.
The Compose file does not start, reconfigure or mount media from Plex/Arr/QB. Enter reachable
same-host service addresses in Librarian. Do not combine this fresh-stack file with an existing
Librarian installation: that would create a separate database. Use the development override below
or explicitly preserve your existing database and transport configuration when upgrading.

For **fresh Unraid installations**, install Librarian and the optional Discovery helper templates.
They share the `plex-librarian-discovery` named Docker volume automatically, read-only in Librarian.
There is no transport path field to fill in. Once installed, enable discovery in Media connections.
Only one helper should use that volume on a host. Plex-only use still works without the helper.

This is **two container installations**, not one-step Unraid installation. A standard Unraid template
creates one container; no supported companion-install mechanism was established. The named volume
removes manual wiring without adding Docker control to Librarian. See the actual
[Unraid template handling](https://raw.githubusercontent.com/unraid/webgui/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php),
[container creation](https://raw.githubusercontent.com/unraid/webgui/master/emhttp/plugins/dynamix.docker.manager/include/CreateDocker.php),
and [Docker named-volume behavior](https://docs.docker.com/engine/storage/volumes/).

**Existing discovery installations:** retain the original `/discovery` bind directory in both
containers, including its pairing key. Do not add the new named-volume mount alongside that bind or
replace it with an empty volume. Saved Unraid templates are not migrated by these source changes.
When adopting updated template settings, keep the old transport mount and omit the new `--mount`
argument. Existing paired state and accepted deletion evidence must remain intact.

## Development installation artifacts

`compose.yaml` is an override for an existing Compose service named `librarian`. It builds the
helper from this checkout and adds the dedicated transport volume. On an **authorized disposable
native Linux host**, use:

```sh
docker compose -f /absolute/path/to/base-compose.yaml \
  -f /absolute/path/to/checkout/deploy/discovery/compose.yaml up -d --build
```

The paths must refer to the disposable deployment. The override has no replacement Librarian service
image or credentials; it extends your base file. Relative build paths in Compose resolve against the
first file: set `build.context` to the absolute checkout path when the base file is elsewhere. Then
connect services through their normal UI and choose **Enable host discovery**. No report upload is
part of pairing.

For development before publication, build a local helper image with
`docker build -f deploy/discovery/Dockerfile -t plex-librarian-discovery:local .`
**only on an explicitly authorized host**. Override the helper template's Repository to that local
tag for the disposable test installation. The template's release reference is not published by this
task. No alternate helper architecture has been introduced to conceal the remaining installation gate.

## Safe local verification

From the repository root on the Windows development machine:

```powershell
deno task verify
docker build -f deploy/discovery/Dockerfile -t plex-librarian-discovery:local-test .
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=64m `
  --mount "type=bind,source=$((Get-Location).Path),target=/workspace,readonly" `
  --workdir /workspace --entrypoint deno plex-librarian-discovery:local-test `
  test --no-config --allow-all `
  backend/src/features/settings/discoveryTransport_test.ts
```

The build creates only a local image. The final command uses that image and has **no Docker socket,
network, or writable media mount**. It tests real Unix-socket transport with a fixture collector. It
is not native-host collection or deletion acceptance.

## Native acceptance still required

Before any remote action, obtain an SSH destination, an **absolute disposable fixture directory**,
and explicit authorization to install/run the helper and delete only generated test media. The
recorded demo authorization is limited to that isolated setup; it does not authorize production
installation or a different destination. Preserve its evidence and verify current access/scope before
resuming. Use the following procedure on disposable fixtures.

1. Inspect the destination and prove the fixture path is isolated from production. Start fresh
   service containers and Librarian with a new database and zero saved relationships. Mount only
   generated fixture media in the service containers.
2. Start the packaged helper in its real host namespaces, enable it once, and connect Plex,
   Sonarr/Radarr and QB through normal UI/API saves. Verify mappings appear without manually
   inserting roots or supplying a collector response.
3. Exercise Plex-only, Sonarr-only, QB-only, and combined show and season choices through preview,
   enqueue and the existing worker. Observe files only as independent test evidence. Include
   separate copies with real Arr import history, shared entries, three season jobs, mixed-season
   packs, retained overlaps and empty/failed download inventories.
4. Change mounts, container identity and manifests between preview/enqueue/execution and after the
   first service response. Stop the helper, interrupt responses and restart the worker. Confirm
   affected work holds without widening scope, replaying uncertain requests or losing attempt
   evidence/reservations. Check UI outcomes.
5. Record actual API responses separately from filesystem observations. Retain the disposable
   evidence until reviewed. Do not run cleanup against production media.

The complete matrix and distribution gate must pass before retiring the retained diagnostic report
routes/tests or claiming this feature ready for release.
