import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
    queryKey: queryKeys.episodeGaps.page(params),
    queryFn: () => api.tools.episodeGapsPage(params),
    placeholderData: (previous) => previous?.scope === search.scope ? previous : undefined,
    enabled: (entry) => !fixture && (!isSyncing || entry.state.data === undefined),
  });
  const pageKey = JSON.stringify(params);
  const [paintedPageKey, setPaintedPageKey] = useState<string>();
  const pageReady = !fixture && query.data?.scope === search.scope &&
    !query.isFetching && !query.isPlaceholderData;
  useEffect(() => {
    if (!pageReady) return;
    // SQLite queries run on the backend's main thread. Let the rows arrive and
    // paint before starting the full-library summary scan.
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setPaintedPageKey(pageKey));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [pageReady, pageKey]);
  const summaryParams = {
    scope: search.scope,
    libraryKey: search.libraryKey,
    search: search.search,
  };
  const summaryQuery = useQuery({
    queryKey: queryKeys.episodeGaps.summary(summaryParams),
    queryFn: () => api.tools.episodeGapsSummary(summaryParams),
    enabled: (entry) =>
      pageReady && paintedPageKey === pageKey &&
      (!isSyncing || entry.state.data === undefined),
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
    summaryData: fixtureData ?? summaryQuery.data,
    isSummaryLoading: fixture === "loading" ||
      (!fixture && summaryQuery.data === undefined && !summaryQuery.isError),
    summaryQuery,
    sonarrTargetsByLibrary,
  };
}
