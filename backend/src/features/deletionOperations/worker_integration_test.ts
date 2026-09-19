Deno.test('service-owned multi-episode request scaling', async () => {
  for (const count of [4, 12, 24, 148]) {
    reset();
    addEpisode();
    configureSonarr();
    live.get('episode-1')!.Media = [{ id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] }];
    for (let i = 2; i <= count; i++) {
      const episode = addAdditionalSonarrEpisode(i, 100 + i * 2, 101 + i * 2);
      episode.managedMediaId = -1; // Native inventory converges before Plex's next scan.
      live.get(episode.ratingKey)!.Media = [{
        id: 100 + i * 2,
        Part: [{ file: episode.managedPath, size: 40_000 }],
      }];
    }
    const fixtureFetch = globalThis.fetch;
    const counts: Record<string, number> = {};
    let observedOperationId: string | undefined;
    const progress: Array<{ phase: string; accepted: number; confirmed: number }> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const key = `${url.hostname}:${init?.method ?? 'GET'}`;
      counts[key] = (counts[key] ?? 0) + 1;
      if (
        observedOperationId && url.hostname === 'sonarr' && init?.method === 'DELETE' &&
        url.pathname.startsWith('/api/v3/episodefile/')
      ) {
        const target = (getDeletionOperation(
          observedOperationId,
          1,
        )! as unknown as import('../../../../shared/types/deletion/operations.ts').DeletionOperation)
          .targets[0];
        progress.push({
          phase: target.phase,
          accepted: target.serviceActionDecisions!.filter((a) => a.requestAccepted).length,
          confirmed: target.serviceActionDecisions!.filter((a) => a.removalConfirmed).length,
        });
      }
      const response = await fixtureFetch(input, init);
      if (
        url.hostname === 'sonarr' && url.pathname === '/api/v3/episode' &&
        url.searchParams.has('episodeFileId') && response.ok
      ) {
        const episodes = await response.json() as Array<{ episodeFileId: number }>;
        return Response.json(
          episodes.filter((e) => e.episodeFileId === Number(url.searchParams.get('episodeFileId'))),
        );
      }
      return response;
    };
    try {
      const choices = {
        libraryKey: 'shows',
        targets: [{ ratingKey: 'show-1' }],
        arrSelected: true,
        qbSelected: false,
      };
      const preview = await (await rawApp.request('/api/service-deletions/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(choices),
      })).json();
      const response = await rawApp.request('/api/service-deletions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...choices,
          previewFingerprint: preview.fingerprint,
          clientRequestId: crypto.randomUUID(),
        }),
      });
      assertEquals(response.status, 202, await response.clone().text());
      const { operationId } = await response.json();
      observedOperationId = operationId;
      for (const key of Object.keys(counts)) delete counts[key];
      await settle();
      const operation = getDeletionOperation(operationId, 1)!;
      assertEquals(operation.status, 'completed', JSON.stringify(operation));
      console.log('service-owned request counts', count, counts);
      assertEquals(counts['sonarr:DELETE'], count + 1);
      assertEquals(counts['plex:DELETE'], 1);
      // Linear HTTP budgets; leave a small fixed allowance for boundary checks.
      assertEquals(counts['plex:GET'] <= 12 * count + 30, true);
      assertEquals(counts['sonarr:GET'] <= 14 * count + 30, true);
      assertEquals(
        progress,
        Array.from(
          { length: count },
          (_, i) => ({ phase: 'arr_coordination', accepted: i, confirmed: i }),
        ),
      );
    } finally {
      globalThis.fetch = fixtureFetch;
      clearPlexClientCache();
    }
  }
});

Deno.test('service-owned preview exposes only selected version files and public display fields', async () => {
  reset();
  addMovie('display-version', [11, 12]);
  reportedPlexLibraries = [{ key: 'movies', title: 'Movies', type: 'movie' }];
  const response = await rawApp.request('/api/service-deletions/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      libraryKey: 'movies',
      targets: [{ ratingKey: 'display-version', mediaId: 11 }],
      arrSelected: false,
      qbSelected: false,
    }),
  });
  assertEquals(response.status, 200);
  const preview = await response.json();
  const target = preview.targets[0];
  assertEquals(target.files, [{
    path: '/movies/display-version-11.mkv',
    size: 50_000,
    service: 'plex',
    actionId: target.decisions.find((d: { service: string }) => d.service === 'plex').actionId,
  }]);
  assertEquals(target.fileCount, 1);
  assertEquals(target.filesTruncated, false);
  assertEquals(target.linkedExtrasIncluded, false);
  assertEquals(wholeDeleteOrder.length, 0);
});

Deno.test('service-owned retry preserves an accepted operation across server-resolution failure', async () => {
  reset();
  addMovie('service-retry-resolution', [11]);
  reportedPlexLibraries = [{ key: 'movies', title: 'Movies', type: 'movie' }];
  const { choices, preview } = await servicePreview('service-retry-resolution');
  const body = {
    ...choices,
    previewFingerprint: preview.fingerprint,
    clientRequestId: crypto.randomUUID(),
  };
  const submit = () =>
    rawApp.request('/api/service-deletions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const first = await submit();
  assertEquals(first.status, 202);
  const accepted = await first.json();
  withTransaction((client) =>
    client.prepare('UPDATE settings SET active_server_id=NULL WHERE id=1').run()
  );
  clearPlexClientCache();
  try {
    assertEquals((await submit()).status, 503);
  } finally {
    withTransaction((client) =>
      client.prepare('UPDATE settings SET active_server_id=1 WHERE id=1').run()
    );
    clearPlexClientCache();
  }
  const retry = await submit();
  assertEquals(retry.status, 202);
  assertEquals((await retry.json()).operationId, accepted.operationId);
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM deletion_operations').value<[number]>()![0]
    ),
    1,
  );
});

Deno.test('service-owned preview and worker reject playback and failed configured QB reads', async () => {
  reset();
  addMovie('service-read-guard', [11]);
  reportedPlexLibraries = [{ key: 'movies', title: 'Movies', type: 'movie' }];
  const choices = {
    libraryKey: 'movies',
    targets: [{ ratingKey: 'service-read-guard' }],
    arrSelected: false,
    qbSelected: true,
  };
  const previewRequest = () =>
    rawApp.request('/api/service-deletions/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(choices),
    });
  // An optional QB choice with no configured target cannot block Plex.
  const response = await previewRequest();
  assertEquals(response.status, 200);
  const preview = await response.json();
  assertEquals(preview.canConfirm, true);
  activePlaybackRatingKey = 'service-read-guard';
  assertEquals((await previewRequest()).status, 409);
  activePlaybackRatingKey = null;
  const accepted = await acceptServicePreview({ choices, preview });
  assertEquals(accepted.status, 202);
  const { operationId } = await accepted.json();
  activePlaybackRatingKey = 'service-read-guard';
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)!.status, 'needs_attention');
  assertEquals(wholeDeleteOrder.length, 0);
  activePlaybackRatingKey = null;
  withTransaction((client) =>
    client.prepare(
      "INSERT INTO qbittorrent_instances (id,server_id,name,url,username,password,created_at,updated_at) VALUES (1,1,'QB','http://qbit','','',1,1)",
    ).run()
  );
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    new URL(String(input)).hostname === 'qbit'
      ? Promise.resolve(new Response('Unavailable', { status: 503 }))
      : fixtureFetch(input, init);
  try {
    const failedRead = await previewRequest();
    if (failedRead.status === 200) assertEquals((await failedRead.json()).canConfirm, false);
    else assertEquals(failedRead.status, 409);
    assertEquals(wholeDeleteOrder.length, 0);
  } finally {
    globalThis.fetch = fixtureFetch;
  }
});

async function servicePreview(ratingKey: string, arrSelected = false) {
  const choices = {
    libraryKey: 'movies',
    targets: [{ ratingKey }],
    arrSelected,
    qbSelected: false,
  };
  const response = await rawApp.request('/api/service-deletions/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(choices),
  });
  const preview = await response.json();
  assertEquals(response.status, 200, JSON.stringify(preview));
  return { choices, preview };
}

async function acceptServicePreview(
  value: Awaited<ReturnType<typeof servicePreview>>,
  requestId = crypto.randomUUID(),
) {
  return await rawApp.request('/api/service-deletions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...value.choices,
      clientRequestId: requestId,
      previewFingerprint: value.preview.fingerprint,
    }),
  });
}

Deno.test('service-owned API deletes a Plex movie without any helper roots or QB configuration', async () => {
  reset();
  addMovie('service-movie', [11]);
  reportedPlexLibraries = [{ key: 'movies', title: 'Movies', type: 'movie' }];
  const value = await servicePreview('service-movie');
  assertEquals(value.preview.canConfirm, true, JSON.stringify(value.preview));
  const requestId = crypto.randomUUID();
  const response = await acceptServicePreview(value, requestId);
  assertEquals(response.status, 202, await response.clone().text());
  const accepted = await response.json();
  await settle();
  const operation = getDeletionOperation(accepted.operationId, 1)!;
  assertEquals(operation.status, 'completed', JSON.stringify(operation));
  assertEquals(operation.removalConfirmedCount, 1);
  assertEquals(live.has('service-movie'), false);
  assertEquals((await acceptServicePreview(value, requestId)).status, 202);
});

Deno.test('service-owned API covers whole shows and seasons without Sonarr or storage setup', async () => {
  for (const ratingKey of ['show-1', 'season-1']) {
    reset();
    addEpisode();
    reportedPlexLibraries = [{ key: 'shows', title: 'Shows', type: 'show' }];
    live.set('season-1', {
      ratingKey: 'season-1',
      title: 'Season 1',
      type: 'season',
      librarySectionID: 'shows',
      parentRatingKey: 'show-1',
      index: 1,
    });
    const choices = {
      libraryKey: 'shows',
      targets: [{ ratingKey }],
      arrSelected: false,
      qbSelected: false,
    };
    const response = await rawApp.request('/api/service-deletions/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(choices),
    });
    const preview = await response.json();
    assertEquals(response.status, 200, JSON.stringify(preview));
    assertEquals(preview.canConfirm, true, JSON.stringify(preview));
    const accepted = await rawApp.request('/api/service-deletions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...choices,
        previewFingerprint: preview.fingerprint,
        clientRequestId: crypto.randomUUID(),
      }),
    });
    assertEquals(accepted.status, 202, await accepted.clone().text());
    const { operationId } = await accepted.json();
    await settle();
    assertEquals(
      getDeletionOperation(operationId, 1)!.status,
      'completed',
      JSON.stringify(getDeletionOperation(operationId, 1)),
    );
    assertEquals(live.has(ratingKey), false);
  }
});

Deno.test('service-owned Radarr movie uses file IDs then catalog-only removal and Plex', async () => {
  reset();
  addMovie('service-radarr', [11], 10);
  configureRadarr();
  arrPresent = true;
  arrManagedFileSize = 50_000;
  arrManagedPath = '/arr/movie-11.mkv';
  arrMoviePath = '/arr';
  live.get('service-radarr')!.Media![0].Part![0].file = '/plex/movie-11.mkv';
  reportedPlexLibraries = [{ key: 'movies', title: 'Movies', type: 'movie' }];
  const value = await servicePreview('service-radarr', true);
  assertEquals(value.preview.canConfirm, true, JSON.stringify(value.preview));
  const response = await acceptServicePreview(value);
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();
  await settle();
  assertEquals(
    getDeletionOperation(operationId, 1)!.status,
    'completed',
    JSON.stringify(getDeletionOperation(operationId, 1)),
  );
  assertEquals(arrPresent, false);
  assertEquals(arrManagedFilePresent, false);
  assertEquals(live.has('service-radarr'), false);
});

Deno.test('service-owned shared file reconciles fresh Plex catalog absence after Radarr deletion', async () => {
  reset();
  addMovie('service-shared', [11], 10);
  configureRadarr();
  arrPresent = true;
  arrManagedFileSize = 50_000;
  arrManagedPath = '/shared/movie-11.mkv';
  arrMoviePath = '/shared';
  live.get('service-shared')!.Media![0].Part![0].file = arrManagedPath;
  reportedPlexLibraries = [{ key: 'movies', title: 'Movies', type: 'movie' }];
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await fixtureFetch(input, init);
    if (
      new URL(String(input)).pathname === `/api/v3/moviefile/${arrManagedFileId}` &&
      init?.method === 'DELETE' && response.ok
    ) live.delete('service-shared');
    return response;
  };
  try {
    const value = await servicePreview('service-shared', true);
    const response = await acceptServicePreview(value);
    assertEquals(response.status, 202, await response.clone().text());
    const { operationId } = await response.json();
    await settle();
    const operation = getDeletionOperation(operationId, 1)!;
    assertEquals(operation.status, 'completed', JSON.stringify(operation));
    assertEquals(operation.removalConfirmedCount, 1);
    assertEquals(arrPresent, false);
    assertEquals(wholeDeleteOrder.length, 0);
  } finally {
    globalThis.fetch = fixtureFetch;
  }
});

Deno.test('service-owned duplicate deletion removes one version and preserves its sibling', async () => {
  reset();
  addMovie('service-versions', [11, 12]);
  reportedPlexLibraries = [{ key: 'movies', title: 'Movies', type: 'movie' }];
  const choices = {
    libraryKey: 'movies',
    targets: [{ ratingKey: 'service-versions', mediaId: 11 }],
    arrSelected: false,
    qbSelected: false,
  };
  const response = await rawApp.request('/api/service-deletions/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(choices),
  });
  const preview = await response.json();
  assertEquals(response.status, 200, JSON.stringify(preview));
  assertEquals(preview.canConfirm, true, JSON.stringify(preview));
  const invalid = await rawApp.request('/api/service-deletions/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...choices,
      targets: [11, 12].map((mediaId) => ({ ratingKey: 'service-versions', mediaId })),
    }),
  });
  assertEquals(invalid.status, 409);
  assertEquals(plexMediaDeleteCount, 0);
  const accepted = await rawApp.request('/api/service-deletions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...choices,
      previewFingerprint: preview.fingerprint,
      clientRequestId: crypto.randomUUID(),
    }),
  });
  assertEquals(accepted.status, 202, await accepted.clone().text());
  const { operationId } = await accepted.json();
  await settle();
  assertEquals(
    getDeletionOperation(operationId, 1)!.status,
    'completed',
    JSON.stringify(getDeletionOperation(operationId, 1)),
  );
  assertEquals(plexMediaDeleteCount, 1);
  assertEquals(live.get('service-versions')!.Media!.map((media) => media.id), [12]);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT media_id FROM item_media_versions WHERE item_rating_key='service-versions'",
      ).values()
    ),
    [[12]],
  );
});

Deno.test('service-owned batch deletes two movie versions and preserves the third', async () => {
  for (const drift of [false, true]) {
    reset();
    addMovie('service-batch', [11, 12, 13]);
    const choices = {
      libraryKey: 'movies',
      targets: [11, 12].map((mediaId) => ({ ratingKey: 'service-batch', mediaId })),
      arrSelected: false,
      qbSelected: false,
    };
    const previewResponse = await rawApp.request('/api/service-deletions/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(choices),
    });
    const preview = await previewResponse.json();
    assertEquals(previewResponse.status, 200, JSON.stringify(preview));
    assertEquals(
      preview.targets.map((target: { fileName: string }) => target.fileName),
      [11, 12].map((id) =>
        live.get('service-batch')!.Media!.find((media) => media.id === id)!.Part![0].file!
          .split('/').at(-1)
      ),
    );
    const accepted = await rawApp.request('/api/service-deletions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...choices,
        previewFingerprint: preview.fingerprint,
        clientRequestId: crypto.randomUUID(),
      }),
    });
    assertEquals(accepted.status, 202, await accepted.clone().text());
    const { operationId } = await accepted.json();
    plexMediaDeleteHook = (mediaId) => {
      if (drift && mediaId === 11) {
        live.get('service-batch')!.Media!.find((m) => m.id === 13)!.Part![0].file =
          '/movies/changed-retained.mkv';
      }
    };
    try {
      await settle();
    } finally {
      plexMediaDeleteHook = null;
    }
    assertEquals(
      getDeletionOperation(operationId, 1)!.status,
      drift ? 'needs_attention' : 'completed',
      JSON.stringify(getDeletionOperation(operationId, 1)),
    );
    assertEquals(plexMediaDeleteCount, drift ? 1 : 2);
    assertEquals(
      live.get('service-batch')!.Media!.map((media) => media.id),
      drift ? [12, 13] : [13],
    );
  }
});

Deno.test('service-owned batch deletes versions across episodes of the same show', async () => {
  for (const arrSelected of [false, true]) {
    reset();
    addEpisode();
    configureSonarr();
    live.get('episode-1')!.Media![0].Part![0].file = sonarrManagedPath;
    addAdditionalSonarrEpisode(2, 31, 32);
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await fixtureFetch(input, init);
      const url = new URL(String(input));
      if (
        url.hostname === 'sonarr' && url.pathname === '/api/v3/episode' &&
        url.searchParams.has('episodeFileId') && response.ok
      ) {
        const episodes = await response.json() as Array<{ episodeFileId: number }>;
        return Response.json(
          episodes.filter((e) => e.episodeFileId === Number(url.searchParams.get('episodeFileId'))),
        );
      }
      return response;
    };
    clearPlexClientCache();
    try {
      const choices = {
        libraryKey: 'shows',
        targets: [
          { ratingKey: 'episode-1', mediaId: 21 },
          { ratingKey: 'episode-2', mediaId: 31 },
        ],
        arrSelected,
        qbSelected: false,
      };
      const previewResponse = await rawApp.request('/api/service-deletions/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(choices),
      });
      const preview = await previewResponse.json();
      assertEquals(previewResponse.status, 200, JSON.stringify(preview));
      const accepted = await rawApp.request('/api/service-deletions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...choices,
          previewFingerprint: preview.fingerprint,
          clientRequestId: crypto.randomUUID(),
        }),
      });
      assertEquals(accepted.status, 202, await accepted.clone().text());
      const { operationId } = await accepted.json();
      await settle();
      assertEquals(
        getDeletionOperation(operationId, 1)!.status,
        'completed',
        JSON.stringify(getDeletionOperation(operationId, 1)),
      );
      // This fixture reconciles the second shared Plex entry after its Sonarr file deletion.
      assertEquals(plexMediaDeleteCount, arrSelected ? 1 : 2);
      assertEquals(live.get('episode-1')!.Media!.map((m) => m.id), [22]);
      assertEquals(live.get('episode-2')!.Media!.map((m) => m.id), [32]);
    } finally {
      globalThis.fetch = fixtureFetch;
      clearPlexClientCache();
    }
  }
});

Deno.test('service-owned season and show finish explained partial and empty Plex refreshes', async () => {
  for (
    const { ratingKey, drift } of ['season-1', 'show-1'].flatMap((ratingKey) =>
      [
        'none',
        'empty',
        'empty-lost',
        'missing',
        'addition',
        'rename',
        'coordinates',
        'retained-shared-path',
        'configuration',
        'playback',
        'lost-file-response',
        'new-qb-overlap',
        'source-reappeared',
        'inventory-wait',
        'inventory-persistent',
        'inventory-new-file',
        'inventory-ref-lag',
      ].map((
        drift,
      ) => ({
        ratingKey,
        drift,
      }))
    )
  ) {
    reset();
    addEpisode();
    configureSonarr(drift === 'new-qb-overlap');
    if (drift === 'new-qb-overlap') qbitJobsOverride = [];
    live.get('episode-1')!.Media = [{ id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] }];
    live.set('season-1', {
      ratingKey: 'season-1',
      title: 'Season 1',
      type: 'season',
      librarySectionID: 'shows',
      parentRatingKey: 'show-1',
      index: 1,
    });
    const second = addAdditionalSonarrEpisode(2, 31, 32);
    live.get(second.ratingKey)!.Media = [{
      id: 31,
      Part: [{ file: second.managedPath, size: 40_000 }],
    }];
    const secondMedia = structuredClone(live.get(second.ratingKey)!.Media);
    const fixtureFetch = globalThis.fetch;
    const deleted: number[] = [];
    let inventoryUnavailable = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (drift === 'playback' && activePlaybackRatingKey && url.pathname === '/status/sessions') {
        return Response.json({
          MediaContainer: {
            Metadata: [{
              ratingKey: second.ratingKey,
              type: 'episode',
              grandparentRatingKey: 'show-1',
            }],
          },
        });
      }
      if (
        inventoryUnavailable && drift !== 'inventory-ref-lag' && url.hostname === 'sonarr' &&
        (!init?.method || init.method === 'GET') && url.pathname === '/api/v3/episodefile'
      ) {
        return new Response('Inventory unavailable', { status: 503 });
      }
      const response = await fixtureFetch(input, init);
      if (
        inventoryUnavailable && drift === 'inventory-ref-lag' && url.hostname === 'sonarr' &&
        url.pathname === '/api/v3/episode' && !url.searchParams.has('episodeFileId')
      ) {
        const episodes = await response.json();
        return Response.json(
          episodes.map((episode: { id: number; episodeFileId: number }) => ({
            ...episode,
            episodeFileId: episode.id === 9 ? sonarrManagedFileId : episode.episodeFileId,
          })),
        );
      }
      if (
        drift === 'empty-lost' && init?.method === 'DELETE' &&
        url.pathname === `/library/metadata/${ratingKey}`
      ) {
        throw new TypeError('Disposable empty-container deletion response lost');
      }
      if (
        url.hostname === 'sonarr' && url.pathname === '/api/v3/episode' &&
        url.searchParams.has('episodeFileId') && response.ok
      ) {
        const episodes = await response.json() as Array<{ episodeFileId: number }>;
        return Response.json(
          episodes.filter((episode) =>
            episode.episodeFileId === Number(url.searchParams.get('episodeFileId'))
          ),
        );
      }
      if (
        url.hostname === 'sonarr' && init?.method === 'DELETE' &&
        url.pathname.startsWith('/api/v3/episodefile/')
      ) {
        const id = Number(url.pathname.split('/').at(-1));
        deleted.push(id);
        if (id === sonarrManagedFileId) {
          // Plex refreshes the first deletion before the next Sonarr request,
          // but retains the season/show and its still-pending episode.
          live.delete('episode-1');
          if (drift === 'missing') live.delete(second.ratingKey);
          if (drift === 'addition') {
            live.set('new-episode', {
              ...structuredClone(live.get(second.ratingKey)!),
              ratingKey: 'new-episode',
              index: 3,
            });
          }
          if (drift === 'rename') {
            live.get(second.ratingKey)!.Media![0].Part![0].file = '/tv/Show/Season 01/new-name.mkv';
          }
          if (drift === 'coordinates') live.get(second.ratingKey)!.index = 99;
          if (drift === 'retained-shared-path') {
            const retained = addAdditionalSonarrEpisode(3, 41, 42);
            live.delete(retained.ratingKey);
            retained.managedPath = second.managedPath;
          }
          if (drift === 'configuration') {
            withTransaction((client) =>
              client.prepare('UPDATE arr_instances SET updated_at=2 WHERE id=2').run()
            );
          }
          if (drift === 'playback') activePlaybackRatingKey = second.ratingKey;
          if (drift === 'lost-file-response') throw new TypeError('Native file response lost');
          if (drift === 'new-qb-overlap') {
            qbitJobsOverride = [{
              hash: torrentHash,
              name: 'New retained owner',
              size: 40_000,
              contentPath: second.managedPath,
              savePath: '/tv/Show/Season 01',
              files: [{ name: second.managedPath.split('/').at(-1)!, size: 40_000 }],
            }];
          }
          if (drift === 'source-reappeared') sonarrManagedFilePresent = true;
        } else {
          if (drift.startsWith('inventory-')) inventoryUnavailable = true;
          // The second Plex scan has not happened yet; native Plex deletion
          // remains necessary for the final current catalog entry.
          if (drift.startsWith('empty')) live.delete(second.ratingKey);
          else live.get(second.ratingKey)!.Media = structuredClone(secondMedia);
        }
      }
      return response;
    };
    clearPlexClientCache();
    try {
      const choices = {
        libraryKey: 'shows',
        targets: [{ ratingKey }],
        arrSelected: true,
        qbSelected: false,
      };
      const previewResponse = await rawApp.request('/api/service-deletions/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(choices),
      });
      const preview = await previewResponse.json();
      assertEquals(previewResponse.status, 200, JSON.stringify(preview));
      assertEquals(
        preview.targets[0].decisions.filter((d: { state: string }) =>
          d.state === 'delete_candidate'
        ).length,
        3,
        JSON.stringify(preview),
      );
      const response = await rawApp.request('/api/service-deletions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...choices,
          previewFingerprint: preview.fingerprint,
          clientRequestId: crypto.randomUUID(),
        }),
      });
      assertEquals(response.status, 202, await response.clone().text());
      const { operationId } = await response.json();
      await settle();
      if (drift.startsWith('inventory-')) {
        assertEquals(getDeletionOperation(operationId, 1)!.status, 'waiting_retry');
        if (drift === 'inventory-persistent') {
          for (let retry = 0; retry < 5; retry++) {
            withTransaction((client) =>
              client.prepare('UPDATE deletion_targets SET next_retry_at=0 WHERE operation_id=?')
                .run(operationId)
            );
            await settle();
          }
          assertEquals(getDeletionOperation(operationId, 1)!.status, 'needs_attention');
          assertEquals(deleted, [sonarrManagedFileId, second.managedFileId]);
          const readSnapshot = () =>
            JSON.parse(
              withTransaction((client) =>
                client.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id=?')
                  .value<[string]>(operationId)![0]
              ),
            );
          const exhausted = readSnapshot();
          assertEquals(exhausted.serviceOwnedVerificationRetries, 6);
          assertEquals(recheckPlexReconciliationAfterSync(1, 'shows'), 0);
          assertEquals(getDeletionOperation(operationId, 1)!.status, 'needs_attention');
          assertEquals(retryDeletionOperation(operationId, 1), true);
          assertEquals(readSnapshot(), { ...exhausted, serviceOwnedVerificationRetries: 0 });
          // A further transient failure gets a fresh automatic budget, without replay.
          await settle();
          assertEquals(getDeletionOperation(operationId, 1)!.status, 'waiting_retry');
          assertEquals(readSnapshot().serviceOwnedVerificationRetries, 1);
          assertEquals(deleted, [sonarrManagedFileId, second.managedFileId]);
        }
        inventoryUnavailable = false;
        if (drift === 'inventory-new-file') addAdditionalSonarrEpisode(3, 41, 42);
        live.delete(ratingKey);
        live.delete('episode-1');
        live.delete(second.ratingKey);
        withTransaction((client) => {
          recoverInterruptedDeletionWork(client, Math.floor(Date.now() / 1000));
          client.prepare('UPDATE deletion_targets SET next_retry_at=0 WHERE operation_id=?').run(
            operationId,
          );
        });
        await settle();
      }
      const operation = getDeletionOperation(operationId, 1)!;
      const succeeds = drift === 'none' || drift === 'empty' || drift === 'inventory-wait' ||
        drift === 'inventory-persistent' ||
        drift === 'inventory-ref-lag' || drift === 'inventory-new-file' && ratingKey === 'season-1';
      const filesDeleted = succeeds || drift === 'empty-lost' || drift === 'inventory-new-file';
      assertEquals(
        operation.status,
        succeeds
          ? 'completed'
          : drift === 'source-reappeared'
          ? 'waiting_retry'
          : 'needs_attention',
        `${drift}: ${JSON.stringify(operation)}`,
      );
      assertEquals(
        deleted,
        filesDeleted ? [sonarrManagedFileId, second.managedFileId] : [sonarrManagedFileId],
      );
      assertEquals(second.managedFilePresent, !filesDeleted);
      assertEquals(live.has(ratingKey), !filesDeleted);
      assertEquals(operation.removalConfirmedCount, succeeds ? 1 : 0);
      if (drift === 'empty-lost' || drift === 'lost-file-response') {
        assertEquals(recheckPlexReconciliationAfterSync(1, 'shows'), 0);
        assertEquals(getDeletionOperation(operationId, 1)!.status, 'needs_attention');
        const requests = wholeDeleteOrder.length;
        const fileRequests = deleted.length;
        retryDeletionOperation(operationId, 1);
        await settle();
        assertEquals(wholeDeleteOrder.length, requests);
        assertEquals(deleted.length, fileRequests);
        assertEquals(getDeletionOperation(operationId, 1)!.removalConfirmedCount, 0);
      }
    } finally {
      globalThis.fetch = fixtureFetch;
      clearPlexClientCache();
    }
  }
});

Deno.test('service-owned populated Sonarr season deletes selected file and unmonitors only its episode while retained QB survives', async () => {
  for (const sharedPlex of [false, true]) {
    reset();
    addEpisode();
    configureSonarr(true);
    seasonPackQbit = true;
    const selectedPath = '/plex-library/Show/Season 01/old.mkv';
    live.get('episode-1')!.Media = [{ id: 21, Part: [{ file: selectedPath, size: 40_000 }] }];
    live.set('season-1', {
      ratingKey: 'season-1',
      title: 'Season 1',
      type: 'season',
      librarySectionID: 'shows',
      parentRatingKey: 'show-1',
      index: 1,
    });
    const sibling = addAdditionalSonarrEpisode(2, 31, 32);
    live.get(sibling.ratingKey)!.parentRatingKey = 'season-2';
    live.get(sibling.ratingKey)!.parentIndex = 2;
    live.set('season-2', {
      ratingKey: 'season-2',
      title: 'Season 2',
      type: 'season',
      librarySectionID: 'shows',
      parentRatingKey: 'show-1',
      index: 2,
    });
    withTransaction((client) => {
      client.prepare(
        "INSERT INTO seasons (server_id,rating_key,show_rating_key,library_key,season_index,title,file_size,updated_at) VALUES (1,'season-2','show-1','shows',2,'Season 2',80,1)",
      ).run();
      client.prepare(
        "UPDATE episode_media_versions SET season_rating_key='season-2',season_index=2 WHERE episode_rating_key=?",
      ).run(sibling.ratingKey);
    });
    for (let n = 0; n < 150; n++) {
      live.set(`unrelated-show-${n}`, {
        ratingKey: `unrelated-show-${n}`,
        type: 'show',
        title: `Unrelated ${n}`,
        librarySectionID: 'shows',
        Guid: [{ id: `tvdb://${1000 + n}` }],
      });
    }
    const qbPath = sharedPlex ? selectedPath : '/downloads/release/old.mkv';
    qbitJobsOverride = [
      {
        hash: torrentHash,
        name: 'retained selected download',
        size: 40_000,
        contentPath: qbPath,
        savePath: qbPath.slice(0, qbPath.lastIndexOf('/')),
        files: [{ name: 'old.mkv', size: 40_000 }],
      },
      ...Array.from(
        { length: 100 },
        (_, n) => ({
          hash: (n + 1).toString(16).padStart(40, '0'),
          name: `Unrelated ${n}`,
          size: 1000,
          contentPath: `/downloads/other-${n}/other.mkv`,
          savePath: `/downloads/other-${n}`,
          files: [{ name: 'other.mkv', size: 1000 }],
        }),
      ),
    ];
    const fixtureFetch = globalThis.fetch;
    const deletedFiles: number[] = [], monitoredEpisodes: number[] = [];
    let wholeLibraryReads = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/library/sections/shows/all') {
        wholeLibraryReads++;
        throw new Error('Unexpected whole-library discovery');
      }
      if (url.hostname === 'sonarr' && url.pathname === '/api/v3/history/series') {
        return Response.json([{
          id: 1,
          episodeId: 9,
          eventType: 'downloadFolderImported',
          downloadId: torrentHash,
          data: {
            fileId: String(sonarrManagedFileId),
            importedPath: sonarrManagedPath,
            droppedPath: '/downloads/release/old.mkv',
          },
        }]);
      }
      if (
        url.hostname === 'sonarr' && init?.method === 'DELETE' &&
        url.pathname.startsWith('/api/v3/episodefile/')
      ) deletedFiles.push(Number(url.pathname.split('/').at(-1)));
      if (
        url.hostname === 'sonarr' && init?.method === 'PUT' &&
        /^\/api\/v3\/episode\/\d+$/.test(url.pathname)
      ) monitoredEpisodes.push(Number(url.pathname.split('/').at(-1)));
      const response = await fixtureFetch(input, init);
      if (url.hostname === 'sonarr' && url.pathname === '/api/v3/episode' && response.ok) {
        let episodes = await response.json() as Array<
          { id: number; seasonNumber: number; episodeFileId: number }
        >;
        episodes = episodes.map((episode) =>
          episode.id === sibling.episodeId ? { ...episode, seasonNumber: 2 } : episode
        );
        if (url.searchParams.has('episodeFileId')) {
          episodes = episodes.filter((episode) =>
            episode.episodeFileId === Number(url.searchParams.get('episodeFileId'))
          );
        }
        return Response.json(episodes);
      }
      return response;
    };
    clearPlexClientCache();
    try {
      const choices = {
        libraryKey: 'shows',
        targets: [{ ratingKey: 'season-1' }],
        arrSelected: true,
        qbSelected: false,
      };
      const response = await rawApp.request('/api/service-deletions/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(choices),
      });
      const preview = await response.json();
      assertEquals(response.status, 200, JSON.stringify(preview));
      assertEquals(preview.canConfirm, true, JSON.stringify(preview));
      assertEquals(
        preview.targets[0].decisions.find((d: { service: string }) => d.service === 'sonarr').state,
        'delete_candidate',
        JSON.stringify(preview),
      );
      assertEquals(
        preview.targets[0].decisions.find((d: { service: string }) => d.service === 'plex').state,
        sharedPlex ? 'kept' : 'delete_candidate',
        JSON.stringify(preview),
      );
      const accepted = await rawApp.request('/api/service-deletions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...choices,
          previewFingerprint: preview.fingerprint,
          clientRequestId: crypto.randomUUID(),
        }),
      });
      assertEquals(accepted.status, 202, await accepted.clone().text());
      const { operationId } = await accepted.json();
      await settle();
      const operation = getDeletionOperation(operationId, 1)!;
      assertEquals(
        operation.status,
        sharedPlex ? 'completed_with_warning' : 'completed',
        JSON.stringify(operation),
      );
      assertEquals(deletedFiles, [10]);
      assertEquals(monitoredEpisodes, [9]);
      assertEquals(sonarrManagedFilePresent, false);
      assertEquals(sonarrMonitored, false);
      assertEquals(sibling.managedFilePresent, true);
      assertEquals(sibling.monitored, true);
      assertEquals(live.has('season-1'), sharedPlex);
      assertEquals(live.has(sibling.ratingKey), true);
      assertEquals(qbitDeleteCount, 0);
      assertEquals(qbitJobsOverride!.length, 101);
      assertEquals(operation.removalConfirmedCount, sharedPlex ? 0 : 1);
      assertEquals(
        withTransaction((client) =>
          client.prepare('SELECT COUNT(*) FROM episode_media_versions WHERE episode_rating_key=?')
            .value<[number]>(sibling.ratingKey)![0]
        ),
        2,
      );
      assertEquals(wholeLibraryReads, 0);
    } finally {
      globalThis.fetch = fixtureFetch;
      clearPlexClientCache();
    }
  }
});

Deno.test('service-owned current Radarr import associates QB and waits across restart without replay', async () => {
  reset();
  addMovie('service-qb', [11], 10);
  configureRadarr(true);
  arrPresent = true;
  arrManagedFileSize = 50_000;
  arrManagedPath = '/arr/movie.mkv';
  arrMoviePath = '/arr';
  live.get('service-qb')!.Media![0].Part![0].file = '/plex/movie.mkv';
  reportedPlexLibraries = [{ key: 'movies', title: 'Movies', type: 'movie' }];
  qbitJobsOverride = [{
    hash: torrentHash,
    name: 'current import',
    size: 50_000,
    contentPath: '/qb/release/movie.mkv',
    savePath: '/qb',
    files: [{ name: 'release/movie.mkv', size: 50_000 }],
  }];
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'radarr' && url.pathname === '/api/v3/history/movie') {
      return Promise.resolve(
        Response.json([{
          id: 1,
          eventType: 'downloadFolderImported',
          downloadId: torrentHash,
          data: {
            fileId: String(arrManagedFileId),
            importedPath: arrManagedPath,
            droppedPath: '/source/release/movie.mkv',
          },
        }]),
      );
    }
    if (url.pathname === '/api/v2/torrents/delete' && init?.method === 'POST') {
      qbitDeleteCount++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    return fixtureFetch(input, init);
  };
  clearPlexClientCache();
  try {
    const choices = {
      libraryKey: 'movies',
      targets: [{ ratingKey: 'service-qb' }],
      arrSelected: true,
      qbSelected: true,
    };
    const response = await rawApp.request('/api/service-deletions/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(choices),
    });
    const preview = await response.json();
    assertEquals(response.status, 200, JSON.stringify(preview));
    assertEquals(
      preview.targets[0].decisions.find((d: { service: string }) => d.service === 'qb').state,
      'delete_candidate',
      JSON.stringify(preview),
    );
    const accepted = await rawApp.request('/api/service-deletions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...choices,
        previewFingerprint: preview.fingerprint,
        clientRequestId: crypto.randomUUID(),
      }),
    });
    assertEquals(accepted.status, 202, await accepted.clone().text());
    const { operationId } = await accepted.json();
    await settle();
    assertEquals(getDeletionOperation(operationId, 1)!.status, 'waiting_retry');
    assertEquals(qbitDeleteCount, 1);
    assertEquals(arrManagedFilePresent, true);
    qbitJobsOverride = [];
    withTransaction((client) => {
      client.prepare("UPDATE deletion_targets SET status='running' WHERE operation_id=?").run(
        operationId,
      );
      recoverInterruptedDeletionWork(client, Math.floor(Date.now() / 1000));
    });
    await settle();
    assertEquals(
      getDeletionOperation(operationId, 1)!.status,
      'completed',
      JSON.stringify(getDeletionOperation(operationId, 1)),
    );
    assertEquals(qbitDeleteCount, 1);
  } finally {
    globalThis.fetch = fixtureFetch;
    clearPlexClientCache();
  }
});

Deno.test('service-owned retained QB completes without Plex removal or catalog pruning', async () => {
  reset();
  addMovie('service-kept', [11]);
  reportedPlexLibraries = [{ key: 'movies', title: 'Movies', type: 'movie' }];
  withTransaction((client) =>
    client.prepare(
      "INSERT INTO qbittorrent_instances (id,server_id,name,url,username,password,created_at,updated_at) VALUES (1,1,'QB','http://qbit','','',1,1)",
    ).run()
  );
  const part = live.get('service-kept')!.Media![0].Part![0];
  const path = part.file!;
  qbitJobsOverride = [{
    hash: torrentHash,
    name: 'retained',
    size: part.size!,
    contentPath: path,
    savePath: path.slice(0, path.lastIndexOf('/')),
    files: [{ name: path.slice(path.lastIndexOf('/') + 1), size: part.size! }],
  }];
  const value = await servicePreview('service-kept');
  assertEquals(value.preview.canConfirm, true, JSON.stringify(value.preview));
  assertEquals(
    value.preview.targets[0].decisions.find((d: { service: string }) => d.service === 'plex').state,
    'kept',
  );
  const response = await acceptServicePreview(value);
  assertEquals(response.status, 202, await response.clone().text());
  const accepted = await response.json();
  await settle();
  const operation = getDeletionOperation(accepted.operationId, 1)!;
  assertEquals(operation.status, 'completed_with_warning', JSON.stringify(operation));
  assertEquals(operation.removalConfirmedCount, 0);
  assertEquals(live.has('service-kept'), true);
  assertEquals(qbitDeleteCount, 0);
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM media_removals WHERE operation_id=?').value<[number]>(
        accepted.operationId,
      )![0]
    ),
    0,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare("SELECT COUNT(*) FROM items WHERE rating_key='service-kept'").value<
        [number]
      >()![0]
    ),
    1,
  );
});

Deno.test('service-owned changed preview and lost response never grant new deletion consent', async () => {
  reset();
  addMovie('service-drift', [11]);
  reportedPlexLibraries = [{ key: 'movies', title: 'Movies', type: 'movie' }];
  const initial = await servicePreview('service-drift');
  live.get('service-drift')!.Media![0].Part![0].file = '/new/location.mkv';
  assertEquals((await acceptServicePreview(initial)).status, 409);
  const current = await servicePreview('service-drift');
  const response = await acceptServicePreview(current);
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await fixtureFetch(input, init);
    if (
      new URL(String(input)).pathname === '/library/metadata/service-drift' &&
      init?.method === 'DELETE'
    ) throw new TypeError('Disposable fixture lost response');
    return response;
  };
  clearPlexClientCache();
  try {
    await settle();
    assertEquals(getDeletionOperation(operationId, 1)!.status, 'needs_attention');
    const before = wholeDeleteOrder.length;
    retryDeletionOperation(operationId, 1);
    await settle();
    assertEquals(wholeDeleteOrder.length, before);
    assertEquals(getDeletionOperation(operationId, 1)!.removalConfirmedCount, 0);
  } finally {
    globalThis.fetch = fixtureFetch;
    clearPlexClientCache();
  }
});

// This adapter changes only in-memory service responses; all HTTP is still intercepted.

import { assertEquals, assertThrows } from '@std/assert';
import { resolve } from '@std/path';
import type { PlexRawMetadata } from '../../integrations/plex/types.ts';

const testDirectory = await Deno.makeTempDir();
const testDbPath = resolve(testDirectory, 'deletion-worker.db');
Deno.env.set('DB_PATH', testDbPath);

// Remote API fixtures use these accessible virtual mounts. Tests using actual
// temporary files continue through the real filesystem implementation.
const realPath = Deno.realPath;
Deno.realPath = (path) => {
  const local = String(path).replaceAll('\\', '/');
  return /^(?:[A-Za-z]:)?\/(tv|downloads)(\/|$)/.test(local)
    ? Promise.resolve(local)
    : realPath(path);
};

const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(testDbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const {
  getDeletionOperation,
  retryDeletionOperation,
  recheckPlexReconciliationAfterSync,
  runDeletionWorkerOnceForTest,
  setAutomaticDeletionWorkerForTest,
} = await import('./service.ts');
const { recoverInterruptedDeletionWork } = await import('./core/recovery.ts');

const { canConfirmOrphanAbsenceForCleanup } = await import(
  './workflow/targetWorkflow.ts'
);
const {
  canonicalJson,
} = await import('./relocation/relocation.ts');

const { clearPlexClientCache } = await import(
  '../../integrations/plex/index.ts'
);
const { createApp } = await import('../../app.ts');
const rawApp = createApp();

// Ordinary fixtures confirm reusable service relationships, without local access checks.

const live = new Map<string, PlexRawMetadata>();
const bulkMetadataOverrides = new Map<string, PlexRawMetadata>();
let exactMetadataFailureStatus: number | null = null;
let plexMachineIdentifier = 'machine-1';
let loseDeleteResponse = false;
let failDeleteBeforeMutation = false;
let plexMediaDeleteCount = 0;
let plexMediaDeleteHook: ((mediaId: number) => void) | null = null;
let coordinatedRatingKey: string | null = null;
let arrPresent = false;
let sonarrSeriesPath = '/tv/Show';
let retainedLibraryReadHook: (() => void) | null = null;
let retainedLibraryReads = 0;
let arrDeleteCount = 0;
const destinationOrder: string[] = [];
let loseArrRemovalResponse = false;
let radarrExclusion: {
  id: number;
  tmdbId: number;
  movieTitle: string;
  movieYear: number;
} | null = null;
let arrManagedFilePresent = true;
let arrManagedFileId = 70;
let arrManagedFileSize = 100_000;
let arrExtraMovieFileId: number | null = null;
let arrRescanFileSize = 50_000;
let arrManagedPath = '/library/Coordinated/movie.mkv';
let arrManagedMediaId: number | null = null;
let arrRescanTargetPath: string | null = null;
let restoreArrPathOnRescan: string | null = null;
let restoredArrPath: string | null = null;
let arrMoviePath = '/library/Coordinated';
let arrMonitored = true;
let arrMonitorMutationCount = 0;
let loseMonitorResponseAtMutation: number | null = null;
let rejectMonitorAtMutation: number | null = null;
let monitorDriftAfterSelectedDelete = false;
let monitorDriftAfterRestorationReads: number | null = null;
let monitorDriftAfterUnmonitoredEvidence = false;
let rejectMonitoringWrites = false;
let loseArrManagedDeleteResponse = false;
let loseArrMoviePathResponse = false;
let loseArrRescanResponse = false;
let rejectArrRescanStatus: number | null = null;
let arrManagedFileReads = 0;
let activatePlaybackOnManagedFileRead: number | null = null;
let changeArrOwnershipOnManagedFileRead: {
  read: number;
  mediaId: number;
  path: string;
} | null = null;
let removePlexMediaOnManagedFileRead: {
  read: number;
  ratingKey: string;
  mediaId: number;
} | null = null;
let pendingPlexMediaRemoval: { ratingKey: string; mediaId: number } | null = null;
let activePlaybackRatingKey: string | null = null;
let activeSessionsHook: (() => void) | null = null;
let sonarrManagedFilePresent = true;
let sonarrManagedFileId = 10;
let sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
let sonarrManagedFileSize = 40_000;
let sonarrManagedFileSeriesId = 8;
let sonarrManagedMediaId: number | null = null;
let sonarrRescanTargetPath: string | null = null;
interface AdditionalSonarrEpisode {
  ratingKey: string;
  episodeId: number;
  episodeNumber: number;
  managedFileId: number;
  managedPath: string;
  managedMediaId: number;
  retainedPath: string;
  retainedMediaId: number;
  monitored: boolean;
  managedFilePresent: boolean;
}
let additionalSonarrEpisodes: AdditionalSonarrEpisode[] = [];
let rejectSonarrMonitoringEpisodeId: number | null = null;
let rejectSonarrManualImportPreflight = false;
let rejectSonarrManualImportStatus: number | null = null;
let sonarrManualImportSize = 40_000;
let sonarrRescanHook: (() => void) | null = null;
let sonarrRescanCount = 0;
let sonarrMonitorMutationCount = 0;
let sonarrMonitored = true;
let sonarrManagedFileShared = false;
let sonarrSharedEpisodeMonitored = true;
let sonarrOldPathLingersAfterDelete = false;
let sonarrFilesystemStatus: number | null = null;
let sonarrFilesystemStatusAfterDelete: number | null = null;
let sonarrReferenceLingersAfterDelete = false;
let sonarrReportedVersion = '4.0.19.2979';
let sonarrUnavailable = false;
let sonarrHistoryUnavailable = false;
let sonarrActivityReadCount = 0;
let blockSonarrActivityAtRead: number | null = null;
let sonarrSnapshotReadCount = 0;
let sonarrSnapshotHook: (() => void) | null = null;
let sonarrSeriesPresent = true;
let sonarrSeriesDeleteHook: (() => void) | null = null;
let sonarrEpisodeFileDeleteHook: ((fileId: number) => void) | null = null;
let loseSonarrSeriesDeleteResponse = false;
let seasonPackQbit = false;
let seasonPackMixed = false;
let seasonPackForeignOwner = false;
let additionalSonarrHistory: Array<{
  downloadId: string;
  droppedPath: string;
  importedPath: string;
}> = [];
let qbitJobsOverride:
  | Array<{
    hash: string;
    name: string;
    size: number;
    contentPath: string;
    savePath: string;
    files: Array<{ name: string; size: number }>;
  }>
  | null = null;
let qbitDeleteHook: ((hashes: string[]) => void) | null = null;
let qbitPresent = false;
let qbitDeleteCount = 0;
let qbitRequestCount = 0;
let loseQbitDeleteResponse = false;
let fetchCount = 0;
let technicalDetailsRequestCount = 0;
let historyAccountId: unknown = null;
let reportedPlexLibraries: Array<{ key: string; title: string; type: string }> | null = null;
const torrentHash = 'a'.repeat(40);
const wholeDeleteOrder: string[] = [];
const versionDeleteOrder: string[] = [];
setAutomaticDeletionWorkerForTest(false);

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  fetchCount++;
  const url = new URL(String(input));
  if (url.pathname === '/identity') {
    return Promise.resolve(
      Response.json({ MediaContainer: { machineIdentifier: plexMachineIdentifier } }),
    );
  }
  if (url.pathname === '/status/sessions') {
    activeSessionsHook?.();
    return Promise.resolve(Response.json({
      MediaContainer: {
        Metadata: activePlaybackRatingKey
          ? [{ ratingKey: activePlaybackRatingKey, type: 'movie' }]
          : [],
      },
    }));
  }
  if (url.pathname === '/library/sections') {
    return Promise.resolve(Response.json({
      MediaContainer: { Directory: reportedPlexLibraries ?? [] },
    }));
  }
  if (url.pathname === '/library/sections/movies/all') {
    retainedLibraryReads++;
    retainedLibraryReadHook?.();
    const metadata = [...live.values()].filter((item) => item.type === 'movie').map((item) =>
      bulkMetadataOverrides.get(item.ratingKey) ?? item
    );
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  if (url.pathname === '/library/sections/shows/all') {
    retainedLibraryReads++;
    retainedLibraryReadHook?.();
    const requestedType = url.searchParams.get('type');
    const metadata = [...live.values()].filter((item) =>
      requestedType === '4' ? item.type === 'episode' : item.type === 'show'
    );
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  if (url.pathname === '/status/sessions/history/all') {
    const metadata = historyAccountId === null
      ? []
      : [{ ratingKey: 'history-item', viewedAt: 100, accountID: historyAccountId }];
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  if (url.hostname === 'plex.tv' && url.pathname === '/api/v2/user') {
    return Promise.resolve(Response.json({ id: 1, username: 'owner' }));
  }
  if (url.hostname === 'plex.tv' && url.pathname === '/api/users') {
    return Promise.resolve(new Response('<MediaContainer />'));
  }
  if (url.pathname === '/accounts') {
    return Promise.resolve(Response.json({ MediaContainer: { Account: [] } }));
  }
  if (url.hostname.startsWith('radarr')) {
    if (url.pathname === '/api/v3/movie') {
      return Promise.resolve(
        Response.json(
          arrPresent
            ? [{
              id: 7,
              tmdbId: 10,
              title: 'Coordinated movie',
              year: 2000,
              path: arrMoviePath,
              monitored: arrMonitored,
            }]
            : [],
        ),
      );
    }
    if (url.pathname === '/api/v3/exclusions/paged') {
      const records = radarrExclusion ? [radarrExclusion] : [];
      return Promise.resolve(Response.json({ records, totalRecords: records.length }));
    }
    if (url.pathname === '/api/v3/exclusions' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Omit<NonNullable<typeof radarrExclusion>, 'id'>;
      radarrExclusion = { id: 91, ...body };
      return Promise.resolve(Response.json(radarrExclusion));
    }
    if (url.pathname === '/api/v3/queue') {
      return Promise.resolve(Response.json({ records: [], totalRecords: 0 }));
    }
    if (url.pathname === '/api/v3/command' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(Response.json([]));
    }
    if (url.pathname === '/api/v3/moviefile') {
      arrManagedFileReads++;
      if (arrManagedFileReads === changeArrOwnershipOnManagedFileRead?.read) {
        arrManagedMediaId = changeArrOwnershipOnManagedFileRead.mediaId;
        arrManagedPath = changeArrOwnershipOnManagedFileRead.path;
      }
      if (arrManagedFileReads === activatePlaybackOnManagedFileRead) {
        activePlaybackRatingKey = coordinatedRatingKey;
      }
      if (arrManagedFileReads === removePlexMediaOnManagedFileRead?.read) {
        pendingPlexMediaRemoval = {
          ratingKey: removePlexMediaOnManagedFileRead.ratingKey,
          mediaId: removePlexMediaOnManagedFileRead.mediaId,
        };
      }
      return Promise.resolve(Response.json(
        arrManagedFilePresent
          ? [{
            id: arrManagedFileId,
            relativePath: arrManagedPath.split('/').at(-1),
            path: arrManagedPath,
            size: arrManagedFileSize,
          }]
          : [],
      ));
    }
    if (url.pathname === '/api/v3/extrafile') {
      return Promise.resolve(Response.json(
        arrExtraMovieFileId === null
          ? []
          : [{ relativePath: 'movie.nfo', type: 'metadata', movieFileId: arrExtraMovieFileId }],
      ));
    }
    if (url.pathname === '/api/v3/filesystem/type') {
      const path = url.searchParams.get('path');
      const exists = path === restoredArrPath ||
        [...live.values()].some((item) =>
          item.Media?.some((media) => media.Part?.some((part) => part.file === path))
        );
      return Promise.resolve(Response.json({ type: exists ? 'file' : 'folder' }));
    }
    if (url.pathname === '/api/v3/history/movie') {
      return Promise.resolve(Response.json([{
        id: 1,
        eventType: 'downloadFolderImported',
        downloadId: torrentHash,
        data: { droppedPath: '/downloads/release/movie.mkv', importedPath: arrManagedPath },
      }]));
    }
    if (url.pathname === '/api/v3/history') {
      return Promise.resolve(Response.json({ totalRecords: 1, records: [{ movieId: 7 }] }));
    }
    if (url.pathname === '/api/v3/movie/7' && init?.method === 'DELETE') {
      destinationOrder.push('arr');
      versionDeleteOrder.push('radarr');
      arrDeleteCount++;
      arrPresent = false;
      if (loseArrRemovalResponse) {
        loseArrRemovalResponse = false;
        return Promise.reject(new TypeError('lost Radarr removal response'));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.pathname === '/api/v3/movie/7' && (init?.method ?? 'GET') === 'GET') {
      if (!arrPresent) return Promise.resolve(new Response(null, { status: 404 }));
      if (
        monitorDriftAfterUnmonitoredEvidence && withTransaction((client) =>
            client.prepare(
              "SELECT COUNT(*) FROM deletion_targets WHERE json_extract(snapshot, '$.arrReassignments[0].originalMonitored') = 0",
            ).value<[number]>()?.[0] ?? 0
          ) > 0
      ) {
        monitorDriftAfterUnmonitoredEvidence = false;
        arrMonitored = true;
      }
      const monitored = arrMonitored;
      if (
        arrMonitorMutationCount >= 2 && monitorDriftAfterRestorationReads !== null &&
        --monitorDriftAfterRestorationReads === 0
      ) {
        monitorDriftAfterRestorationReads = null;
        arrMonitored = false;
      }
      return Promise.resolve(Response.json({
        id: 7,
        tmdbId: 10,
        title: 'Coordinated movie',
        path: arrMoviePath,
        monitored,
      }));
    }
    if (url.pathname === '/api/v3/movie/7' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { path?: string; monitored?: boolean };
      if (
        body.monitored !== undefined &&
        (rejectMonitoringWrites || arrMonitorMutationCount + 1 === rejectMonitorAtMutation)
      ) {
        return Promise.resolve(new Response('monitoring rejected', { status: 503 }));
      }
      if (body.path) arrMoviePath = body.path;
      if (body.monitored !== undefined) {
        arrMonitorMutationCount++;
        arrMonitored = body.monitored;
      }
      if (arrMonitorMutationCount === loseMonitorResponseAtMutation) {
        loseMonitorResponseAtMutation = null;
        return Promise.reject(new TypeError('lost Radarr monitoring response'));
      }
      if (loseArrMoviePathResponse) {
        loseArrMoviePathResponse = false;
        return Promise.reject(new TypeError('lost Radarr movie path response'));
      }
      return Promise.resolve(Response.json({ id: 7, monitored: arrMonitored }));
    }
    if (
      url.pathname === `/api/v3/moviefile/${arrManagedFileId}` &&
      init?.method === 'DELETE'
    ) {
      arrManagedFilePresent = false;
      if (coordinatedRatingKey && arrManagedMediaId !== null) {
        const item = live.get(coordinatedRatingKey);
        if (item?.Media) {
          item.Media = item.Media.filter((media) => media.id !== arrManagedMediaId);
        }
      }
      if (loseArrManagedDeleteResponse) {
        loseArrManagedDeleteResponse = false;
        return Promise.reject(new TypeError('lost Radarr file deletion response'));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.pathname === '/api/v3/command' && init?.method === 'POST') {
      if (rejectArrRescanStatus !== null) {
        return Promise.resolve(
          new Response('rescan disabled', { status: rejectArrRescanStatus }),
        );
      }
      if (arrRescanTargetPath) {
        arrManagedPath = arrRescanTargetPath;
        arrManagedFileId++;
        arrManagedFileSize = arrRescanFileSize;
        arrManagedFilePresent = true;
      }
      restoredArrPath = restoreArrPathOnRescan;
      if (loseArrRescanResponse) {
        loseArrRescanResponse = false;
        return Promise.reject(new TypeError('lost Radarr rescan response'));
      }
      return Promise.resolve(Response.json({ id: 80 }));
    }
  }
  if (url.hostname === 'sonarr') {
    if (sonarrUnavailable) return Promise.reject(new TypeError('Sonarr is unavailable'));
    if (url.pathname === '/api/v3/system/status') {
      return Promise.resolve(Response.json({ appName: 'Sonarr', version: sonarrReportedVersion }));
    }
    if (url.pathname === '/api/v3/series') {
      return Promise.resolve(Response.json(
        sonarrSeriesPresent
          ? [{
            id: 8,
            tvdbId: 20,
            title: 'Example Show',
            path: sonarrSeriesPath,
          }]
          : [],
      ));
    }
    if (url.pathname === '/api/v3/series/8' && init?.method === 'DELETE') {
      if (!sonarrSeriesPresent) return Promise.resolve(new Response(null, { status: 404 }));
      destinationOrder.push('arr');
      arrDeleteCount++;
      sonarrSeriesDeleteHook?.();
      sonarrSeriesPresent = false;
      sonarrManagedFilePresent = false;
      if (loseSonarrSeriesDeleteResponse) {
        loseSonarrSeriesDeleteResponse = false;
        return Promise.reject(new TypeError('lost Sonarr series deletion response'));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.pathname === '/api/v3/queue') {
      sonarrActivityReadCount++;
      const blocked = sonarrActivityReadCount === blockSonarrActivityAtRead;
      return Promise.resolve(Response.json({
        records: blocked ? [{ id: 901, seriesId: 8, status: 'importing' }] : [],
        totalRecords: blocked ? 1 : 0,
      }));
    }
    if (url.pathname === '/api/v3/command' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(Response.json([]));
    }
    if (url.pathname === '/api/v3/command/81') {
      return Promise.resolve(Response.json({ id: 81, name: 'ManualImport', status: 'completed' }));
    }
    if (url.pathname === '/api/v3/filesystem/type') {
      if (sonarrFilesystemStatus !== null) {
        return Promise.resolve(
          new Response('filesystem unavailable', {
            status: sonarrFilesystemStatus,
          }),
        );
      }
      const path = url.searchParams.get('path');
      const visible = (sonarrManagedFilePresent || sonarrOldPathLingersAfterDelete) &&
          path === sonarrManagedPath ||
        path === sonarrRescanTargetPath ||
        additionalSonarrEpisodes.some((episode) =>
          episode.managedFilePresent && path === episode.managedPath ||
          path === episode.retainedPath
        );
      return Promise.resolve(Response.json({ type: visible ? 'file' : 'folder' }));
    }
    if (url.pathname === '/api/v3/manualimport' && init?.method === 'POST') {
      const candidates = JSON.parse(String(init.body)) as Array<
        { path: string; episodeIds: number[] }
      >;
      return Promise.resolve(Response.json(candidates.map((candidate) => ({
        path: candidate.path,
        size: sonarrManualImportSize,
        seriesId: 8,
        seasonNumber: 1,
        // Model Sonarr independently parsing the retained path. The production
        // preflight deliberately sends no caller-selected episode IDs.
        episodes: candidate.path === sonarrRescanTargetPath
          ? [{ id: 9 }]
          : additionalSonarrEpisodes.flatMap((episode) =>
            candidate.path === episode.retainedPath ? [{ id: episode.episodeId }] : []
          ),
        quality: {
          quality: { id: 6, name: 'WEB 1080p', source: 'web', resolution: 1080 },
          revision: { version: 1, real: 0, isRepack: false },
        },
        languages: [{ id: 1, name: 'English' }],
        releaseGroup: 'Group',
        indexerFlags: 0,
        releaseType: 'webRip',
        rejections: rejectSonarrManualImportPreflight
          ? [{ reason: 'manual import unavailable' }]
          : [],
      }))));
    }
    if (url.pathname === '/api/v3/manualimport' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(Response.json([
        ...(sonarrRescanTargetPath
          ? [{
            path: sonarrRescanTargetPath,
            size: sonarrManualImportSize,
            seriesId: 8,
            episodes: [{ id: 9 }],
            rejections: [],
          }]
          : []),
        ...additionalSonarrEpisodes.map((episode) => ({
          path: episode.retainedPath,
          size: sonarrManualImportSize,
          seriesId: 8,
          episodes: [{ id: episode.episodeId }],
          rejections: [],
        })),
      ]));
    }
    if (
      url.pathname === '/api/v3/history/series' && seasonPackQbit && !sonarrHistoryUnavailable
    ) {
      return Promise.resolve(Response.json([
        {
          id: 501,
          eventType: 'downloadFolderImported',
          downloadId: torrentHash,
          data: {
            droppedPath: '/downloads/release/old.mkv',
            sourcePath: '/downloads/release',
            importedPath: sonarrManagedPath,
          },
        },
        ...additionalSonarrHistory.map((entry, index) => ({
          id: 502 + index,
          eventType: 'downloadFolderImported',
          downloadId: entry.downloadId,
          data: {
            droppedPath: entry.droppedPath,
            sourcePath: entry.droppedPath.slice(0, entry.droppedPath.lastIndexOf('/')),
            importedPath: entry.importedPath,
          },
        })),
      ]));
    }
    if (url.pathname === '/api/v3/history' && seasonPackQbit && !sonarrHistoryUnavailable) {
      const records = [{ seriesId: 8 }, ...(seasonPackForeignOwner ? [{ seriesId: 99 }] : [])];
      return Promise.resolve(Response.json({ totalRecords: records.length, records }));
    }
    if (url.pathname === '/api/v3/episode/monitor' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { episodeIds: number[]; monitored: boolean };
      sonarrMonitorMutationCount++;
      for (const episodeId of body.episodeIds) {
        if (episodeId === 9) sonarrMonitored = body.monitored;
        if (episodeId === 11) sonarrSharedEpisodeMonitored = body.monitored;
        const additional = additionalSonarrEpisodes.find((episode) =>
          episode.episodeId === episodeId
        );
        if (additional) additional.monitored = body.monitored;
      }
      return Promise.resolve(
        Response.json(body.episodeIds.map((id) => ({ id, monitored: body.monitored }))),
      );
    }
    if (url.pathname === '/api/v3/episode') {
      if (url.searchParams.has('seriesId')) {
        sonarrSnapshotReadCount++;
        sonarrSnapshotHook?.();
      }
      return Promise.resolve(Response.json([
        {
          id: 9,
          seriesId: 8,
          seasonNumber: 1,
          episodeNumber: 1,
          episodeFileId: sonarrManagedFilePresent ? sonarrManagedFileId : 0,
          monitored: sonarrMonitored,
        },
        ...(sonarrManagedFileShared
          ? [{
            id: 11,
            seriesId: 8,
            seasonNumber: 1,
            episodeNumber: 2,
            episodeFileId: sonarrManagedFilePresent ? sonarrManagedFileId : 0,
            monitored: sonarrSharedEpisodeMonitored,
          }]
          : []),
        ...(!sonarrManagedFilePresent && sonarrReferenceLingersAfterDelete
          ? [{
            id: 12,
            seriesId: 8,
            seasonNumber: 2,
            episodeNumber: 1,
            episodeFileId: sonarrManagedFileId,
            monitored: true,
          }]
          : []),
        ...additionalSonarrEpisodes.map((episode) => ({
          id: episode.episodeId,
          seriesId: 8,
          seasonNumber: 1,
          episodeNumber: episode.episodeNumber,
          episodeFileId: episode.managedFilePresent ? episode.managedFileId : 0,
          monitored: episode.monitored,
        })),
      ]));
    }
    if (url.pathname === '/api/v3/episodefile') {
      return Promise.resolve(Response.json([
        ...(sonarrManagedFilePresent
          ? [{
            id: sonarrManagedFileId,
            seriesId: sonarrManagedFileSeriesId,
            relativePath: sonarrManagedPath.replace('/tv/Show/', ''),
            path: sonarrManagedPath,
            size: sonarrManagedFileSize,
          }]
          : []),
        ...additionalSonarrEpisodes.flatMap((episode) =>
          episode.managedFilePresent
            ? [{
              id: episode.managedFileId,
              seriesId: 8,
              relativePath: episode.managedPath.replace('/tv/Show/', ''),
              path: episode.managedPath,
              size: 40_000,
            }]
            : []
        ),
      ]));
    }
    const episodePathMatch = /^\/api\/v3\/episode\/(\d+)$/.exec(url.pathname);
    if (episodePathMatch && (init?.method ?? 'GET') === 'GET') {
      const episodeId = Number(episodePathMatch[1]);
      const additional = additionalSonarrEpisodes.find((episode) =>
        episode.episodeId === episodeId
      );
      const shared = episodeId === 11 && sonarrManagedFileShared;
      if (episodeId !== 9 && !additional && !shared) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      if (
        episodeId === 9 &&
        monitorDriftAfterUnmonitoredEvidence && withTransaction((client) =>
            client.prepare(
              "SELECT COUNT(*) FROM deletion_targets WHERE json_extract(snapshot, '$.arrReassignments[0].originalMonitored') = 0",
            ).value<[number]>()?.[0] ?? 0
          ) > 0
      ) {
        monitorDriftAfterUnmonitoredEvidence = false;
        sonarrMonitored = true;
      }
      const monitored = additional?.monitored ??
        (shared ? sonarrSharedEpisodeMonitored : sonarrMonitored);
      if (
        episodeId === 9 &&
        sonarrMonitorMutationCount >= 2 && monitorDriftAfterRestorationReads !== null &&
        --monitorDriftAfterRestorationReads === 0
      ) {
        monitorDriftAfterRestorationReads = null;
        sonarrMonitored = false;
      }
      return Promise.resolve(Response.json({
        id: episodeId,
        seriesId: 8,
        seasonNumber: 1,
        episodeNumber: additional?.episodeNumber ?? (shared ? 2 : 1),
        monitored,
        episodeFileId: additional
          ? additional.managedFilePresent ? additional.managedFileId : 0
          : sonarrManagedFilePresent
          ? sonarrManagedFileId
          : 0,
      }));
    }
    if (episodePathMatch && init?.method === 'PUT') {
      const episodeId = Number(episodePathMatch[1]);
      const additional = additionalSonarrEpisodes.find((episode) =>
        episode.episodeId === episodeId
      );
      const shared = episodeId === 11 && sonarrManagedFileShared;
      if (episodeId !== 9 && !additional && !shared) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      const body = JSON.parse(String(init.body)) as { monitored?: boolean };
      if (
        body.monitored !== undefined &&
        (rejectMonitoringWrites || sonarrMonitorMutationCount + 1 === rejectMonitorAtMutation ||
          episodeId === rejectSonarrMonitoringEpisodeId)
      ) {
        return Promise.resolve(new Response('monitoring rejected', { status: 503 }));
      }
      sonarrMonitorMutationCount++;
      if (typeof body.monitored === 'boolean') {
        if (additional) additional.monitored = body.monitored;
        else if (shared) sonarrSharedEpisodeMonitored = body.monitored;
        else sonarrMonitored = body.monitored;
      }
      if (sonarrMonitorMutationCount === loseMonitorResponseAtMutation) {
        loseMonitorResponseAtMutation = null;
        return Promise.reject(new TypeError('lost Sonarr monitoring response'));
      }
      return Promise.resolve(Response.json({
        id: episodeId,
        monitored: additional?.monitored ??
          (shared ? sonarrSharedEpisodeMonitored : sonarrMonitored),
      }));
    }
    const episodeFilePathMatch = /^\/api\/v3\/episodefile\/(\d+)$/.exec(url.pathname);
    if (episodeFilePathMatch && (init?.method ?? 'GET') === 'GET') {
      const fileId = Number(episodeFilePathMatch[1]);
      const additional = additionalSonarrEpisodes.find((episode) =>
        episode.managedFileId === fileId
      );
      if (fileId !== sonarrManagedFileId && !additional) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      if (additional ? !additional.managedFilePresent : !sonarrManagedFilePresent) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      return Promise.resolve(Response.json({
        id: fileId,
        seriesId: 8,
        relativePath: (additional?.managedPath ?? sonarrManagedPath).replace('/tv/Show/', ''),
        path: additional?.managedPath ?? sonarrManagedPath,
        size: 40_000,
      }));
    }
    if (episodeFilePathMatch && init?.method === 'DELETE') {
      const fileId = Number(episodeFilePathMatch[1]);
      const additional = additionalSonarrEpisodes.find((episode) =>
        episode.managedFileId === fileId
      );
      if (fileId !== sonarrManagedFileId && !additional) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      if (seasonPackQbit) versionDeleteOrder.push('sonarr');
      if (additional) additional.managedFilePresent = false;
      else sonarrManagedFilePresent = false;
      sonarrEpisodeFileDeleteHook?.(fileId);
      sonarrFilesystemStatus = sonarrFilesystemStatusAfterDelete;
      if (!additional && monitorDriftAfterSelectedDelete) sonarrMonitored = true;
      const managedMediaId = additional?.managedMediaId ?? sonarrManagedMediaId;
      if (managedMediaId !== null) {
        const episode = live.get(additional?.ratingKey ?? 'episode-1');
        if (episode?.Media) {
          episode.Media = episode.Media.filter((media) => media.id !== managedMediaId);
        }
      }
      if (loseArrManagedDeleteResponse) {
        loseArrManagedDeleteResponse = false;
        return Promise.reject(new TypeError('lost Sonarr file deletion response'));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.pathname === '/api/v3/command' && init?.method === 'POST') {
      const command = JSON.parse(String(init.body)) as {
        name?: string;
        files?: Array<{ path?: string }>;
      };
      sonarrRescanCount++;
      if (command.name === 'ManualImport' && rejectSonarrManualImportStatus !== null) {
        return Promise.resolve(
          new Response('manual import rejected', { status: rejectSonarrManualImportStatus }),
        );
      }
      const manualImportPath = command.name === 'ManualImport'
        ? command.files?.[0]?.path ?? null
        : null;
      if (
        sonarrRescanTargetPath &&
        (manualImportPath === null || manualImportPath === sonarrRescanTargetPath)
      ) {
        sonarrManagedPath = sonarrRescanTargetPath;
        sonarrManagedFileId++;
        sonarrManagedFilePresent = true;
      }
      for (const episode of additionalSonarrEpisodes) {
        if (manualImportPath !== null && manualImportPath !== episode.retainedPath) continue;
        if (episode.managedFilePresent) sonarrEpisodeFileDeleteHook?.(episode.managedFileId);
        episode.managedPath = episode.retainedPath;
        episode.managedFileId++;
        episode.managedFilePresent = true;
      }
      sonarrRescanHook?.();
      if (loseArrRescanResponse) {
        loseArrRescanResponse = false;
        return Promise.reject(new TypeError('lost Sonarr rescan response'));
      }
      return Promise.resolve(Response.json({
        id: 81,
        name: command.name ?? 'ManualImport',
        status: 'queued',
      }));
    }
  }
  if (url.hostname === 'qbit') {
    qbitRequestCount++;
    if (url.pathname === '/api/v2/app/version') return Promise.resolve(new Response('5.1.2'));
    if (url.pathname === '/api/v2/torrents/info') {
      if (qbitJobsOverride !== null) {
        const requestedHash = url.searchParams.get('hashes');
        return Promise.resolve(
          Response.json(
            qbitJobsOverride.filter((job) => requestedHash === null || job.hash === requestedHash)
              .sort((a, b) => a.hash.localeCompare(b.hash))
              .slice(
                Number(url.searchParams.get('offset') ?? 0),
                Number(url.searchParams.get('offset') ?? 0) +
                  Number(url.searchParams.get('limit') ?? qbitJobsOverride.length),
              )
              .map((job) => ({
                hash: job.hash,
                name: job.name,
                size: job.size,
                total_size: job.files.reduce((sum, file) => sum + file.size, 0),
                content_path: job.contentPath,
                save_path: job.savePath,
              })),
          ),
        );
      }
      return Promise.resolve(Response.json(
        qbitPresent
          ? [{
            hash: torrentHash,
            name: 'Release',
            size: seasonPackQbit ? 40_000 : 100_000,
            total_size: seasonPackMixed ? 80_000 : seasonPackQbit ? 40_000 : 100_000,
            content_path: seasonPackQbit ? '/downloads/release/old.mkv' : '/downloads/release',
            save_path: '/downloads',
          }]
          : [],
      ));
    }
    if (url.pathname === '/api/v2/torrents/files') {
      if (qbitJobsOverride !== null) {
        const hash = url.searchParams.get('hash');
        const job = qbitJobsOverride.find((entry) => entry.hash === hash);
        return Promise.resolve(Response.json(
          job?.files.map((file, index) => ({ index, name: file.name, size: file.size })) ?? [],
        ));
      }
      return Promise.resolve(Response.json([
        {
          index: 0,
          name: seasonPackQbit ? 'release/old.mkv' : 'release/movie.mkv',
          size: seasonPackQbit ? 40_000 : 100_000,
        },
        ...(seasonPackMixed ? [{ index: 1, name: 'release/unselected.mkv', size: 40_000 }] : []),
      ]));
    }
    if (url.pathname === '/api/v2/torrents/delete' && init?.method === 'POST') {
      destinationOrder.push('qbittorrent');
      if (seasonPackQbit) versionDeleteOrder.push('qbit');
      qbitDeleteCount++;
      const hashes = String(init.body instanceof URLSearchParams ? init.body.get('hashes') : '')
        .split('|').filter(Boolean);
      qbitDeleteHook?.(hashes);
      if (qbitJobsOverride !== null) {
        qbitJobsOverride = qbitJobsOverride.filter((job) => !hashes.includes(job.hash));
      }
      qbitPresent = false;
      if (loseQbitDeleteResponse) {
        loseQbitDeleteResponse = false;
        return Promise.reject(new TypeError('lost qBittorrent delete response'));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }
  }
  const seasonChildren = url.pathname.match(/^\/library\/metadata\/([^/]+)\/children$/);
  if (seasonChildren) {
    const seasonRatingKey = decodeURIComponent(seasonChildren[1]);
    const metadata = [...live.values()].filter((item) =>
      item.type === 'episode' && item.parentRatingKey === seasonRatingKey
    );
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  const allLeaves = url.pathname.match(/^\/library\/metadata\/([^/]+)\/allLeaves$/);
  if (allLeaves) {
    const showRatingKey = decodeURIComponent(allLeaves[1]);
    const metadata = [...live.values()].filter((item) =>
      item.type === 'episode' && item.grandparentRatingKey === showRatingKey
    );
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  const mediaDelete = url.pathname.match(/^\/library\/metadata\/([^/]+)\/media\/(\d+)$/);
  if (mediaDelete && init?.method === 'DELETE') {
    versionDeleteOrder.push('plex');
    plexMediaDeleteCount++;
    const ratingKey = decodeURIComponent(mediaDelete[1]);
    const mediaId = Number(mediaDelete[2]);
    const item = live.get(ratingKey);
    if (!item?.Media?.some((media) => media.id === mediaId)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (failDeleteBeforeMutation) return Promise.reject(new TypeError('fetch failed'));
    item.Media = item.Media.filter((media) => media.id !== mediaId);
    plexMediaDeleteHook?.(mediaId);
    if (monitorDriftAfterSelectedDelete) arrMonitored = true;
    if (loseDeleteResponse) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  const metadata = url.pathname.match(/^\/library\/metadata\/([^/]+)$/);
  if (metadata) {
    if (url.searchParams.get('includeOptionalElements') === 'Stream') {
      technicalDetailsRequestCount++;
    }
    const ratingKey = decodeURIComponent(metadata[1]);
    if (pendingPlexMediaRemoval?.ratingKey === ratingKey) {
      const pendingItem = live.get(ratingKey);
      if (pendingItem?.Media) {
        pendingItem.Media = pendingItem.Media.filter((media) =>
          media.id !== pendingPlexMediaRemoval!.mediaId
        );
      }
      pendingPlexMediaRemoval = null;
    }
    const item = live.get(ratingKey);
    if (init?.method === 'DELETE') {
      if (!item) return Promise.resolve(new Response(null, { status: 404 }));
      if (failDeleteBeforeMutation) return Promise.reject(new TypeError('fetch failed'));
      destinationOrder.push('plex');
      wholeDeleteOrder.push(ratingKey);
      live.delete(ratingKey);
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    if (exactMetadataFailureStatus !== null) {
      return Promise.resolve(new Response(null, { status: exactMetadataFailureStatus }));
    }
    return Promise.resolve(
      item
        ? Response.json({ MediaContainer: { Metadata: [item] } })
        : new Response(null, { status: 404 }),
    );
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}) as typeof fetch;

withTransaction((client) => {
  client.prepare(
    "INSERT INTO servers (id, machine_identifier, name, url, access_token, last_connected_at) VALUES (1, 'machine-1', 'Test Plex', 'http://plex', 'token', 1)",
  ).run();
  client.prepare("INSERT INTO settings (id, client_id, active_server_id) VALUES (1, 'test', 1)")
    .run();
  client.prepare(
    "INSERT INTO libraries (server_id, key, title, type, synced_at) VALUES (1, 'movies', 'Movies', 'movie', 1)",
  ).run();
  client.prepare(
    "INSERT INTO libraries (server_id, key, title, type, synced_at) VALUES (1, 'shows', 'Shows', 'show', 1)",
  ).run();
});

function reset(): void {
  plexMachineIdentifier = 'machine-1';
  loseDeleteResponse = false;
  failDeleteBeforeMutation = false;
  plexMediaDeleteCount = 0;
  coordinatedRatingKey = null;
  arrPresent = false;
  retainedLibraryReadHook = null;
  retainedLibraryReads = 0;
  arrDeleteCount = 0;
  sonarrSeriesPath = '/tv/Show';
  destinationOrder.length = 0;
  loseArrRemovalResponse = false;
  radarrExclusion = null;
  arrManagedFilePresent = true;
  arrManagedFileId = 70;
  arrManagedFileSize = 100_000;
  arrExtraMovieFileId = null;
  arrRescanFileSize = 50_000;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrManagedMediaId = null;
  arrRescanTargetPath = null;
  restoreArrPathOnRescan = null;
  restoredArrPath = null;
  arrMoviePath = '/library/Coordinated';
  arrMonitored = true;
  arrMonitorMutationCount = 0;
  loseMonitorResponseAtMutation = null;
  rejectMonitorAtMutation = null;
  monitorDriftAfterSelectedDelete = false;
  monitorDriftAfterRestorationReads = null;
  monitorDriftAfterUnmonitoredEvidence = false;
  rejectMonitoringWrites = false;
  loseArrManagedDeleteResponse = false;
  loseArrMoviePathResponse = false;
  loseArrRescanResponse = false;
  rejectArrRescanStatus = null;
  arrManagedFileReads = 0;
  activatePlaybackOnManagedFileRead = null;
  changeArrOwnershipOnManagedFileRead = null;
  removePlexMediaOnManagedFileRead = null;
  pendingPlexMediaRemoval = null;
  activePlaybackRatingKey = null;
  activeSessionsHook = null;
  sonarrManagedFilePresent = true;
  sonarrManagedFileId = 10;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrManagedFileSize = 40_000;
  sonarrManagedFileSeriesId = 8;
  sonarrManagedMediaId = null;
  sonarrRescanTargetPath = null;
  additionalSonarrEpisodes = [];
  rejectSonarrMonitoringEpisodeId = null;
  rejectSonarrManualImportPreflight = false;
  rejectSonarrManualImportStatus = null;
  sonarrManualImportSize = 40_000;
  sonarrRescanHook = null;
  sonarrRescanCount = 0;
  sonarrMonitorMutationCount = 0;
  sonarrMonitored = true;
  sonarrManagedFileShared = false;
  sonarrSharedEpisodeMonitored = true;
  sonarrOldPathLingersAfterDelete = false;
  sonarrFilesystemStatus = null;
  sonarrFilesystemStatusAfterDelete = null;
  sonarrReferenceLingersAfterDelete = false;
  sonarrReportedVersion = '4.0.19.2979';
  sonarrUnavailable = false;
  sonarrHistoryUnavailable = false;
  sonarrActivityReadCount = 0;
  blockSonarrActivityAtRead = null;
  sonarrSnapshotReadCount = 0;
  sonarrSnapshotHook = null;
  sonarrSeriesPresent = true;
  sonarrSeriesDeleteHook = null;
  sonarrEpisodeFileDeleteHook = null;
  loseSonarrSeriesDeleteResponse = false;
  seasonPackQbit = false;
  seasonPackMixed = false;
  seasonPackForeignOwner = false;
  additionalSonarrHistory = [];
  qbitJobsOverride = null;
  qbitDeleteHook = null;
  qbitPresent = false;
  qbitDeleteCount = 0;
  qbitRequestCount = 0;
  loseQbitDeleteResponse = false;
  fetchCount = 0;
  technicalDetailsRequestCount = 0;
  historyAccountId = null;
  reportedPlexLibraries = null;
  wholeDeleteOrder.length = 0;
  versionDeleteOrder.length = 0;
  live.clear();
  bulkMetadataOverrides.clear();
  exactMetadataFailureStatus = null;
  withTransaction((client) => {
    for (
      const table of [
        'media_version_reservations',
        'deletion_targets',
        'deletion_operations',
        'media_removals',
        'events',
        'sync_log',
        'torrent_delete_attempts',
        'download_file_delete_attempts',
        'arr_delete_attempts',
        'seerr_request_seasons',
        'seerr_requests',
        'seerr_instances',
        'item_media_versions',
        'episode_media_versions',
        'seasons',
        'items',
        'arr_library_mappings',
        'arr_path_mappings',
        'service_path_roots',
        'qbittorrent_path_mappings',
        'plex_path_mappings',
        'qbittorrent_instances',
        'arr_instances',
      ]
    ) client.exec(`DELETE FROM ${table}`);
  });
}

function addMovie(ratingKey: string, mediaIds = [11, 12], tmdbId: number | null = null): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO items (server_id, rating_key, library_key, title, type, file_size, tmdb_id, updated_at) VALUES (1, ?, 'movies', ?, 'movie', 100, ?, 1)",
    ).run(ratingKey, `Movie ${ratingKey}`, tmdbId);
    for (const mediaId of mediaIds) {
      client.prepare(
        "INSERT INTO item_media_versions (server_id, media_id, item_rating_key, library_key, file_size, updated_at) VALUES (1, ?, ?, 'movies', 50, 1)",
      ).run(mediaId, ratingKey);
    }
  });
  live.set(ratingKey, {
    ratingKey,
    title: `Movie ${ratingKey}`,
    type: 'movie',
    librarySectionID: 'movies',
    Guid: tmdbId === null ? [] : [{ id: `tmdb://${tmdbId}` }],
    Media: mediaIds.map((id) => ({
      id,
      Part: [{ file: `/movies/${ratingKey}-${id}.mkv`, size: 50_000 }],
    })),
  });
}

function configureRadarr(withQbit = false): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO arr_instances (id, server_id, type, name, url, api_key, created_at, updated_at) VALUES (1, 1, 'radarr', 'Radarr', 'http://radarr', 'key', 1, 1)",
    ).run();
    client.prepare(
      "INSERT INTO arr_library_mappings (server_id, library_key, arr_instance_id, add_import_exclusion) VALUES (1, 'movies', 1, 1)",
    ).run();
    if (withQbit) {
      client.prepare(
        "INSERT INTO qbittorrent_instances (id, server_id, name, url, username, password, created_at, updated_at) VALUES (1, 1, 'qBittorrent', 'http://qbit', '', '', 1, 1)",
      ).run();
    }
  });
}

function configureSonarr(withQbit = false, verifiedPaths = false): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO arr_instances (id, server_id, type, name, url, api_key, created_at, updated_at) VALUES (2, 1, 'sonarr', 'Sonarr', 'http://sonarr', 'key', 1, 1)",
    ).run();
    client.prepare(
      "INSERT INTO arr_library_mappings (server_id, library_key, arr_instance_id, add_import_exclusion) VALUES (1, 'shows', 2, 0)",
    ).run();
    if (withQbit) {
      client.prepare(
        "INSERT INTO qbittorrent_instances (id, server_id, name, url, username, password, created_at, updated_at) VALUES (1, 1, 'qBittorrent', 'http://qbit', '', '', 1, 1)",
      ).run();
    }
  });
  if (verifiedPaths) {
    withTransaction((client) => {
      client.exec(`
      INSERT INTO arr_path_mappings (arr_instance_id, kind, arr_path, local_path)
        VALUES (2, 'library', '/tv', '/tv');
      INSERT INTO plex_path_mappings (server_id, library_key, plex_path, local_path, case_sensitive, revision,
        validation_plex_path, validation_local_path, validation_size, validated_at, created_at, updated_at)
        VALUES (1, 'shows', '/tv', '/tv', 1, 1, '/tv/sample', '/tv/sample', 10, 1, 1, 1);
      INSERT INTO qbittorrent_path_mappings (server_id, instance_key, qbittorrent_path, local_path, case_sensitive, revision,
        validation_qbittorrent_path, validation_local_path, validation_size, validated_at, created_at, updated_at)
        VALUES (1, 'db:1', '/tv', '/tv', 1, 1, '/tv/sample', '/tv/sample', 10, 1, 1, 1),
               (1, 'db:1', '/downloads', '/downloads', 1, 1, '/downloads/sample', '/downloads/sample', 10, 1, 1, 1);
    `);
    });
  }
}

function addEpisode(): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO items (server_id, rating_key, library_key, title, type, file_size, tvdb_id, updated_at) VALUES (1, 'show-1', 'shows', 'Example Show', 'show', 100, 20, 1)",
    ).run();
    client.prepare(
      "INSERT INTO seasons (server_id, rating_key, show_rating_key, library_key, season_index, title, file_size, updated_at) VALUES (1, 'season-1', 'show-1', 'shows', 1, 'Season 1', 100, 1)",
    ).run();
    for (const mediaId of [21, 22]) {
      client.prepare(
        "INSERT INTO episode_media_versions (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key, library_key, episode_title, episode_index, season_index, file_size, updated_at) VALUES (1, ?, 'episode-1', 'season-1', 'show-1', 'shows', 'Pilot', 1, 1, 40, 1)",
      ).run(mediaId);
    }
  });
  live.set('show-1', {
    ratingKey: 'show-1',
    title: 'Example Show',
    type: 'show',
    librarySectionID: 'shows',
    Guid: [{ id: 'tvdb://20' }],
  });
  live.set('episode-1', {
    ratingKey: 'episode-1',
    title: 'Pilot',
    type: 'episode',
    librarySectionID: 'shows',
    grandparentRatingKey: 'show-1',
    parentRatingKey: 'season-1',
    parentIndex: 1,
    index: 1,
    Media: [21, 22].map((id) => ({
      id,
      Part: [{ file: `/tv/show-1-${id}.mkv`, size: 40_000 }],
    })),
  });
}

function addAdditionalSonarrEpisode(
  episodeNumber: number,
  managedMediaId: number,
  retainedMediaId: number,
): AdditionalSonarrEpisode {
  const ratingKey = `episode-${episodeNumber}`;
  const managedPath = `/tv/Show/Season 01/episode-${episodeNumber}-old.mkv`;
  const retainedPath = `/tv/Show/Season 01/episode-${episodeNumber}-retained.mkv`;
  const state: AdditionalSonarrEpisode = {
    ratingKey,
    episodeId: 9 + episodeNumber,
    episodeNumber,
    managedFileId: 10 + episodeNumber * 10,
    managedPath,
    managedMediaId,
    retainedPath,
    retainedMediaId,
    monitored: true,
    managedFilePresent: true,
  };
  additionalSonarrEpisodes.push(state);
  withTransaction((client) => {
    for (const mediaId of [managedMediaId, retainedMediaId]) {
      client.prepare(
        "INSERT INTO episode_media_versions (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key, library_key, episode_title, episode_index, season_index, file_size, updated_at) VALUES (1, ?, ?, 'season-1', 'show-1', 'shows', ?, ?, 1, 40, 1)",
      ).run(mediaId, ratingKey, `Episode ${episodeNumber}`, episodeNumber);
    }
  });
  live.set(ratingKey, {
    ratingKey,
    title: `Episode ${episodeNumber}`,
    type: 'episode',
    librarySectionID: 'shows',
    grandparentRatingKey: 'show-1',
    parentRatingKey: 'season-1',
    parentIndex: 1,
    index: episodeNumber,
    Media: [
      { id: managedMediaId, Part: [{ file: managedPath, size: 40_000 }] },
      { id: retainedMediaId, Part: [{ file: retainedPath, size: 40_000 }] },
    ],
  });
  return state;
}

Deno.test('relocation snapshot canonicalization sorts objects but preserves array order', () => {
  assertEquals(
    canonicalJson({ z: [{ b: 2, a: 1 }, 3], a: true }),
    '{"a":true,"z":[{"a":1,"b":2},3]}',
  );
  assertThrows(
    () => canonicalJson({ invalid: Number.POSITIVE_INFINITY }),
    Error,
    'invalid number',
  );
});

Deno.test('Sonarr orphan absence requires this snapshot own unlink attempt', () => {
  const proof = { path: '/downloads/episode.mkv' };
  assertEquals(
    canConfirmOrphanAbsenceForCleanup(
      { sonarrReclamation: { proofs: [proof] } } as never,
      proof.path,
    ),
    false,
  );
  assertEquals(
    canConfirmOrphanAbsenceForCleanup(
      { sonarrReclamation: { proofs: [{ ...proof, unlinkAttemptedAt: 10 }] } } as never,
      proof.path,
    ),
    true,
  );
  assertEquals(canConfirmOrphanAbsenceForCleanup({}, proof.path), true);
});

async function settle(): Promise<void> {
  await runDeletionWorkerOnceForTest();
  await Promise.resolve();
}

/** Expose the current library and payload as separate hardlink directory entries. */
