# plex-librarian

Library health insights for your Plex server — find stale content, track viewing patterns, and reclaim disk space.

## Unraid / Docker

### Unraid (Community Applications)

Add the template repository URL in **Settings → Docker → Template Repositories**:

```
https://raw.githubusercontent.com/BrycePearce/plex-librarian/main/
```

Then install **PlexLibrarian** from the Apps tab. Map `/data` to a persistent path (e.g. `/mnt/user/appdata/plex-librarian`) and open the web UI to complete setup.

### Docker Compose

```yaml
services:
  plex-librarian:
    image: ghcr.io/BrycePearce/plex-librarian:latest
    container_name: plex-librarian
    ports:
      - "8080:8080"
    volumes:
      - /path/to/appdata:/data
    environment:
      # Optional: skip the OAuth wizard by providing credentials directly
      # PLEX_URL: http://192.168.1.100:32400
      # PLEX_TOKEN: your-plex-token
    restart: unless-stopped
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PATH` | No | Path to SQLite database (default: `/data/librarian.db`) |
| `PORT` | No | HTTP port (default: `8080`) |
| `PLEX_URL` | No | Skip OAuth — direct URL to your Plex server |
| `PLEX_TOKEN` | No | Skip OAuth — your Plex auth token |
| `PLEX_WEBHOOK_SECRET` | No | Validates incoming Plex webhook requests |
| `LIBRARY_SYNC_CONCURRENCY` | No | Max libraries synced in parallel (default: `3`) |
| `FETCH_CONCURRENCY` | No | Max concurrent Plex page requests per library (default: `8`) |
| `SYNC_STALL_TIMEOUT_MINUTES` | No | Abort a sync if it reports no progress for this long, e.g. a Plex host going offline mid-sync (default: `15`) |

Migrations run automatically on startup. No manual database setup required.

Sync concurrency defaults are deliberately conservative to keep the container's footprint small, especially since Plex itself often runs on the same host. Only raise these if you're running on dedicated hardware with room to spare.

### Manual Plex setup (skip OAuth)

Set both `PLEX_URL` and `PLEX_TOKEN` to bypass the setup wizard entirely.

**Finding your token:** In Plex Web, play any item, then click the three-dot menu → "Get Info" → "View XML". Your token is the `X-Plex-Token` query parameter in the URL. Alternatively, browse to `http://<your-plex-host>:32400/identity?X-Plex-Token=<token>` — if you get a valid response, the token works.

**Finding your server URL:** Use `http://<local-ip>:32400` for a local server. plex.tv relay URLs (`https://xxx.plex.direct:...`) also work but local is faster.

## Webhooks (Plex Pass only)

Webhooks enable real-time `lastViewedAt` updates when someone plays or finishes a title, without waiting for a manual sync.

In Plex Web, go to **Settings → Webhooks → Add Webhook** and enter:

```
http://<your-host>:8080/api/webhook/plex
```

If you set `PLEX_WEBHOOK_SECRET`, append `?token=<secret>` to the URL. Requests without a matching token are rejected with 401.

| Event | Effect |
|-------|--------|
| `media.play` | Updates `lastViewedAt` to now |
| `media.scrobble` | Updates `lastViewedAt` + `viewCount` (Plex's 90%-watched threshold) |

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/settings` | Global defaults, e.g. `{ staleMinAgeDays }` |
| PATCH | `/api/settings` | Update global defaults |
| POST | `/api/auth/plex/pin` | Start OAuth PIN flow, returns `{ pinId, authUrl }` |
| GET | `/api/auth/plex/pin/:id` | Poll PIN status, returns `{ status, servers? }` |
| POST | `/api/auth/plex/server` | Save chosen server after OAuth |
| GET | `/api/auth/status` | Returns `{ configured, source, reachable? }` — `configured: false` redirects the UI to setup |
| DELETE | `/api/auth/plex` | Disconnect / switch servers |
| GET | `/api/libraries` | All synced libraries |
| GET | `/api/libraries/:key/stale` | Stale items (supports `days`, `filter`, `sort`, `limit`, `offset`, etc.) |
| PATCH | `/api/libraries/:key` | Set a per-library `staleMinAgeDays` override (`null` to use the global default) |
| GET | `/api/libraries/:key/shows/:ratingKey` | Show detail with per-season rollups |
| GET | `/api/proxy/thumb` | Server-side Plex thumbnail proxy |
| POST | `/api/sync` | Trigger a full sync from Plex |
| POST | `/api/sync/libraries/:key` | Trigger a sync for a single library |
| GET | `/api/sync/history` | Last 20 sync runs |
| GET | `/api/sync/:id` | Status of a specific sync run |
| GET | `/api/sync/:id/events` | SSE stream of live sync progress |
| POST | `/api/webhook/plex` | Plex webhook receiver (Plex Pass only) |

## Development

**Prerequisites:** [Deno 2.x](https://deno.com/manual/getting_started/installation)

```bash
# Copy and fill in env vars
cp backend/.env.example backend/.env

# Start backend + frontend dev servers
deno task dev
```

Backend: `http://localhost:8080` · Frontend: `http://localhost:5173`

### Database

Migrations run automatically when the server starts. To generate a new migration after schema changes:

```bash
cd backend && deno task db:generate
```

Other backend tasks (run from `backend/`):

```bash
deno task fmt    # format
deno task lint   # lint
```
