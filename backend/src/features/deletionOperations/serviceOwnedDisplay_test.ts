import { assertEquals } from '@std/assert';
import type { ServiceOwnedPlannedAction } from '../mediaDeletion/serviceOwnedPlanning.ts';
import {
  SERVICE_PREVIEW_FILE_LIMIT,
  SERVICE_PREVIEW_TOTAL_FILE_LIMIT,
  serviceOwnedDisplayFiles,
} from './serviceOwnedDisplay.ts';

function action(
  service: ServiceOwnedPlannedAction['service'],
  count = 1,
): ServiceOwnedPlannedAction {
  return {
    id: `${service}-action`,
    service,
    serviceKey: 'private-instance-identity',
    targetId: 'private-target',
    presence: 'current',
    effectsComplete: true,
    entries: [],
    files: Array.from(
      { length: count },
      (_, i) => ({ path: `/${service}/file-${i}.mkv`, size: i }),
    ),
  };
}

Deno.test('service display returns exact scoped paths and action links without internal fields', () => {
  const plex = action('plex');
  const sonarr = action('sonarr');
  sonarr.files[0].size = null;
  const before = JSON.stringify([plex, sonarr]);
  assertEquals(serviceOwnedDisplayFiles([plex, sonarr], SERVICE_PREVIEW_TOTAL_FILE_LIMIT), {
    files: [
      { path: '/plex/file-0.mkv', size: 0, service: 'plex', actionId: 'plex-action' },
      { path: '/sonarr/file-0.mkv', size: null, service: 'sonarr', actionId: 'sonarr-action' },
    ],
    fileCount: 2,
    filesTruncated: false,
  });
  assertEquals(JSON.stringify([plex, sonarr]), before);
});

Deno.test('service display limits preserve full count and never mutate execution files', () => {
  const large = action('qb', SERVICE_PREVIEW_FILE_LIMIT + 5);
  const perTarget = serviceOwnedDisplayFiles([large], SERVICE_PREVIEW_TOTAL_FILE_LIMIT);
  assertEquals(perTarget.files.length, SERVICE_PREVIEW_FILE_LIMIT);
  assertEquals(perTarget.fileCount, SERVICE_PREVIEW_FILE_LIMIT + 5);
  assertEquals(perTarget.filesTruncated, true);
  const lastTarget = serviceOwnedDisplayFiles([large], 2);
  assertEquals(lastTarget.files.length, 2);
  assertEquals(lastTarget.fileCount, SERVICE_PREVIEW_FILE_LIMIT + 5);
  assertEquals(serviceOwnedDisplayFiles([large], 0).files, []);
  assertEquals(large.files.length, SERVICE_PREVIEW_FILE_LIMIT + 5);
});
