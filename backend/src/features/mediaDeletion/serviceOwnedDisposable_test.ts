import { assertEquals, assertRejects } from '@std/assert';
import { fileURLToPath } from 'node:url';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import { buildServiceOwnedPlan, type ServiceOwnedPlanningInput } from './serviceOwnedPlanning.ts';

import type { ServiceOwnedAttempt } from '../deletionOperations/workflow/serviceOwnedWorkflow.ts';

// Only the DB imported by the execution module is initialized; this process never
// opens a saved application database. All service reads/actions below are simulated.
Deno.env.set('DB_PATH', ':memory:');
const { executeServiceOwnedActions } = await import(
  '../deletionOperations/workflow/serviceOwnedWorkflow.ts'
);

const payload = 'disposable media bytes';
const filename = 'Fixture S01E01.mkv';

async function removeFixtureFile(path: string) {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function serviceFixture(shared: boolean) {
  const downloadPath = `/downloads/${filename}`;
  const plexPath = shared ? downloadPath : `/plex/Fixture/${filename}`;
  const arrPath = shared ? downloadPath : `/arr/Fixture/${filename}`;
  const arrRoot = shared ? '/downloads' : '/arr/Fixture';
  const part = { ratingKey: 'episode', mediaId: 1, path: plexPath, size: payload.length };
  const identity = (ratingKey: string) => ({
    ratingKey,
    title: ratingKey,
    type: ratingKey === 'season' ? 'season' : 'show',
    librarySectionId: 'tv',
    tmdbId: null,
    tvdbId: ratingKey === 'show' ? 123 : null,
    parentRatingKey: ratingKey === 'season' ? 'show' : null,
    grandparentRatingKey: null,
    seasonIndex: null,
    index: ratingKey === 'season' ? 1 : null,
    media: [],
  });
  let manifests = 0;
  const plex = {
    metadataIdentity: (key: string) => Promise.resolve(identity(key)),
    mediaPathPreview: () =>
      Promise.resolve({
        paths: [plexPath, '/plex/Other/S02E01.mkv'],
        truncated: false,
        fileSizes: { [plexPath]: payload.length, '/plex/Other/S02E01.mkv': 40 },
        versionFiles: [part, {
          ratingKey: 'other',
          mediaId: 2,
          path: '/plex/Other/S02E01.mkv',
          size: 40,
        }],
      }),
    libraryFileEntries: () => {
      throw new Error('Unrelated whole-library scan is forbidden');
    },
    seasonDeletionEpisodes: () =>
      Promise.resolve([{
        ratingKey: 'episode',
        title: 'Episode',
        showRatingKey: 'show',
        seasonRatingKey: 'season',
        seasonIndex: 1,
        episodeIndex: 1,
        media: [{ mediaId: 1, paths: [{ path: plexPath, byteSize: payload.length }] }],
      }]),
  };
  const arr = {
    lookup: () => Promise.resolve({ id: 7, title: 'Fixture', path: arrRoot }),
    sonarrSeriesSnapshot: () =>
      Promise.resolve({
        files: [{
          id: 5,
          seriesId: 7,
          path: arrPath,
          relativePath: filename,
          size: payload.length,
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
    sonarrExtraFiles: () => Promise.reject(new Error('No public extras inventory')),
    torrentAssociations: () =>
      Promise.resolve([{
        hash: 'fixture-job',
        episodeFileId: 5,
        episodeId: 8,
        historyId: 1,
        date: null,
        sourcePath: downloadPath,
        importedPath: arrPath,
        payloadPath: null,
      }]),
    downloadIdIsExclusiveTo: () => Promise.resolve(true),
  };
  const job: DownloadJob = {
    id: 'fixture-job',
    name: 'Fixture',
    state: 'uploading',
    size: payload.length,
    uploaded: 0,
    completedAt: 1,
    ratio: 0,
    seedingTime: 1,
    contentPath: downloadPath,
    savePath: '/downloads',
    trackerHost: null,
    fileCount: 1,
    files: [{ path: filename, size: payload.length }],
    filesTruncated: false,
    manifestFiles: [{ path: filename, size: payload.length }],
  };
  const qb: DownloadClientTarget = {
    provider: 'qbittorrent',
    instanceId: 1,
    instanceKey: '1',
    instanceName: 'QB',
    configurationIdentity: 'fixture',
    client: {
      scanJobSummaries: async (visit) => {
        await visit({
          id: job.id,
          savePath: job.savePath,
          contentPath: job.contentPath,
          size: job.size,
        });
        await visit({
          id: 'unrelated-job',
          savePath: '/unrelated',
          contentPath: '/unrelated/Sentinel.mkv',
          size: 25,
        });
        return 'stable-fixture-inventory';
      },
      findJob: (id) => {
        assertEquals(id, 'fixture-job', 'Unrelated job manifests must not be loaded');
        manifests++;
        return Promise.resolve(job);
      },
      deleteJob: () => {
        throw new Error('Retained QB job must never receive deletion');
      },
    },
  };
  const target: ArrDeleteTarget = {
    instanceId: 1,
    instanceName: 'Sonarr',
    instanceType: 'sonarr',
    instanceUrl: 'http://fixture.invalid',
    configurationUpdatedAt: 1,
    mappingIdentity: 'unused',
    pathMappings: [],
    addImportExclusion: false,
    client: arr as unknown as ArrDeleteTarget['client'],
  };
  const input: ServiceOwnedPlanningInput = {
    serverId: 1,
    libraryKey: 'tv',
    selection: {
      ratingKey: 'season',
      type: 'season',
      title: 'season',
      tmdbId: null,
      tvdbId: 123,
      showRatingKey: 'show',
      seasonIndex: 1,
    },
    arrSelected: true,
    qbSelected: false,
    plex: plex as unknown as PlexClient,
    arrTargets: [target],
    downloadTargets: [qb],
  };
  return { input, manifestReads: () => manifests };
}

async function disposableCase(shared: boolean) {
  const parent = fileURLToPath(new URL('./', import.meta.url));
  const directory = await Deno.makeTempDir({ dir: parent, prefix: 'disposable-service-owned-' });
  const files = {
    download: `${directory}/download.mkv`,
    plex: `${directory}/plex.mkv`,
    arr: `${directory}/arr.mkv`,
    sentinel: `${directory}/sentinel.mkv`,
  };
  try {
    await Deno.writeTextFile(files.download, payload);
    await Deno.link(files.download, files.plex);
    await Deno.link(files.download, files.arr);
    await Deno.writeTextFile(files.sentinel, 'unrelated sentinel');
    const fixture = serviceFixture(shared);
    const plan = await buildServiceOwnedPlan(fixture.input);
    assertEquals(
      Object.fromEntries(
        plan.retention.decisions.map((decision) => [decision.service, decision.state]),
      ),
      {
        sonarr: shared ? 'kept' : 'delete_candidate',
        plex: shared ? 'kept' : 'delete_candidate',
        qb: 'kept',
      },
    );
    assertEquals(fixture.manifestReads() > 0, true);
    const attempts: Record<string, ServiceOwnedAttempt> = {};
    const saved: string[] = [];
    const catalog = new Set(plan.actions.map((action) => action.id));
    const requests: string[] = [];
    const runtime = {
      save() {
        saved.push(JSON.stringify(attempts));
      },
      async revalidate() {
        assertEquals(await Deno.readTextFile(files.download), payload);
        assertEquals(await Deno.readTextFile(files.sentinel), 'unrelated sentinel');
      },
      present: (action: { id: string }) => Promise.resolve(catalog.has(action.id)),
      async mutate(
        action: { id: string; service: string; targetId: string },
        record: (response: { status: 'succeeded'; httpStatus: number }) => void,
      ) {
        // These adapters simulate service ID requests. Virtual API paths never
        // become deletion paths: only this fresh fixture's exact files are used.
        assertEquals(shared, false, 'Known retained overlap must prevent every simulated mutation');
        assertEquals(JSON.parse(saved.at(-1)!)[action.id].response, undefined);
        assertEquals(typeof JSON.parse(saved.at(-1)!)[action.id].startedAt, 'number');
        if (action.service === 'sonarr') {
          assertEquals(plan.actions.find((entry) => entry.id === action.id)!.fileId, 5);
          requests.push('DELETE /episodefile/5');
          await Deno.remove(files.arr);
        } else {
          assertEquals(action.service, 'plex');
          requests.push('DELETE /library/metadata/season');
          await Deno.remove(files.plex);
        }
        catalog.delete(action.id); // Explicit simulated catalog effect, not inferred from unlink.
        record({ status: 'succeeded', httpStatus: 204 });
      },
    };
    await executeServiceOwnedActions(plan, attempts, runtime);
    assertEquals(
      requests,
      shared ? [] : ['DELETE /episodefile/5', 'DELETE /library/metadata/season'],
    );
    assertEquals(await Deno.readTextFile(files.download), payload);
    assertEquals(await Deno.readTextFile(files.sentinel), 'unrelated sentinel');
    if (shared) {
      assertEquals(await Deno.readTextFile(files.plex), payload);
      assertEquals(await Deno.readTextFile(files.arr), payload);
      assertEquals(Object.keys(attempts), []);
    } else {
      await assertRejects(() => Deno.stat(files.plex), Deno.errors.NotFound);
      await assertRejects(() => Deno.stat(files.arr), Deno.errors.NotFound);
      assertEquals(
        Object.values(attempts).every((attempt) => attempt.outcome?.status === 'target_absent'),
        true,
      );
    }
    const plexRemovals = plan.actions.filter((action) =>
      action.service === 'plex' && attempts[action.id]?.outcome?.status === 'target_absent'
    );
    assertEquals(plexRemovals.length, shared ? 0 : 1);
    // Resume must only observe completed simulated service records, never unlink again.
    await executeServiceOwnedActions(plan, attempts, runtime);
    assertEquals(requests.length, shared ? 0 : 2);
  } finally {
    for (const path of Object.values(files)) {
      await removeFixtureFile(path);
    }
    // Exact files and a freshly created directory only; no recursive cleanup.
    await Deno.remove(directory);
  }
}

Deno.test('simulated service IDs remove selected hardlink names beside retained download and sentinel', () =>
  disposableCase(false));
Deno.test('collector known same-entry retention prevents all simulated service unlinks', () =>
  disposableCase(true));
