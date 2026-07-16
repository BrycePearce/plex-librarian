export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 200;

// Route validators use this canonical form so copied URLs, query keys, and API requests
// agree about whitespace and length handling.
export function normalizeSearchQuery(value: unknown): string {
  if (typeof value !== 'string') return '';
  const search = value.trim();
  return search.length >= SEARCH_MIN_LENGTH
    ? search.slice(0, SEARCH_MAX_LENGTH)
    : '';
}
