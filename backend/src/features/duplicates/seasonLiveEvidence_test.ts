/// <reference lib="deno.ns" />

import { assertEquals, assertStrictEquals } from '@std/assert';
import type { PlexMediaTechnicalDetails } from '../../integrations/plex/types.ts';
import { classifyEpisodeLiveEvidence, failedEpisodeLiveEvidence } from './seasonLiveEvidence.ts';

function details(): PlexMediaTechnicalDetails {
  return {
    width: 1920,
    height: 1080,
    duration: 1,
    videoProfile: null,
    videoBitDepth: 8,
    videoDynamicRange: null,
    videoFrameRate: null,
    videoScanType: null,
    audioCodec: 'aac',
    audioChannels: 2,
    audioProfile: null,
    audioStreams: [],
    subtitleStreams: [],
    streamDetailsAvailable: true,
  };
}

Deno.test('season live evidence preserves complete exact media-id equality', () => {
  const versions = new Map([[2, details()], [1, details()]]);
  const evidence = classifyEpisodeLiveEvidence([1, 2], versions);
  assertEquals(evidence.status, 'complete');
  assertStrictEquals(evidence.versions, versions);
});

Deno.test('season live evidence keeps missing and unexpected ids separate', () => {
  const versions = new Map([[2, details()], [3, details()]]);
  const evidence = classifyEpisodeLiveEvidence([1, 2], versions);
  assertEquals(evidence.status, 'mismatch');
  if (evidence.status !== 'mismatch') throw new Error('expected mismatch evidence');
  assertEquals(evidence.missingExpectedMediaIds, [1]);
  assertEquals(evidence.unexpectedLiveMediaIds, [3]);
  assertStrictEquals(evidence.versions, versions);
});

Deno.test('season live evidence preserves request failure separately', () => {
  const evidence = failedEpisodeLiveEvidence();
  assertEquals(evidence.status, 'failed');
  assertEquals(evidence.versions.size, 0);
});
