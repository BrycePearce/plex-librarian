import { docker, localPath, project, qb, runtime, sonarr } from './native-fixture-services.ts';
try {
  await Deno.stat(new URL('sonarr-qb-provisioning.json', runtime));
  throw new Error('Fixture provisioning already completed; preserve subsequent acceptance state');
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
const groups: { name: string; files: string[]; hash: string; length: number }[] = JSON.parse(
  await Deno.readTextFile(new URL('generated/manifest.json', runtime)),
);
const jobs = await (await qb('torrents/info')).json();
if (
  jobs.some((job: { hash: string; save_path: string }) =>
    !groups.some((group) => group.hash === job.hash) ||
    job.save_path.replace(/\/$/, '') !== '/downloads-root/payloads'
  )
) {
  throw new Error('QB contains unexpected jobs');
}
const series = await sonarr('series');
if (
  series.some((s: { title: string; path: string }) =>
    s.title !== 'Doug' || s.path !== '/arr-vault/tv/Doug (1991)'
  )
) {
  throw new Error('Sonarr contains unexpected series');
}
if ((await sonarr('indexer')).length || (await sonarr('downloadclient')).length) {
  throw new Error('Expected Sonarr without acquisition services');
}
await docker([
  'cp',
  localPath(new URL('generated/payloads/', runtime)) + '.',
  `${project}-sonarr-1:/arr-vault/payloads/`,
]);
await docker(['exec', `${project}-sonarr-1`, 'chown', '-R', '1000:1000', '/arr-vault/payloads']);
for (const group of groups) {
  if (jobs.some((job: { hash: string }) => job.hash === group.hash)) continue;
  const form = new FormData();
  form.set(
    'torrents',
    new Blob([await Deno.readFile(new URL(`generated/torrents/${group.name}.torrent`, runtime))]),
    `${group.name}.torrent`,
  );
  form.set('savepath', '/downloads-root/payloads');
  form.set('stopped', 'true');
  form.set('paused', 'true');
  form.set('autoTMM', 'false');
  form.set('skip_checking', 'false');
  form.set('contentLayout', 'Original');
  await qb('torrents/add', form);
}
const roots = await sonarr('rootfolder');
if (roots.some((root: { path: string }) => root.path !== '/arr-vault/tv')) {
  throw new Error('Unexpected Sonarr root');
}
if (!roots.length) await sonarr('rootfolder', { path: '/arr-vault/tv' });
let show = series[0];
if (!show) {
  const matches = (await sonarr('series/lookup?term=Doug')).filter((
    s: { title: string; year: number },
  ) => s.title === 'Doug' && s.year === 1991);
  if (matches.length !== 1) throw new Error('Expected unique native Doug1991 lookup');
  show = await sonarr('series', {
    ...matches[0],
    path: '/arr-vault/tv/Doug (1991)',
    rootFolderPath: '/arr-vault/tv',
    qualityProfileId: (await sonarr('qualityprofile'))[0].id,
    monitored: false,
    seasonFolder: true,
    addOptions: { searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false },
  });
}
await docker(['exec', `${project}-sonarr-1`, 'mkdir', '-p', '/arr-vault/tv/Doug (1991)']);
await docker(['exec', `${project}-sonarr-1`, 'chown', '1000:1000', '/arr-vault/tv/Doug (1991)']);
let episodes: { id: number; seasonNumber: number; episodeNumber: number }[] = [];
for (let i = 0; i < 60; i++) {
  episodes = await sonarr(`episode?seriesId=${show.id}`);
  if (
    [1, 2, 3].every((season) =>
      [1, 2].every((episode) =>
        episodes.some((e) => e.seasonNumber === season && e.episodeNumber === episode)
      )
    )
  ) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
for (const group of groups.filter((group) => group.name.startsWith('Doug.'))) {
  const existing = await sonarr(`episodefile?seriesId=${show.id}`);
  const season = Number(/S(\d+)/.exec(group.name)![1]);
  if (
    existing.filter((file: { seasonNumber: number }) => file.seasonNumber === season).length === 2
  ) continue;
  const candidates = await sonarr(
    `manualimport?folder=${
      encodeURIComponent(`/arr-vault/payloads/${group.name}`)
    }&filterExistingFiles=true`,
  );
  if (candidates.length !== 2) throw new Error('Expected exactly two native import candidates');
  const files = candidates.map(
    (
      candidate: {
        path: string;
        quality: unknown;
        languages: unknown;
        releaseGroup: string;
        indexerFlags: unknown;
        releaseType: unknown;
        rejections: unknown[];
      },
    ) => {
      const number = Number(/E(\d+)/.exec(candidate.path)![1]);
      const owners = episodes.filter((e) =>
        e.seasonNumber === season && e.episodeNumber === number
      );
      if (
        owners.length !== 1 || !group.files.includes(candidate.path.split('/').at(-1)!)
      ) throw new Error('Unexpected native episode owner');
      return {
        path: candidate.path,
        downloadId: group.hash,
        seriesId: show.id,
        seasonNumber: season,
        episodeIds: owners.map((e) => e.id),
        quality: candidate.quality,
        languages: candidate.languages,
        releaseGroup: candidate.releaseGroup,
        indexerFlags: candidate.indexerFlags,
        releaseType: candidate.releaseType,
      };
    },
  );
  const command = await sonarr('command', { name: 'ManualImport', importMode: 'copy', files });
  for (let i = 0; i < 60; i++) {
    const state = await sonarr(`command/${command.id}`);
    if (state.status === 'failed') throw new Error('Native ManualImport failed');
    if (state.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
const files = await sonarr(`episodefile?seriesId=${show.id}`);
const history = await sonarr(`history/series?seriesId=${show.id}`);
const evidence = {
  seriesId: show.id,
  tvdbId: show.tvdbId,
  files,
  history,
  jobs: await (await qb('torrents/info')).json(),
};
await Deno.writeTextFile(
  new URL('sonarr-qb-provisioning.json', runtime),
  JSON.stringify(evidence, null, 2),
);
console.log(
  JSON.stringify({
    seriesId: show.id,
    tvdbId: show.tvdbId,
    fileCount: files.length,
    historyCount: history.length,
    jobCount: evidence.jobs.length,
  }),
);
