import { assertEquals } from '@std/assert';
import { sonarrActivityConflictMessage } from './sonarrSeasonInspection.ts';

Deno.test('Sonarr activity conflicts explain transient refreshes in plain language', () => {
  assertEquals(
    sonarrActivityConflictMessage(['RefreshSeries']),
    'Sonarr is currently refreshing this series. Plex Librarian waits for it to finish so the file list cannot change during removal. Try again in a moment.',
  );
});

Deno.test('Sonarr activity conflicts explain other file-changing work without raw commands', () => {
  assertEquals(
    sonarrActivityConflictMessage(['DownloadedEpisodesScan']),
    'Sonarr is currently updating or importing files for this series. Plex Librarian waits for it to finish so the file list cannot change during removal. Try again in a moment.',
  );
});
