import { apiFetch } from "./client.ts";
import type {
  LibrariesResponse,
  Library,
  MovieDetail,
  ShowDetail,
  StaleResponse,
} from "@shared/types";
import type { StaleParams } from "./types.ts";

export const librariesApi = {
  list: (limit = 100, offset = 0) =>
    apiFetch<LibrariesResponse>(`/libraries?limit=${limit}&offset=${offset}`),
  listAll: async () => {
    const pageSize = 1000;
    const libraries: Library[] = [];
    let total = 0;

    do {
      const page = await apiFetch<LibrariesResponse>(
        `/libraries?limit=${pageSize}&offset=${libraries.length}`,
      );
      total = page.total;
      libraries.push(...page.libraries);
      if (page.libraries.length === 0) break;
    } while (libraries.length < total);

    return {
      limit: libraries.length,
      offset: 0,
      total,
      libraries,
    } satisfies LibrariesResponse;
  },
  stale: (key: string, params: StaleParams = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) q.set(k, String(v));
    }
    return apiFetch<StaleResponse>(`/libraries/${encodeURIComponent(key)}/stale?${q}`);
  },
  showDetail: (key: string, ratingKey: string) =>
    apiFetch<ShowDetail>(
      `/libraries/${encodeURIComponent(key)}/shows/${encodeURIComponent(ratingKey)}`,
    ),
  movieDetail: (key: string, ratingKey: string) =>
    apiFetch<MovieDetail>(
      `/libraries/${encodeURIComponent(key)}/movies/${encodeURIComponent(ratingKey)}`,
    ),
  updateStaleMinAgeDays: (key: string, staleMinAgeDays: number | null) =>
    apiFetch<Library>(`/libraries/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify({ staleMinAgeDays }),
    }),
};
