import { and, eq, sql } from 'drizzle-orm';
import {
  episodeMediaVersions,
  itemMediaVersions,
  items,
  libraries,
  seasons,
  syncLog,
  users,
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

export const usersByServer = (serverId: number) => eq(users.serverId, serverId);

// Matches on users.accountId, the stable plex.tv/Home roster id. For non-owners this
// is also the PMS SystemAccount/history id; the owner's PMS id is the reserved value 1.
export const userByAccountId = (serverId: number, accountId: number) =>
  and(eq(users.serverId, serverId), eq(users.accountId, accountId));

// Matches on the PMS SystemAccount id carried by webhook payloads (Account.id) and
// history entries (accountID). This equals users.accountId for non-owners; the owner
// is always represented as local id 1. See users.localAccountId in schema.ts.
export const userByLocalAccountId = (serverId: number, localAccountId: number) =>
  and(eq(users.serverId, serverId), eq(users.localAccountId, localAccountId));

// The single definition of "these grouped Media versions constitute a genuine
// duplicate" (see Duplicate detection in CLAUDE.md) — shared by the global
// /api/duplicates endpoint and the per-library ?duplicatesOnly stale filter so a future
// change to the rule
// (e.g. excluding a version flagged inaccessible) can't be applied to one and
// silently forgotten in the other.
export const HAS_DUPLICATE_VERSIONS = sql`count(*) >= 2`;
