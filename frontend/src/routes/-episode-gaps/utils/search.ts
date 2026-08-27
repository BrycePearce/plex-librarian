import type { EpisodeGapsSort, EpisodeGapsStatusFilter } from "@shared/types";
import type { EpisodeGapsSearch } from "../types/index.ts";

export const EPISODE_GAPS_PAGE_SIZE = 50;

export function validateEpisodeGapsSearch(
  search: Record<string, unknown>,
): EpisodeGapsSearch {
  const status = ["gaps", "irregular", "all"].includes(String(search.status))
    ? search.status as EpisodeGapsStatusFilter
    : "gaps";
  const sort = ["missingCount", "title", "seasonIndex", "auditSyncedAt"].includes(
      String(search.sort),
    )
    ? search.sort as EpisodeGapsSort
    : "missingCount";
  const offset = Number(search.offset);
  return {
    status,
    sort,
    order: search.order === "asc" ? "asc" : "desc",
    libraryKey: typeof search.libraryKey === "string" && search.libraryKey
      ? search.libraryKey
      : undefined,
    search: typeof search.search === "string" ? search.search.slice(0, 200) : undefined,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    fixture: import.meta.env.DEV &&
        ["gaps", "clean", "no-tv", "unaudited", "loading", "syncing", "error", "large"]
          .includes(String(search.fixture))
      ? search.fixture as EpisodeGapsSearch["fixture"]
      : undefined,
  };
}
