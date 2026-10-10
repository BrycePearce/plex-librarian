/** Reproducible synthetic sync comparison. No real services or production DB writes. */
import { resolve } from '@std/path';
import type { PlexClient, PlexRawMetadata } from '../../integrations/plex/index.ts';
const dir = await Deno.makeTempDir({ prefix: 'missing-content-benchmark-' });
const dbPath = resolve(dir, 'benchmark.db');
Deno.env.set('DB_PATH', dbPath);
Deno.env.delete('PLEX_URL');
Deno.env.delete('PLEX_TOKEN');
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(dbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { withMissingAudit } = await import('./audit.ts');
const { runLibrarySync } = await import('../sync/service.ts');
const scale = Math.max(1, Number(Deno.args[0] || 1));
const totalPlex = 2775 * scale;
const totalRadarr = 2899 * scale;
const managed = 2636 * scale;
withTransaction((db) =>
  db.exec(`
  INSERT INTO servers(id,machine_identifier,name,url,access_token,last_connected_at) VALUES(1,'fixture','Fixture','http://plex.invalid','fixture',1);
  INSERT INTO settings(id,client_id,active_server_id) VALUES(1,'benchmark',1) ON CONFLICT(id) DO UPDATE SET active_server_id=1;
  INSERT INTO libraries(server_id,key,title,type,synced_at) VALUES(1,'1','Movies','movie',1);
  INSERT INTO arr_instances(id,server_id,type,name,url,api_key,created_at,updated_at) VALUES(1,1,'radarr','Radarr','http://radarr.invalid','fixture',1,1);
  INSERT INTO arr_library_mappings(server_id,library_key,arr_instance_id) VALUES(1,'1',1);
  INSERT INTO arr_path_mappings(arr_instance_id,kind,arr_path,local_path) VALUES(1,'library','/arr','/store');
  INSERT INTO plex_path_mappings(server_id,library_key,plex_path,local_path,validation_plex_path,validation_local_path,validation_size,validated_at,created_at,updated_at) VALUES(1,'1','/plex','/store','/plex/a','/store/a',1,1,1,1);
  INSERT INTO sync_log(id,server_id,started_at,status,items_processed) VALUES(1,1,1,'pending',0);
`)
);
let plexPages = 0, radarrCalls = 0, responseBytes = 0;
function raw(i: number): PlexRawMetadata {
  return {
    ratingKey: String(i),
    type: 'movie',
    title: `Fixture movie ${i}`,
    year: 2000,
    Guid: i <= 13 ? [] : [{ id: `tmdb://${i <= 39 ? i + 1000000 : i}` }],
    Media: [{
      id: i,
      Part: [{ file: `/plex/${i > 39 && i <= 47 ? 'alternate-' : ''}${i}.mkv`, size: 1000000000 }],
    }],
  };
}
const plex = {
  identity: () => Promise.resolve('fixture'),
  async *libraryItems() {
    for (let offset = 0; offset < totalPlex; offset += 300) {
      plexPages++;
      const page = Array.from(
        { length: Math.min(300, totalPlex - offset) },
        (_, n) => raw(offset + n + 1),
      );
      yield {
        auditMetadata: page,
        items: page.map((p) => ({
          ratingKey: p.ratingKey,
          title: p.title,
          type: 'movie',
          thumb: null,
          addedAt: 100,
          lastViewedAt: null,
          viewCount: 0,
          fileSize: 1000000,
          duration: 120000,
          year: 2000,
          tmdbId: Number(p.Guid?.[0]?.id?.split('://')[1]) || null,
          tvdbId: null,
        })),
        mediaVersions: page.map((p) => ({
          mediaId: Number(p.ratingKey),
          itemRatingKey: p.ratingKey,
          videoResolution: '1080',
          width: 1920,
          height: 1080,
          duration: 120000,
          bitrate: 8000,
          videoCodec: 'h264',
          videoProfile: null,
          videoBitDepth: 8,
          videoDynamicRange: null,
          videoFrameRate: null,
          videoScanType: null,
          container: 'mkv',
          audioCodec: 'aac',
          audioChannels: 2,
          audioProfile: null,
          audioStreams: [],
          subtitleStreams: [],
          streamDetailsAvailable: false,
          fileSize: 1000000,
        })),
      };
    }
  },
  async *libraryHistory() {
    yield [];
  },
} as unknown as PlexClient;
const fetcher = ((input: RequestInfo | URL) => {
  radarrCalls++;
  if (String(input).includes('/queue')) {
    return Promise.resolve(Response.json({ totalRecords: 0, records: [] }));
  }
  let i = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i === totalRadarr) {
        c.close();
        return;
      }
      let chunk = i === 0 ? '[' : '';
      for (let count = 0; count < 10 && i < totalRadarr; count++) {
        ++i;
        chunk += (i > 1 ? ',' : '') + JSON.stringify({
          id: i,
          title: `Fixture movie ${i}`,
          year: 2000,
          titleSlug: `movie-${i}`,
          tmdbId: i,
          hasFile: i <= managed,
          movieFileId: i,
          movieFile: {
            id: i,
            movieId: i,
            path: `/arr/${i}.mkv`,
            dateAdded: '2020-01-01T00:00:00Z',
          },
          overview: 'A realistic metadata description. '.repeat(170),
          images: [{ coverType: 'poster', remoteUrl: 'http://fixture.invalid/poster.jpg' }],
          ratings: { tmdb: { votes: 12000, value: 7.5 } },
          alternateTitles: [{ title: `Alternative ${i}`, sourceType: 'tmdb' }],
        });
      }
      if (i === totalRadarr) chunk += ']';
      const bytes = encoder.encode(chunk);
      responseBytes += bytes.length;
      c.enqueue(bytes);
    },
  });
  return Promise.resolve(new Response(body));
}) as typeof fetch;
const { default: findingRouter } = await import('./route.ts');
// A separate worker schedules HTTP requests while native SQLite work blocks this thread.
const probeServer = Deno.serve(
  { hostname: '127.0.0.1', port: 0, onListen() {} },
  (request) =>
    new URL(request.url).pathname === '/health'
      ? Response.json({ ok: true })
      : findingRouter.fetch(request),
);
const probeSource = `
let running = false;
onmessage = async ({ data }) => {
  if (data.stop) { running = false; return; }
  running = true;
  const health = [], findings = [];
  let errors = 0;
  postMessage({ ready: true });
  while (running) {
    await Promise.all([['/health', health], ['/?library=1', findings]].map(async ([path, samples]) => {
      const start = performance.now();
      try {
        const response = await fetch(data.url + path);
        await response.arrayBuffer();
        if (!response.ok) errors++;
      } catch { errors++; }
      samples.push(performance.now() - start);
    }));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const stats = values => {
    values.sort((a,b) => a-b);
    return { samples: values.length, p95Ms: values[Math.floor((values.length-1)*.95)], maxMs: values.at(-1) };
  };
  postMessage({ health: stats(health), findings: stats(findings), errors });
};`;
const results = [];
for (const enabled of [false, true, false, true, false, true]) {
  plexPages = 0;
  radarrCalls = 0;
  responseBytes = 0;
  const worker = new Worker(`data:application/javascript,${encodeURIComponent(probeSource)}`, {
    type: 'module',
  });
  await new Promise<void>((resolve, reject) => {
    worker.onmessage = () => resolve();
    worker.onerror = reject;
    worker.postMessage({ url: `http://127.0.0.1:${probeServer.addr.port}` });
  });
  const startMemory = Deno.memoryUsage();
  let peak = startMemory;
  const gaps: number[] = [];
  let lastTick = performance.now();
  const timer = setInterval(() => {
    const tick = performance.now();
    gaps.push(tick - lastTick);
    lastTick = tick;
    const m = Deno.memoryUsage();
    peak = { ...m, heapUsed: Math.max(m.heapUsed, peak.heapUsed), rss: Math.max(m.rss, peak.rss) };
  }, 5);
  const start = performance.now();
  try {
    if (enabled) {
      await withMissingAudit(
        plex,
        1,
        1,
        '1',
        new AbortController().signal,
        (sink) => runLibrarySync(plex, 1, '1', undefined, sink),
        fetcher,
      );
    } else await runLibrarySync(plex, 1, '1');
  } finally {
    gaps.push(performance.now() - lastTick);
    clearInterval(timer);
  }
  const elapsedMs = performance.now() - start;
  gaps.sort((a, b) => a - b);
  const http = await new Promise<unknown>((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = reject;
    worker.postMessage({ stop: true });
  });
  worker.terminate();
  results.push({
    enabled,
    elapsedMs,
    http,
    heartbeatGapP95Ms: gaps[Math.floor((gaps.length - 1) * .95)],
    heartbeatGapMaxMs: gaps[gaps.length - 1],
    plexPages,
    radarrCalls,
    responseBytes,
    startHeapMiB: startMemory.heapUsed / 1048576,
    peakHeapMiB: peak.heapUsed / 1048576,
    peakRssMiB: peak.rss / 1048576,
  });
}
await probeServer.shutdown();
const counts = withTransaction((db) => {
  const s = db.prepare(
    'SELECT type,count(*) count FROM missing_findings WHERE resolved_at IS NULL GROUP BY type',
  );
  try {
    return s.all();
  } finally {
    s.finalize();
  }
});
const databaseBytes = withTransaction((db) => {
  const s = db.prepare('PRAGMA page_count');
  try {
    return Number(s.value()?.[0]) * 4096;
  } finally {
    s.finalize();
  }
});
console.log(
  JSON.stringify(
    {
      fixture: {
        totalPlex,
        totalRadarr,
        managed,
        networkLatency: 'none; generated response stream',
        physicalVerification: false,
      },
      results,
      counts,
      databaseBytes,
    },
    null,
    2,
  ),
);
