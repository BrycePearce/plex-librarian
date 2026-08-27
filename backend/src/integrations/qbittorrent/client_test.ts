import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { normalizeQbittorrentUrl, QbittorrentApiError, QbittorrentClient } from './client.ts';

Deno.test('normalizeQbittorrentUrl preserves a reverse-proxy base path', () => {
  assertEquals(
    normalizeQbittorrentUrl('https://media.example/qbit/api/v2/'),
    'https://media.example/qbit',
  );
});

Deno.test('normalizeQbittorrentUrl rejects credentials embedded in the URL', () => {
  assertThrows(
    () => normalizeQbittorrentUrl('http://admin:secret@qbit:8080'),
    Error,
    'must not include a username or password',
  );
});

Deno.test('client authenticates and maps torrent details without exposing tracker passkeys', async () => {
  const hash = 'a'.repeat(40);
  const calls: string[] = [];
  const client = new QbittorrentClient('http://qbit:8080', 'user', 'pass', (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/app/version') && !new Headers(init?.headers).has('Cookie')) {
      return Promise.resolve(new Response('Forbidden', { status: 403 }));
    }
    if (url.endsWith('/auth/login')) {
      return Promise.resolve(new Response('Ok.', { headers: { 'Set-Cookie': 'SID=abc; path=/' } }));
    }
    if (url.includes('/torrents/info')) {
      return Promise.resolve(Response.json([{
        hash,
        name: 'Release',
        size: 12,
        total_size: 12,
        uploaded: 24,
        ratio: 2,
        seeding_time: 30,
        completion_on: 40,
        content_path: '/downloads/Release',
        save_path: '/downloads',
        tracker: 'https://tracker.example/secret/passkey',
        state: 'uploading',
      }]));
    }
    return Promise.resolve(Response.json([{ index: 0, name: 'Release/movie.mkv', size: 12 }]));
  });
  const torrent = await client.torrent(hash);
  assertEquals(torrent?.trackerHost, 'tracker.example');
  assertEquals(torrent?.fileCount, 1);
  assertEquals(torrent?.files, [{ path: 'Release/movie.mkv', size: 12 }]);
  assertEquals(torrent?.filesTruncated, false);
  assertEquals(calls.length, 5);
});

Deno.test('client supports qBittorrent authentication bypass without credentials', async () => {
  const calls: string[] = [];
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input, init) => {
    const url = String(input);
    calls.push(url);
    assertEquals(new Headers(init?.headers).has('Cookie'), false);
    if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    return Promise.resolve(Response.json([]));
  });

  assertEquals(await client.testConnection(), { version: 'v5.1.2' });
  assertEquals(await client.torrent('a'.repeat(40)), null);
  assertEquals(calls, [
    'http://qbit:8080/api/v2/app/version',
    'http://qbit:8080/api/v2/app/version',
    `http://qbit:8080/api/v2/torrents/info?hashes=${'a'.repeat(40)}`,
  ]);
});

Deno.test('client supports qBittorrent 5.2 login responses with no content', async () => {
  const calls: string[] = [];
  const client = new QbittorrentClient('http://qbit:8080', 'user', 'pass', (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/app/version') && !new Headers(init?.headers).has('Cookie')) {
      return Promise.resolve(new Response('Forbidden', { status: 403 }));
    }
    if (url.endsWith('/auth/login')) {
      return Promise.resolve(
        new Response(null, {
          status: 204,
          headers: { 'Set-Cookie': 'SID_8080=abc; path=/' },
        }),
      );
    }
    assertEquals(new Headers(init?.headers).get('Cookie'), 'SID_8080=abc');
    return Promise.resolve(new Response('v5.2.0'));
  });

  assertEquals(await client.testConnection(), { version: 'v5.2.0' });
  assertEquals(calls, [
    'http://qbit:8080/api/v2/app/version',
    'http://qbit:8080/api/v2/auth/login',
    'http://qbit:8080/api/v2/app/version',
  ]);
});

Deno.test('client accepts any successful login status when a session cookie is issued', async () => {
  const client = new QbittorrentClient('http://qbit:8080', 'user', 'pass', (input, init) => {
    const url = String(input);
    if (url.endsWith('/app/version') && !new Headers(init?.headers).has('Cookie')) {
      return Promise.resolve(new Response('Forbidden', { status: 403 }));
    }
    if (url.endsWith('/auth/login')) {
      return Promise.resolve(
        new Response(null, {
          status: 202,
          headers: { 'Set-Cookie': 'SID=abc; path=/' },
        }),
      );
    }
    return Promise.resolve(new Response('vFuture'));
  });

  assertEquals(await client.testConnection(), { version: 'vFuture' });
});

Deno.test('client rejects failed authentication', async () => {
  const client = new QbittorrentClient(
    'http://qbit:8080',
    'bad',
    'bad',
    (input) =>
      Promise.resolve(
        String(input).endsWith('/app/version')
          ? new Response('Forbidden', { status: 403 })
          : new Response('Fails.', { status: 200 }),
      ),
  );
  await assertRejects(
    () => client.testConnection(),
    QbittorrentApiError,
    'qBittorrent login failed',
  );
});

Deno.test('client rejects oversized qBittorrent manifests before retaining them', async () => {
  const hash = 'b'.repeat(40);
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    const url = String(input);
    if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    if (url.includes('/torrents/info')) {
      return Promise.resolve(Response.json([{
        hash,
        name: 'large',
        size: 10_001,
        total_size: 10_001,
        content_path: '/downloads/large',
        save_path: '/downloads',
      }]));
    }
    return Promise.resolve(Response.json(
      Array.from(
        { length: 10_001 },
        (_, index) => ({ index, name: `large/${index}.mkv`, size: 1 }),
      ),
    ));
  });

  await assertRejects(
    () => client.torrent(hash),
    QbittorrentApiError,
    '10000-record safety limit',
  );
});

Deno.test('client rejects a qBittorrent manifest response over the byte limit', async () => {
  const hash = 'b'.repeat(40);
  const oversizedManifest = JSON.stringify([{
    index: 0,
    name: `large/${'a'.repeat(8 * 1024 * 1024)}.mkv`,
    size: 1,
  }]);
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    const url = String(input);
    if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    if (url.includes('/torrents/info')) {
      return Promise.resolve(Response.json([{
        hash,
        size: 1,
        total_size: 1,
        content_path: '/downloads/large',
        save_path: '/downloads',
      }]));
    }
    return Promise.resolve(new Response(oversizedManifest));
  });

  await assertRejects(
    () => client.torrent(hash),
    QbittorrentApiError,
    '8388608-byte safety limit',
  );
});

Deno.test('client rejects an ambiguous exact torrent summary before reading its manifest', async () => {
  const hash = 'b'.repeat(40);
  let manifestRead = false;
  const summary = {
    hash,
    size: 1,
    total_size: 1,
    content_path: '/downloads/release',
    save_path: '/downloads',
  };
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    const url = String(input);
    if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    if (url.includes('/torrents/info')) {
      return Promise.resolve(Response.json([summary, summary]));
    }
    manifestRead = true;
    return Promise.resolve(Response.json([{ index: 0, name: 'release/one.mkv', size: 1 }]));
  });

  await assertRejects(
    () => client.torrent(hash),
    QbittorrentApiError,
    'ambiguous torrent identity',
  );
  assertEquals(manifestRead, false);
});

Deno.test('client rejects a manifest whose byte sum disagrees with total_size', async () => {
  const hash = 'c'.repeat(40);
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    const url = String(input);
    if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    if (url.includes('/torrents/info')) {
      return Promise.resolve(Response.json([{
        hash,
        name: 'partial',
        size: 1,
        total_size: 2,
        content_path: '/downloads/partial',
        save_path: '/downloads',
      }]));
    }
    return Promise.resolve(Response.json([{ index: 0, name: 'partial/one.mkv', size: 1 }]));
  });
  await assertRejects(
    () => client.torrent(hash),
    QbittorrentApiError,
    'incomplete torrent manifest',
  );
});

Deno.test('client rejects missing, duplicate, negative, non-integer, and noncontiguous indexes', async () => {
  const hash = 'c'.repeat(40);
  const manifests: Array<Array<Record<string, unknown>>> = [
    [{ name: 'release/one.mkv', size: 1 }],
    [
      { index: 0, name: 'release/one.mkv', size: 1 },
      { index: 0, name: 'release/two.mkv', size: 1 },
    ],
    [{ index: -1, name: 'release/one.mkv', size: 1 }],
    [{ index: 0.5, name: 'release/one.mkv', size: 1 }],
    [{ index: 1, name: 'release/one.mkv', size: 1 }],
  ];
  for (const manifest of manifests) {
    const totalSize = manifest.reduce((total, file) => total + Number(file.size), 0);
    const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
      const url = String(input);
      if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.1'));
      if (url.includes('/torrents/info')) {
        return Promise.resolve(Response.json([{
          hash,
          size: totalSize,
          total_size: totalSize,
          content_path: '/downloads/release',
          save_path: '/downloads',
        }]));
      }
      return Promise.resolve(Response.json(manifest));
    });
    await assertRejects(
      () => client.torrent(hash),
      QbittorrentApiError,
      'malformed torrent manifest',
    );
  }
});

Deno.test('client rejects missing, negative, non-integer, unsafe, and coerced manifest sizes', async () => {
  const hash = 'c'.repeat(40);
  const invalidSizes: unknown[] = [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'];
  for (const invalidSize of invalidSizes) {
    const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
      const url = String(input);
      if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.1'));
      if (url.includes('/torrents/info')) {
        return Promise.resolve(Response.json([{
          hash,
          size: 1,
          total_size: 1,
          content_path: '/downloads/release',
          save_path: '/downloads',
        }]));
      }
      return Promise.resolve(Response.json([{
        index: 0,
        name: 'release/one.mkv',
        size: invalidSize,
      }]));
    });
    await assertRejects(
      () => client.torrent(hash),
      QbittorrentApiError,
      'malformed torrent manifest',
    );
  }
});

Deno.test('client rejects malformed, duplicate, and file-directory-conflicting manifest paths', async () => {
  const hash = 'c'.repeat(40);
  const manifests: Array<Array<Record<string, unknown>>> = [
    [{ index: 0, name: '/release/one.mkv', size: 1 }],
    [{ index: 0, name: 'C:\\release\\one.mkv', size: 1 }],
    [{ index: 0, name: 'release/../one.mkv', size: 1 }],
    [
      { index: 0, name: 'release/one.mkv', size: 1 },
      { index: 1, name: 'RELEASE/ONE.MKV', size: 1 },
    ],
    [
      { index: 0, name: 'release', size: 1 },
      { index: 1, name: 'release/one.mkv', size: 1 },
    ],
  ];
  for (const manifest of manifests) {
    const totalSize = manifest.reduce((total, file) => total + Number(file.size), 0);
    const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
      const url = String(input);
      if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.1'));
      if (url.includes('/torrents/info')) {
        return Promise.resolve(Response.json([{
          hash,
          size: totalSize,
          total_size: totalSize,
          content_path: '/downloads/release',
          save_path: '/downloads',
        }]));
      }
      return Promise.resolve(Response.json(manifest));
    });
    await assertRejects(() => client.torrent(hash), QbittorrentApiError);
  }
});

Deno.test('client rejects malformed total_size and size greater than total_size', async () => {
  const hash = 'c'.repeat(40);
  const invalidSizes = [
    { size: 1 },
    { size: 0, total_size: 0 },
    { size: 0, total_size: -1 },
    { size: 0, total_size: 1.5 },
    { size: 0, total_size: Number.MAX_SAFE_INTEGER + 1 },
    { size: 2, total_size: 1 },
  ];
  for (const invalid of invalidSizes) {
    const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
      if (String(input).endsWith('/app/version')) return Promise.resolve(new Response('v5.1.1'));
      return Promise.resolve(Response.json([{
        hash,
        content_path: '/downloads/release',
        save_path: '/downloads',
        ...invalid,
      }]));
    });
    await assertRejects(
      () => client.torrent(hash),
      QbittorrentApiError,
      'malformed torrent size',
    );
  }
});

Deno.test('client rejects exact summary identity drift across the manifest read', async () => {
  const hash = 'c'.repeat(40);
  let summaryReads = 0;
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    const url = String(input);
    if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.1'));
    if (url.includes('/torrents/files')) {
      return Promise.resolve(Response.json([{ index: 0, name: 'release/one.mkv', size: 1 }]));
    }
    summaryReads++;
    return Promise.resolve(Response.json([{
      hash,
      size: 1,
      total_size: 1,
      content_path: summaryReads === 1 ? '/downloads/release' : '/downloads/moved',
      save_path: '/downloads',
    }]));
  });
  await assertRejects(
    () => client.torrent(hash),
    QbittorrentApiError,
    'identity changed during manifest read',
  );
});

Deno.test('client accepts a qBittorrent 5.1.1 indexed multi-file manifest without num_files', async () => {
  const hash = 'c'.repeat(40);
  const files = Array.from({ length: 21 }, (_, index) => ({
    index,
    name: `Dark Angel Season 1/episode-${index + 1}.mkv`,
    size: index + 1,
  }));
  const totalSize = files.reduce((total, file) => total + file.size, 0);
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    const url = String(input);
    if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.1'));
    if (url.includes('/torrents/info')) {
      return Promise.resolve(Response.json([{
        hash,
        name: 'Dark Angel Season 1',
        size: totalSize,
        total_size: totalSize,
        content_path: '/downloads/Dark Angel Season 1',
        save_path: '/downloads',
      }]));
    }
    return Promise.resolve(Response.json(files));
  });

  const torrent = await client.torrent(hash);
  assertEquals(torrent?.fileCount, 21);
  assertEquals(torrent?.manifestFiles.length, 21);
});

Deno.test('client rejects a returned torrent hash that differs from the requested hash', async () => {
  const requested = 'd'.repeat(40);
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    if (String(input).endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    return Promise.resolve(Response.json([{
      hash: 'e'.repeat(40),
      name: 'replacement',
      content_path: '/downloads/replacement',
      save_path: '/downloads',
    }]));
  });
  await assertRejects(
    () => client.torrent(requested),
    QbittorrentApiError,
    'nonmatching torrent identity',
  );
});

Deno.test('client rejects whitespace-normalized torrent authority', async () => {
  const hash = 'f'.repeat(40);
  const identityClient = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    if (String(input).endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    return Promise.resolve(Response.json([{ hash: ` ${hash}` }]));
  });
  await assertRejects(() => identityClient.torrent(hash), QbittorrentApiError);

  const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    const url = String(input);
    if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    if (url.includes('/torrents/info')) {
      return Promise.resolve(Response.json([{
        hash,
        size: 1,
        total_size: 1,
        content_path: '/downloads/release',
        save_path: '/downloads',
      }]));
    }
    return Promise.resolve(Response.json([{ index: 0, name: 'release/episode.mkv ', size: 1 }]));
  });
  await assertRejects(
    () => client.torrent(hash),
    QbittorrentApiError,
    'malformed torrent manifest',
  );
});

Deno.test('direct discovery rejects summaries without absolute content paths', async () => {
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    if (String(input).endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    return Promise.resolve(Response.json([{
      hash: 'a'.repeat(40),
      content_path: '',
      save_path: '/downloads',
      total_size: 10,
    }]));
  });
  await assertRejects(
    () => client.discoverySummaries(),
    QbittorrentApiError,
    'malformed direct-discovery summaries',
  );
});

Deno.test('direct discovery rejects a truncated job inventory', async () => {
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input) => {
    if (String(input).endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    return Promise.resolve(Response.json(Array.from({ length: 501 }, (_, index) => ({
      hash: index.toString(16).padStart(40, '0'),
      content_path: `/downloads/${index}`,
      save_path: '/downloads',
      total_size: 10,
    }))));
  });
  await assertRejects(
    () => client.discoverySummaries(),
    QbittorrentApiError,
    'direct discovery is truncated',
  );
});
