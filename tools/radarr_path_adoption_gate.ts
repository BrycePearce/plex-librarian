/**
 * Disposable Phase 0 feasibility gate for Radarr retained-path adoption.
 *
 * This intentionally operates on an already-prepared real Radarr movie. Both
 * files must be disposable test media. The script leaves Movie.Path pointed at
 * the target folder and never deletes either file.
 */

const required = (name: string): string => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const baseUrl = required('RADARR_URL').replace(/\/+$/, '') + '/api/v3';
const apiKey = required('RADARR_API_KEY');
const movieId = Number(required('RADARR_MOVIE_ID'));
const originalMoviePath = required('RADARR_ORIGINAL_MOVIE_PATH');
const targetMoviePath = required('RADARR_TARGET_MOVIE_PATH');
const originalLocalFile = required('RADARR_ORIGINAL_LOCAL_FILE');
const targetLocalFile = required('RADARR_TARGET_LOCAL_FILE');

if (!Number.isSafeInteger(movieId) || movieId <= 0) {
  throw new Error('RADARR_MOVIE_ID must be a positive integer');
}

const headers = { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' };
const MINIMUM_RADARR_VERSION = '6.3.0.10514';
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_CATALOG_RECORDS = 50_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  if (!response.ok) {
    throw new Error(`Radarr ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

async function boundedJson<T>(path: string, maxBytes: number): Promise<{
  value: T;
  bytes: number;
  elapsedMs: number;
}> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`Radarr ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(`Radarr ${path} exceeds the ${maxBytes}-byte feasibility limit`);
  }
  if (!response.body) throw new Error(`Radarr ${path} returned no body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Radarr ${path} exceeded the ${maxBytes}-byte feasibility limit`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    value: JSON.parse(new TextDecoder().decode(body)) as T,
    bytes,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

function compareVersions(left: string, right: string): number | null {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 4; index++) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

interface MovieResource extends Record<string, unknown> {
  id: number;
  tmdbId: number;
  path: string;
  monitored: boolean;
}

interface MovieFile {
  id: number;
  movieId: number;
  path: string;
  relativePath: string;
  size: number;
}

interface Command {
  id: number;
  status: string;
  message?: string;
}

const snapshot = async (path: string) => {
  const stat = await Deno.stat(path);
  if (!stat.isFile || stat.size <= 0) throw new Error(`${path} is not a positive-size file`);
  return { path, size: stat.size, mtime: stat.mtime?.getTime() ?? null };
};

const normalized = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '');
const basename = (path: string) => normalized(path).split('/').at(-1)?.toLowerCase();

async function waitForCommand(id: number): Promise<Command> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const command = await request<Command>(`/command/${id}`);
    if (['completed', 'failed', 'aborted'].includes(command.status)) return command;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Radarr command ${id} did not finish within 120 seconds`);
}

const [status, catalogMeasurement, movie, oldFiles, originalBefore, targetBefore] = await Promise
  .all([
    request<{ version: string }>('/system/status'),
    boundedJson<unknown[]>('/movie', MAX_CATALOG_BYTES),
    request<MovieResource>(`/movie/${movieId}`),
    request<MovieFile[]>(`/moviefile?movieId=${movieId}`),
    snapshot(originalLocalFile),
    snapshot(targetLocalFile),
  ]);

if (compareVersions(status.version, MINIMUM_RADARR_VERSION) === null) {
  throw new Error(`Radarr returned an unverifiable version: ${status.version}`);
}
if (compareVersions(status.version, MINIMUM_RADARR_VERSION)! < 0) {
  throw new Error(
    `Radarr ${status.version} is older than the path-adoption minimum ${MINIMUM_RADARR_VERSION}`,
  );
}
if (!Array.isArray(catalogMeasurement.value)) {
  throw new Error('Radarr returned a malformed movie catalog');
}
if (catalogMeasurement.value.length > MAX_CATALOG_RECORDS) {
  throw new Error(`Radarr movie catalog exceeds the ${MAX_CATALOG_RECORDS}-record limit`);
}
for (const entry of catalogMeasurement.value) {
  if (
    !entry || typeof entry !== 'object' || Array.isArray(entry) ||
    !Number.isSafeInteger((entry as { id?: number }).id) ||
    typeof (entry as { path?: string }).path !== 'string'
  ) throw new Error('Radarr returned a malformed movie catalog record');
}

if (normalized(movie.path) !== normalized(originalMoviePath)) {
  throw new Error(`Movie.Path is ${movie.path}, expected ${originalMoviePath}`);
}
if (oldFiles.length !== 1 || oldFiles[0]!.movieId !== movieId || oldFiles[0]!.id <= 0) {
  throw new Error('Radarr must expose exactly one original managed movie-file record');
}
if (basename(oldFiles[0]!.relativePath) === basename(targetLocalFile)) {
  throw new Error('The original and retained relative filenames must differ');
}

const originalMonitored = movie.monitored;
const update = { ...movie, path: targetMoviePath, monitored: false };
await request<MovieResource>(`/movie/${movieId}?moveFiles=false`, {
  method: 'PUT',
  body: JSON.stringify(update),
});
const readBack = await request<MovieResource>(`/movie/${movieId}`);
if (normalized(readBack.path) !== normalized(targetMoviePath) || readBack.monitored !== false) {
  throw new Error('Radarr movie path/monitoring read-back did not converge');
}

const issued = await request<Command>('/command', {
  method: 'POST',
  body: JSON.stringify({ name: 'RescanMovie', movieId }),
});
const completed = await waitForCommand(issued.id);
if (completed.status !== 'completed') {
  throw new Error(`RescanMovie ${completed.status}: ${completed.message ?? 'no detail'}`);
}

const [adoptedFiles, originalAfter, targetAfter] = await Promise.all([
  request<MovieFile[]>(`/moviefile?movieId=${movieId}`),
  snapshot(originalLocalFile),
  snapshot(targetLocalFile),
]);
if (adoptedFiles.length !== 1) throw new Error('Radarr did not expose exactly one adopted file');
const adopted = adoptedFiles[0]!;
if (
  adopted.id === oldFiles[0]!.id || adopted.movieId !== movieId ||
  normalized(adopted.path) !== normalized(targetMoviePath + '/' + adopted.relativePath) ||
  adopted.size !== targetAfter.size
) {
  throw new Error('Radarr did not adopt a new exact retained-path and size record');
}
if (
  JSON.stringify(originalAfter) !== JSON.stringify(originalBefore) ||
  JSON.stringify(targetAfter) !== JSON.stringify(targetBefore)
) {
  throw new Error('A physical fixture path, size, or mtime changed during adoption');
}

console.log(JSON.stringify(
  {
    passed: true,
    radarrVersion: status.version,
    movieId,
    originalMonitored,
    originalMovieFile: oldFiles[0],
    adoptedMovieFile: adopted,
    commandId: issued.id,
    physicalFilesUnchanged: true,
    requestedMoveFiles: false,
    catalogMeasurement: {
      records: catalogMeasurement.value.length,
      bytes: catalogMeasurement.bytes,
      elapsedMs: catalogMeasurement.elapsedMs,
      maximumRecords: MAX_CATALOG_RECORDS,
      maximumBytes: MAX_CATALOG_BYTES,
    },
  },
  null,
  2,
));
