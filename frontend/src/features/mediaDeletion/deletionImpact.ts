import type { WholeItemDeletionCandidate } from "./types.ts";

export function deletionImpact(items: readonly WholeItemDeletionCandidate[]): {
  totalSize: number;
  unknownSizeCount: number;
} {
  const totalSize = items.reduce((sum, item) => sum + (item.fileSize ?? 0), 0);
  const unknownSizeCount =
    items.filter((item) => item.fileSize === null).length;
  return {
    totalSize,
    unknownSizeCount,
  };
}
