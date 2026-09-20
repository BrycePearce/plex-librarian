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

/** Keep each title's selected versions together and bound every service preview. */
export function serviceCleanupBatches(
  plans: readonly {
    candidate: Pick<SmartDuplicateCandidate, "libraryKey" | "ratingKey">;
    deleteMediaIds: readonly number[];
  }[],
): Array<{ libraryKey: string; targets: Array<{ ratingKey: string; mediaId: number }> }> {
  const libraries = new Map<string, typeof plans[number][]>();
  for (const plan of plans) {
    const group = libraries.get(plan.candidate.libraryKey) ?? [];
    group.push(plan);
    libraries.set(plan.candidate.libraryKey, group);
  }
  const batches: Array<
    { libraryKey: string; targets: Array<{ ratingKey: string; mediaId: number }> }
  > = [];
  for (const [libraryKey, group] of libraries) {
    let targets: Array<{ ratingKey: string; mediaId: number }> = [];
    for (const plan of group) {
      if (plan.deleteMediaIds.length > 200) throw new Error("Too many versions for one title");
      if (targets.length + plan.deleteMediaIds.length > 200) {
        batches.push({ libraryKey, targets });
        targets = [];
      }
      targets.push(
        ...plan.deleteMediaIds.map((mediaId) => ({ ratingKey: plan.candidate.ratingKey, mediaId })),
      );
    }
    if (targets.length) batches.push({ libraryKey, targets });
  }
  return batches;
}
