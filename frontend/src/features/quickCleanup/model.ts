import type { SmartDuplicateCandidate } from "../../lib/api.ts";

export function candidateKey(candidate: SmartDuplicateCandidate): string {
  return `${candidate.mediaType}:${candidate.ratingKey}`;
}

export function selectedSize(
  candidates: SmartDuplicateCandidate[],
  selected: ReadonlySet<string>,
  keepSelections: ReadonlyMap<string, number>,
): number | null {
  const chosen = candidates.filter((candidate) => selected.has(candidateKey(candidate)));
  const deleted = chosen.flatMap((candidate) => {
    const keepMediaId = keepSelections.get(candidateKey(candidate)) ?? candidate.keepMediaId;
    return candidate.versions.filter((version) => version.mediaId !== keepMediaId);
  });
  return deleted.every((version) => version.fileSize != null)
    ? deleted.reduce((total, version) => total + version.fileSize!, 0)
    : null;
}

export function candidateReclaimableSize(
  candidate: SmartDuplicateCandidate,
  keepMediaId: number,
): number | null {
  const deleted = candidate.versions.filter((version) => version.mediaId !== keepMediaId);
  return deleted.every((version) => version.fileSize != null)
    ? deleted.reduce((total, version) => total + version.fileSize!, 0)
    : null;
}
