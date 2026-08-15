import type { PlexMediaTechnicalDetails } from '../../integrations/plex/types.ts';

export type EpisodeLiveEvidence =
  | {
    status: 'complete';
    versions: Map<number, PlexMediaTechnicalDetails>;
  }
  | {
    status: 'mismatch';
    versions: Map<number, PlexMediaTechnicalDetails>;
    missingExpectedMediaIds: number[];
    unexpectedLiveMediaIds: number[];
  }
  | {
    status: 'failed';
    versions: Map<number, never>;
  };

export function failedEpisodeLiveEvidence(): EpisodeLiveEvidence {
  return { status: 'failed', versions: new Map<number, never>() };
}

export function classifyEpisodeLiveEvidence(
  expectedMediaIds: readonly number[],
  versions: Map<number, PlexMediaTechnicalDetails>,
): EpisodeLiveEvidence {
  const expectedIds = [...new Set(expectedMediaIds)].sort((a, b) => a - b);
  const liveIds = [...versions.keys()].sort((a, b) => a - b);
  const expectedSet = new Set(expectedIds);
  const liveSet = new Set(liveIds);
  const missingExpectedMediaIds = expectedIds.filter((id) => !liveSet.has(id));
  const unexpectedLiveMediaIds = liveIds.filter((id) => !expectedSet.has(id));
  return missingExpectedMediaIds.length === 0 && unexpectedLiveMediaIds.length === 0
    ? { status: 'complete', versions }
    : { status: 'mismatch', versions, missingExpectedMediaIds, unexpectedLiveMediaIds };
}
