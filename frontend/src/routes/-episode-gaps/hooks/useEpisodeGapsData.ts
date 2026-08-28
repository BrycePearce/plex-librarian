import { useQuery } from "@tanstack/react-query";
import type { EpisodeGapsResponse } from "@shared/types";
import { api } from "../../../lib/api.ts";
import { queryKeys } from "../../../lib/queryKeys.ts";
import type { EpisodeGapSonarrTarget, EpisodeGapsSearch } from "../types/index.ts";
import {
  cleanEpisodeGapFixture,
  cleanSeasonGapFixture,
  episodeGapFixture,
  largeEpisodeGapFixture,
  seasonGapFixture,
} from "../fixtures.ts";
import { EPISODE_GAPS_PAGE_SIZE } from "../utils/search.ts";

export function useEpisodeGapsData(search: EpisodeGapsSearch, isSyncing: boolean) {
  const { fixture, ...liveSearch } = search;
  const params = { ...liveSearch, limit: EPISODE_GAPS_PAGE_SIZE };
  const query = useQuery({
    queryKey: queryKeys.episodeGaps.list(params),
    queryFn: () => api.tools.episodeGaps(params),
    placeholderData: (previous) => previous?.scope === search.scope ? previous : undefined,
    enabled: (entry) => !fixture && (!isSyncing || entry.state.data === undefined),
  });
  const { data: arrSettings } = useQuery({
    queryKey: queryKeys.arrIntegrations.all,
    queryFn: api.arr.get,
    enabled: !fixture,
  });

  const scopedFixture = search.scope === "season" ? seasonGapFixture : episodeGapFixture;
  const scopedCleanFixture = search.scope === "season"
    ? cleanSeasonGapFixture
    : cleanEpisodeGapFixture;
  const fixtureData: EpisodeGapsResponse | undefined = fixture === "gaps" || fixture === "error"
    ? scopedFixture
    : fixture === "syncing"
    ? {
      ...scopedFixture,
      libraryAudits: scopedFixture.libraryAudits.map((audit) => ({
        ...audit,
        episodeAuditSyncedAt: null,
      })),
      rows: scopedFixture.rows.map((row) => ({ ...row, episodeAuditSyncedAt: null })),
      summary: { ...scopedFixture.summary, checkedLibraryCount: 0 },
    } as EpisodeGapsResponse
    : fixture === "large"
    ? search.scope === "episode" ? largeEpisodeGapFixture : seasonGapFixture
    : fixture === "clean"
    ? scopedCleanFixture
    : fixture === "no-tv"
    ? { ...scopedCleanFixture, libraryAudits: [] } as EpisodeGapsResponse
    : fixture === "unaudited"
    ? {
      ...scopedCleanFixture,
      libraryAudits: scopedCleanFixture.libraryAudits.map((audit) => ({
        ...audit,
        episodeAuditSyncedAt: null,
      })),
      summary: { ...scopedCleanFixture.summary, checkedLibraryCount: 0 },
    } as EpisodeGapsResponse
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
    data: fixtureData ?? (query.data?.scope === search.scope ? query.data : undefined),
    isLoading: fixture === "loading" ||
      (!fixture && (query.isLoading || query.data?.scope !== search.scope)),
    query,
    sonarrTargetsByLibrary,
  };
}
