import { deepStrictEqual as equal } from 'node:assert/strict';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import { buildServiceOwnedPlan, type ServiceOwnedPlanningInput } from './serviceOwnedPlanning.ts';

function populatedFixture(type: 'season' | 'episode') {
  const plexRoot = '/plex-tv/Selected Show';
  const arrRoot = '/sonarr-library/Selected Show';
  const filename = 'Selected Show S01E01.mkv';
  const selectedPath = `${plexRoot}/${filename}`;
  const unrelatedLibraryEntries = Array.from({ length: 500 }, (_, n) => ({
    ratingKey: `other-title-${n}`,
    path: `/plex-tv/Other Show ${n}/S01E01.mkv`,
  }));
  const showFiles = [
    { ratingKey: 'episode', mediaId: 1, path: selectedPath, size: 1000 },
    ...Array.from({ length: 200 }, (_, n) => ({
      ratingKey: `other-episode-${n}`,
      mediaId: n + 2,
      path: `${plexRoot}/Season 02/Selected Show S02E${n + 1}.mkv`,
      size: 2000,
    })),
  ];
  const calls = { wholeLibrary: 0, manifests: [] as string[], showPreview: 0 };
  const identity = (key: string) => ({
    ratingKey: key,
    title: key,
    type: key === 'episode' ? 'episode' : key === 'season' ? 'season' : 'show',
    librarySectionId: 'tv',
    tmdbId: null,
    tvdbId: key === 'show' ? 123 : null,
    parentRatingKey: key === 'season' ? 'show' : key === 'episode' ? 'season' : null,
    grandparentRatingKey: key === 'episode' ? 'show' : null,
    seasonIndex: key === 'episode' ? 1 : null,
    index: key === 'show' ? null : 1,
    media: key === 'episode' ? [{ mediaId: 1 }] : [],
  });
  const preview = (files: typeof showFiles) => ({
    paths: files.map((file) => file.path),
    truncated: false,
    fileSizes: Object.fromEntries(files.map((file) => [file.path, file.size])),
    versionFiles: files,
  });
  const plex = {
    libraries: () => Promise.resolve([{ key: 'tv', type: 'show' }]),
    libraryFileEntries: () => {
      calls.wholeLibrary++;
      throw new Error(
        `Whole-library inspection is forbidden (${unrelatedLibraryEntries.length} unrelated records)`,
      );
    },
    metadataIdentity: (key: string) => Promise.resolve(identity(key)),
    mediaPathPreview: (key: string) => {
      if (key === 'show') {
        calls.showPreview++;
        return Promise.resolve(preview(showFiles));
      }
      return Promise.resolve(preview(showFiles.slice(0, 1)));
    },
    seasonDeletionEpisodes: () =>
      Promise.resolve([{
        ratingKey: 'episode',
        title: 'Selected episode',
        showRatingKey: 'show',
        seasonRatingKey: 'season',
        seasonIndex: 1,
        episodeIndex: 1,
        media: [{ mediaId: 1, paths: [{ path: selectedPath, byteSize: 1000 }] }],
      }]),
  };
  const managedFile = {
    id: 5,
    seriesId: 7,
    path: `${arrRoot}/${filename}`,
    relativePath: filename,
    size: 1000,
    episodeIds: [8],
  };
  const arr = {
    lookup: () => Promise.resolve({ id: 7, title: 'Selected Show', path: arrRoot }),
    sonarrSeriesSnapshot: () =>
      Promise.resolve({
        files: [
          managedFile,
          ...showFiles.slice(1).map((file, n) => ({
            id: n + 100,
            seriesId: 7,
            path: file.path.replace(plexRoot, arrRoot),
            relativePath: `Season 02/${file.path.split('/').at(-1)}`,
            size: file.size,
            episodeIds: [n + 1000],
          })),
        ],
        episodes: [
          {
            id: 8,
            seriesId: 7,
            seasonNumber: 1,
            episodeNumber: 1,
            episodeFileId: 5,
            monitored: true,
          },
          ...showFiles.slice(1).map((_file, n) => ({
            id: n + 1000,
            seriesId: 7,
            seasonNumber: 2,
            episodeNumber: n + 1,
            episodeFileId: n + 100,
            monitored: true,
          })),
        ],
      }),
    sonarrEpisodeFileOwnerIds: () => Promise.resolve([8]),
    sonarrExtraFiles: () => Promise.reject(new Error('API does not expose extras enumeration')),
    torrentAssociations: () =>
      Promise.resolve([{
        hash: 'selected-hash',
        episodeFileId: 5,
        episodeId: 8,
        historyId: 20,
        date: null,
        sourcePath: `/downloads/selected/${filename}`,
        importedPath: managedFile.path,
        payloadPath: null,
      }]),
    downloadIdIsExclusiveTo: () => Promise.resolve(true),
  };
  const selectedJob: DownloadJob = {
    id: 'selected-hash',
    name: 'Selected Show',
    state: 'uploading',
    size: 1000,
    uploaded: 100,
    completedAt: 1,
    ratio: 1,
    seedingTime: 10,
    contentPath: `/downloads/selected/${filename}`,
    savePath: '/downloads/selected',
    trackerHost: null,
    fileCount: 1,
    files: [{ path: filename, size: 1000 }],
    filesTruncated: false,
    manifestFiles: [{ path: filename, size: 1000 }],
  };
  let jobs = [
    selectedJob,
    ...Array.from({ length: 200 }, (_entry, n) => ({
      ...selectedJob,
      id: `unrelated-${n}`,
      name: `Other ${n}`,
      savePath: `/downloads/unrelated-${n}`,
      contentPath: `/downloads/unrelated-${n}/Other.mkv`,
      files: [{ path: 'Other.mkv', size: 1000 }],
      manifestFiles: [{ path: 'Other.mkv', size: 1000 }],
    })),
  ];
  const qb = {
    scanJobSummaries: async (visit: (job: DownloadJob) => Promise<void>) => {
      for (const job of jobs) await visit(job);
      return JSON.stringify(
        jobs.map((j) => ({ id: j.id, savePath: j.savePath, contentPath: j.contentPath })),
      );
    },
    findJob: (id: string) => {
      calls.manifests.push(id);
      return Promise.resolve(jobs.find((j) => j.id === id) ?? null);
    },
    deleteJob: () => {
      throw new Error('Read-only planning cannot delete');
    },
  };
  const arrTarget: ArrDeleteTarget = {
    instanceId: 1,
    instanceName: 'Sonarr',
    instanceType: 'sonarr',
    instanceUrl: 'http://sonarr.invalid',
    configurationUpdatedAt: 1,
    mappingIdentity: 'unused',
    pathMappings: [],
    addImportExclusion: false,
    client: arr as unknown as ArrDeleteTarget['client'],
  };
  const qbTarget: DownloadClientTarget = {
    provider: 'qbittorrent',
    instanceId: 1,
    instanceKey: '1',
    instanceName: 'QB',
    configurationIdentity: 'qb-config',
    client: qb,
  };
  const input: ServiceOwnedPlanningInput = {
    serverId: 1,
    libraryKey: 'tv',
    selection: {
      ratingKey: type,
      type,
      title: 'Selected',
      tmdbId: null,
      tvdbId: 123,
      showRatingKey: 'show',
      seasonIndex: 1,
      ...(type === 'episode' ? { episodeIndex: 1 } : {}),
    },
    arrSelected: true,
    qbSelected: false,
    plex: plex as unknown as PlexClient,
    arrTargets: [arrTarget],
    downloadTargets: [qbTarget],
  };
  return {
    input,
    plex,
    arr,
    qb,
    calls,
    selectedJob,
    managedFile,
    selectedPath,
    removeJobs: () => {
      jobs = [];
    },
    unrelatedLibraryEntries,
    showFiles,
  };
}
const decisions = (plan: Awaited<ReturnType<typeof buildServiceOwnedPlan>>) =>
  Object.fromEntries(plan.retention.decisions.map((d) => [d.service, d.state]));

Deno.test('populated TV libraries allow selected season and episode with separately retained download', async () => {
  for (const type of ['season', 'episode'] as const) {
    const fixture = populatedFixture(type);
    const plan = await buildServiceOwnedPlan(fixture.input);
    equal(decisions(plan), { sonarr: 'delete_candidate', plex: 'delete_candidate', qb: 'kept' });
    equal(fixture.calls.wholeLibrary, 0);
    equal(fixture.unrelatedLibraryEntries.length, 500);
    equal(fixture.calls.manifests.some((id) => id.startsWith('unrelated-')), false);
    equal(plan.actions.find((a) => a.service === 'sonarr')?.fileId, 5);
  }
});

Deno.test('populated TV retained QB exact overlap vetoes only affected atomic actions', async () => {
  for (const scope of ['plex', 'sonarr'] as const) {
    const fixture = populatedFixture('season');
    const path = scope === 'plex' ? fixture.selectedPath : fixture.managedFile.path;
    fixture.selectedJob.savePath = path.slice(0, path.lastIndexOf('/'));
    fixture.selectedJob.contentPath = path;
    const plan = await buildServiceOwnedPlan(fixture.input);
    equal(decisions(plan)[scope], 'kept');
    equal(decisions(plan)[scope === 'plex' ? 'sonarr' : 'plex'], 'delete_candidate');
    equal(decisions(plan).qb, 'kept');
    equal(fixture.calls.wholeLibrary, 0);
  }
});

Deno.test('populated TV successful absent QB inventory differs from failed required QB reads', async () => {
  const absent = populatedFixture('season');
  absent.removeJobs();
  equal(decisions(await buildServiceOwnedPlan(absent.input)), {
    sonarr: 'delete_candidate',
    plex: 'delete_candidate',
    qb: 'not_applicable',
  });
  const failed = populatedFixture('season');
  failed.qb.scanJobSummaries = () => Promise.reject(new Error('disposable unavailable QB'));
  const plan = await buildServiceOwnedPlan(failed.input);
  equal(decisions(plan).plex, 'held');
  equal(decisions(plan).sonarr, 'held');
  equal(absent.calls.wholeLibrary, 0);
  equal(failed.calls.wholeLibrary, 0);
});

Deno.test('populated TV failed owning-show evidence remains held without a whole-library fallback', async () => {
  const fixture = populatedFixture('episode');
  const original = fixture.plex.mediaPathPreview;
  fixture.plex.mediaPathPreview = (key) =>
    key === 'show' ? Promise.reject(new Error('selected show read failed')) : original(key);
  const plan = await buildServiceOwnedPlan(fixture.input);
  equal(decisions(plan).plex, 'held');
  equal(fixture.calls.wholeLibrary, 0);
});

Deno.test('populated TV required selected-download manifest failure stays held', async () => {
  const fixture = populatedFixture('season');
  const original = fixture.qb.findJob;
  fixture.qb.findJob = (id) =>
    id === 'selected-hash'
      ? Promise.reject(new Error('disposable selected manifest failure'))
      : original(id);
  const plan = await buildServiceOwnedPlan(fixture.input);
  equal(decisions(plan).plex, 'held');
  equal(decisions(plan).sonarr, 'held');
  equal(fixture.calls.wholeLibrary, 0);
});

Deno.test('populated TV parent-show sibling sharing the selected entry retains the whole Plex action', async () => {
  const fixture = populatedFixture('season');
  const arrSnapshot = await fixture.arr.sonarrSeriesSnapshot();
  fixture.arr.sonarrSeriesSnapshot = () => Promise.resolve(arrSnapshot);
  fixture.showFiles[1].path = fixture.selectedPath;
  const plan = await buildServiceOwnedPlan(fixture.input);
  equal(decisions(plan).plex, 'kept');
  equal(decisions(plan).sonarr, 'delete_candidate');
  equal(fixture.calls.wholeLibrary, 0);
});
