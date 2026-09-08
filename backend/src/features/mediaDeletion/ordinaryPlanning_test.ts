import { assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import { resolve } from '@std/path';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import type { ServicePathRoot } from '../../../../shared/serviceStorage.ts';

const temporary = await Deno.makeTempDir();
Deno.env.set('DB_PATH', resolve(temporary, 'ordinary-planning.db'));
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(Deno.env.get('DB_PATH')!, resolve(import.meta.dirname!, '../../../drizzle'));
const { buildOrdinaryDeletionPlan } = await import('./ordinaryPlanning.ts');
const { ordinaryPreview } = await import('./ordinaryPreview.ts');

function fixture() {
  const selection = {
    ratingKey: 'show',
    title: 'Jessica Jones',
    type: 'show' as const,
    tmdbId: null,
    tvdbId: 123,
  };
  const files = [1, 2, 3].map((id) => ({
    id,
    path: `/arr/Jessica/Season ${id}/episode.mkv`,
    size: 100,
    episodeIds: [id],
  }));
  const episodes = files.map((file) => ({
    id: file.id,
    seriesId: 9,
    seasonNumber: file.id,
    episodeNumber: 1,
    monitored: true,
    episodeFileId: file.id,
  }));
  const jobs: DownloadJob[] = files.map((file) => ({
    id: `hash${file.id}`,
    name: `Jessica season ${file.id}`,
    state: 'uploading',
    size: 100,
    uploaded: 10,
    ratio: 0.1,
    seedingTime: 10,
    completedAt: 1,
    contentPath: `/downloads/season${file.id}`,
    savePath: '/downloads',
    trackerHost: null,
    fileCount: 1,
    files: [{ path: `season${file.id}/episode.mkv`, size: 100 }],
    manifestFiles: [{ path: `season${file.id}/episode.mkv`, size: 100 }],
    filesTruncated: false,
  }));
  const state = {
    files,
    episodes,
    jobs,
    arrUnavailable: false,
    sharedHistory: false,
    otherFolders: [] as Array<{ id: number; path: string }>,
    retained: [] as Array<
      { ratingKey: string; showRatingKey: string; seasonRatingKey: string; path: string }
    >,
    playing: false,
  };
  const plex = {
    metadataIdentity: () => Promise.resolve({ ...selection, librarySectionId: 'tv', media: [] }),
    activeSessions: () =>
      Promise.resolve(state.playing ? [{ ratingKey: 'ep', grandparentRatingKey: 'show' }] : []),
    mediaPathPreview: () =>
      Promise.resolve({
        paths: state.files.map((file) => file.path.replace('/arr', '/plex')),
        fileSizes: Object.fromEntries(
          state.files.map((file) => [file.path.replace('/arr', '/plex'), file.size]),
        ),
        truncated: false,
      }),
    libraries: () => Promise.resolve([{ key: 'tv', type: 'show' }]),
    async *libraryFileEntries() {
      yield state.retained;
    },
  } as unknown as PlexClient;
  const arrTargets: ArrDeleteTarget[] = [{
    instanceId: 1,
    instanceName: 'Sonarr',
    instanceType: 'sonarr',
    instanceUrl: 'http://fixture.invalid',
    mappingIdentity: 'mapping',
    configurationUpdatedAt: 1,
    addImportExclusion: false,
    pathMappings: [],
    client: {
      lookup: () =>
        state.arrUnavailable
          ? Promise.reject(new Error('Unavailable Sonarr'))
          : Promise.resolve({ id: 9, path: '/arr/Jessica' }),
      sonarrSeriesSnapshot: () => Promise.resolve({ files: state.files, episodes: state.episodes }),
      sonarrSeasonCoordinationCapabilities: () =>
        Promise.resolve({ available: true, version: '4.0.16' }),
      sonarrSeriesActivity: () => Promise.resolve({ quiet: true }),
      managedScopes: () =>
        Promise.resolve([{ id: 9, path: '/arr/Jessica' }, ...state.otherFolders]),
      torrentAssociations: () =>
        Promise.resolve(
          state.files.map((file) => ({
            hash: `hash${file.id}`,
            sourcePath: `/source/season${file.id}/episode.mkv`,
            importedPath: file.path,
          })),
        ),
      downloadIdIsExclusiveTo: () => Promise.resolve(!state.sharedHistory),
    } as unknown as ArrDeleteTarget['client'],
  }];
  const downloadTargets: DownloadClientTarget[] = [{
    provider: 'qbittorrent',
    instanceKey: 'db:1',
    instanceId: 1,
    instanceName: 'QB',
    configurationIdentity: 'qb',
    client: {
      scanJobSummaries: async (visit) => {
        for (const job of state.jobs) await visit(job);
        return JSON.stringify(
          state.jobs.map((job) => [job.id, job.contentPath, job.savePath, job.size]),
        );
      },
      findJob: (hash) => Promise.resolve(state.jobs.find((job) => job.id === hash) ?? null),
      deleteJob: () => {
        throw new Error('Planning must never mutate');
      },
    },
  }];
  const roots: ServicePathRoot[] = [
    ['plex:tv', '/plex', '/storage/library'],
    ['arr:1', '/arr', '/storage/library'],
    ['arr:1', '/source', '/storage/downloads'],
    ['qb:db:1', '/downloads', '/storage/downloads'],
  ].map(([serviceKey, serviceRoot, storageRoot], index) => ({
    id: index + 1,
    serverId: 1,
    serviceKey,
    serviceRoot,
    storageRoot,
    configurationIdentity: serviceKey,
    caseSensitive: true,
    hasAliases: false,
    revision: 1,
  }));
  const connections = [...new Set(roots.map((root) => root.serviceKey))].map((key) => ({
    key,
    name: key,
    configurationIdentity: key,
    libraryKeys: ['tv'],
    roots: [],
  }));
  return {
    state,
    input: {
      serverId: 1,
      libraryKey: 'tv',
      selection,
      plex,
      arrTargets,
      downloadTargets,
      roots,
      connections,
      arrSelected: false,
      qbSelected: false,
    },
  };
}

Deno.test('all five ordinary scenario rows work with non-existent local paths and reusable service roots', async () => {
  const { input } = fixture();
  for (
    const [arrSelected, qbSelected, configured] of [
      [false, false, false],
      [true, false, false],
      [false, false, true],
      [true, false, true],
      [false, true, true],
      [true, true, true],
    ]
  ) {
    const plan = await buildOrdinaryDeletionPlan({
      ...input,
      arrSelected,
      qbSelected,
      downloadTargets: configured ? input.downloadTargets : [],
    });
    assertEquals(plan.arr.length, arrSelected ? 1 : 0);
    assertEquals(plan.jobs.length, qbSelected ? 3 : 0);
  }
  const second = fixture();
  second.input.selection.title = 'Another title';
  assertEquals(
    (await buildOrdinaryDeletionPlan({ ...second.input, arrSelected: true, qbSelected: true }))
      .roots,
    input.roots,
  );
});
Deno.test('Mad Men historical hashes absent produce no current QB target, not a mount requirement', async () => {
  const { state, input } = fixture();
  state.jobs = [];
  const plan = await buildOrdinaryDeletionPlan({ ...input, arrSelected: true, qbSelected: true });
  assertEquals(plan.jobs, []);
  assertEquals(plan.noJobReason?.includes('No matching live'), true);
});
Deno.test('unselected unavailable Sonarr permits exact Plex/QB entry evidence', async () => {
  const { state, input } = fixture();
  state.arrUnavailable = true;
  state.jobs = state.jobs.map((job, index) => ({
    ...job,
    savePath: '/downloads',
    contentPath: `/downloads/Jessica/Season ${index + 1}`,
    manifestFiles: [{ path: `Jessica/Season ${index + 1}/episode.mkv`, size: 100 }],
  }));
  input.roots[3].storageRoot = '/storage/library';
  const plan = await buildOrdinaryDeletionPlan({ ...input, qbSelected: true });
  assertEquals(plan.jobs.length, 3);
  assertEquals(plan.arr, []);
  await assertRejects(
    () => buildOrdinaryDeletionPlan({ ...input, arrSelected: true }),
    Error,
    'Unavailable Sonarr',
  );
});
Deno.test('shared pack, extras, incomplete manifests, and moved source evidence fail closed', async () => {
  for (const change of ['shared', 'extras', 'partial', 'moved'] as const) {
    const { state, input } = fixture();
    if (change === 'shared') state.sharedHistory = true;
    if (change === 'extras') {
      state.jobs[0].manifestFiles.push({ path: 'season1/extra.txt', size: 2 });
      state.jobs[0].fileCount++;
    }
    if (change === 'partial') state.jobs[0].filesTruncated = true;
    if (change === 'moved') state.jobs[0].savePath = '/downloads/moved';
    await assertRejects(() => buildOrdinaryDeletionPlan({ ...input, qbSelected: true }), Error);
  }
});
Deno.test('unchecked QB blocks shared entries; explicit eligible QB scope resolves that conflict', async () => {
  const { state, input } = fixture();
  input.roots[3].storageRoot = '/storage/library';
  state.jobs = state.jobs.map((job, index) => ({
    ...job,
    contentPath: `/downloads/Jessica/Season ${index + 1}`,
    manifestFiles: [{ path: `Jessica/Season ${index + 1}/episode.mkv`, size: 100 }],
  }));
  await assertRejects(() => buildOrdinaryDeletionPlan(input), Error, 'retained qBittorrent');
  assertEquals((await buildOrdinaryDeletionPlan({ ...input, qbSelected: true })).jobs.length, 3);
});
Deno.test('folder ancestry, declared aliases and retained Plex files veto deletion', async () => {
  for (const change of ['nested', 'alias', 'retained'] as const) {
    const { state, input } = fixture();
    if (change === 'nested') state.otherFolders.push({ id: 10, path: '/arr/Jessica/Other title' });
    if (change === 'alias') input.roots[1].hasAliases = true;
    if (change === 'retained') {
      state.retained.push({
        ratingKey: 'other',
        showRatingKey: 'other',
        seasonRatingKey: 'other',
        path: '/plex/Jessica/Other title/file.mkv',
      });
    }
    await assertRejects(() => buildOrdinaryDeletionPlan({ ...input, arrSelected: true }), Error);
  }
});
Deno.test('scope fingerprints ignore seeding statistics but bind root revisions, IDs and sizes', async () => {
  const { state, input } = fixture();
  const selected = { ...input, arrSelected: true, qbSelected: true };
  const first = await buildOrdinaryDeletionPlan(selected);
  state.jobs[0].uploaded++;
  state.jobs[0].seedingTime++;
  assertEquals((await buildOrdinaryDeletionPlan(selected)).fingerprint, first.fingerprint);
  input.roots[0].revision++;
  assertNotEquals((await buildOrdinaryDeletionPlan(selected)).fingerprint, first.fingerprint);
  state.files[0].size++;
  await assertRejects(() => buildOrdinaryDeletionPlan(selected), Error);
});
Deno.test('preview fingerprints are the exact enqueue and execution planner scopes', async () => {
  const { input } = fixture();
  const preview = await ordinaryPreview(input);
  for (
    const [arrSelected, qbSelected, field] of [
      [false, false, 'plexOnlyFingerprint'],
      [true, false, 'sonarrCleanupFingerprint'],
      [false, true, 'qbittorrentOnlyFingerprint'],
      [true, true, 'cleanupFingerprint'],
    ] as const
  ) {
    assertEquals(
      preview[field],
      (await buildOrdinaryDeletionPlan({ ...input, arrSelected, qbSelected })).fingerprint,
    );
  }
});

Deno.test('Jessica Jones selects exactly one 13-file season or all three seasons from 39 current episodes', async () => {
  const { state, input } = fixture();
  state.files = Array.from(
    { length: 39 },
    (_, index) => ({
      id: index + 1,
      path: `/arr/Jessica/Season ${Math.floor(index / 13) + 1}/episode${index % 13 + 1}.mkv`,
      size: 100,
      episodeIds: [index + 1],
    }),
  );
  state.episodes = state.files.map((file, index) => ({
    id: file.id,
    seriesId: 9,
    seasonNumber: Math.floor(index / 13) + 1,
    episodeNumber: index % 13 + 1,
    monitored: true,
    episodeFileId: file.id,
  }));
  state.jobs = [1, 2, 3].map((season) => ({
    ...state.jobs[season - 1],
    id: `season${season}`,
    size: 1300,
    contentPath: `/downloads/season${season}`,
    fileCount: 13,
    manifestFiles: Array.from(
      { length: 13 },
      (_, index) => ({ path: `season${season}/episode${index + 1}.mkv`, size: 100 }),
    ),
  }));
  input.arrTargets[0].client.torrentAssociations = () =>
    Promise.resolve(
      state.files.map((file, index) => ({
        hash: `season${Math.floor(index / 13) + 1}`,
        payloadPath: null,
        historyId: index + 1,
        date: null,
        sourcePath: `/source/season${Math.floor(index / 13) + 1}/episode${index % 13 + 1}.mkv`,
        importedPath: file.path,
      })),
    );
  const whole = await buildOrdinaryDeletionPlan({ ...input, arrSelected: true, qbSelected: true });
  assertEquals(whole.arr[0].episodes.length, 39);
  assertEquals(whole.jobs.length, 3);
  assertEquals(whole.jobs.flatMap((job) => job.job.manifestFiles).length, 39);
  const selection = {
    ...input.selection,
    ratingKey: 'season-one',
    type: 'season' as const,
    showRatingKey: 'show',
    seasonIndex: 1,
  };
  input.plex.metadataIdentity = () =>
    Promise.resolve(
      {
        ...selection,
        librarySectionId: 'tv',
        media: [],
        guids: [],
        parentRatingKey: 'show',
        grandparentRatingKey: null,
        index: 1,
      } as Awaited<ReturnType<PlexClient['metadataIdentity']>>,
    );
  const seasonEpisodes = state.episodes.filter((episode) => episode.seasonNumber === 1).map(
    (episode) => ({
      ratingKey: `episode${episode.id}`,
      title: `Episode ${episode.id}`,
      showRatingKey: 'show',
      seasonRatingKey: 'season-one',
      seasonIndex: 1,
      episodeIndex: episode.episodeNumber,
      media: [{
        mediaId: episode.id,
        paths: [{ path: state.files[episode.id - 1].path.replace('/arr', '/plex'), byteSize: 100 }],
      }],
    }),
  );
  const season = await buildOrdinaryDeletionPlan({
    ...input,
    selection,
    seasonEpisodes,
    arrSelected: true,
    qbSelected: true,
  });
  assertEquals(season.arr[0].directory, false);
  assertEquals(season.arr[0].files.length, 13);
  assertEquals(season.jobs.map((job) => job.job.id), ['season1']);
  state.files[0].episodeIds.push(14);
  await assertRejects(
    () =>
      buildOrdinaryDeletionPlan({
        ...input,
        selection,
        seasonEpisodes,
        arrSelected: true,
        qbSelected: true,
      }),
    Error,
    'unselected episode',
  );
});

Deno.test('missing roots, changed connection identity, playback and cross-instance nested folders block preview', async () => {
  for (const change of ['missing', 'connection', 'playing', 'instance'] as const) {
    const { state, input } = fixture();
    if (change === 'missing') input.roots.splice(1, 1);
    if (change === 'connection') {
      input.connections.find((entry) => entry.key === 'arr:1')!.configurationIdentity = 'changed';
    }
    if (change === 'playing') state.playing = true;
    if (change === 'instance') {
      input.arrTargets.push({
        ...input.arrTargets[0],
        instanceId: 2,
        instanceName: 'Second Sonarr',
        client: {
          ...input.arrTargets[0].client,
          lookup: () => Promise.resolve({ id: 10, path: '/second/Jessica/Nested' }),
        } as unknown as ArrDeleteTarget['client'],
      });
      input.roots.push({
        ...input.roots[1],
        id: 5,
        serviceKey: 'arr:2',
        configurationIdentity: 'arr:2',
        serviceRoot: '/second',
      });
      input.connections.push({
        key: 'arr:2',
        name: 'Second Sonarr',
        configurationIdentity: 'arr:2',
        libraryKeys: ['tv'],
        roots: [],
      });
    }
    await assertRejects(
      () => buildOrdinaryDeletionPlan({ ...input, arrSelected: true, qbSelected: true }),
      Error,
    );
  }
});

Deno.test('retained Plex media in a second library uses its configured prefix translation', async () => {
  const { input, state } = fixture();
  input.connections.push({
    key: 'plex:other',
    name: 'Other library',
    configurationIdentity: 'plex:other',
    libraryKeys: ['other'],
    roots: [],
  });
  input.roots.push({
    ...input.roots[0],
    id: 5,
    serviceKey: 'plex:other',
    configurationIdentity: 'plex:other',
    serviceRoot: '/other-plex',
  });
  state.retained.push({
    ratingKey: 'other-title',
    showRatingKey: 'other-title',
    seasonRatingKey: 'other-season',
    path: '/other-plex/Jessica/retained.mkv',
  });
  await assertRejects(
    () => buildOrdinaryDeletionPlan({ ...input, arrSelected: true }),
    Error,
    'retained in Plex',
  );
});

Deno.test('a second configured Arr instance cannot hide a retained nested title behind a missing selected match', async () => {
  const { input } = fixture();
  input.arrTargets.push({
    ...input.arrTargets[0],
    instanceId: 2,
    instanceName: 'Other Sonarr',
    client: {
      lookup: () => Promise.resolve(null),
      managedScopes: () => Promise.resolve([{ id: 88, path: '/second/Jessica/Retained' }]),
    } as unknown as ArrDeleteTarget['client'],
  });
  input.connections.push({
    key: 'arr:2',
    name: 'Other Sonarr',
    configurationIdentity: 'arr:2',
    libraryKeys: ['tv'],
    roots: [],
  });
  input.roots.push({
    ...input.roots[1],
    id: 5,
    serviceKey: 'arr:2',
    configurationIdentity: 'arr:2',
    serviceRoot: '/second',
  });
  await assertRejects(
    () => buildOrdinaryDeletionPlan({ ...input, arrSelected: true }),
    Error,
    'retained title',
  );
});

Deno.test('an unresolved retained Plex root cannot be silently excluded from broad Arr deletion', async () => {
  const { input, state } = fixture();
  input.plex.libraries = () =>
    Promise.resolve(
      [{ key: 'tv', type: 'show' }, { key: 'other', type: 'movie' }] as Awaited<
        ReturnType<PlexClient['libraries']>
      >,
    );
  state.retained.push({
    ratingKey: 'retained',
    showRatingKey: 'retained',
    seasonRatingKey: 'other',
    path: '/unresolved/title/file.mkv',
  });
  await assertRejects(
    () => buildOrdinaryDeletionPlan({ ...input, arrSelected: true }),
    Error,
    'retained Plex library',
  );
  input.connections.push({
    key: 'plex:other',
    name: 'Other',
    configurationIdentity: 'plex:other',
    libraryKeys: ['other'],
    roots: [],
  });
  input.roots.push({
    ...input.roots[0],
    id: 5,
    serviceKey: 'plex:other',
    configurationIdentity: 'plex:other',
    serviceRoot: '/unresolved',
    storageRoot: '/separate',
  });
  assertEquals((await buildOrdinaryDeletionPlan({ ...input, arrSelected: true })).arr.length, 1);
  input.roots[4].storageRoot = '/storage/library/Jessica';
  await assertRejects(
    () => buildOrdinaryDeletionPlan({ ...input, arrSelected: true }),
    Error,
    'retained in Plex',
  );
});

Deno.test('Plex-only Windows deletion protects another item sharing the same directory entry without roots', async () => {
  const { input, state } = fixture();
  state.files = [{ id: 1, path: 'D:\\Movies\\Shared.mkv', size: 100, episodeIds: [1] }];
  state.retained.push({
    ratingKey: 'other-item',
    showRatingKey: 'other-show',
    seasonRatingKey: 'other-season',
    path: 'D:\\Movies\\Shared.mkv',
  });
  await assertRejects(
    () => buildOrdinaryDeletionPlan({ ...input, downloadTargets: [], roots: [] }),
    Error,
    'retained in Plex',
  );
  state.retained[0].path = 'D:\\Movies\\Different.mkv';
  assertEquals(
    (await buildOrdinaryDeletionPlan({ ...input, downloadTargets: [], roots: [] })).plexFiles
      .length,
    1,
  );
});

Deno.test('all four preview destination combinations share one streaming retained-media inspection', async () => {
  const { input } = fixture();
  let scans = 0;
  const original = input.plex.libraryFileEntries.bind(input.plex);
  input.plex.libraryFileEntries = async function* (key, episodes) {
    scans++;
    yield* original(key, episodes);
  };
  const preview = await ordinaryPreview(input);
  assertEquals(preview.status, 'resolved');
  assertEquals(scans, 1);
});
