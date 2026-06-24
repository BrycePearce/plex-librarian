# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Library health insights for a Plex server — find stale content, track viewing patterns, reclaim disk space. Intended to ship as a Docker image for Unraid.

## Commands

All commands run from `backend/`:

```bash
deno task dev          # start with file watching
deno task start        # start without watching
deno task db:generate  # generate migration SQL from schema changes
deno task db:migrate   # apply pending migrations
deno task fmt          # format
deno task lint         # lint
```

First-time setup: `db:generate` → `db:migrate` → `dev`.

`db:migrate` needs `--allow-net` on first run to download the `@db/sqlite` native DLL from GitHub. It's cached after that.

## Architecture

Deno 2.x backend only (no frontend yet). Entry point is `src/main.ts` — Hono app with two route groups mounted at `/api/libraries` and `/api/sync`.

**DB layer** (`src/db/`): Drizzle ORM over `@db/sqlite` (Deno-native FFI SQLite). The proxy adapter in `src/db/index.ts` bridges `@db/sqlite`'s synchronous API to drizzle's async sqlite-proxy interface. Migrations are applied by a hand-rolled runner in `src/db/migrate.ts` — drizzle-kit's built-in migrator was dropped because `@libsql/client` (the previous driver) didn't expose `client.migrate()` in its node subpath. The runner tracks applied migrations in `__drizzle_migrations`.

**Plex client** (`src/lib/plex.ts`): Hand-rolled `fetch`-based client, not `@ctrl/plex`. The npm package was dropped because its TypeScript types omit `lastViewedAt` and `viewCount` on TV episode types. `PlexClient` hits `/library/sections` and `/library/sections/:key/all` directly. `createPlexClient()` reads `PLEX_URL` and `PLEX_TOKEN` from env.

**Stale query**: `GET /api/libraries/:key/stale` supports `days`, `maxDays` (range buckets), `minAgeDays` (exclude recently-added unwatched, default 90), `filter` (all/watched/unwatched), `sort` (fileSize/lastViewedAt/addedAt/title/year), `order` (asc/desc), `limit`, and `offset`. Composite indexes on `(libraryKey, lastViewedAt)` and `(libraryKey, fileSize)` back the common query shapes.

**Thumb proxy**: `GET /api/proxy/thumb?path=<plexThumbPath>&width=N&height=N` — injects the Plex token server-side. When width/height are provided, routes through Plex's `/photo/:/transcode` endpoint for server-side resizing.

**Sync**: full sync only — fetches all items from Plex on every run. TV show libraries use `?type=2` to sync at show level rather than episode level. Plex's `?updatedAt>={timestamp}` filter exists and could enable incremental syncs in the future (see Planned Work).

## Scale assumptions

Real users can have libraries with millions of items (e.g. anime collections, large TV archives). Design accordingly:

- Never accumulate an entire library into a single in-memory array. `libraryItems()` is an async generator — consume it page-by-page.
- DB inserts are one generator batch at a time (≤ FETCH_CONCURRENCY × ITEMS_PAGE_SIZE rows). Do not re-introduce a separate accumulation step.
- `FETCH_CONCURRENCY` caps parallel Plex requests — do not use unbounded `Promise.all` over page ranges.

## Plex auth implementation plan

Goal: "Sign in with Plex" OAuth as the primary config path for Docker/Unraid users, with env var override for power users. Uses the modern Ed25519 JWT flow — no legacy tokens.

### Step 1 — Settings table (current)
- Add `settings` table to schema (singleton row, id always 1):
  - `clientId` text — UUID generated once at first boot, identifies this installation to Plex
  - `publicJwk` text — Ed25519 public key as serialised JWK JSON
  - `privateJwk` text — Ed25519 private key as serialised JWK JSON (sensitive, same risk profile as the token itself)
  - `plexToken` text — JWT returned by Plex after OAuth
  - `plexTokenExpiresAt` integer — unix timestamp, JWTs last 7 days
  - `plexUrl` text — URL of the chosen Plex Media Server
- Update `createPlexClient()` to be async: check env vars first (`PLEX_URL` + `PLEX_TOKEN`), fall back to DB settings row
- Migration: `0005_add_settings.sql`

### Step 2 — OAuth PIN endpoints
- `POST /api/auth/plex/pin`
  - Generates Ed25519 keypair if not already in settings (Deno native Web Crypto, no packages needed)
  - Calls `POST clients.plex.tv/api/v2/pins` with public JWK + `strong=true`
  - Returns `{ pinId, code, authUrl }` — authUrl is the full `app.plex.tv/auth#?...` redirect
- `GET /api/auth/plex/pin/:id`
  - Signs a JWT (`aud: "plex.tv"`, `iss: clientId`) with the stored private key
  - Polls `GET clients.plex.tv/api/v2/pins/:id?deviceJWT=<signedJWT>`
  - If `authToken` is present: fetches `GET clients.plex.tv/api/v2/resources` to get the server list
  - Returns `{ status: "pending" }` or `{ status: "complete", servers: [...] }`
- `POST /api/auth/plex/server`
  - Body: `{ serverUrl, token }` — user has picked a server from the list
  - Saves `plexUrl` and `plexToken` (+ expiry) to settings
  - Returns `{ ok: true }`

### Step 3 — Token refresh ✓ (N/A)
Traditional Plex PIN tokens are permanent — they don't expire unless the user revokes access. No refresh needed. Invalid token detection is handled in `GET /api/auth/status`, which validates against `plex.tv/api/v2/user` and clears the stored token on 401 so the client redirects to setup. `DELETE /api/auth/plex` allows disconnecting/switching servers.

### Step 4 — Frontend setup wizard
- First-run detection: `GET /api/settings` returns `{ configured: false }` if no `plexUrl`/`plexToken` in DB and no env vars set
- Client redirects to `/setup` on `configured: false`
- Setup page: "Sign in with Plex" button → hits `POST /api/auth/plex/pin` → opens `authUrl` in new tab → polls `GET /api/auth/plex/pin/:id` → server picker → `POST /api/auth/plex/server` → redirect to dashboard

### Key decisions for auth
- Using the **traditional Plex PIN flow**, not the newer JWT/Ed25519 flow. The JWT flow is what Overseerr and every other established Plex app uses. The JWT/Ed25519 flow is undocumented for third parties, has known XML/JSON issues, and isn't yet supported consistently across PMS versions. Revisit when Plex stabilises it.
- Env vars (`PLEX_URL` + `PLEX_TOKEN`) always win over DB — Docker power users can skip OAuth entirely
- `clientId` is a UUID generated once at first boot and stored in `settings` — identifies this installation to Plex
- `privateJwk` / `publicJwk` columns exist in settings for a future JWT upgrade but are unused in the PIN flow

## Planned work

**Incremental sync**: Plex supports `?updatedAt>={timestamp}` on `/library/sections/:key/all`, returning only items modified since that time. Combined with the stored `syncedAt` timestamp this would make syncs near-instant for large libraries (fetch 5 watched shows instead of 10,000). Needs a periodic full sync to catch deletions — Plex has no deletion events, and the current prune step (`DELETE WHERE updatedAt < now`) only works when all items are refreshed. Webhook integration already handles real-time watch updates as a complementary path.

**Stale endpoint COUNT opt-in**: `COUNT(*)` runs on every paginated request. Add `?count=false` for page 2+ in infinite scroll clients that already have the total from page 1.

## Key decisions

- `@libsql/client` was replaced with `@db/sqlite` — libsql is designed for Turso hosted databases and its node variant had FFI issues.
- `@ctrl/plex` was replaced with direct fetch — the library's episode types are missing `lastViewedAt`/`viewCount`, which are native Plex API fields.
- `--allow-env` is intentionally broad — `@db/sqlite` (via `@denosaurs/plug`) reads several platform env vars (`LOCALAPPDATA`, `HOME`, `DENO_DIR`, etc.) to locate its DLL cache, making per-var scoping impractical.
