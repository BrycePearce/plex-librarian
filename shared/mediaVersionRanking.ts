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

export function bestMediaVersionCandidate(
  versions: readonly MediaVersionQualityCandidate[],
  candidateMediaIds: readonly number[],
): number | null {
  const candidates = new Set(candidateMediaIds);
  const eligible = versions.filter((version) => candidates.has(version.mediaId));
  if (eligible.length === 0) return null;
  return eligible.reduce((best, version) => {
    const bestRank = [
      resolutionScore(best),
      best.bitrate ?? 0,
      best.fileSize ?? 0,
      -best.mediaId,
    ];
    const rank = [
      resolutionScore(version),
      version.bitrate ?? 0,
      version.fileSize ?? 0,
      -version.mediaId,
    ];
    for (let index = 0; index < rank.length; index++) {
      if (rank[index] === bestRank[index]) continue;
      return rank[index]! > bestRank[index]! ? version : best;
    }
    return best;
  }).mediaId;
}
