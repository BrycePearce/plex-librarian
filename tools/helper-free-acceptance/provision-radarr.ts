/** Copy-imports generated media only into the named disposable Radarr fixture. */
const project = 'librarian-helper-free-acceptance';
const runtime = new URL('./.runtime/', import.meta.url);
const inspected = await new Deno.Command('docker', {
  args: ['--context', 'desktop-linux', 'inspect', `${project}-radarr-1`],
  stdout: 'piped',
  stderr: 'piped',
}).output();
if (!inspected.success) throw new Error('Disposable Radarr unavailable');
const [container] = JSON.parse(new TextDecoder().decode(inspected.stdout));
if (
  container.Config.Labels['com.docker.compose.project'] !== project ||
  container.Config.Labels['com.docker.compose.service'] !== 'radarr' ||
  !container.Mounts.some((m: { Name: string }) => m.Name === `${project}_fixture-media`)
) throw new Error('Disposable container/volume ownership mismatch');
const credentials = JSON.parse(await Deno.readTextFile(new URL('credentials.json', runtime)));
async function api(path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:17878/api/v3/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Api-Key': credentials.radarrApiKey, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`Disposable Radarr ${path.split('?')[0]} HTTP ${response.status}`);
  }
  return await response.json();
}
const root = '/movie-vault/movies';
const roots = await api('rootfolder');
if (!roots.some((r: { path: string }) => r.path === root)) await api('rootfolder', { path: root });
const movies = await api('movie');
let movie = movies.find((m: { tmdbId: number }) => m.tmdbId === 603);
if (!movie) {
  const metadata = await api('movie/lookup/tmdb?tmdbId=603');
  movie = await api('movie', {
    ...metadata,
    qualityProfileId: 1,
    rootFolderPath: root,
    monitored: false,
    minimumAvailability: 'released',
    addOptions: { searchForMovie: false },
  });
}
let files = await api(`moviefile?movieId=${movie.id}`);
if (!files.length) {
  const name = 'The.Matrix.1999.720p.WEB-DL.ACCEPTANCE';
  const folder = `/movie-vault/payloads/${name}`;
  // movieId on this GET selects the library folder instead of the supplied folder.
  const entries = await api(
    `manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=false`,
  );
  if (entries.length !== 1 || entries[0].movie?.id !== movie.id) {
    throw new Error('Synthetic movie import did not resolve exactly one expected file');
  }
  const entry = entries[0];
  const command = await api('command', {
    name: 'ManualImport',
    importMode: 'copy',
    files: [{
      path: entry.path,
      folderName: name,
      movieId: movie.id,
      quality: entry.quality,
      languages: entry.languages,
      downloadId: '322d5d5b0d3916668f890ed552117f79015e7164',
      indexerFlags: 0,
      releaseType: 'unknown',
    }],
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await api(`command/${command.id}`);
    if (current.status === 'completed') break;
    if (current.status === 'failed') throw new Error('Synthetic movie import failed');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  files = await api(`moviefile?movieId=${movie.id}`);
}
if (files.length !== 1) throw new Error('Expected exactly one imported synthetic movie file');
const history = await api(`history/movie?movieId=${movie.id}`);
await Deno.writeTextFile(
  new URL('radarr-provision-result.json', runtime),
  JSON.stringify(
    {
      movieId: movie.id,
      files,
      history,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ movieId: movie.id, fileId: files[0].id, path: files[0].path }));
