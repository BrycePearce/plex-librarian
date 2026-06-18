# plex-librarian

Insights into Plex library health — stale content, last-watched dates, and disk-usage-weighted staleness.

## Setup

1. [Install Deno 2.x](https://deno.com/manual/getting_started/installation)

2. Copy `.env.example` to `.env` and fill in your values:
   ```bash
   cp backend/.env.example backend/.env
   ```

   **Getting your Plex token:** Play any media in Plex Web, click the three-dot menu
   on the item → "Get Info" → "View XML". Your token is the `X-Plex-Token` query
   parameter in the URL.

3. Generate the initial migration:
   ```bash
   cd backend && deno task db:generate
   ```

4. Apply the migration (creates the SQLite database):
   ```bash
   deno task db:migrate
   ```

5. Start the dev server:
   ```bash
   deno task dev
   ```

The server starts on `http://localhost:8080` (or the `PORT` from your `.env`).

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/libraries` | All synced libraries |
| GET | `/api/libraries/:key/stale?days=365` | Stale items in a library |
| POST | `/api/sync` | Trigger a full sync from Plex |
| GET | `/api/sync/history` | Last 20 sync runs |
| GET | `/api/sync/:id` | Status of a specific sync run |
| POST | `/api/webhook/plex` | Plex webhook receiver (requires Plex Pass) |

## Webhooks (Plex Pass only)

Webhooks enable real-time `lastViewedAt` updates — when someone plays or finishes
a title, the database updates immediately without waiting for a manual sync.

On startup, the server checks whether your Plex account has Plex Pass and logs
the result. Without Plex Pass, everything works normally via manual sync; the
webhook endpoint simply won't receive any traffic.

### Configuring the webhook in Plex

1. In Plex Web, go to **Settings → Webhooks → Add Webhook**.
2. Enter your server's webhook URL:
   ```
   http://<your-server-host>:<PORT>/api/webhook/plex
   ```
3. Save. Plex will now POST an event every time media is played or scrobbled.

### Optional: secure the endpoint

If your server is reachable from the internet, set `PLEX_WEBHOOK_SECRET` in your `.env`:

```env
PLEX_WEBHOOK_SECRET=some-random-string
```

Then append `?token=<your-secret>` to the webhook URL you register in Plex:

```
http://<your-server-host>:<PORT>/api/webhook/plex?token=some-random-string
```

Requests without a matching token will be rejected with `401`.

### Events handled

| Event | Effect |
|-------|--------|
| `media.play` | Updates `lastViewedAt` to now (immediate timer reset) |
| `media.scrobble` | Updates `lastViewedAt` + `viewCount` (Plex's 90%-watched threshold) |

All other Plex events are acknowledged and ignored.
