import {
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
} from '@plex-librarian/shared/search.ts';

export type SearchQueryResult =
  | { search: string; error?: never }
  | { search?: never; error: string };

export function parseSearchQuery(value: string | undefined): SearchQueryResult {
  const search = (value ?? '').trim();
  if (search.length > 0 && search.length < SEARCH_MIN_LENGTH) {
    return { error: `search must be at least ${SEARCH_MIN_LENGTH} characters` };
  }
  if (search.length > SEARCH_MAX_LENGTH) {
    return { error: `search must be ${SEARCH_MAX_LENGTH} characters or fewer` };
  }
  return { search };
}
