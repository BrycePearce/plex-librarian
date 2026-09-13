import { withTransaction } from '../../db/index.ts';
import type { ServiceOwnedPlan } from './serviceOwnedPlanning.ts';

/** Synced same-title candidates bound live ownership checks; never a global absence claim. */
export function relatedServiceOwnedPlexItems(
  serverId: number,
  selection: ServiceOwnedPlan['selection'],
) {
  const movie = selection.type === 'movie';
  const externalId = movie ? selection.tmdbId : selection.tvdbId;
  if (externalId === null) return Promise.resolve([]);
  const rows = withTransaction((db) =>
    db.prepare(
      `SELECT rating_key, library_key FROM items WHERE server_id=? AND type=? AND ${
        movie ? 'tmdb_id' : 'tvdb_id'
      }=? LIMIT 201`,
    ).values<[string, string]>(serverId, movie ? 'movie' : 'show', externalId)
  );
  if (rows.length > 200) throw new Error('Related Plex title budget exceeded');
  return Promise.resolve(rows.map(([ratingKey, libraryKey]) => ({
    ratingKey,
    libraryKey,
    type: movie ? 'movie' as const : 'show' as const,
  })));
}
