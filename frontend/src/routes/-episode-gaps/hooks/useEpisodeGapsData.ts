import { useQuery } from "@tanstack/react-query";
import type { EpisodeGapsResponse } from "@shared/types";
import { api } from "../../../lib/api.ts";
import { queryKeys } from "../../../lib/queryKeys.ts";
import type { EpisodeGapSonarrTarget, EpisodeGapsSearch } from "../types/index.ts";
import { cleanEpisodeGapFixture, episodeGapFixture, largeEpisodeGapFixture } from "../fixtures.ts";
import { EPISODE_GAPS_PAGE_SIZE } from "../utils/search.ts";

export function useEpisodeGapsData(search: EpisodeGapsSearch, isSyncing: boolean) {
  const { fixture, ...liveSearch } = search;
  const params = { ...liveSearch, limit: EPISODE_GAPS_PAGE_SIZE };
  const query = useQuery({
    queryKey: queryKeys.episodeGaps.list(params),
    queryFn: () => api.tools.episodeGaps(params),
    placeholderData: (previous) => previous,
    enabled: (entry) => !fixture && (!isSyncing || entry.state.data === undefined),
  });
  const { data: arrSettings } = useQuery({
    queryKey: queryKeys.arrIntegrations.all,
    queryFn: api.arr.get,
    enabled: !fixture,
  });

  const fixtureData: EpisodeGapsResponse | undefined = fixture === "gaps" || fixture === "error"
    ? episodeGapFixture
    : fixture === "syncing"
    ? {
      ...episodeGapFixture,
      libraryAudits: episodeGapFixture.libraryAudits.map((audit) => ({
        ...audit,
        episodeAuditSyncedAt: null,
      })),
      rows: episodeGapFixture.rows.map((row) => ({ ...row, episodeAuditSyncedAt: null })),
      summary: { ...episodeGapFixture.summary, checkedLibraryCount: 0 },
    }
    : fixture === "large"
    ? largeEpisodeGapFixture
    : fixture === "clean"
    ? cleanEpisodeGapFixture
    : fixture === "no-tv"
    ? { ...cleanEpisodeGapFixture, libraryAudits: [] }
    : fixture === "unaudited"
    ? {
      ...cleanEpisodeGapFixture,
      libraryAudits: cleanEpisodeGapFixture.libraryAudits.map((audit) => ({
        ...audit,
        episodeAuditSyncedAt: null,
      })),
      summary: { ...cleanEpisodeGapFixture.summary, checkedLibraryCount: 0 },
    }
    : undefined;

  const sonarrInstances = new Map(
    (arrSettings?.instances ?? [])
      .filter((instance) => instance.type === "sonarr")
      .map((instance) => [instance.id, instance] as const),
  );
  const sonarrTargetsByLibrary = new Map<string, EpisodeGapSonarrTarget[]>();
  for (const mapping of arrSettings?.mappings ?? []) {
    const instance = sonarrInstances.get(mapping.instanceId);
    if (!instance) continue;
    const targets = sonarrTargetsByLibrary.get(mapping.libraryKey) ?? [];
    if (!targets.some((target) => target.id === instance.id)) {
      targets.push({ id: instance.id, name: instance.name });
      sonarrTargetsByLibrary.set(mapping.libraryKey, targets);
    }
  }

  return {
    data: fixtureData ?? query.data,
    isLoading: fixture === "loading" || (!fixture && query.isLoading),
    query,
    sonarrTargetsByLibrary,
  };
}
