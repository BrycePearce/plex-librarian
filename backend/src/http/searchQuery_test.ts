import { assertEquals } from '@std/assert';
import { SEARCH_MAX_LENGTH } from '@plex-librarian/shared/search.ts';
import { parseSearchQuery } from './searchQuery.ts';

Deno.test('parseSearchQuery trims valid searches and accepts an empty search', () => {
  assertEquals(parseSearchQuery('  star wars  '), { search: 'star wars' });
  assertEquals(parseSearchQuery('   '), { search: '' });
});

Deno.test('parseSearchQuery rejects searches outside the shared length contract', () => {
  assertEquals(parseSearchQuery('x'), { error: 'search must be at least 2 characters' });
  assertEquals(parseSearchQuery('x'.repeat(SEARCH_MAX_LENGTH + 1)), {
    error: 'search must be 200 characters or fewer',
  });
});
