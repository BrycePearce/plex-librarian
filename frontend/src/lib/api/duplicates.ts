import { apiFetch } from "./client.ts";
import type {
  DuplicateDirectoryResponse,
  DuplicatesResponse,
  MediaVersionsRefreshResponse,
  SeasonVersionAnalysisResponse,
  SmartDuplicateAnalysisResponse,
} from "@shared/types";
import type { DuplicateComparisonFilter } from "@shared/mediaComparison";

type DuplicateListParams = {
  type?: "movie" | "tv" | "all";
  comparison?: DuplicateComparisonFilter;
  search?: string;
  limit?: number;
  offset?: number;
};

function duplicateListQuery(params: Record<string, string | number | boolean | undefined>) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) q.set(key, String(value));
  }
  return q;
}

export const duplicatesApi = {
  list: (
    params: DuplicateListParams = {},
  ) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) q.set(k, String(v));
    }
    return apiFetch<DuplicatesResponse>(`/duplicates?${q}`);
  },
  directory: (params: DuplicateListParams = {}) =>
    apiFetch<DuplicateDirectoryResponse>(
      `/duplicates?${duplicateListQuery({ ...params, includeSeasonDetails: false })}`,
    ),
  seasonPreview: async (
    seasonRatingKey: string,
    comparison: DuplicateComparisonFilter,
    search: string,
  ) => {
    const response = await apiFetch<DuplicatesResponse>(`/duplicates?${
      duplicateListQuery({
        type: "tv",
        seasonRatingKey,
        comparison,
        search,
        limit: 1,
      })
    }`);
    const group = response.groups[0];
    if (!group || group.mediaType !== "season" || group.seasonRatingKey !== seasonRatingKey) {
      throw new Error(
        "This season no longer matches the current duplicate filters. Refresh the list.",
      );
    }
    return group;
  },
  smartAnalysis: (options: { movies: boolean; tv: boolean }) =>
    apiFetch<SmartDuplicateAnalysisResponse>("/duplicates/smart-analysis", {
      method: "POST",
      body: JSON.stringify(options),
    }),
  analyzeSeasonVersions: (
    seasonRatingKey: string,
    episodeRatingKeys: string[],
    totalEpisodeCount: number,
    options?: { selectionOnly: boolean },
  ) =>
    apiFetch<SeasonVersionAnalysisResponse>(
      `/duplicates/seasons/${encodeURIComponent(seasonRatingKey)}/analysis${
        options?.selectionOnly ? "?selectionOnly=true" : ""
      }`,
      {
        method: "POST",
        body: JSON.stringify({ episodeRatingKeys, totalEpisodeCount }),
      },
    ),
  refreshTechnicalDetails: (mediaType: "movie" | "episode", ratingKey: string) =>
    apiFetch<MediaVersionsRefreshResponse>(
      `/duplicates/${mediaType === "movie" ? "movies" : "episodes"}/${
        encodeURIComponent(
          ratingKey,
        )
      }/media/technical-refresh`,
      { method: "POST" },
    ),
};
