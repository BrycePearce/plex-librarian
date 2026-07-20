<div align="center">
  <img src="assets/icon.png" alt="Plex Librarian" width="128" height="128">

  # Plex Librarian

  **Find the Plex media nobody watches. Recover space without guesswork.**

  A lightweight, self-hosted library health dashboard for Plex.

  [![CI](https://github.com/BrycePearce/plex-librarian/actions/workflows/ci.yml/badge.svg)](https://github.com/BrycePearce/plex-librarian/actions/workflows/ci.yml)
  [![Docker pulls](https://img.shields.io/docker/pulls/edon231/plex-librarian?logo=docker&label=pulls)](https://hub.docker.com/r/edon231/plex-librarian)
  [![GHCR](https://img.shields.io/badge/GHCR-plex--librarian-2496ED?logo=docker&logoColor=white)](https://github.com/BrycePearce/plex-librarian/pkgs/container/plex-librarian)
  [![Unraid](https://img.shields.io/badge/Unraid-Community%20Apps-F15A2C?logo=unraid&logoColor=white)](https://ca.unraid.net/apps/plexlibrarian-08vc6n70wshbuf)
  [![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

  [Install](#installation) · [Features](#what-it-does) · [Integrations](#sonarr-radarr-and-qbittorrent) · [Configuration](#configuration) · [Get help](https://github.com/BrycePearce/plex-librarian/issues)
</div>

![Plex Librarian dashboard](https://github.com/user-attachments/assets/a8f19d12-d86f-4395-897b-0447768f5d12)

Plex Librarian turns stale, duplicated, and oversized media into clear cleanup
decisions. It combines Plex viewing history with file-size insights, user
activity, and optional Sonarr, Radarr, and qBittorrent integrations so you can
reclaim terabytes in a few deliberate clicks—not by blindly deleting files.

It ships as one small Docker container for Unraid or any other Docker host. The
defaults are designed to be useful immediately, while every destructive action
is previewed and revalidated before it runs.

## What it does

| | Capability | What you get |
| --- | --- | --- |
| 🧹 | **Stale media discovery** | Find unwatched or long-unwatched movies, shows, and music; filter and sort by age, size, play count, and more. |
| 💾 | **Duplicate detection** | Surface duplicate movie and episode versions and see how much space each copy consumes. |
| 👥 | **User insights** | Review viewing activity, inactive accounts, and signals that may indicate account sharing. |
| 🔗 | **Sonarr & Radarr coordination** | Remove a title through the app that manages it, preventing an immediate re-download. Multiple instances are supported. |
| 🌱 | **qBittorrent cleanup** | Optionally remove a verified torrent payload and its remaining Arr hardlink in the same guided workflow. |
| 🛡️ | **Deletion guardrails** | Preview every effect, check active playback and ownership, queue work durably, and retry or review failures. |
| 🔄 | **Automatic sync** | Schedule daily refreshes in your own time zone and follow live sync progress from the web UI. |

Plex Librarian complements tools such as Sonarr and Radarr: they acquire and
organize media; Plex Librarian shows what is no longer earning its space and
helps you remove it safely.

## Installation

### Unraid

[Open Plex Librarian in Community Apps](https://ca.unraid.net/apps/plexlibrarian-08vc6n70wshbuf),
or search for **Plex Librarian** from the **Apps** tab. Keep the defaults, select
**Apply**, then open the web UI from the Docker page and choose **Sign in with
Plex**. Plex Librarian discovers your server and starts its first sync.

Normal operation does not require access to your media shares. Plex, Sonarr, or
Radarr performs managed deletion using its own mounts and permissions. Only the
optional orphan-download cleanup needs the additional read-only library and
read/write download mounts described below.

### Docker Compose

Create a `compose.yml` file:

```yaml
services:
  plex-librarian:
    image: edon231/plex-librarian:latest
    container_name: plex-librarian
    ports:
      - "8288:8080"
    volumes:
      - plex-librarian-data:/data
      # Optional: required only for verified orphan-hardlink cleanup.
      # - /path/to/library:/media:ro
      # - /path/to/downloads:/downloads:rw
    restart: unless-stopped

volumes:
  plex-librarian-data:
```

Start the container, open `http://<docker-host>:8288`, and choose **Sign in with
Plex**:

```bash
docker compose up -d
```

Images are published for AMD64 and ARM64 to
[Docker Hub](https://hub.docker.com/r/edon231/plex-librarian) and
[GitHub Container Registry](https://github.com/BrycePearce/plex-librarian/pkgs/container/plex-librarian).
Use `edon231/plex-librarian:latest` for the newest stable release, or pin a full
version such as `edon231/plex-librarian:0.1.0` for predictable upgrades. The
equivalent GHCR image is `ghcr.io/brycepearce/plex-librarian`. The `edge` tag
tracks the latest successful build from `main` and may contain unreleased
changes.

## Sonarr, Radarr, and qBittorrent

### Connect Sonarr and Radarr

Plex Librarian can coordinate whole-title deletion with Radarr for movies and
Sonarr for TV. Arr removes the title and its files, then Plex Librarian asks
Plex to refresh the affected library.

Before anything is queued, the confirmation dialog verifies the mapped Arr
title and shows the folder it manages. Radarr's `deleteFiles` operation owns
removal of the complete title folder, including its safeguards for shared or
nested movie paths. If a library is not mapped, coordinated deletion is
refused; **Delete from Plex only** must be selected explicitly.

Open **Settings → Media connections**, add an instance with its URL and API key
(found in Sonarr/Radarr under **Settings → General → Security**), then map each
library under **Library mappings**.

Use a URL reachable from inside the Plex Librarian container, such as
`http://192.168.1.20:8989` or `http://sonarr:8989` on a shared Docker network.
Do not use `localhost`, which points back at Plex Librarian itself.

### Optional qBittorrent cleanup

Add qBittorrent under **Settings → Media connections** to inspect live torrents
associated with Sonarr/Radarr import history. The deletion preview shows the
bounded payload tree plus the job's tracker host, ratio, upload total, and
cumulative seeding time. When explicitly selected, Plex Librarian removes the
verified job and asks qBittorrent to delete its downloaded payload before Arr
deletes the remaining library hardlink.

Plex Librarian does not locate or independently delete a saved `.torrent` file.
If an association cannot be verified, that item remains Arr-only. In a bulk
selection, qBittorrent cleanup applies only to rows with a verified job, and the
preview identifies the Plex, Sonarr, Radarr, and qBittorrent actions for every
item.

#### Orphan hardlink cleanup

Retained Radarr import history can point to an old download path after its
torrent has disappeared. Plex Librarian shows these paths as unmanaged
leftovers by default. To inspect the common hardlink case, edit the Radarr
connection, expand **Orphan download cleanup**, and configure:

- The library root reported by Radarr and its read-only Plex Librarian mount.
- The download root reported by Radarr and its read/write Plex Librarian mount.

For example, Radarr paths under `/data/media` and `/data/torrents` could map to
Plex Librarian mounts `/media` and `/downloads`. Radarr roots may also be Windows
drive or UNC paths such as `D:\Media`; the Plex Librarian mount is always the
absolute Linux path visible inside its container.

Plex Librarian removes an orphaned source file only when the source and current
Radarr-managed destination are regular files on the same filesystem with the
same inode. It rechecks that identity immediately before unlinking, rejects
symbolic links and paths outside the configured download root, and prunes only
empty directories. Radarr-tracked media, subtitle, and metadata sidecars inside
the same historical payload are eligible under that exact rule. Untracked
sidecars, samples, metadata, and mixed directory contents are retained and
explained in the preview.

Inspection stops after a shared 5,000-entry budget per preview or 12 directory
levels and reports the unverified remainder; directories are never recursively
deleted. Multi-file torrents are removed with their payload only when every
manifest file is attributable to the selected Arr title. Mixed or partially
attributed packs remain untouched.

The two mounts must refer to the same underlying filesystems Radarr sees. Their
container paths can differ because the web UI stores the translation, but the
local library and download roots must be separate, non-overlapping paths.
Configure Radarr's **Import Extra Files** setting for sidecars such as `sub`,
`idx`, and `srt` so Radarr can track them with the managed movie folder.

Use the qBittorrent Web UI URL as seen from the Plex Librarian container. Enter
its username and password, or leave both blank only when qBittorrent's
authentication bypass explicitly trusts the Plex Librarian host or subnet.
Desktop qBittorrent users must first enable **Web User Interface (Remote
control)**. Private tracker passkeys are never returned to the browser; only the
tracker hostname is displayed.

## Configuration

Most settings live in the web UI. Under **Settings → Automatic sync**, you can
enable daily refreshes, choose the local-time hour and IANA time zone, and
decide whether the app catches up after being offline for more than 24 hours.
The page previews the next scheduled window, and named zones follow daylight
saving changes automatically. If a daylight-saving jump removes the chosen
local hour, that day's scheduled run is skipped.

These environment variables are available for Docker and advanced Unraid
installations:

| Variable | Required | Description |
| --- | :---: | --- |
| `DB_PATH` | No | SQLite database path. Default: `/data/librarian.db` |
| `PORT` | No | Container HTTP port. Default: `8080` |
| `PLEX_URL` | No | Direct Plex server URL; use with `PLEX_TOKEN` to skip the setup wizard |
| `PLEX_TOKEN` | No | Plex authentication token; use with `PLEX_URL` |
| `QBITTORRENT_URL` | No | qBittorrent Web UI URL; overrides connections saved in the web UI |
| `QBITTORRENT_USERNAME` | No | qBittorrent Web UI username; omit only when authentication bypass trusts this container |
| `QBITTORRENT_PASSWORD` | No | qBittorrent Web UI password; omit only when authentication bypass trusts this container |
| `LIBRARY_SYNC_CONCURRENCY` | No | Maximum libraries synced in parallel. Default: `3` |
| `FETCH_CONCURRENCY` | No | Maximum concurrent Plex page requests per library. Default: `8` |
| `SYNC_STALL_TIMEOUT_MINUTES` | No | Abort a sync after this many minutes without progress. Default: `15` |
| `LOG_RETENTION_DAYS` | No | Days to retain sync history and activity; use `0` to retain indefinitely. Default: `180` |

The concurrency defaults are intentionally conservative because Plex Librarian
often shares a host with Plex. Raise them only when the host has capacity to
spare.

For a bind mount instead of the Docker-managed volume shown above, map any
persistent host directory to `/data`. This makes the database easy to include
in a file-based backup routine.

Sonarr and Radarr are configured in the web UI so multiple instances can be
managed independently. qBittorrent can also be configured there; the
`QBITTORRENT_*` variables are power-user overrides and take precedence over
database-backed connections.

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
between full syncs. In Plex Web, open **Settings → Webhooks → Add Webhook** and
enter:

```text
http://<plex-librarian-host>:8288/api/webhook/plex
```

The webhook records playback lifecycle events used for watch-state and user
activity insights. It follows the same trusted-network security model as the
rest of the application.

## Backups and security

All application data lives under `/data`, including the SQLite database, Plex
credentials, Sonarr/Radarr API keys, mappings, and activity history. Back up
this directory and treat the backup as sensitive.

Plex Librarian is designed for a trusted self-hosted network. If remote access
is required, place it behind a reverse proxy that provides authentication and
TLS.

## Support and contributing

Found a bug or have an idea? [Open an issue](https://github.com/BrycePearce/plex-librarian/issues).
Pull requests are welcome; please run the workspace lint and test commands
before submitting a change.

```bash
deno lint
deno test --allow-all backend/src frontend/src
deno task build
```

Plex Librarian is open-source software available under the [MIT License](LICENSE).
