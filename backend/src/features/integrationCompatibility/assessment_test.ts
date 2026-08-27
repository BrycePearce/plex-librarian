import { assertEquals, assertStringIncludes } from '@std/assert';
import { assessArr, assessQbittorrent, compatibleSeerr } from './assessment.ts';

const identity = {
  key: 'sonarr:1',
  instanceId: 1,
  kind: 'sonarr' as const,
  name: 'TV',
};

Deno.test('old Sonarr remains connected but reports limited season cleanup', () => {
  const result = assessArr(identity, '4.0.18.2800');
  assertEquals(result.status, 'limited');
  assertStringIncludes(result.message ?? '', 'coordinated season cleanup');
});

Deno.test('supported Sonarr reports compatible', () => {
  assertEquals(assessArr(identity, '4.0.19.2979').status, 'compatible');
});

Deno.test('future and unknown Arr versions are informational instead of limitations', () => {
  assertEquals(assessArr(identity, '5.0.0.0').status, 'unverified');
  assertEquals(assessArr(identity, null).status, 'unverified');
  const radarr = { ...identity, key: 'radarr:2', kind: 'radarr' as const };
  assertEquals(assessArr(radarr, '7.0.0.0').status, 'unverified');
  assertEquals(assessArr(radarr, '6.3.0.10514').status, 'compatible');
});

Deno.test('qBittorrent compatibility follows its Web API version', () => {
  const qbit = { ...identity, key: 'qbittorrent:2', kind: 'qbittorrent' as const };
  assertEquals(assessQbittorrent(qbit, 'v5.2.0', '2.14.1').status, 'compatible');
  assertEquals(assessQbittorrent(qbit, 'v4.0.4', '1.9').status, 'incompatible');
});

Deno.test('Seerr is compatible after its authenticated behavior probe succeeds', () => {
  const seerr = { ...identity, key: 'seerr:3', kind: 'seerr' as const };
  assertEquals(compatibleSeerr(seerr, '3.4.1').status, 'compatible');
});
