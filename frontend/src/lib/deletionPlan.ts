export function partitionDeletionRatingKeys(
  ratingKeys: readonly string[],
  coordinatedRatingKeys: readonly string[],
): { coordinated: string[]; plexOnly: string[] } {
  const selected = new Set(ratingKeys);
  const coordinated = [...new Set(coordinatedRatingKeys)].filter((key) => selected.has(key));
  const coordinatedSet = new Set(coordinated);
  return {
    coordinated,
    plexOnly: [...selected].filter((key) => !coordinatedSet.has(key)),
  };
}
