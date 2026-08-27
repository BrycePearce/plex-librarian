import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock3, RotateCcw, ScanLine, Tv2 } from "lucide-react";
import { requireAuth } from "../lib/requireAuth.ts";
import { useAnySyncStatus } from "../lib/useLibrarySync.tsx";
import { CollectionToolbar, PageHeader, workspaceToneClass } from "../components/Workspace.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { SyncDataNotice } from "../components/SyncDataNotice.tsx";
import { EpisodeGapRow } from "./-episode-gaps/components/EpisodeGapRow.tsx";
import { EpisodeGapsFilters } from "./-episode-gaps/components/EpisodeGapsFilters.tsx";
import {
  EpisodeGapsEmpty,
  EpisodeGapsSkeleton,
} from "./-episode-gaps/components/EpisodeGapsStates.tsx";
import { EpisodeGapsSummary } from "./-episode-gaps/components/EpisodeGapsSummary.tsx";
import { useEpisodeGapsData } from "./-episode-gaps/hooks/useEpisodeGapsData.ts";
import type { EpisodeGapsSearch } from "./-episode-gaps/types/index.ts";
import { formatEpisodeAuditTime } from "./-episode-gaps/utils/formatters.ts";
import { EPISODE_GAPS_PAGE_SIZE, validateEpisodeGapsSearch } from "./-episode-gaps/utils/search.ts";
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

  return (
    <div className={`episode-gaps-page workspace-page ${workspaceToneClass("cobalt")} space-y-6`}>
      <PageHeader
        eyebrow="Library health tool"
        title="Episode Gaps"
        icon={ScanLine}
        description={
          <>
            Find the holes hiding between episodes already in your TV library.
            <span className="episode-gaps-scope-note">
              Checks gaps between Plex's first and last known episode; missing season starts or
              endings aren't detected.
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
          Episode audits are refreshing with the current Plex sync. Settled findings remain visible
          until the full library audit completes.
        </SyncDataNotice>
      )}

      <EpisodeGapsSummary data={data} loading={isLoading} />
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
          eyebrow="Season findings"
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
              ? "The saved episode audit could not be loaded."
              : query.error instanceof Error
              ? query.error.message
              : "Failed to load episode gaps"}
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
            description="Connect and sync at least one Plex TV library to audit episode numbering."
          />
        )
        : unaudited
        ? (
          <EpisodeGapsEmpty
            icon={Clock3}
            title="Episode audit not ready"
            description="Your TV libraries are known, but none has completed an episode audit yet. A successful full sync will populate this tool."
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
              description={data.summary.irregularSeasonCount > 0
                ? "No trustworthy internal gaps were found in the current results. Irregular seasons still need review, and this does not claim seasons are complete."
                : "No internal gaps were found between the first and last episode in each audited season. This does not claim the seasons are complete."}
              celebrate
            />
          )
        : (
          <div className="episode-gaps-results">
            {data?.rows.map((row) => (
              <EpisodeGapRow
                key={`${row.libraryKey}:${row.seasonRatingKey}`}
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
