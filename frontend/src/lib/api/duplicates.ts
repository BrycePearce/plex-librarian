import { apiFetch } from "./client.ts";
import type {
  DuplicatesResponse,
  MediaVersionsRefreshResponse,
  SeasonVersionAnalysisResponse,
  SmartDuplicateAnalysisResponse,
} from "@shared/types";
import type { DuplicateComparisonFilter } from "@shared/mediaComparison";

export const duplicatesApi = {
  list: (
    params: {
      type?: "movie" | "tv" | "all";
      comparison?: DuplicateComparisonFilter;
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) q.set(k, String(v));
    }
    return apiFetch<DuplicatesResponse>(`/duplicates?${q}`);
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
