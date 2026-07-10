import { and, eq, sql } from 'drizzle-orm';
import {
  episodeMediaVersions,
  itemMediaVersions,
  items,
  libraries,
  seasons,
  syncLog,
} from './schema.ts';

// Centralizes the "row belongs to this server" predicates that are otherwise
// hand-repeated as and(eq(table.serverId, serverId), ...) at every call site —
// a future query that forgets the serverId filter is the same class of bug this
// server-scoping migration exists to fix, so the common shapes live here once.

export const libraryByKey = (serverId: number, key: string) =>
  and(eq(libraries.serverId, serverId), eq(libraries.key, key));

export const syncLogById = (serverId: number, id: number) =>
  and(eq(syncLog.serverId, serverId), eq(syncLog.id, id));

export const itemByRatingKey = (serverId: number, ratingKey: string) =>
  and(eq(items.serverId, serverId), eq(items.ratingKey, ratingKey));

export const itemsByLibrary = (serverId: number, libraryKey: string) =>
  and(eq(items.serverId, serverId), eq(items.libraryKey, libraryKey));

export const seasonsByShow = (serverId: number, showRatingKey: string) =>
  and(eq(seasons.serverId, serverId), eq(seasons.showRatingKey, showRatingKey));

export const seasonsByLibrary = (serverId: number, libraryKey: string) =>
  and(eq(seasons.serverId, serverId), eq(seasons.libraryKey, libraryKey));

export const mediaVersionsByItem = (serverId: number, itemRatingKey: string) =>
  and(eq(itemMediaVersions.serverId, serverId), eq(itemMediaVersions.itemRatingKey, itemRatingKey));

export const mediaVersionsByLibrary = (serverId: number, libraryKey: string) =>
  and(eq(itemMediaVersions.serverId, serverId), eq(itemMediaVersions.libraryKey, libraryKey));

export const episodeVersionsByEpisode = (serverId: number, episodeRatingKey: string) =>
  and(
    eq(episodeMediaVersions.serverId, serverId),
    eq(episodeMediaVersions.episodeRatingKey, episodeRatingKey),
  );

export const episodeVersionsByLibrary = (serverId: number, libraryKey: string) =>
  and(eq(episodeMediaVersions.serverId, serverId), eq(episodeMediaVersions.libraryKey, libraryKey));

export const episodeVersionsByShow = (serverId: number, showRatingKey: string) =>
  and(
    eq(episodeMediaVersions.serverId, serverId),
    eq(episodeMediaVersions.showRatingKey, showRatingKey),
  );

// The single definition of "these grouped Media versions constitute a genuine
// duplicate" (see Duplicate detection in CLAUDE.md) — shared by the global
// /api/duplicates endpoint (routes/duplicates.ts) and the per-library
// ?duplicatesOnly stale filter (routes/libraries.ts) so a future change to the rule
// (e.g. excluding a version flagged inaccessible) can't be applied to one and
// silently forgotten in the other.
export const HAS_DUPLICATE_VERSIONS = sql`count(*) >= 2`;
