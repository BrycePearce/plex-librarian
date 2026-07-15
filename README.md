# Plex Librarian

Understand what is taking up space on your Plex server, find content nobody is
watching, and clean up your library with confidence.

Plex Librarian is a self-hosted library health dashboard built for Plex. It
helps you:

- Find movies, shows, and music that have gone unwatched for months or years.
- Sort stale content by age, size, play count, and other useful signals.
- Find duplicate movie and episode versions that are wasting disk space.
- Review viewing activity, inactive users, and unusual sharing patterns.
- Delete whole titles through Sonarr or Radarr so they are not immediately
  downloaded again.
- Run scheduled library syncs and follow their progress from the web UI.

It ships as a single Docker container and is designed to run alongside Plex on
Unraid or any other Docker host.

## Install on Unraid

Install **Plex Librarian** from Community Applications (the **Apps** tab). Map
`/data` to a persistent appdata directory such as
`/mnt/user/appdata/plex-librarian`, then start the container.

Open the web UI from the Docker page and select **Sign in with Plex** — the app
walks you through the rest.

Plex Librarian does not need access to your media shares. Sonarr, Radarr, or
Plex performs file deletion using its own existing mounts and permissions.

## Install with Docker

Create a Compose file with a persistent `/data` mount:

```yaml
services:
  plex-librarian:
    image: ghcr.io/brycepearce/plex-librarian:latest
    container_name: plex-librarian
    ports:
      - "8288:8080"
    volumes:
      - /path/to/appdata/plex-librarian:/data
    restart: unless-stopped
```

Start the container, open `http://<docker-host>:8288`, and select **Sign in with
Plex**:

```bash
docker compose up -d
```

## Connect Sonarr and Radarr

Plex Librarian can coordinate whole-title deletion with Radarr for movie
libraries and Sonarr for TV libraries. Arr removes the title and its files, then
Plex Librarian asks Plex to refresh the affected library.

The confirmation dialog verifies the mapped Arr title before deletion and shows
the folder Arr manages, plus any extra files Radarr reports for a movie. Arr's
`deleteFiles` operation owns removal of that complete title folder and includes
its built-in safeguards for shared or nested movie paths. If a library is not
mapped, coordinated deletion is refused; **Delete from Plex only** must be
selected explicitly.

Open **Settings → Media connections**, add an instance with its URL and API key
(found in Sonarr/Radarr under **Settings → General → Security**), then map each
library to an instance under **Library mappings**.

Use a URL that is reachable from inside the Plex Librarian container, such as
`http://192.168.1.20:8989` or `http://sonarr:8989` on a shared Docker network —
not `localhost`, which points back at Plex Librarian itself.

### Optional qBittorrent cleanup

Add qBittorrent under **Settings → Media connections** to inspect live torrents
associated with Sonarr/Radarr import history. The delete confirmation can then
show a bounded payload file tree plus the job's tracker host, ratio, upload
total, and cumulative seeding time. When explicitly selected, Plex Librarian
removes the verified job from qBittorrent and asks qBittorrent to delete its
downloaded payload before Arr deletes the remaining library hardlink. Plex
Librarian does not locate or independently delete a saved `.torrent` file. If
the association cannot be verified for an item, that row remains Arr-only. In a
bulk selection, qBittorrent cleanup applies only to rows with a verified job;
the confirmation list shows small Plex, Sonarr, Radarr, and qBittorrent action
indicators for each item. The option stays disabled only when none of the
selected items can be verified for qBittorrent cleanup.

Retained Arr import history can point at an old download path even after its
torrent has disappeared from qBittorrent. Plex Librarian shows those paths as
unmanaged leftovers but never recursively deletes them: without a live torrent
manifest or Arr ownership there is no safe proof that every neighboring file
belongs to the selected title. Configure Radarr's **Import Extra Files** setting
for sidecars such as `sub`, `idx`, and `srt` so Radarr can track them with the
managed movie folder.

Use the qBittorrent Web UI URL as seen from the Plex Librarian container. Enter
qBittorrent's Web UI username and password, or leave both blank when
qBittorrent's authentication bypass explicitly trusts the Plex Librarian host or
subnet. Desktop qBittorrent users must enable **Web User Interface (Remote
control)** first. In Docker, `localhost` points to Plex Librarian rather than
the qBittorrent container. Private tracker passkeys are never returned to the
browser; only the tracker hostname is displayed.

## Configuration

Most settings are managed from the web UI. These environment variables are
available for Docker and advanced Unraid installations:

| Variable                     | Required | Description                                                                                           |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `DB_PATH`                    | No       | SQLite database path. Default: `/data/librarian.db`                                                   |
| `PORT`                       | No       | Container HTTP port. Default: `8080`                                                                  |
| `PLEX_URL`                   | No       | Direct Plex server URL; use with `PLEX_TOKEN` to skip the setup wizard                                |
| `PLEX_TOKEN`                 | No       | Plex authentication token; use with `PLEX_URL`                                                        |
| `QBITTORRENT_URL`            | No       | qBittorrent Web UI URL; overrides qBittorrent connections saved in the web UI                         |
| `QBITTORRENT_USERNAME`       | No       | qBittorrent Web UI username; omit only when authentication bypass trusts this container               |
| `QBITTORRENT_PASSWORD`       | No       | qBittorrent Web UI password; omit only when authentication bypass trusts this container               |
| `LIBRARY_SYNC_CONCURRENCY`   | No       | Maximum libraries synced in parallel. Default: `3`                                                    |
| `FETCH_CONCURRENCY`          | No       | Maximum concurrent Plex page requests per library. Default: `8`                                       |
| `SYNC_STALL_TIMEOUT_MINUTES` | No       | Abort a sync after this many minutes without progress. Default: `15`                                  |
| `LOG_RETENTION_DAYS`         | No       | Days to retain sync history and activity entries; use `0` to retain them indefinitely. Default: `180` |

The concurrency defaults are intentionally conservative because Plex Librarian
often shares a host with Plex. Raise them only when the host has capacity to
spare.

Sonarr and Radarr connections are configured in the web UI rather than through
environment variables so multiple instances can be managed independently.
qBittorrent can also be configured there; the `QBITTORRENT_*` variables are a
power-user override and take precedence over database-backed connections.

### Manual Plex configuration

Set both `PLEX_URL` and `PLEX_TOKEN` to bypass the Plex authorization wizard.
Environment variables take precedence over credentials saved through the web UI.

Use a direct local Plex URL when possible, such as `http://192.168.1.100:32400`.
To locate a token in Plex Web, open an item's three-dot menu, select **Get Info
→ View XML**, and copy the `X-Plex-Token` parameter from the resulting URL.

## Optional Plex webhooks

Plex Pass users can configure a webhook for faster viewing-activity updates
between full syncs.

In Plex Web, open **Settings → Webhooks → Add Webhook** and enter:

```text
http://<plex-librarian-host>:8288/api/webhook/plex
```

The webhook records playback lifecycle events used for watch-state and user
activity insights. It follows the same trusted-network security model as the
rest of the application.

## Backups and security

All application data is stored under `/data`, including the SQLite database,
Plex credentials, Sonarr/Radarr API keys, mappings, and activity history. Back
up this directory and treat the backup as sensitive.

Plex Librarian is intended for a trusted self-hosted network. If remote access
is required, place it behind a reverse proxy that provides authentication and
TLS.

## Questions or problems

Open an issue at
[github.com/BrycePearce/plex-librarian/issues](https://github.com/BrycePearce/plex-librarian/issues).
