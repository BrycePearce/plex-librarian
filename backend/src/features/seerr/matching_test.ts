import { assertEquals } from '@std/assert';
import { currentUniqueMatch, typedExternalIdKey } from './matching.ts';

Deno.test('current unique matching fails closed without current evidence', () => {
  assertEquals(currentUniqueMatch<number>(undefined, null), null);
});

Deno.test('current unique matching can use a later independent identifier', () => {
  assertEquals(currentUniqueMatch<number>(undefined, 42), 42);
});

Deno.test('an ambiguous identifier vetoes an otherwise unique identifier', () => {
  assertEquals(currentUniqueMatch<number>(null, 42), null);
});

Deno.test('current unique matching accepts identifiers that agree', () => {
  assertEquals(currentUniqueMatch<number>(42, 42), 42);
});

Deno.test('current unique matching rejects conflicting identifiers', () => {
  assertEquals(currentUniqueMatch<number>(42, 84), null);
});

Deno.test('external media keys cannot cross movie and TV types', () => {
  assertEquals(typedExternalIdKey('tvdb', 42, 'movie'), 'tvdb:42:movie');
  assertEquals(typedExternalIdKey('tvdb', 42, 'tv'), 'tvdb:42:tv');
  assertEquals(typedExternalIdKey('tvdb', 42, null), null);
});
