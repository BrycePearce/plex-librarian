import type { PlexRawMetadata } from '../../integrations/plex/types.ts';

export type FindingType = 'missing' | 'metadata' | 'version' | 'unable';
export interface MovieEvidence {
  id: number;
  title: string;
  year: number | null;
  slug: string;
  tmdb: string | null;
  imdb: string | null;
  fileId: number | null;
  path: string | null;
  importedAt: number | null;
}
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
export function movieEvidence(raw: Record<string, unknown>): MovieEvidence | null {
  if (!positive(raw.id) || typeof raw.title !== 'string' || typeof raw.hasFile !== 'boolean') {
    throw new Error('Invalid Radarr movie record');
  }
  if (!raw.hasFile) return null;
  const f = raw.movieFile as Record<string, unknown> | undefined;
  const fileId = f && positive(f.id) && f.id === raw.movieFileId &&
      (f.movieId === undefined || f.movieId === raw.id)
    ? f.id
    : null;
  const date = typeof f?.dateAdded === 'string' ? Date.parse(f.dateAdded) / 1000 : NaN;
  return {
    id: raw.id,
    title: raw.title.slice(0, 1000),
    year: positive(raw.year) ? raw.year : null,
    slug: typeof raw.titleSlug === 'string' ? raw.titleSlug.slice(0, 1000) : '',
    tmdb: positive(raw.tmdbId) ? String(raw.tmdbId) : null,
    imdb: typeof raw.imdbId === 'string' && /^tt\d+$/.test(raw.imdbId) ? raw.imdbId : null,
    fileId,
    path: fileId && typeof f?.path === 'string' ? f.path : null,
    importedAt: Number.isFinite(date) && date > 0 ? Math.floor(date) : null,
  };
}
export interface PathMap {
  source: string;
  target: string;
  caseSensitive?: boolean;
}
/** Explicit namespaces only; case folding requires an explicit mapping flag. */
export function trustedPath(path: string | null, maps: PathMap[]): string | null {
  if (!path || path.length > 8192 || path.includes('\u0000')) return null;
  const normalize = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '');
  const p = normalize(path);
  if (p.split('/').some((s) => s === '.' || s === '..')) return null;
  const matches = maps.filter((m) => {
    const compared = m.caseSensitive === false ? p.toLowerCase() : p;
    const source = m.caseSensitive === false
      ? normalize(m.source).toLowerCase()
      : normalize(m.source);
    return compared === source || compared.startsWith(source + '/');
  });
  // Overlapping mappings are ambiguous even if the suffix happens to look plausible.
  if (matches.length !== 1) return null;
  const m = matches[0];
  const translated = normalize(m.target) + p.slice(normalize(m.source).length);
  return m.caseSensitive === false ? translated.toLowerCase() : translated;
}
export function providerIds(item: PlexRawMetadata): { tmdb: string[]; imdb: string[] } {
  const result = { tmdb: [] as string[], imdb: [] as string[] };
  for (const guid of [...(item.Guid ?? []).map((g) => g.id), item.guid]) {
    if (!guid) continue;
    const match =
      /^(tmdb|imdb|com\.plexapp\.agents\.themoviedb|com\.plexapp\.agents\.imdb):\/\/([^?]+)/.exec(
        guid,
      );
    if (!match) continue;
    const kind = match[1] === 'tmdb' || match[1].endsWith('themoviedb') ? 'tmdb' : 'imdb';
    if ((kind === 'tmdb' ? /^[1-9]\d*$/ : /^tt\d+$/).test(match[2])) result[kind].push(match[2]);
  }
  return { tmdb: [...new Set(result.tmdb)], imdb: [...new Set(result.imdb)] };
}
export interface MatchEvidence {
  ratingKey: string;
  title: string;
  tmdb: string[];
  imdb: string[];
  paths: string[];
  exact: boolean;
}
export function classify(
  movie: MovieEvidence,
  matches: MatchEvidence[],
  comparable: boolean,
  completePaths: boolean,
  pending: boolean,
  now: number,
): { type: FindingType; reason: string } | null {
  if (!movie.fileId) {
    return {
      type: 'unable',
      reason: 'Radarr reports a file but its managed file identity is incomplete.',
    };
  }
  if (matches.length > 30) {
    return {
      type: 'unable',
      reason: 'Too many catalog matches to establish an unambiguous identity.',
    };
  }
  const exact = matches.filter((m) => m.exact);
  const candidates = exact.length ? exact : matches;
  if (candidates.length > 1) {
    return {
      type: 'unable',
      reason: 'Multiple Plex entries match; catalog identity is ambiguous.',
    };
  }
  const found = candidates[0];
  if (found) {
    const conflicts = (['tmdb', 'imdb'] as const).filter((k) =>
      movie[k] && found[k].length && !found[k].includes(movie[k]!)
    );
    const missing = (['tmdb', 'imdb'] as const).filter((k) => movie[k] && !found[k].length);
    if (conflicts.length || exact.length && missing.length) {
      return {
        type: 'metadata',
        reason: `${
          conflicts.length
            ? 'Conflicting ' + conflicts.join('/') + ' identifiers.'
            : 'Plex lacks ' + missing.join('/') + ' identifiers.'
        } ${
          exact.length
            ? 'The exact managed path is present in the catalog.'
            : 'An external identity matches, but the managed version is unverified.'
        }`,
      };
    }
    if (exact.length) return null;
    return {
      type: 'version',
      reason: 'The movie identity is present; the exact Radarr-managed copy is not verified.',
    };
  }
  if (pending) {
    return {
      type: 'unable',
      reason:
        'A pending Radarr queue entry may change the managed copy. Rechecked on the next sync.',
    };
  }
  if (!movie.importedAt || now - movie.importedAt < 86400) {
    return {
      type: 'unable',
      reason: movie.importedAt
        ? 'Within the 24-hour import grace period. Rechecked on the next sync.'
        : 'Import time is unknown; missing content cannot yet be established.',
    };
  }
  if (!comparable || !completePaths || !(movie.tmdb || movie.imdb)) {
    return {
      type: 'unable',
      reason:
        'Trusted path comparison or catalog identity evidence is incomplete. No absence is inferred.',
    };
  }
  return {
    type: 'missing',
    reason:
      'No exact managed path or external identity was found in the completely audited expected Plex library. This is catalog evidence, not physical-file verification.',
  };
}
