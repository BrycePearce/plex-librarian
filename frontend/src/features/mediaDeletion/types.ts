import type { DuplicateMovieGroup, MediaVersion } from "../../lib/api.ts";

// The whole-title deletion workflow is shared by the stale and duplicates pages.
// Keep its input limited to the fields the confirmation/preview UI actually needs so
// callers do not have to manufacture stale/watch-history data for a non-stale item.
export interface WholeItemDeletionCandidate {
  ratingKey: string;
  libraryKey: string;
  title: string;
  type: string;
  fileSize: number | null;
  versions?: MediaVersion[];
  hasDuplicateEpisodes?: boolean;
}

export function duplicateMovieDeletionCandidate(
  group: DuplicateMovieGroup,
): WholeItemDeletionCandidate {
  return {
    ratingKey: group.ratingKey,
    libraryKey: group.libraryKey,
    title: group.title,
    type: "movie",
    fileSize: group.combinedFileSize,
    versions: group.versions,
  };
}
