import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock3, RotateCcw, ScanLine, Tv2 } from "lucide-react";
import { requireAuth } from "../lib/requireAuth.ts";
import { useAnySyncStatus } from "../lib/useLibrarySync.tsx";
import { CollectionToolbar, PageHeader, workspaceToneClass } from "../components/Workspace.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { SyncDataNotice } from "../components/SyncDataNotice.tsx";
import { EpisodeGapRow } from "./-episode-gaps/components/EpisodeGapRow.tsx";
import { SeasonGapRow } from "./-episode-gaps/components/SeasonGapRow.tsx";
import { EpisodeGapsFilters } from "./-episode-gaps/components/EpisodeGapsFilters.tsx";
import {
  EpisodeGapsEmpty,
  EpisodeGapsSkeleton,
} from "./-episode-gaps/components/EpisodeGapsStates.tsx";
import { EpisodeGapsSummary } from "./-episode-gaps/components/EpisodeGapsSummary.tsx";
import { useEpisodeGapsData } from "./-episode-gaps/hooks/useEpisodeGapsData.ts";
import type { EpisodeGapsSearch } from "./-episode-gaps/types/index.ts";
import { formatEpisodeAuditTime } from "./-episode-gaps/utils/formatters.ts";
import {
  EPISODE_GAPS_PAGE_SIZE,
  switchEpisodeGapsScope,
  validateEpisodeGapsSearch,
} from "./-episode-gaps/utils/search.ts";
import {
  hasRetainedEpisodeAuditFindings,
  isEpisodeAuditUninitialized,
} from "./-episode-gaps/utils/auditState.ts";
import "./episode-gaps.css";

export const Route = createFileRoute("/tools/episode-gaps")({
  validateSearch: validateEpisodeGapsSearch,
  search: {
    middlewares: [
      stripSearchParams({
        scope: "episode",
        status: "gaps",
        sort: "missingCount",
        order: "desc",
        offset: 0,
        search: "",
      }),
    ],
  },
  beforeLoad: ({ context, location }) =>
    import.meta.env.DEV && location.searchStr.includes("fixture=")
      ? undefined
      : requireAuth(context.queryClient),
  component: EpisodeGapsPage,
});

function EpisodeGapsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { isSyncing: liveSyncing } = useAnySyncStatus();
  const isSyncing = liveSyncing || search.fixture === "syncing";
  const { data, isLoading, query, sonarrTargetsByLibrary } = useEpisodeGapsData(
    search,
    isSyncing,
  );
  const update = (next: Partial<EpisodeGapsSearch>) =>
    void navigate({
      search: { ...search, ...next, ...(next.offset === undefined ? { offset: 0 } : {}) },
      replace: true,
    });
  const maxAudit = data?.libraryAudits.reduce<number | null>(
    (latest, audit) =>
      audit.episodeAuditSyncedAt && (!latest || audit.episodeAuditSyncedAt > latest)
        ? audit.episodeAuditSyncedAt
        : latest,
    null,
  );
  const noTvLibraries = data?.libraryAudits.length === 0;
  const unaudited = data ? isEpisodeAuditUninitialized(data) : false;
  const hasRetainedAudit = data ? hasRetainedEpisodeAuditFindings(data) : false;
  const filtered = Boolean(search.search || search.libraryKey || search.status !== "gaps");
  const seasonScope = search.scope === "season";
  const switchScope = (scope: "episode" | "season") =>
    void navigate({
      search: switchEpisodeGapsScope(search, scope),
      replace: true,
    });

  return (
    <div className={`episode-gaps-page workspace-page ${workspaceToneClass("cobalt")} space-y-6`}>
      <PageHeader
        eyebrow="Library health tool"
        title={
          <span className="episode-gaps-title-row">
            <span>{seasonScope ? "Season Gaps" : "Episode Gaps"}</span>
            <span className="episode-gaps-scope-switch" role="tablist" aria-label="Gap scope">
              {(["episode", "season"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  role="tab"
                  aria-selected={search.scope === scope}
                  className={search.scope === scope ? "is-active" : ""}
                  onClick={() => switchScope(scope)}
                >
                  {scope === "episode" ? "Episodes" : "Seasons"}
                </button>
              ))}
            </span>
          </span>
        }
        icon={ScanLine}
        description={
          <>
            {seasonScope
              ? "Find internal holes between numbered seasons already in each Plex show."
              : "Find the holes hiding between episodes already in a Plex season."}
            <span className="episode-gaps-scope-note">
              {seasonScope
                ? "This is not a complete-series check; leading and trailing season gaps aren't inferred."
                : "Checks between Plex's first and last known episode; leading and trailing episode gaps aren't inferred."}
            </span>
          </>
        }
        actions={
          <div className="episode-gaps-refresh">
            <Clock3 />{" "}
            <span>
              {maxAudit
                ? `Audited ${formatEpisodeAuditTime(maxAudit)}`
                : hasRetainedAudit
                ? "Retained audit · refresh incomplete"
                : "Awaiting first audit"}
            </span>
          </div>
        }
      />

      {isSyncing && (
        <SyncDataNotice>
          Gap audits are refreshing with the current Plex sync. Settled findings remain visible
          until the full library audit completes.
        </SyncDataNotice>
      )}

      <EpisodeGapsSummary data={data} loading={isLoading} scope={search.scope} />
      {data?.libraryAudits.some((audit) =>
        audit.episodeAuditSyncedAt === null
      ) && !unaudited && (
        <div className="episode-gaps-stale">
          <AlertTriangle />{" "}
          Some TV libraries have stale or unfinished audits. Their retained findings may change
          after the next successful sync.
        </div>
      )}

      <div className="episode-gaps-sticky-controls workspace-sticky-header sticky top-0 z-20">
        <CollectionToolbar
          eyebrow={seasonScope ? "Show findings" : "Season findings"}
          title="Inspected ranges"
          meta={data
            ? `${data.total.toLocaleString()} result${data.total === 1 ? "" : "s"}`
            : undefined}
        />
        <EpisodeGapsFilters
          search={search}
          audits={data?.libraryAudits ?? []}
          pending={query.isFetching}
          update={update}
        />
      </div>

      {query.isError || search.fixture === "error"
        ? (
          <ErrorAlert
            message={search.fixture === "error"
              ? `The saved ${seasonScope ? "season" : "episode"} audit could not be loaded.`
              : query.error instanceof Error
              ? query.error.message
              : `Failed to load ${seasonScope ? "season" : "episode"} gaps`}
            onRetry={() => void query.refetch()}
          />
        )
        : isLoading
        ? <EpisodeGapsSkeleton />
        : noTvLibraries
        ? (
          <EpisodeGapsEmpty
            icon={Tv2}
            title="TV libraries required"
            description={`Connect and sync at least one Plex TV library to audit ${
              seasonScope ? "season" : "episode"
            } numbering.`}
          />
        )
        : unaudited
        ? (
          <EpisodeGapsEmpty
            icon={Clock3}
            title="Gap audit not ready"
            description="Your TV libraries are known, but none has completed a gap audit yet. A successful full sync will populate this tool."
          />
        )
        : data?.rows.length === 0
        ? filtered
          ? (
            <EpisodeGapsEmpty
              icon={RotateCcw}
              title="No findings match these filters"
              description="Keep the audit context and broaden the library, status, or title filters."
              action={
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    update({
                      status: "gaps",
                      libraryKey: undefined,
                      search: "",
                      sort: "missingCount",
                      order: "desc",
                    })}
                >
                  Reset filters
                </button>
              }
            />
          )
          : (
            <EpisodeGapsEmpty
              icon={CheckCircle2}
              title="No internal gaps found"
              description={seasonScope
                ? data.scope === "season" && data.summary.irregularShowCount > 0
                  ? "No trustworthy internal season gaps were found. Irregular show or season-numbering metadata still needs review."
                  : "No internal gaps were found between the first and last numbered season in each audited show. This does not claim each series is complete."
                : data.scope === "episode" && data.summary.irregularSeasonCount > 0
                ? "No trustworthy internal episode gaps were found. Irregular seasons still need review."
                : "No internal gaps were found between the first and last episode in each audited season. This does not claim the seasons are complete."}
              celebrate
            />
          )
        : (
          <div className="episode-gaps-results">
            {data?.scope === "episode"
              ? data.rows.map((row) => (
                <EpisodeGapRow
                  key={`${row.libraryKey}:${row.seasonRatingKey}`}
                  row={row}
                  sonarrTargets={sonarrTargetsByLibrary.get(row.libraryKey) ?? []}
                />
              ))
              : data?.rows.map((row) => (
                <SeasonGapRow
                  key={`${row.libraryKey}:${row.showRatingKey}`}
                  row={row}
                  sonarrTargets={sonarrTargetsByLibrary.get(row.libraryKey) ?? []}
                />
              ))}
          </div>
        )}

      <Pagination
        page={Math.floor(search.offset / EPISODE_GAPS_PAGE_SIZE)}
        totalPages={data ? Math.ceil(data.total / EPISODE_GAPS_PAGE_SIZE) : 0}
        onPageChange={(page) => update({ offset: page * EPISODE_GAPS_PAGE_SIZE })}
      />
    </div>
  );
}
