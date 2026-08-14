export interface MediaVersionQualityCandidate {
  mediaId: number;
  videoResolution: string | null;
  height: number | null;
  bitrate: number | null;
  fileSize: number | null;
}

function resolutionScore(version: MediaVersionQualityCandidate): number {
  if (version.height !== null) return version.height;
  const normalized = version.videoResolution?.toLowerCase() ?? '';
  if (normalized.includes('4k')) return 2160;
  const numeric = Number(normalized.match(/\d+/)?.[0]);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function compareMediaVersionQuality(
  left: MediaVersionQualityCandidate,
  right: MediaVersionQualityCandidate,
): number {
  const leftRank = [resolutionScore(left), left.bitrate ?? 0, left.fileSize ?? 0];
  const rightRank = [resolutionScore(right), right.bitrate ?? 0, right.fileSize ?? 0];
  for (let index = 0; index < leftRank.length; index++) {
    if (leftRank[index] === rightRank[index]) continue;
    return leftRank[index]! > rightRank[index]! ? 1 : -1;
  }
  return 0;
}

export function bestMediaVersionCandidate(
  versions: readonly MediaVersionQualityCandidate[],
  candidateMediaIds: readonly number[],
): number | null {
  const candidates = new Set(candidateMediaIds);
  const eligible = versions.filter((version) => candidates.has(version.mediaId));
  if (eligible.length === 0) return null;
  return eligible.reduce((best, version) => {
    const comparison = compareMediaVersionQuality(version, best);
    if (comparison !== 0) return comparison > 0 ? version : best;
    return version.mediaId < best.mediaId ? version : best;
  }).mediaId;
}
