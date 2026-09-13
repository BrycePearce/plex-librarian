import { makeTorrent } from './generate-fixtures.ts';
import {
  credentials,
  docker,
  localPath,
  project,
  qb,
  runtime,
  sonarr,
} from './native-fixture-services.ts';
const season = Number(Deno.args[0] ?? 4);
if (Deno.args.length > 1 || ![4, 5].includes(season)) {
  throw new Error('Only fixture season 4 or 5 is supported');
}
const name = `Doug.S0${season}.720p.WEB-DL.ACCEPTANCE`;
const show = (await sonarr('series')).find((s: { tvdbId: number; path: string }) =>
  s.tvdbId === 72210 && s.path === '/arr-vault/tv/Doug (1991)'
);
if (!show) throw new Error('Expected disposable Doug series');
const current = await sonarr(`episodefile?seriesId=${show.id}`);
if (current.some((file: { seasonNumber: number }) => file.seasonNumber === season)) {
  throw new Error('Fixture season already imported; preserve native evidence');
}
const bytes = await Deno.readFile(new URL('generated/synthetic.mkv', runtime));
const files = [1, 2].map((episode) => ({
  name: `Doug.S0${season}E0${episode}.720p.WEB-DL.ACCEPTANCE.mkv`,
  bytes,
}));
const torrent = await makeTorrent(name, files);
const source = new URL(`generated/${name}/`, runtime);
await Deno.mkdir(source, { recursive: true });
for (const file of files) await Deno.writeFile(new URL(file.name, source), bytes);
await docker(['exec', `${project}-sonarr-1`, 'mkdir', '-p', `/arr-vault/payloads/${name}`]);
await docker(['cp', localPath(source) + '.', `${project}-sonarr-1:/arr-vault/payloads/${name}/`]);
await docker([
  'exec',
  `${project}-sonarr-1`,
  'chown',
  '-R',
  '1000:1000',
  `/arr-vault/payloads/${name}`,
]);
const existingJobs = await (await qb('torrents/info')).json();
if (!existingJobs.some((job: { hash: string }) => job.hash === torrent.hash)) {
  const form = new FormData();
  form.set('torrents', new Blob([new Uint8Array(torrent.bytes)]), `${name}.torrent`);
  form.set('savepath', '/downloads-root/payloads');
  form.set('stopped', 'true');
  form.set('paused', 'true');
  form.set('skip_checking', 'false');
  form.set('autoTMM', 'false');
  form.set('contentLayout', 'Original');
  await qb('torrents/add', form);
}
await qb('torrents/recheck', new URLSearchParams({ hashes: torrent.hash }));
let ready = false;
for (let i = 0; i < 60; i++) {
  const [job] = await (await qb(`torrents/info?hashes=${torrent.hash}`)).json();
  if (job?.progress === 1 && ['stoppedUP', 'pausedUP'].includes(job.state)) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready) throw new Error('Native QB fixture has not completed recheck while stopped');
const category = 'acceptance-sonarr';
const categories = await (await qb('torrents/categories')).json();
if (!(category in categories)) {
  await qb('torrents/createCategory', new URLSearchParams({ category, savePath: '' }));
}
await qb('torrents/setCategory', new URLSearchParams({ hashes: torrent.hash, category }));
const clients = await sonarr('downloadclient');
if (clients.some((client: { name: string }) => client.name !== 'Acceptance QB')) {
  throw new Error('Unexpected downloadclient');
}
if (!clients.length) {
  const schema = (await sonarr('downloadclient/schema')).find((s: { implementation: string }) =>
    s.implementation === 'QBittorrent'
  );
  const values: Record<string, unknown> = {
    host: 'qb',
    port: 8080,
    username: 'acceptance',
    password: credentials.qbPassword,
    tvCategory: category,
    initialState: 1,
  };
  await sonarr('downloadclient', {
    ...schema,
    name: 'Acceptance QB',
    enable: true,
    priority: 1,
    removeCompletedDownloads: false,
    removeFailedDownloads: false,
    fields: schema.fields.map((field: { name: string }) => ({
      ...field,
      ...(field.name in values ? { value: values[field.name] } : {}),
    })),
  });
}
const mappings = await sonarr('remotepathmapping');
if (
  !mappings.some((m: { host: string; remotePath: string; localPath: string }) =>
    m.host === 'qb' && m.remotePath === '/downloads-root/' && m.localPath === '/arr-vault/'
  )
) {
  await sonarr('remotepathmapping', {
    host: 'qb',
    remotePath: '/downloads-root/',
    localPath: '/arr-vault/',
  });
}
const check = await sonarr('command', { name: 'CheckForFinishedDownload' });
for (let i = 0; i < 60; i++) {
  const status = await sonarr(`command/${check.id}`);
  if (status.status === 'failed') throw new Error('Native completed-download check failed');
  if (status.status === 'completed') break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const tracked = (await sonarr('queue/details')).filter((q: { downloadId?: string }) =>
  q.downloadId?.toLowerCase() === torrent.hash
);
if (!tracked.length) throw new Error('Native Sonarr has not tracked the exact fixture torrent');
// These generated 60-second videos intentionally trigger Sample. Exercise the native
// manual-import override on the real tracked download, never manufacture history.
const candidates = await sonarr(
  `manualimport?folder=${
    encodeURIComponent(`/arr-vault/payloads/${name}`)
  }&filterExistingFiles=true`,
);
if (candidates.length !== 2) throw new Error('Expected two native tracked fixture candidates');
const episodes = await sonarr(`episode?seriesId=${show.id}`);
const importedFiles = candidates.map((candidate: {
  path: string;
  quality: unknown;
  languages: unknown;
  releaseGroup: unknown;
  indexerFlags: unknown;
  releaseType: unknown;
}) => {
  if (!files.some((file) => candidate.path === `/arr-vault/payloads/${name}/${file.name}`)) {
    throw new Error('Unexpected fixture import path');
  }
  const number = Number(/E(\d+)/.exec(candidate.path)![1]);
  const owners = episodes.filter((e: { seasonNumber: number; episodeNumber: number }) =>
    e.seasonNumber === season && e.episodeNumber === number
  );
  if (owners.length !== 1) throw new Error('Expected unique native fixture episode');
  return {
    path: candidate.path,
    downloadId: torrent.hash.toUpperCase(),
    seriesId: show.id,
    seasonNumber: season,
    episodeIds: [owners[0].id],
    quality: candidate.quality,
    languages: candidate.languages,
    releaseGroup: candidate.releaseGroup,
    indexerFlags: candidate.indexerFlags,
    releaseType: candidate.releaseType,
  };
});
await sonarr('command', { name: 'ManualImport', importMode: 'copy', files: importedFiles });
let imported: unknown[] = [];
for (let i = 0; i < 60; i++) {
  imported = (await sonarr(`episodefile?seriesId=${show.id}`)).filter((
    file: { seasonNumber: number },
  ) => file.seasonNumber === season);
  if (imported.length === 2) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const history = await sonarr(`history/series?seriesId=${show.id}`);
const nativeHistory = history.filter((h: { downloadId?: string }) =>
  h.downloadId?.toLowerCase() === torrent.hash
);
if (imported.length !== 2 || nativeHistory.length !== 2) {
  throw new Error('Native tracked import did not establish two owned files and hash history');
}
await Deno.writeTextFile(
  new URL(
    season === 4 ? 'tracked-season-provisioning.json' : 'tracked-season-5-provisioning.json',
    runtime,
  ),
  JSON.stringify(
    {
      hash: torrent.hash,
      files: imported,
      history: nativeHistory,
      queue: await sonarr('queue/details'),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    hash: torrent.hash,
    fileCount: imported.length,
    nativeHashHistoryCount: nativeHistory.length,
  }),
);
