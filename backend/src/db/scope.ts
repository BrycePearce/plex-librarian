import { and, eq } from 'drizzle-orm';
import { items, libraries, seasons, syncLog } from './schema.ts';

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
