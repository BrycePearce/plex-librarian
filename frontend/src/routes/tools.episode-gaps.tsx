import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import {
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Library,
  RotateCcw,
  ScanLine,
  Search,
  Tv2,
} from "lucide-react";
import type {
  EpisodeGapSeason,
  EpisodeGapsParams,
  EpisodeGapsSort,
  EpisodeGapsStatusFilter,
} from "@shared/types";
import { api } from "../lib/api.ts";
import { queryKeys } from "../lib/queryKeys.ts";
import { requireAuth } from "../lib/requireAuth.ts";
import { useAnySyncStatus } from "../lib/useLibrarySync.tsx";
import {
  CollectionToolbar,
  DataSurface,
  PageHeader,
  workspaceToneClass,
} from "../components/Workspace.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { PosterThumb } from "../components/PosterThumb.tsx";
import { ServiceIcon } from "../components/ServiceIcons.tsx";
import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { SyncDataNotice } from "../components/SyncDataNotice.tsx";
import "./episode-gaps.css";
import {
  cleanEpisodeGapFixture,
  episodeGapFixture,
  largeEpisodeGapFixture,
} from "./-episode-gaps/fixtures.ts";
import {
  hasRetainedEpisodeAuditFindings,
  isEpisodeAuditUninitialized,
} from "./-episode-gaps/state.ts";
import { loadPosterPalette, type PosterPalette } from "./-episode-gaps/posterPalette.ts";

const PAGE_SIZE = 50;
type Search =
  & Required<Pick<EpisodeGapsParams, "status" | "sort" | "order">>
  & Pick<EpisodeGapsParams, "libraryKey" | "search">
  & {
    offset: number;
    fixture?:
      | "gaps"
      | "clean"
      | "no-tv"
      | "unaudited"
      | "loading"
      | "syncing"
      | "error"
      | "large";
  };

function validate(search: Record<string, unknown>): Search {
  const status = ["gaps", "irregular", "all"].includes(String(search.status))
    ? search.status as EpisodeGapsStatusFilter
    : "gaps";
  const sort =
    ["missingCount", "title", "seasonIndex", "auditSyncedAt"].includes(String(search.sort))
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
      ? search.fixture as Search["fixture"]
      : undefined,
  };
}

export const Route = createFileRoute("/tools/episode-gaps")({
  validateSearch: validate,
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
  const { fixture, ...liveSearch } = search;
  const { isSyncing: liveSyncing } = useAnySyncStatus();
  const isSyncing = liveSyncing || fixture === "syncing";
  const params = { ...liveSearch, limit: PAGE_SIZE };
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
  const fixtureData = fixture === "gaps" || fixture === "error"
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
  const data = fixtureData ?? query.data;
  const isLoading = fixture === "loading" || (!fixture && query.isLoading);
  const update = (next: Partial<Search>) =>
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
  const sonarrInstances = new Map(
    (arrSettings?.instances ?? [])
      .filter((instance) => instance.type === "sonarr")
      .map((instance) => [instance.id, instance] as const),
  );
  const sonarrTargetsByLibrary = new Map<string, SonarrTarget[]>();
  for (const mapping of arrSettings?.mappings ?? []) {
    const instance = sonarrInstances.get(mapping.instanceId);
    if (!instance) continue;
    const targets = sonarrTargetsByLibrary.get(mapping.libraryKey) ?? [];
    if (!targets.some((target) => target.id === instance.id)) {
      targets.push({ id: instance.id, name: instance.name });
      sonarrTargetsByLibrary.set(mapping.libraryKey, targets);
    }
  }

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
                ? `Audited ${formatTime(maxAudit)}`
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

      <Summary data={data} loading={isLoading} />
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
        <Filters
          search={search}
          audits={data?.libraryAudits ?? []}
          pending={query.isFetching}
          update={update}
        />
      </div>

      {query.isError || fixture === "error"
        ? (
          <ErrorAlert
            message={fixture === "error"
              ? "The saved episode audit could not be loaded."
              : query.error instanceof Error
              ? query.error.message
              : "Failed to load episode gaps"}
            onRetry={() => void query.refetch()}
          />
        )
        : isLoading
        ? <ResultsSkeleton />
        : noTvLibraries
        ? (
          <DesignedEmpty
            icon={Tv2}
            title="TV libraries required"
            description="Connect and sync at least one Plex TV library to audit episode numbering."
          />
        )
        : unaudited
        ? (
          <DesignedEmpty
            icon={Clock3}
            title="Episode audit not ready"
            description="Your TV libraries are known, but none has completed an episode audit yet. A successful full sync will populate this tool."
          />
        )
        : data?.rows.length === 0
        ? (
          filtered
            ? (
              <DesignedEmpty
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
              <DesignedEmpty
                icon={CheckCircle2}
                title="No internal gaps found"
                description={data.summary.irregularSeasonCount > 0
                  ? "No trustworthy internal gaps were found in the current results. Irregular seasons still need review, and this does not claim seasons are complete."
                  : "No internal gaps were found between the first and last episode in each audited season. This does not claim the seasons are complete."}
                celebrate
              />
            )
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
        page={Math.floor(search.offset / PAGE_SIZE)}
        totalPages={data ? Math.ceil(data.total / PAGE_SIZE) : 0}
        onPageChange={(page) => update({ offset: page * PAGE_SIZE })}
      />
    </div>
  );
}

function Summary(
  { data, loading }: {
    data: Awaited<ReturnType<typeof api.tools.episodeGaps>> | undefined;
    loading: boolean;
  },
) {
  const irregularCount = data?.summary.irregularSeasonCount;
  const auditClean = !loading && irregularCount === 0;
  return (
    <section className="episode-gaps-summary" aria-label="Episode audit summary">
      <DataSurface className="episode-gaps-overview">
        <div className="episode-gaps-overview-main">
          <span className="episode-gaps-overview-icon">
            <ScanLine />
          </span>
          <div>
            <span className="episode-gaps-overview-kicker">Audit findings</span>
            <div className="episode-gaps-overview-value">
              {loading
                ? <span className="skeleton h-9 w-20" />
                : <strong>{data?.summary.missingEpisodeCount.toLocaleString() ?? "—"}</strong>}
              <span>episodes missing</span>
            </div>
            <p>
              Across {loading ? "—" : data?.summary.gapSeasonCount.toLocaleString() ?? "—"}{" "}
              seasons with internal gaps
            </p>
          </div>
        </div>
        <div className="episode-gaps-overview-details">
          <div className="episode-gap-stat is-coverage">
            <Library />
            <div>
              <span>Coverage</span>
              {loading
                ? <span className="skeleton h-6 w-10" />
                : <strong>{data?.summary.checkedLibraryCount.toLocaleString() ?? "—"}</strong>}
              <small>TV libraries checked</small>
            </div>
          </div>
          <div className={`episode-gap-stat is-irregular ${auditClean ? "is-clear" : ""}`}>
            {auditClean ? <CheckCircle2 /> : <AlertTriangle />}
            <div>
              <span>{auditClean ? "Audit clean" : "Needs review"}</span>
              {loading
                ? <span className="skeleton h-6 w-10" />
                : <strong>{irregularCount?.toLocaleString() ?? "—"}</strong>}
              <small>{auditClean ? "No irregular seasons" : "Irregular seasons"}</small>
            </div>
          </div>
        </div>
      </DataSurface>
    </section>
  );
}

function Filters(
  { search, audits, pending, update }: {
    search: Search;
    audits: Array<{ libraryKey: string; libraryTitle: string }>;
    pending: boolean;
    update: (next: Partial<Search>) => void;
  },
) {
  return (
    <div className="episode-gaps-filters" aria-label="Episode gap filters">
      <label className="episode-gaps-search">
        <Search />
        <span className="sr-only">Search by show title</span>
        <input
          value={search.search ?? ""}
          onChange={(e) => update({ search: e.target.value })}
          placeholder="Search show title…"
        />
        {pending && <span className="loading loading-spinner loading-xs" />}
      </label>
      <label>
        <span>Library</span>
        <select
          value={search.libraryKey ?? ""}
          onChange={(e) => update({ libraryKey: e.target.value || undefined })}
        >
          <option value="">All TV libraries</option>
          {audits.map((audit) => (
            <option key={audit.libraryKey} value={audit.libraryKey}>{audit.libraryTitle}</option>
          ))}
        </select>
      </label>
      <fieldset className="episode-gaps-status">
        <legend>Status</legend>
        <div>
          {(["gaps", "irregular", "all"] as const).map((status) => (
            <button
              key={status}
              type="button"
              className={search.status === status ? "is-active" : ""}
              onClick={() => update({ status })}
            >
              {status === "gaps" ? "Gaps" : status === "irregular" ? "Irregular" : "All"}
            </button>
          ))}
        </div>
      </fieldset>
      <label>
        <span>Sort</span>
        <select
          value={search.sort}
          onChange={(e) => update({ sort: e.target.value as EpisodeGapsSort })}
        >
          <option value="missingCount">Most missing</option>
          <option value="title">Show title</option>
          <option value="seasonIndex">Season number</option>
          <option value="auditSyncedAt">Recently synced</option>
        </select>
      </label>
      <button
        className="episode-sort-order"
        type="button"
        onClick={() => update({ order: search.order === "asc" ? "desc" : "asc" })}
        aria-label={`Sort ${search.order === "asc" ? "descending" : "ascending"}`}
      >
        <ArrowDownUp /> {search.order === "asc" ? "Asc" : "Desc"}
      </button>
    </div>
  );
}

type SonarrTarget = { id: number; name: string };

function EpisodeGapRow(
  { row, sonarrTargets }: { row: EpisodeGapSeason; sonarrTargets: SonarrTarget[] },
) {
  const irregular = row.status === "irregular";
  const [highlightedRange, setHighlightedRange] = useState<
    { start: number; end: number } | null
  >(null);
  const ambientPoster = row.showThumb
    ? `/api/proxy/thumb?path=${encodeURIComponent(row.showThumb)}&width=96&height=144`
    : null;
  const { palette, rowRef } = usePosterPalette(ambientPoster);
  const paletteStyle = palette
    ? {
      "--episode-palette-tl": palette.topLeft,
      "--episode-palette-tr": palette.topRight,
      "--episode-palette-br": palette.bottomRight,
      "--episode-palette-bl": palette.bottomLeft,
    } as CSSProperties
    : undefined;
  return (
    <article
      ref={rowRef}
      className={`episode-gap-row ${irregular ? "is-irregular" : ""}`}
      style={paletteStyle}
    >
      {palette && <span className="episode-gap-row-ambient" aria-hidden="true" />}
      <div className="episode-gap-show">
        <PosterThumb
          thumb={row.showThumb}
          width={96}
          height={144}
          className="episode-gap-poster"
        />
        <div>
          <span className="episode-gap-library">{row.libraryTitle}</span>
          <h3>{row.showTitle}</h3>
          <p>{row.seasonTitle || `Season ${row.seasonIndex}`}</p>
        </div>
      </div>
      <div className="episode-gap-finding">
        <div className="episode-gap-finding-title">
          {irregular ? "Numbering needs review" : (
            <>
              <strong>{row.missingCount}</strong> episode{row.missingCount === 1 ? "" : "s"} missing
            </>
          )}
        </div>
        <p>
          {irregular
            ? reasonLabel(row.reason)
            : `${row.presentCount} of ${
              row.presentCount + row.missingCount
            } episodes present · inspected E${row.firstEpisodeIndex}–E${row.lastEpisodeIndex}`}
        </p>
        {!irregular && <EpisodeStrip row={row} highlightedRange={highlightedRange} />}
        <div className="episode-gap-tokens" aria-label={irregular ? undefined : "Missing episodes"}>
          {irregular
            ? <span className="episode-gap-token">Irregular metadata</span>
            : row.missingRanges.map((range) => (
              <span
                className="episode-gap-token"
                key={`${range.start}-${range.end}`}
                onPointerEnter={(event) => {
                  if (event.pointerType !== "touch") setHighlightedRange(range);
                }}
                onPointerLeave={() => setHighlightedRange(null)}
              >
                {range.start === range.end ? `E${range.start}` : `E${range.start}–E${range.end}`}
              </span>
            ))}
        </div>
      </div>
      <nav className="episode-gap-actions" aria-label={`Open ${row.showTitle}`}>
        <a
          className="episode-gap-service-action is-plex"
          href={`/api/tools/episode-gaps/open/plex/${encodeURIComponent(row.showRatingKey)}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in Plex"
          aria-label={`Open ${row.showTitle} in Plex`}
        >
          <span>Plex</span> <ExternalLink aria-hidden />
        </a>
        {sonarrTargets.map((target) => (
          <a
            key={target.id}
            className="episode-gap-service-action is-sonarr"
            href={`/api/tools/episode-gaps/open/sonarr/${target.id}/${
              encodeURIComponent(row.showRatingKey)
            }`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open in ${target.name}`}
            aria-label={`Open ${row.showTitle} in ${target.name}`}
          >
            <ServiceIcon service="sonarr" />
            <span>{sonarrTargets.length > 1 ? target.name : "Sonarr"}</span>
          </a>
        ))}
      </nav>
    </article>
  );
}

function usePosterPalette(url: string | null): {
  palette: PosterPalette | null;
  rowRef: RefObject<HTMLElement | null>;
} {
  const [palette, setPalette] = useState<PosterPalette | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const rowRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = rowRef.current;
    if (!node || nearViewport) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: "320px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [nearViewport]);
  useEffect(() => {
    let current = true;
    setPalette(null);
    if (url && nearViewport) {
      void loadPosterPalette(url).then((next) => current && setPalette(next));
    }
    return () => {
      current = false;
    };
  }, [nearViewport, url]);
  return { palette, rowRef };
}

function EpisodeStrip({
  row,
  highlightedRange,
}: {
  row: EpisodeGapSeason;
  highlightedRange: { start: number; end: number } | null;
}) {
  const first = row.firstEpisodeIndex!;
  const last = row.lastEpisodeIndex!;
  const width = last - first + 1;
  const [hoveredEpisode, setHoveredEpisode] = useState<number | null>(null);
  const missing = (index: number) =>
    row.missingRanges.some((range) => index >= range.start && index <= range.end);
  const highlighted = (index: number) =>
    highlightedRange !== null &&
    index >= highlightedRange.start &&
    index <= highlightedRange.end;
  const tooltipRange = hoveredEpisode !== null
    ? { start: hoveredEpisode, end: hoveredEpisode }
    : highlightedRange;
  const tooltipMissing = hoveredEpisode !== null
    ? missing(hoveredEpisode)
    : highlightedRange !== null;
  const label = `Episodes ${first} through ${last}; missing ${
    row.missingRanges.map((range) =>
      range.start === range.end
        ? `episode ${range.start}`
        : `episodes ${range.start} through ${range.end}`
    ).join(", ")
  }`;
  if (width <= 32) {
    return (
      <div className="episode-strip is-cells" role="img" aria-label={label}>
        <div className="episode-strip-visual">
          {Array.from({ length: width }, (_, i) => first + i).map((index) => (
            <span
              className={`${missing(index) ? "is-gap" : ""} ${
                hoveredEpisode === index ? "is-hovered" : ""
              } ${highlighted(index) ? "is-related" : ""}`}
              key={index}
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") setHoveredEpisode(index);
              }}
              onPointerLeave={() => setHoveredEpisode(null)}
            >
              <i>{index}</i>
            </span>
          ))}
        </div>
        <EpisodeStripTooltip
          range={tooltipRange}
          first={first}
          width={width}
          missing={tooltipMissing}
        />
        <small>E{first}</small>
        <small>E{last}</small>
      </div>
    );
  }
  return (
    <div className="episode-strip is-track" role="img" aria-label={label}>
      <div
        className="episode-strip-visual"
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const position = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width - 1);
          setHoveredEpisode(first + Math.floor((position / bounds.width) * width));
        }}
        onPointerLeave={() => setHoveredEpisode(null)}
      >
        {row.missingRanges.map((range) => (
          <span
            className={`episode-strip-gap ${
              highlightedRange?.start === range.start && highlightedRange.end === range.end
                ? "is-related"
                : ""
            }`}
            key={range.start}
            style={{
              left: `${((range.start - first) / width) * 100}%`,
              width: `${((range.end - range.start + 1) / width) * 100}%`,
            }}
          />
        ))}
        {hoveredEpisode !== null && (
          <span
            className={`episode-strip-hover-marker ${missing(hoveredEpisode) ? "is-gap" : ""}`}
            style={{
              left: `${((hoveredEpisode - first) / width) * 100}%`,
              width: `${(1 / width) * 100}%`,
            }}
          />
        )}
      </div>
      <EpisodeStripTooltip
        range={tooltipRange}
        first={first}
        width={width}
        missing={tooltipMissing}
      />
      <small>E{first}</small>
      <small>E{last}</small>
    </div>
  );
}

function EpisodeStripTooltip({
  range,
  first,
  width,
  missing,
}: {
  range: { start: number; end: number } | null;
  first: number;
  width: number;
  missing: boolean;
}) {
  if (range === null) return null;
  const position = (((range.start + range.end) / 2 - first + 0.5) / width) * 100;
  const episodeLabel = range.start === range.end
    ? `E${range.start}`
    : `E${range.start}–E${range.end}`;
  return (
    <span
      aria-hidden="true"
      className={`episode-strip-tooltip ${missing ? "is-gap" : ""}`}
      style={{ left: `${Math.min(Math.max(position, 7), 93)}%` }}
    >
      {episodeLabel} <i aria-hidden /> {missing ? "Missing" : "Present"}
    </span>
  );
}

function ResultsSkeleton() {
  return (
    <div className="episode-gaps-results" aria-label="Loading episode gap findings">
      {[1, 2, 3].map((key) => (
        <div className="episode-gap-row episode-gap-skeleton" key={key}>
          <span className="skeleton episode-gap-poster" />
          <div className="space-y-3 flex-1">
            <span className="skeleton h-4 w-1/3" />
            <span className="skeleton h-7 w-1/2" />
            <span className="skeleton h-4 w-4/5" />
            <span className="skeleton h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
function DesignedEmpty(
  { icon: Icon, title, description, action, celebrate = false }: {
    icon: typeof Tv2;
    title: string;
    description: string;
    action?: React.ReactNode;
    celebrate?: boolean;
  },
) {
  return (
    <DataSurface className={`episode-gaps-empty ${celebrate ? "is-clean" : ""}`}>
      <span>
        <Icon />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </DataSurface>
  );
}
function reasonLabel(reason: string | null) {
  return reason === "episode_index_too_large"
    ? "Episode indexes exceed the safe audit range."
    : reason === "invalid_season_index"
    ? "Plex returned an invalid season index."
    : reason === "season_index_too_large"
    ? "The season index exceeds the safe audit range."
    : reason === "range_limit_exceeded"
    ? "Numbering is too fragmented for a trustworthy result."
    : reason === "conflicting_season_identity"
    ? "Plex returned conflicting season identity."
    : reason === "invalid_projection"
    ? "Saved audit data could not be validated."
    : "One or more episodes has an invalid index.";
}
function formatTime(epoch: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    epoch * 1000,
  );
}
