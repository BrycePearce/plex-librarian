# Enable discovery on an existing Unraid installation

Updating the Librarian image or reconnecting Sonarr does not install the optional
host helper or change an existing Unraid template. Discovery needs both the helper
and its private connection to Librarian. This applies to services running on one
native Linux Docker host, including Unraid.

Before changing anything, back up the existing Unraid template. If `/discovery`
is already mounted, preserve that original mount and pairing key in both containers;
do not add a second mount or substitute an empty volume. Follow the publication
check in [the installation guide](README.md) before trying to pull the helper image.

Already paired installations should skip steps 1–2: update their existing containers
while retaining the original transport configuration and key. Do not install a second
helper or add another mount. Verify discovery afterwards; re-enable only if disabled.

1. Read the access requirements below, then download
   [the helper template](plex-librarian-discovery.xml) to Unraid's saved templates.
   For a host without that saved template, run in the Unraid Terminal:

   ```sh
   test ! -e /boot/config/plugins/dockerMan/templates-user/my-plex-librarian-discovery.xml &&
     curl -fL https://raw.githubusercontent.com/BrycePearce/plex-librarian/main/deploy/discovery/plex-librarian-discovery.xml \
       -o /boot/config/plugins/dockerMan/templates-user/my-plex-librarian-discovery.xml
   ```

   In **Docker → Add Container**, select `plex-librarian-discovery` from the
   templates and Apply. It uses image
   `ghcr.io/brycepearce/plex-librarian-discovery:latest`. Install only one helper
   using the `plex-librarian-discovery` volume. Enable its Unraid autostart if you
   want discovery available after starting the array.
2. Only if Librarian has no `/discovery` mount, edit the **existing Librarian container**
   in Unraid, switch to Advanced View, and append this to **Extra Parameters**, keeping
   the existing parameters. If the helper already uses a bind-mounted transport directory,
   mount that same directory read-only instead of adding the named volume below:

   ```text
   --mount=type=volume,source=plex-librarian-discovery,target=/discovery,readonly
   ```

   Keep the existing `/data` database mapping, ports, and connection settings.
   Apply the change. This recreates Librarian; Plex, Sonarr and qBittorrent do not
   need to restart. Do not install a second Librarian or use the fresh-stack
   Compose file to upgrade an existing database.
3. Open **Media connections** in Librarian. If discovery is disabled, choose **Enable host discovery**.
   Read the administrator-access warning, check the initially unchecked acknowledgement,
   and choose **Confirm enable discovery**. Cancel makes no pairing request.
   Existing saved connections can be discovered without disconnecting them.
4. Check the discovery status, then open a deletion preview for the intended
   selection. Pairing, service connection, and deletion eligibility are separate
   checks. Both optional deletion destinations start unchecked.

## Existing manual mappings

Discovery preserves manual relationships. **Discovery details → Manual relationships
preserved** means the helper is connected but is not allowed to replace those
assertions. A deletion preview may still work with valid manual mappings.

To move a service to automatic mapping, open **Discovery details** and choose
**Download mapping backup**. Review its saved relationships, then use **Remove
mapping** and confirm removal for each old relationship for that service. Retry
discovery after removal. These controls remove configuration, not media. New
installations do not need this migration or any manually entered paths. Manual
mapping and local-access editors are not part of the single-host MVP.

Review a fresh deletion preview after any mapping change;
do not assume an earlier preview or queued operation has the same scope. Do not
replace manual paths with guessed `/data` values. Different container paths are
supported when discovery can identify their actual mounts unambiguously.

## Access and verification

Only the helper gets the Docker socket, host PID/network namespaces, and the two
inspection capabilities in its template. Docker-socket access gives the helper
host-administrator-equivalent power even with a read-only socket mount. Its fixed
collector uses read-only commands; Librarian receives authenticated configuration
evidence over the private Unix socket. Neither container needs new media mounts.

Installing an updated helper grants that image the same host-administrator power.
The template download above tracks `main`, and its image tracks `latest`; neither
is immutable. Before public installation, require the release security checks in
[the installation guide](README.md), review the template revision and image digest,
and keep the whole Librarian API restricted to trusted administrators. Plex sign-in
does not authenticate callers of the application API.

The transport directory must be owned by the container user (currently root), must
not be a symlink, and must not be writable by group/other users. Its key must be a
regular non-symlink file with the same owner and private permissions (normally
0600). A previously shared or permissive directory now fails closed. Review its
exact host path and ownership before correcting it; do not relax permissions or
replace a working private volume during a routine image upgrade.

Disabling discovery in Librarian removes pairing authority but does not stop the
helper or revoke its Docker access. To withdraw that privilege, stop the identified
helper container and prevent its automatic restart. Preserve the transport and
database while deciding whether to reinstall. If the key was exposed, stop the
helper, replace only its identified key with a new securely generated private key,
restart the helper, then explicitly disable and re-enable discovery in Librarian.
Changing the key deliberately invalidates the old pairing; pending operations may
need attention. Do not delete operation history or reservations to force progress.
There is no automatic key rotation or revocation of a running compromised helper.

Open a show or season preview to verify relevant destinations and paths. An
available checkbox is not proof of completed deletion. Confirming enqueues a
durable operation whose worker revalidates the accepted scope. Leave confirmation
untouched when performing a setup-only check.
