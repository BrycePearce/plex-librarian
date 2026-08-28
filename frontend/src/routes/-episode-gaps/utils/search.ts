/// <reference types="vite/client" />

import type { EpisodeGapsScope, EpisodeGapsSort, EpisodeGapsStatusFilter } from "@shared/types";
import type { EpisodeGapsSearch } from "../types/index.ts";

export const EPISODE_GAPS_PAGE_SIZE = 50;

export function validateEpisodeGapsSearch(
  search: Record<string, unknown>,
): EpisodeGapsSearch {
  const status = ["gaps", "irregular", "all"].includes(String(search.status))
    ? search.status as EpisodeGapsStatusFilter
    : "gaps";
  const scope = ["episode", "season"].includes(String(search.scope))
    ? search.scope as EpisodeGapsScope
    : "episode";
  const requestedSort = ["missingCount", "title", "seasonIndex", "auditSyncedAt"].includes(
      String(search.sort),
    )
    ? search.sort as EpisodeGapsSort
    : "missingCount";
  const sort = scope === "season" && requestedSort === "seasonIndex"
    ? "missingCount"
    : requestedSort;
  const offset = Number(search.offset);
  return {
    scope,
    status,
    sort,
    order: search.order === "asc" ? "asc" : "desc",
    libraryKey: typeof search.libraryKey === "string" && search.libraryKey
      ? search.libraryKey
      : undefined,
    search: typeof search.search === "string" ? search.search.slice(0, 200) : undefined,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    fixture: import.meta.env?.DEV &&
        ["gaps", "clean", "no-tv", "unaudited", "loading", "syncing", "error", "large"]
          .includes(String(search.fixture))
      ? search.fixture as EpisodeGapsSearch["fixture"]
      : undefined,
  };
}

export function switchEpisodeGapsScope(
  search: EpisodeGapsSearch,
  scope: "episode" | "season",
): EpisodeGapsSearch {
  return { ...search, scope, sort: "missingCount", order: "desc", offset: 0 };
}
