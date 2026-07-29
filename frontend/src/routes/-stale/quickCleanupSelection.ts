export function selectedQuickCleanupKeys(
  availableRatingKeys: readonly string[],
  excludedRatingKeys: ReadonlySet<string>,
): Set<string> {
  return new Set(
    availableRatingKeys.filter((ratingKey) => !excludedRatingKeys.has(ratingKey)),
  );
}

export function updateQuickCleanupExclusions(
  current: ReadonlySet<string>,
  ratingKeys: readonly string[],
  excluded: boolean,
): Set<string> {
  const next = new Set(current);
  for (const ratingKey of ratingKeys) {
    if (excluded) next.add(ratingKey);
    else next.delete(ratingKey);
  }
  return next;
}
