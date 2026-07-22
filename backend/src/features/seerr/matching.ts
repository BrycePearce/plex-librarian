// Returns only a unique match derived from the current sync payload. Callers
// deliberately do not supply a previously stored value: unresolved or ambiguous
// current evidence must fail closed instead of preserving stale attribution.
export function currentUniqueMatch<T>(
  ...matches: Array<T | null | undefined>
): T | null {
  // undefined means that an identifier was absent or had no candidate. null is emitted
  // by the uniqueness maps only when the current identifier is ambiguous, and must veto
  // attribution even if another identifier happens to produce one candidate.
  if (matches.some((match) => match === null)) return null;
  const current = matches.filter((match): match is T => match !== null && match !== undefined);
  if (current.length === 0) return null;
  const first = current[0];
  return current.every((match) => match === first) ? first : null;
}

export function typedExternalIdKey(
  provider: 'tmdb' | 'tvdb',
  id: number,
  mediaType: 'movie' | 'tv' | null,
): string | null {
  return mediaType === null ? null : `${provider}:${id}:${mediaType}`;
}
