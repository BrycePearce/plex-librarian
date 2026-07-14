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

Start the container, open `http://<docker-host>:8288`, and select **Sign in
with Plex**:

```bash
docker compose up -d
```

## Connect Sonarr and Radarr

Plex Librarian can coordinate whole-title deletion with Radarr for movie
libraries and Sonarr for TV libraries. Arr removes the title and its files, then
Plex Librarian asks Plex to refresh the affected library.

Open **Settings → Sonarr & Radarr**, add an instance with its URL and API key
(found in Sonarr/Radarr under **Settings → General → Security**), then map each
library to an instance under **Library mappings**.

Use a URL that is reachable from inside the Plex Librarian container, such as
`http://192.168.1.20:8989` or `http://sonarr:8989` on a shared Docker network —
not `localhost`, which points back at Plex Librarian itself.

## Configuration

Most settings are managed from the web UI. These environment variables are
available for Docker and advanced Unraid installations:

| Variable                     | Required | Description                                                                                           |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `DB_PATH`                    | No       | SQLite database path. Default: `/data/librarian.db`                                                   |
| `PORT`                       | No       | Container HTTP port. Default: `8080`                                                                  |
| `PLEX_URL`                   | No       | Direct Plex server URL; use with `PLEX_TOKEN` to skip the setup wizard                                |
| `PLEX_TOKEN`                 | No       | Plex authentication token; use with `PLEX_URL`                                                        |
| `LIBRARY_SYNC_CONCURRENCY`   | No       | Maximum libraries synced in parallel. Default: `3`                                                    |
| `FETCH_CONCURRENCY`          | No       | Maximum concurrent Plex page requests per library. Default: `8`                                       |
| `SYNC_STALL_TIMEOUT_MINUTES` | No       | Abort a sync after this many minutes without progress. Default: `15`                                  |
| `LOG_RETENTION_DAYS`         | No       | Days to retain sync history and activity entries; use `0` to retain them indefinitely. Default: `180` |

The concurrency defaults are intentionally conservative because Plex Librarian
often shares a host with Plex. Raise them only when the host has capacity to
spare.

Sonarr and Radarr connections are configured in the web UI rather than through
environment variables so multiple instances can be managed independently.

### Manual Plex configuration

Set both `PLEX_URL` and `PLEX_TOKEN` to bypass the Plex authorization wizard.
Environment variables take precedence over credentials saved through the web
UI.

Use a direct local Plex URL when possible, such as
`http://192.168.1.100:32400`. To locate a token in Plex Web, open an item's
three-dot menu, select **Get Info → View XML**, and copy the `X-Plex-Token`
parameter from the resulting URL.

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
Plex credentials, Sonarr/Radarr API keys, mappings, and activity history. Back up
this directory and treat the backup as sensitive.

Plex Librarian is intended for a trusted self-hosted network. If remote access
is required, place it behind a reverse proxy that provides authentication and
TLS.

## Questions or problems

Open an issue at
[github.com/BrycePearce/plex-librarian/issues](https://github.com/BrycePearce/plex-librarian/issues).
