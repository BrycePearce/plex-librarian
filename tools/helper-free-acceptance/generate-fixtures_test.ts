import { deepStrictEqual as equal, rejects } from 'node:assert/strict';
import { bencode, makeTorrent } from './generate-fixtures.ts';

Deno.test('private fixture torrent hashes concatenate bytes across file boundaries', async () => {
  const first = new Uint8Array(262140).fill(97);
  const second = new Uint8Array(10).fill(98);
  const joined = new Uint8Array(262150);
  joined.set(first);
  joined.set(second, first.length);
  const pieces = new Uint8Array(40);
  pieces.set(new Uint8Array(await crypto.subtle.digest('SHA-1', joined.slice(0, 262144))));
  pieces.set(new Uint8Array(await crypto.subtle.digest('SHA-1', joined.slice(262144))), 20);
  const info = {
    files: [{ length: first.length, path: ['one.mkv'] }, {
      length: second.length,
      path: ['two.mkv'],
    }],
    name: 'Fixture',
    'piece length': 262144,
    pieces,
    private: 1,
  };
  const torrent = await makeTorrent('Fixture', [
    { name: 'one.mkv', bytes: first },
    { name: 'two.mkv', bytes: second },
  ]);
  equal(torrent.bytes, bencode({ info }));
  equal(
    torrent.hash,
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array(bencode(info)))))
      .map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  );
});

Deno.test('fixture torrents reject traversal and duplicate file entries', async () => {
  const file = { name: 'one.mkv', bytes: new Uint8Array([1]) };
  await rejects(() => makeTorrent('../escape', [file]));
  await rejects(() => makeTorrent('Fixture', [{ ...file, name: '../escape.mkv' }]));
  await rejects(() => makeTorrent('Fixture', [file, file]));
  await rejects(() => makeTorrent('Fixture', []));
});
