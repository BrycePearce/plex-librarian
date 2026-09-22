import { deepStrictEqual as equal, notDeepStrictEqual, rejects } from 'node:assert/strict';
import { PlexClient } from '../../integrations/plex/client.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { DownloadClientTarget, DownloadJob, DownloadJobSummary } from './downloadClient.ts';
import { buildServiceOwnedPlan, type ServiceOwnedPlanningInput } from './serviceOwnedPlanning.ts';
import { boundServiceOwnedConsent } from './serviceOwnedConsent.ts';

Deno.test('discovery reads each intended file once and leaves ownership inventories to verification', async () => {
  const f = fixture();
  f.setJobs([f.job]);
  f.input.downloadTargets = [f.download];
  f.input.qbSelected = true;
  let scans = 0, ownership = 0, manifests = 0;
  const scan = f.qb.scanJobSummaries;
  f.qb.scanJobSummaries = (visit) => {
    scans++;
    return scan(visit);
  };
  f.arr.downloadIdIsExclusiveTo = () => {
    ownership++;
    return Promise.resolve(true);
  };
  const find = f.qb.findJob;
  f.qb.findJob = (id) => {
    manifests++;
    return find(id);
  };
  const discovered = await buildServiceOwnedPlan({ ...f.input, discovery: true });
  equal(scans, 0);
  equal(ownership, 0);
  equal(manifests, 1);
  equal(f.calls, ['plex.identity', 'plex.files']);
  equal(discovered.actions.find((a) => a.service === 'qb')!.files, [{
    path: '/qb/Movie.mkv',
    size: 100,
  }]);
  const verified = await buildServiceOwnedPlan(f.input);
  equal(scans, 2);
  equal(ownership, 1);
  equal(decisions(boundServiceOwnedConsent(discovered, verified)), {
    radarr: 'delete_candidate',
    plex: 'delete_candidate',
    qb: 'delete_candidate',
  });
});

Deno.test('worker consent ceiling holds new paths and propagates retention without widening service effects', async () => {
  const f = fixture();
  const approved = await buildServiceOwnedPlan({ ...f.input, discovery: true });
  f.arr.extraFiles = () =>
    Promise.resolve([{ relativePath: 'Movie.srt', movieFileId: 5, type: 'subtitle' }]);
  const current = boundServiceOwnedConsent(approved, await buildServiceOwnedPlan(f.input));
  equal(decisions(current), { radarr: 'held', plex: 'delete_candidate' });
  equal(approved.actions.find((a) => a.service === 'radarr')!.files.length, 1);
});

Deno.test('verification narrows selected QB jobs with changed ownership and rejects changed connections', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.input.qbSelected = true;
  f.setJobs([f.job]);
  const approved = await buildServiceOwnedPlan({ ...f.input, discovery: true });
  f.arr.downloadIdIsExclusiveTo = () => Promise.resolve(false);
  equal(
    decisions(boundServiceOwnedConsent(approved, await buildServiceOwnedPlan(f.input))).qb,
    'kept',
  );
  f.download.configurationIdentity = 'changed-mapping';
  await rejects(
    async () => boundServiceOwnedConsent(approved, await buildServiceOwnedPlan(f.input)),
    /configuration changed/,
  );
});

function fixture() {
  const file = { id: 5, path: '/arr/Movie.mkv', relativePath: 'Movie.mkv', size: 100 };
  const identity = {
    ratingKey: 'movie',
    title: 'Movie',
    type: 'movie',
    librarySectionId: '1',
    tmdbId: 123,
    tvdbId: null,
    parentRatingKey: null,
    grandparentRatingKey: null,
    seasonIndex: null,
    index: null,
    media: [],
  };
  const calls: string[] = [];
  const plex = {
    libraries: () => Promise.resolve([{ key: '1', type: 'movie' }]),
    libraryFileEntries: async function* (_libraryKey: string, _episodes: boolean) {
      yield [{ ratingKey: 'movie', path: '/plex/Movie.mkv' }];
    },
    metadataIdentity: (_ratingKey?: string) => {
      calls.push('plex.identity');
      return Promise.resolve(identity);
    },
    mediaPathPreview: (_ratingKey?: string) => {
      calls.push('plex.files');
      return Promise.resolve({
        paths: ['/plex/Movie.mkv'],
        truncated: false,
        fileSizes: { '/plex/Movie.mkv': 100 },
        versionFiles: [{ ratingKey: 'movie', mediaId: 1, path: '/plex/Movie.mkv', size: 100 }],
      });
    },
  };
  const arr = {
    radarrMovieCatalogPaths: () => Promise.resolve([{ id: 7, tmdbId: 123, path: '/arr' }]),
    lookup: () => Promise.resolve({ id: 7, title: 'Movie', path: '/arr' }),
    radarrManagedFile: () => Promise.resolve(file),
    extraFiles: () =>
      Promise.resolve(
        [] as Array<{ relativePath: string; movieFileId: number | null; type: 'subtitle' }>,
      ),
    torrentAssociations: () =>
      Promise.resolve([{
        hash: 'hash',
        movieFileId: 5,
        sourcePath: '/imports/Movie.mkv',
        importedPath: '/arr/Movie.mkv',
        payloadPath: null,
        historyId: 1,
        date: null,
      }]),
    downloadIdIsExclusiveTo: () => Promise.resolve(true),
  };
  const job: DownloadJob = {
    id: 'hash',
    name: 'Movie',
    state: 'uploading',
    size: 100,
    uploaded: 1,
    completedAt: 1,
    ratio: 1,
    seedingTime: 10,
    contentPath: '/qb/Movie.mkv',
    savePath: '/qb',
    trackerHost: null,
    fileCount: 1,
    files: [{ path: 'Movie.mkv', size: 100 }],
    filesTruncated: false,
    manifestFiles: [{ path: 'Movie.mkv', size: 100 }],
  };
  let jobs: DownloadJob[] = [];
  const qb = {
    scanJobSummaries: async (visit: (s: DownloadJobSummary) => Promise<void>) => {
      for (const j of jobs) {
        await visit({ id: j.id, savePath: j.savePath, contentPath: j.contentPath, size: j.size });
      }
      return JSON.stringify(jobs.map((j) => j.id));
    },
    findJob: (id: string) => Promise.resolve(jobs.find((j) => j.id === id) ?? null),
    deleteJob: () => {
      throw new Error('Collector must not delete');
    },
  };
  const target: ArrDeleteTarget = {
    instanceId: 1,
    instanceName: 'Radarr',
    instanceType: 'radarr',
    instanceUrl: 'http://arr.invalid',
    configurationUpdatedAt: 1,
    mappingIdentity: 'unused',
    pathMappings: [],
    addImportExclusion: false,
    client: arr as unknown as ArrDeleteTarget['client'],
  };
  const download: DownloadClientTarget = {
    provider: 'qbittorrent',
    instanceKey: '1',
    instanceId: 1,
    instanceName: 'QB',
    configurationIdentity: 'endpoint-1',
    client: qb,
  };
  const input: ServiceOwnedPlanningInput = {
    serverId: 1,
    libraryKey: '1',
    selection: { ratingKey: 'movie', title: 'Movie', type: 'movie', tmdbId: 123, tvdbId: null },
    arrSelected: true,
    qbSelected: false,
    plex: plex as unknown as PlexClient,
    arrTargets: [target],
    downloadTargets: [],
  };
  return {
    input,
    plex,
    arr,
    target,
    download,
    qb,
    job,
    file,
    identity,
    calls,
    setJobs: (value: DownloadJob[]) => {
      jobs = value;
    },
  };
}
const decisions = (p: Awaited<ReturnType<typeof buildServiceOwnedPlan>>) =>
  Object.fromEntries(p.retention.decisions.map((d) => [d.service, d.state]));

Deno.test('API collector associates movie under arbitrary roots without mappings', async () => {
  const f = fixture();
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p), { radarr: 'delete_candidate', plex: 'delete_candidate' });
  equal(p.policyVersion, 4);
  equal(p.actions.find((a) => a.service === 'radarr')?.fileId, 5);
  equal('roots' in p, false);
});
Deno.test('complete empty QB inventory does not block Plex or Radarr', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p), {
    radarr: 'delete_candidate',
    plex: 'delete_candidate',
    qb: 'not_applicable',
  });
});
Deno.test('missing history independently preserves valid Arr matching', async () => {
  const f = fixture();
  f.arr.torrentAssociations = () => Promise.reject(new Error('private-token'));
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).radarr, 'delete_candidate');
  equal(JSON.stringify(p).includes('private-token'), false);
});
Deno.test('retained QB equal paths keep Plex while separate names remain eligible', async () => {
  const f = fixture();
  f.input.arrSelected = false;
  f.input.downloadTargets = [f.download];
  f.setJobs([f.job]);
  let p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).plex, 'delete_candidate');
  f.job.savePath = '/plex';
  f.job.contentPath = '/plex/Movie.mkv';
  p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).plex, 'kept');
  equal(decisions(p).qb, 'kept');
});
Deno.test('selected complete current provenance-associated QB job is a candidate', async () => {
  const f = fixture();
  f.input.qbSelected = true;
  f.input.downloadTargets = [f.download];
  f.setJobs([f.job]);
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).qb, 'delete_candidate');
  equal(p.actions.find((a) => a.service === 'qb')?.hash, 'hash');
  equal(p.actions.find((a) => a.service === 'qb')?.matchedToSelection, true);
});
Deno.test('overlap-only QB jobs remain protected without becoming matched destinations', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.input.qbSelected = true;
  f.job.id = 'unassociated';
  f.job.savePath = '/plex';
  f.job.contentPath = '/plex/Movie.mkv';
  f.setJobs([f.job]);
  const p = await buildServiceOwnedPlan(f.input);
  equal(p.actions.find((a) => a.service === 'qb')?.presence, 'current');
  equal(p.actions.find((a) => a.service === 'qb')?.matchedToSelection, false);
  equal(decisions(p).qb, 'kept');
  equal(decisions(p).plex, 'kept');
});
Deno.test('complete mixed torrent is retained while separate Plex remains eligible', async () => {
  for (const selected of [false, true]) {
    const f = fixture();
    f.input.qbSelected = selected;
    f.input.downloadTargets = [f.download];
    f.job.manifestFiles.push({ path: 'Extra.txt', size: 1 });
    f.job.fileCount = 2;
    f.setJobs([f.job]);
    const p = await buildServiceOwnedPlan(f.input);
    equal(decisions(p).qb, 'kept');
    equal(decisions(p).plex, 'delete_candidate');
    equal(p.actions.find((a) => a.service === 'qb')?.effectsComplete, true);
    equal(p.actions.find((a) => a.service === 'qb')?.retainedOwnership, true);
  }
});
Deno.test('QB read failure is not an empty inventory', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.qb.scanJobSummaries = () => Promise.reject(new Error('secret'));
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).plex, 'held');
  equal(decisions(p).qb, 'held');
  equal(JSON.stringify(p).includes('secret'), false);
});
Deno.test('historical missing hash never creates a current job deletion', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.input.qbSelected = true;
  const p = await buildServiceOwnedPlan(f.input);
  equal(p.actions.some((a) => a.hash === 'hash'), false);
  equal(decisions(p).plex, 'delete_candidate');
});
Deno.test('Arr filename or size mismatch cannot become permission to delete', async () => {
  for (const field of ['path', 'size'] as const) {
    const f = fixture();
    if (field === 'path') f.file.path = '/arr/Other.mkv';
    else f.file.size = 101;
    const p = await buildServiceOwnedPlan(f.input);
    equal(decisions(p).radarr, 'held');
  }
});
Deno.test('multiple current Arr instances remain ambiguous', async () => {
  const f = fixture();
  f.input.arrTargets = [f.target, { ...f.target, instanceId: 2 }];
  const p = await buildServiceOwnedPlan(f.input);
  equal(p.actions.filter((a) => a.service === 'radarr').every((a) => !a.effectsComplete), true);
});
Deno.test('unassociated Radarr extras are not added to selected file-ID deletion effects', async () => {
  const f = fixture();
  f.arr.extraFiles = () =>
    Promise.resolve([{ relativePath: 'Movie.srt', movieFileId: null, type: 'subtitle' }]);
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).radarr, 'delete_candidate');
  equal(
    p.actions.find((a) => a.service === 'radarr')?.files.some((file) =>
      file.path === '/arr/Movie.srt'
    ),
    false,
  );
});
Deno.test('owned Radarr extras are included in the whole file action', async () => {
  const f = fixture();
  f.arr.extraFiles = () =>
    Promise.resolve([{ relativePath: 'Movie.srt', movieFileId: 5, type: 'subtitle' }]);
  const p = await buildServiceOwnedPlan(f.input);
  equal(p.actions.find((a) => a.service === 'radarr')?.files, [{
    path: '/arr/Movie.mkv',
    size: 100,
  }, { path: '/arr/Movie.srt', size: null }]);
});
Deno.test('stable fingerprint ignores changing QB seeding counters', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.input.qbSelected = true;
  f.setJobs([f.job]);
  const a = await buildServiceOwnedPlan(f.input);
  f.job.uploaded += 10;
  f.job.ratio = 2;
  f.job.seedingTime += 50;
  const b = await buildServiceOwnedPlan(f.input);
  equal(a.fingerprint, b.fingerprint);
  f.input.arrSelected = false;
  notDeepStrictEqual((await buildServiceOwnedPlan(f.input)).fingerprint, b.fingerprint);
});
Deno.test('changed current Plex identity remains unknown rather than absent', async () => {
  const f = fixture();
  let count = 0;
  f.plex.metadataIdentity = () =>
    Promise.resolve({ ...f.identity, title: ++count === 1 ? 'Movie' : 'Changed' });
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).plex, 'held');
});
Deno.test('collector rejects unsupported selection before any service read', async () => {
  const f = fixture();
  f.input.selection.type = 'artist';
  await rejects(() => buildServiceOwnedPlan(f.input));
  equal(f.calls, []);
});
Deno.test('connection identities are retained without transport credentials or mappings', async () => {
  const f = fixture();
  f.target.instanceUrl = 'http://user:private@arr.invalid/?token=private';
  const p = await buildServiceOwnedPlan(f.input);
  equal(p.connections.length, 1);
  equal(JSON.stringify(p).includes('private'), false);
});

Deno.test('other Plex item sharing selected Part is retained before deletion', async () => {
  const f = fixture();
  f.input.arrTargets = [];
  f.input.relatedPlexItems = () =>
    Promise.resolve([{ ratingKey: 'other', libraryKey: '1', type: 'movie' }]);
  f.plex.metadataIdentity = (key) => Promise.resolve({ ...f.identity, ratingKey: key ?? 'movie' });
  const paths = f.plex.mediaPathPreview;
  f.plex.mediaPathPreview = async (key) => ({
    ...await paths(),
    versionFiles: [{ ratingKey: key ?? 'movie', mediaId: 1, path: '/plex/Movie.mkv', size: 100 }],
  });
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).plex, 'kept');
});
Deno.test('different related Plex file does not create hypothetical alias hold', async () => {
  const f = fixture();
  f.input.arrTargets = [];
  f.input.relatedPlexItems = () =>
    Promise.resolve([{ ratingKey: 'other', libraryKey: '1', type: 'movie' }]);
  f.plex.metadataIdentity = (key) => Promise.resolve({ ...f.identity, ratingKey: key ?? 'movie' });
  const paths = f.plex.mediaPathPreview;
  f.plex.mediaPathPreview = async (key) => ({
    ...await paths(),
    versionFiles: [{
      ratingKey: key ?? 'movie',
      mediaId: 1,
      path: key === 'other' ? '/plex/Other.mkv' : '/plex/Movie.mkv',
      size: 100,
    }],
  });
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).plex, 'delete_candidate');
});
Deno.test('failed scoped retained title read cannot imply no retained owner', async () => {
  const f = fixture();
  f.input.arrTargets = [];
  f.input.relatedPlexItems = () =>
    Promise.resolve([{ ratingKey: 'other', libraryKey: '1', type: 'movie' }]);
  f.plex.metadataIdentity = (key) =>
    key === 'other' ? Promise.reject(new Error('private')) : Promise.resolve(f.identity);
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).plex, 'held');
});
Deno.test('version preview does not authorize whole movie catalog cleanup', async () => {
  const f = fixture();
  f.input.selection.mediaId = 1;
  f.plex.mediaPathPreview = () =>
    Promise.resolve({
      paths: ['/plex/Movie.mkv'],
      truncated: false,
      fileSizes: { '/plex/Movie.mkv': 100 },
      versionFiles: [{ ratingKey: 'movie', mediaId: 1, path: '/plex/Movie.mkv', size: 100 }, {
        ratingKey: 'movie',
        mediaId: 2,
        path: '/plex/Movie.mkv',
        size: 100,
      }],
    });
  const p = await buildServiceOwnedPlan(f.input);
  equal(p.actions.find((a) => a.service === 'radarr')?.recordCleanup, undefined);
  equal(decisions(p).plex, 'kept');
});

function tvFixture(type: 'show' | 'season' | 'episode') {
  const f = fixture();
  const episode = {
    ratingKey: 'episode',
    title: 'Episode',
    showRatingKey: 'show',
    seasonRatingKey: 'season',
    seasonIndex: 1,
    episodeIndex: 1,
    media: [{ mediaId: 1, paths: [{ path: '/plex/Show S01E01.mkv', byteSize: 100 }] }],
  };
  const identity = (key: string) => ({
    ratingKey: key,
    title: key,
    type: key,
    librarySectionId: '1',
    tmdbId: null,
    tvdbId: key === 'show' ? 123 : null,
    parentRatingKey: key === 'season' ? 'show' : key === 'episode' ? 'season' : null,
    grandparentRatingKey: key === 'episode' ? 'show' : null,
    seasonIndex: key === 'episode' ? 1 : null,
    index: key === 'show' ? null : 1,
    media: [],
  });
  const plex = {
    metadataIdentity: (key: string) => Promise.resolve(identity(key)),
    seasonDeletionEpisodes: () => Promise.resolve([episode]),
    libraries: () => Promise.resolve([{ key: '1', type: 'show' }]),
    libraryFileEntries: async function* () {
      yield [{ ratingKey: 'episode', path: '/plex/Show S01E01.mkv' }];
    },
    mediaPathPreview: () =>
      Promise.resolve({
        paths: ['/plex/Show S01E01.mkv'],
        truncated: false,
        fileSizes: { '/plex/Show S01E01.mkv': 100 },
        versionFiles: [{
          ratingKey: 'episode',
          mediaId: 1,
          path: '/plex/Show S01E01.mkv',
          size: 100,
        }],
      }),
  };
  const arr = {
    lookup: () => Promise.resolve({ id: 7, title: 'Show', path: '/arr' }),
    sonarrSeriesSnapshot: () =>
      Promise.resolve({
        files: [{
          id: 5,
          seriesId: 7,
          path: '/arr/Show S01E01.mkv',
          relativePath: 'Show S01E01.mkv',
          size: 100,
          episodeIds: [8],
        }],
        episodes: [{
          id: 8,
          seriesId: 7,
          seasonNumber: 1,
          episodeNumber: 1,
          episodeFileId: 5,
          monitored: true,
        }],
      }),
    sonarrEpisodeFileOwnerIds: () => Promise.resolve([8]),
    sonarrExtraFiles: () => Promise.reject(new Error('unsupported')),
    torrentAssociations: () => Promise.resolve([]),
  };
  f.input.plex = plex as unknown as PlexClient;
  f.input.selection = {
    ratingKey: type,
    type,
    title: type,
    tvdbId: 123,
    tmdbId: null,
    ...(type === 'show' ? {} : { showRatingKey: 'show', seasonIndex: 1 }),
  };
  f.input.arrTargets = [{
    ...f.target,
    instanceType: 'sonarr',
    client: arr as unknown as ArrDeleteTarget['client'],
  }];
  return { ...f, tvPlex: plex, tvArr: arr };
}
Deno.test('show season and episode use current TVDB coordinates and exact file evidence', async () => {
  for (const type of ['show', 'season', 'episode'] as const) {
    const f = tvFixture(type);
    const p = await buildServiceOwnedPlan(f.input);
    const sonarr = p.actions.find((a) => a.service === 'sonarr');
    equal(sonarr?.recordId, 7);
    equal(sonarr?.fileId, 5);
    equal(sonarr?.associatedExtras, { policy: 'sonarr_file_id', managedRoot: '/arr' });
    equal(sonarr?.effectsComplete, true);
    equal(decisions(p).sonarr, 'delete_candidate');
  }
});
Deno.test('Plex-only season remains applicable without unchecked Sonarr extras support', async () => {
  const f = tvFixture('season');
  f.input.arrSelected = false;
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).plex, 'delete_candidate');
});
Deno.test('Sonarr owner outside selected season is unknown instead of silently included', async () => {
  const f = tvFixture('season');
  f.tvArr.sonarrEpisodeFileOwnerIds = () => Promise.resolve([8, 99]);
  const p = await buildServiceOwnedPlan(f.input);
  equal(p.actions.find((a) => a.service === 'sonarr')?.presence, 'unknown');
  equal(decisions(p).sonarr, 'held');
});

Deno.test('Sonarr unselected file owner also protects the same Plex path', async () => {
  const f = tvFixture('season');
  const snapshot = await f.tvArr.sonarrSeriesSnapshot();
  snapshot.files[0].path = '/plex/Show S01E01.mkv';
  f.tvArr.sonarrSeriesSnapshot = () => Promise.resolve(snapshot);
  f.tvArr.sonarrEpisodeFileOwnerIds = () => Promise.resolve([8, 99]);
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).sonarr, 'held');
  equal(decisions(p).plex, 'kept');
});

Deno.test('first Sonarr owner failure preserves later snapshot-known retained files', async () => {
  const f = tvFixture('season');
  const snapshot = await f.tvArr.sonarrSeriesSnapshot();
  snapshot.files.push({
    ...snapshot.files[0],
    id: 6,
    path: '/plex/Show S01E01.mkv',
    episodeIds: [8, 99],
  });
  snapshot.episodes.push({
    ...snapshot.episodes[0],
    id: 99,
    episodeNumber: 2,
    episodeFileId: 6,
  });
  f.tvArr.sonarrSeriesSnapshot = () => Promise.resolve(snapshot);
  // The first path is distinct from Plex; the second path overlaps Plex. Even
  // though its live owner call is never reached, its retained owner is known.
  f.tvArr.sonarrEpisodeFileOwnerIds = () => Promise.resolve([8, 100]);
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).sonarr, 'held');
  equal(decisions(p).plex, 'kept');
});

Deno.test('unrelated Radarr catalog is not scanned as a blanket deletion prerequisite', async () => {
  const f = fixture();
  f.arr.radarrMovieCatalogPaths = () => {
    throw new Error('Unrelated full catalog must not be read');
  };
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).radarr, 'delete_candidate');
});
Deno.test('failed or changed Radarr current file ownership is held', async () => {
  for (const mode of ['failed', 'changed'] as const) {
    const f = fixture();
    let reads = 0;
    f.arr.radarrManagedFile = () =>
      mode === 'failed'
        ? Promise.reject(new Error('unavailable'))
        : Promise.resolve({ ...f.file, id: ++reads === 1 ? 5 : 6 });
    const p = await buildServiceOwnedPlan(f.input);
    equal(decisions(p).radarr, 'held');
  }
});

Deno.test('current empty whole-movie Arr record is a catalog-only target, not absence', async () => {
  const f = fixture();
  const client = { ...f.arr, radarrManagedFile: () => Promise.resolve(null) };
  f.input.arrTargets = [{ ...f.target, client: client as unknown as ArrDeleteTarget['client'] }];
  const p = await buildServiceOwnedPlan(f.input);
  const a = p.actions.find((a) => a.service === 'radarr')!;
  equal(a.presence, 'current');
  equal(a.catalogOnly, true);
  equal(a.recordId, 7);
  equal(a.fileId, undefined);
  equal(a.recordCleanup, { deleteFiles: false, addImportExclusion: false });
  equal(decisions(p).radarr, 'delete_candidate');
});
Deno.test('empty current season has no invented whole-record deletion', async () => {
  const f = tvFixture('season');
  const client = {
    ...f.tvArr,
    sonarrSeriesSnapshot: () => Promise.resolve({ files: [], episodes: [] }),
  };
  f.input.arrTargets = [{
    ...f.input.arrTargets[0],
    client: client as unknown as ArrDeleteTarget['client'],
  }];
  const p = await buildServiceOwnedPlan(f.input);
  equal(p.actions.find((a) => a.service === 'sonarr')?.catalogOnly, undefined);
  equal(decisions(p).sonarr, 'not_applicable');
});
Deno.test('fresh empty Plex season/show evidence stays held without earlier accepted file effects', async () => {
  for (const type of ['season', 'show'] as const) {
    const f = tvFixture(type);
    f.input.arrTargets = [];
    f.input.plex = {
      ...f.tvPlex,
      seasonDeletionEpisodes: () => Promise.resolve([]),
      mediaPathPreview: () =>
        Promise.resolve({ paths: [], truncated: false, fileSizes: {}, versionFiles: [] }),
    } as unknown as PlexClient;
    const p = await buildServiceOwnedPlan(f.input);
    equal(p.actions[0].presence, 'current');
    equal(p.actions[0].effectsComplete, true);
    equal(p.actions[0].files, []);
    equal(decisions(p).plex, 'held');
  }
});
Deno.test('stale historical Radarr file ID cannot authorize current torrent deletion', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.input.qbSelected = true;
  f.setJobs([f.job]);
  const original = f.arr.torrentAssociations;
  f.arr.torrentAssociations = async () =>
    (await original()).map((i) => ({ ...i, movieFileId: 99 }));
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).qb, 'kept');
  equal(decisions(p).plex, 'delete_candidate');
});
Deno.test('per-action provenance changes when import lineage changes', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.input.qbSelected = true;
  f.setJobs([f.job]);
  const before = await buildServiceOwnedPlan(f.input);
  const original = f.arr.torrentAssociations;
  f.arr.torrentAssociations = async () => (await original()).map((i) => ({ ...i, historyId: 2 }));
  const after = await buildServiceOwnedPlan(f.input);
  notDeepStrictEqual(
    before.actions.find((a) => a.service === 'qb')?.provenanceFingerprint,
    after.actions.find((a) => a.service === 'qb')?.provenanceFingerprint,
  );
});
Deno.test('current Arr file outside its own record folder is not eligible', async () => {
  const f = fixture();
  f.file.path = '/outside/Movie.mkv';
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).radarr, 'held');
});

Deno.test('known retained QB sidecar vetoes Sonarr native file unit while separate Plex proceeds', async () => {
  for (
    const relativePath of [
      'Show S01E01.en.srt',
      'subs/Different Name S01E01.en.ass',
      'subs/Alternate 1x01.en.srt',
    ]
  ) {
    const f = tvFixture('season');
    f.input.downloadTargets = [f.download];
    Object.assign(f.job, {
      savePath: '/arr',
      contentPath: `/arr/${relativePath}`,
      size: 10,
      manifestFiles: [{ path: relativePath, size: 10 }],
    });
    f.setJobs([f.job]);
    const p = await buildServiceOwnedPlan(f.input);
    equal(decisions(p).sonarr, 'kept');
    equal(decisions(p).plex, 'delete_candidate');
    equal(decisions(p).qb, 'kept');
    equal(
      p.actions.find((a) => a.service === 'sonarr')?.files.some((file) =>
        file.path === `/arr/${relativePath}`
      ),
      true,
    );
  }
});

Deno.test('retained sidecar for a different episode does not veto selected Sonarr file', async () => {
  const f = tvFixture('season');
  f.input.downloadTargets = [f.download];
  Object.assign(f.job, {
    savePath: '/arr',
    contentPath: '/arr/subs/Other S01E02.en.srt',
    size: 10,
    manifestFiles: [{ path: 'subs/Other S01E02.en.srt', size: 10 }],
  });
  f.setJobs([f.job]);
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).sonarr, 'delete_candidate');
  equal(decisions(p).plex, 'delete_candidate');
});

Deno.test('unrelated QB inventory churn neither reads its payload nor changes confirmation fingerprint', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.setJobs([f.job]);
  const original = f.qb.findJob;
  const reads: string[] = [];
  f.qb.findJob = (id) => {
    reads.push(id);
    if (id === 'unrelated') throw new Error('Unrelated payload must not be read');
    return original(id);
  };
  const before = await buildServiceOwnedPlan(f.input);
  const unrelated = {
    ...structuredClone(f.job),
    id: 'unrelated',
    savePath: '/other',
    contentPath: '/other/Other.mkv',
    size: 999,
  };
  f.setJobs([f.job, unrelated]);
  const after = await buildServiceOwnedPlan(f.input);
  equal(before.fingerprint, after.fingerprint);
  equal(reads.every((id) => id === 'hash'), true);
  unrelated.size = 1001;
  unrelated.state = 'downloading';
  equal((await buildServiceOwnedPlan(f.input)).fingerprint, before.fingerprint);
});

Deno.test('relevant QB summary changes still hold deletion', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.setJobs([f.job]);
  let scans = 0;
  const scan = f.qb.scanJobSummaries;
  f.qb.scanJobSummaries = (visit) => {
    scans++;
    return scan((summary) =>
      visit({ ...summary, size: scans === 1 ? summary.size : summary.size + 1 })
    );
  };
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).qb, 'held');
  equal(decisions(p).plex, 'held');
});

Deno.test('ordinary scoped preview does not read the complete Plex library catalog', async () => {
  const f = fixture();
  f.plex.libraries = () => Promise.reject(new Error('Unrelated library scan forbidden'));
  f.plex.libraryFileEntries = async function* () {
    yield await Promise.reject(new Error('Unrelated file scan forbidden'));
  };
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).plex, 'delete_candidate');
  equal(p.confidencePolicy, 'service-owned-reasonable-v1');
});

Deno.test('failed second provenance read never authorizes QB from its first unverified result', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.input.qbSelected = true;
  f.setJobs([f.job]);
  const first = f.arr.torrentAssociations;
  let reads = 0;
  f.arr.torrentAssociations = () =>
    ++reads === 1 ? first() : Promise.reject(new Error('second history read failed'));
  const p = await buildServiceOwnedPlan(f.input);
  equal(
    p.retention.decisions.some((d) => d.service === 'qb' && d.state === 'delete_candidate'),
    false,
  );
  equal(p.actions.some((a) => a.associationUnavailable), true);
  equal(p.retention.decisions.some((d) => d.service === 'qb' && d.state === 'held'), true);
  equal(decisions(p).plex, 'delete_candidate');
  equal(decisions(p).radarr, 'delete_candidate');
});

Deno.test('confirmed zero current QB jobs remains inapplicable despite failed provenance', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.input.qbSelected = true;
  f.arr.torrentAssociations = () => Promise.reject(new Error('history unavailable'));
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).qb, 'not_applicable');
  equal(p.actions.some((a) => a.associationUnavailable), false);
  equal(decisions(p).plex, 'delete_candidate');
  equal(decisions(p).radarr, 'delete_candidate');
});

Deno.test('different retained video version is not mistaken for a linked Sonarr sidecar', async () => {
  const f = tvFixture('season');
  f.input.downloadTargets = [f.download];
  Object.assign(f.job, {
    savePath: '/arr',
    contentPath: '/arr/Show S01E01.4k.mkv',
    size: 200,
    manifestFiles: [{ path: 'Show S01E01.4k.mkv', size: 200 }],
  });
  f.setJobs([f.job]);
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).sonarr, 'delete_candidate');
  equal(
    p.actions.find((a) => a.service === 'sonarr')?.files.some((file) =>
      file.path.endsWith('4k.mkv')
    ),
    false,
  );
});

Deno.test('retained unassociated Radarr extra keeps overlapping Plex but separate file deletion proceeds', async () => {
  const f = fixture();
  f.arr.extraFiles = () =>
    Promise.resolve([{ relativePath: 'Movie.srt', movieFileId: null, type: 'subtitle' }]);
  f.plex.mediaPathPreview = () =>
    Promise.resolve({
      paths: ['/plex/Movie.mkv', '/arr/Movie.srt'],
      truncated: false,
      fileSizes: { '/plex/Movie.mkv': 100, '/arr/Movie.srt': 10 },
      versionFiles: [
        { ratingKey: 'movie', mediaId: 1, path: '/plex/Movie.mkv', size: 100 },
        { ratingKey: 'movie', mediaId: 1, path: '/arr/Movie.srt', size: 10 },
      ],
    });
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).plex, 'kept');
  equal(decisions(p).radarr, 'delete_candidate');
});

Deno.test('failed Radarr extras read remains unavailable rather than an empty effect inventory', async () => {
  const f = fixture();
  f.arr.extraFiles = () => Promise.reject(new Error('extras unavailable'));
  const p = await buildServiceOwnedPlan(f.input);
  equal(decisions(p).radarr, 'held');
});

Deno.test('unmanaged episode version keeps positively identified remaining Sonarr file', async () => {
  for (const scenario of ['matched', 'wrong-size', 'ambiguous', 'failed-owner', 'drift'] as const) {
    const f = tvFixture('episode');
    f.input.selection.mediaId = 2;
    let reads = 0;
    f.tvPlex.mediaPathPreview = () => {
      reads++;
      return Promise.resolve({
        paths: ['/plex/Show S01E01.mkv', '/plex/Show S01E01 1080.mkv'],
        truncated: false,
        fileSizes: { '/plex/Show S01E01.mkv': 100 },
        versionFiles: [
          {
            ratingKey: 'episode',
            mediaId: 1,
            path: '/plex/Show S01E01.mkv',
            size: scenario === 'wrong-size' || scenario === 'drift' && reads > 1 ? 101 : 100,
          },
          { ratingKey: 'episode', mediaId: 2, path: '/plex/Show S01E01 1080.mkv', size: 100 },
          ...(scenario === 'ambiguous'
            ? [{ ratingKey: 'episode', mediaId: 3, path: '/other/Show S01E01.mkv', size: 100 }]
            : []),
        ],
      });
    };
    if (scenario === 'failed-owner') {
      f.tvArr.sonarrEpisodeFileOwnerIds = () => Promise.reject(new Error('offline'));
    }
    const plan = await buildServiceOwnedPlan(f.input);
    if (scenario === 'matched') {
      equal(decisions(plan).sonarr, 'kept');
      equal(decisions(plan).plex, 'delete_candidate');
      equal(plan.actions.find((a) => a.service === 'sonarr')?.retainedOwnership, true);
    } else {
      equal(decisions(plan).sonarr, 'held', scenario);
    }
  }
});

Deno.test('immediate boundary refreshes ownership once without repeating full phase verification', async () => {
  const f = fixture();
  f.input.downloadTargets = [f.download];
  f.setJobs([f.job]);
  let scans = 0;
  const scan = f.qb.scanJobSummaries;
  f.qb.scanJobSummaries = (visit) => {
    scans++;
    return scan(visit);
  };
  const verified = await buildServiceOwnedPlan(f.input);
  f.calls.length = 0;
  scans = 0;
  const boundary = await buildServiceOwnedPlan({ ...f.input, boundaryCheck: true });
  equal(boundary.fingerprint, verified.fingerprint);
  equal(scans, 1);
  equal(f.calls, ['plex.identity', 'plex.files']);
  // A newly observed live job still protects its files at the boundary.
  f.setJobs([{ ...f.job, id: 'new-owner', savePath: '/plex', contentPath: '/plex/Movie.mkv' }]);
  equal(decisions(await buildServiceOwnedPlan({ ...f.input, boundaryCheck: true })).plex, 'kept');
});

Deno.test('delayed show discovery bounds child reads and preserves intended files', async () => {
  const f = fixture();
  const show = { ...f.identity, ratingKey: 'show', type: 'show', tmdbId: null, tvdbId: 123 };
  let active = 0, peak = 0, reads = 0;
  const plex = {
    ...f.plex,
    metadataIdentity: async (key: string) => {
      if (key === 'show') return show;
      reads++;
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return {
        ...show,
        ratingKey: key,
        type: 'episode',
        grandparentRatingKey: 'show',
        seasonIndex: 1,
        index: Number(key),
      };
    },
    mediaPathPreview: () =>
      Promise.resolve({
        truncated: false,
        paths: [],
        versionFiles: Array.from(
          { length: 24 },
          (_, i) => ({
            ratingKey: String(i + 1),
            mediaId: i + 1,
            path: `/plex/Show/${i + 1}.mkv`,
            size: 100,
          }),
        ),
      }),
  };
  const started = performance.now();
  const plan = await buildServiceOwnedPlan({
    ...f.input,
    discovery: true,
    arrTargets: [],
    selection: { ...f.input.selection, ratingKey: 'show', type: 'show', tmdbId: null, tvdbId: 123 },
    plex: plex as unknown as PlexClient,
  });
  console.log(
    `24 children, 20ms/read: ${
      Math.round(performance.now() - started)
    }ms; reads=${reads}; peak=${peak}`,
  );
  equal(reads, 24);
  equal(peak, 4);
  equal(active, 0);
  equal(plan.actions[0].presence, 'current');
  equal(plan.actions[0].files.length, 24);
  equal(
    plan.actions[0].plexParts!.map((p) => p.episode).sort((a, b) => a! - b!),
    Array.from({ length: 24 }, (_, i) => i + 1),
  );
  plex.metadataIdentity = (key) =>
    key === '2' ? Promise.reject(new Error('offline')) : Promise.resolve({
      ...show,
      ratingKey: key,
      type: key === 'show' ? 'show' : 'episode',
      grandparentRatingKey: 'show',
      seasonIndex: 1,
      index: Number(key),
    });
  const failed = await buildServiceOwnedPlan({
    ...f.input,
    discovery: true,
    arrTargets: [],
    selection: plan.selection,
    plex: plex as unknown as PlexClient,
  });
  equal(failed.actions[0].presence, 'unknown');
  equal(failed.actions[0].effectsComplete, false);
});

Deno.test('discovery reuses the route owner identity but execution reads it fresh', async () => {
  for (const type of ['season', 'episode'] as const) {
    const f = tvFixture(type);
    const owner = await f.tvPlex.metadataIdentity('show');
    const readIdentity = f.tvPlex.metadataIdentity;
    let ownerReads = 0;
    f.tvPlex.metadataIdentity = (key) => {
      if (key === 'show') ownerReads++;
      return readIdentity(key);
    };
    const input = { ...f.input, discoveredOwner: owner };
    const discovery = await buildServiceOwnedPlan({ ...input, discovery: true });
    equal(ownerReads, 0);
    equal(discovery.actions[0].presence, 'current');
    equal(discovery.actions.find((a) => a.service === 'sonarr')!.fileId, 5);
    const verified = await buildServiceOwnedPlan(input);
    equal(ownerReads > 0, true);
    equal(verified.actions[0].presence, 'current');
    const wrongOwner = await buildServiceOwnedPlan({
      ...input,
      discovery: true,
      discoveredOwner: { ...owner, ratingKey: 'different-show' },
    });
    equal(wrongOwner.actions[0].presence, 'unknown');
  }
});

Deno.test('live leaf discovery avoids per-episode HTTP reads while worker verification remains fresh', async () => {
  const f = fixture();
  const show = {
    ratingKey: 'show',
    title: 'Show',
    type: 'show',
    librarySectionID: '1',
    Guid: [{ id: 'tvdb://123' }],
  };
  const leaves = Array.from({ length: 24 }, (_, i) => ({
    ratingKey: String(i + 1),
    title: `Episode ${i + 1}`,
    type: 'episode',
    librarySectionID: '1',
    grandparentRatingKey: 'show',
    parentIndex: 1,
    index: i + 1,
    Media: [{ id: i + 1, Part: [{ file: `/plex/Show/${i + 1}.mkv`, size: 100 }] }],
  }));
  const requests: string[] = [];
  let delay = 20;
  let moved = false;
  let incompleteLeaf = false;
  const plex = new PlexClient(
    'http://fixture.invalid',
    'fixture-token',
    undefined,
    (async (input) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (path.endsWith('/allLeaves')) {
        return Response.json({
          MediaContainer: {
            totalSize: leaves.length,
            Metadata: leaves.map((leaf, index) =>
              incompleteLeaf && index === 0 ? { ...leaf, librarySectionID: undefined } : leaf
            ),
          },
        });
      }
      const key = path.split('/').at(-1);
      const item = key === 'show' ? show : leaves.find((leaf) => leaf.ratingKey === key);
      return Response.json({
        MediaContainer: {
          Metadata: item
            ? [{ ...item, ...(moved && key !== 'show' ? { grandparentRatingKey: 'other' } : {}) }]
            : [],
        },
      });
    }) as typeof fetch,
  );
  const input: ServiceOwnedPlanningInput = {
    ...f.input,
    plex,
    arrTargets: [],
    selection: { ratingKey: 'show', title: 'Show', type: 'show', tmdbId: null, tvdbId: 123 },
  };
  const started = performance.now();
  const discovery = await buildServiceOwnedPlan({ ...input, discovery: true });
  console.log(
    `live leaf discovery: ${
      Math.round(performance.now() - started)
    }ms; HTTP reads=${requests.length}`,
  );
  equal(requests.length, 2);
  equal(discovery.actions[0].presence, 'current');
  equal(discovery.actions[0].files.length, 24);
  equal(
    discovery.actions[0].plexParts!.map((p) => p.episode).sort((a, b) => a! - b!),
    Array.from({ length: 24 }, (_, i) => i + 1),
  );
  delay = 0;
  incompleteLeaf = true;
  requests.length = 0;
  const fallback = await buildServiceOwnedPlan({ ...input, discovery: true });
  equal(requests.length, 3);
  equal(fallback.actions[0].plexParts, discovery.actions[0].plexParts);
  incompleteLeaf = false;
  requests.length = 0;
  const verified = await buildServiceOwnedPlan(input);
  equal(verified.actions[0].plexParts, discovery.actions[0].plexParts);
  equal(requests.filter((path) => /^\/library\/metadata\/\d+$/.test(path)).length, 24);
  moved = true;
  equal((await buildServiceOwnedPlan(input)).actions[0].presence, 'unknown');
  moved = false;
  leaves[0].grandparentRatingKey = 'other';
  equal(
    (await buildServiceOwnedPlan({ ...input, discovery: true })).actions[0].presence,
    'unknown',
  );
  leaves[0].grandparentRatingKey = 'show';
  leaves[0].librarySectionID = 'other';
  equal(
    (await buildServiceOwnedPlan({ ...input, discovery: true })).actions[0].presence,
    'unknown',
  );
});
