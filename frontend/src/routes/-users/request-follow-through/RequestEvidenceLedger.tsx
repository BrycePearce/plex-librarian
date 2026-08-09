import { CheckCircle2, Clock3, Film, ListVideo, Tv } from "lucide-react";
import type { RequestFollowThroughDetailItem } from "../../../lib/api.ts";
import { formatDate } from "../../../lib/format.ts";
import { PosterThumb } from "../../../components/PosterThumb.tsx";

export type OutcomeFilter = "all" | "watched" | "unwatched";

export function RequestEvidenceLedger({
  items,
  filter,
  watchedCount,
  unwatchedCount,
  onFilterChange,
}: {
  items: RequestFollowThroughDetailItem[];
  filter: OutcomeFilter;
  watchedCount: number;
  unwatchedCount: number;
  onFilterChange: (filter: OutcomeFilter) => void;
}) {
  const filters: Array<{
    value: OutcomeFilter;
    label: string;
    count: number;
    icon: typeof ListVideo;
    activeClassName: string;
    countClassName: string;
  }> = [
    {
      value: "all",
      label: "All",
      count: watchedCount + unwatchedCount,
      icon: ListVideo,
      activeClassName: "bg-info/10 text-info ring-info/25",
      countClassName: "bg-info/15",
    },
    {
      value: "watched",
      label: "Watched",
      count: watchedCount,
      icon: CheckCircle2,
      activeClassName: "bg-success/10 text-success ring-success/25",
      countClassName: "bg-success/15",
    },
    {
      value: "unwatched",
      label: "Not watched",
      count: unwatchedCount,
      icon: Clock3,
      activeClassName: "bg-error/10 text-error ring-error/25",
      countClassName: "bg-error/15",
    },
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100/25 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-300 bg-base-200/45 p-2.5">
        <div
          className="flex rounded-lg border border-base-300/80 bg-base-300/25 p-1 shadow-inner"
          role="group"
          aria-label="Filter request outcomes"
        >
          {filters.map((option) => {
            const active = filter === option.value;
            const FilterIcon = option.icon;
            return (
              <button
                key={option.value}
                type="button"
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 ring-inset transition-all ${
                  active
                    ? `${option.activeClassName} shadow-sm`
                    : "text-base-content/50 ring-transparent hover:bg-base-200/60 hover:text-base-content/80"
                }`}
                aria-pressed={active}
                onClick={() => onFilterChange(option.value)}
              >
                <FilterIcon className={`size-3 ${active ? "opacity-90" : "opacity-55"}`} />
                {option.label}
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums transition-colors ${
                    active ? option.countClassName : "bg-base-200/70 text-base-content/45"
                  }`}
                >
                  {option.count.toLocaleString()}
                </span>
              </button>
            );
          })}
        </div>
        <p className="pr-1 text-xs text-base-content/40">One scrollable evidence list</p>
      </div>
      <div className="max-h-[28rem] overflow-y-auto overscroll-contain">
        <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1.15fr)] gap-4 border-b border-base-300 bg-base-200/95 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-base-content/40 backdrop-blur sm:grid">
          <span>Request</span>
          <span>Timeline</span>
          <span>Follow-through</span>
        </div>
        {items.length > 0
          ? (
            <ul className="divide-y divide-base-300/60">
              {items.map((item) => <RequestItem key={item.key} item={item} />)}
            </ul>
          )
          : (
            <div className="px-4 py-10 text-center">
              <ListVideo className="mx-auto size-5 text-base-content/25" />
              <p className="mt-2 text-sm text-base-content/45">
                No requests match this outcome.
              </p>
            </div>
          )}
      </div>
    </div>
  );
}

function RequestItem({ item }: { item: RequestFollowThroughDetailItem }) {
  const MediaIcon = item.mediaType === "tv" ? Tv : Film;
  const daysWithoutWatch = Math.max(
    0,
    Math.floor((Date.now() / 1000 - item.availableAt) / 86_400),
  );
  const seasonLabel = item.mediaType === "tv" && item.requestedSeasons.length
    ? item.requestedSeasons.map((season) => season === 0 ? "Specials" : `S${season}`).join(", ")
    : null;
  return (
    <li className="group/request relative grid gap-3 px-4 py-3 transition-colors hover:bg-base-200/35 sm:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1.15fr)] sm:items-center sm:gap-4">
      <span
        className={`absolute inset-y-2 left-0 w-0.5 rounded-r ${
          item.watchedAt === null ? "bg-error/70" : "bg-success/70"
        }`}
      />
      <div className="flex min-w-0 gap-3">
        <PosterThumb
          thumb={item.thumb}
          width={64}
          height={96}
          className="h-16 w-11 shadow-sm"
        />
        <div className="min-w-0 self-center">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-medium" title={item.title}>
              {item.title}
              {item.year ? ` (${item.year})` : ""}
            </p>
            <MediaIcon className="mt-0.5 size-3.5 shrink-0 text-base-content/30" />
          </div>
          <p className="mt-1 text-[11px] uppercase tracking-wide text-base-content/35">
            {item.mediaType === "tv" ? "TV request" : "Movie request"}
          </p>
        </div>
      </div>
      <div className="pl-14 text-xs text-base-content/50 sm:pl-0">
        <p>Requested {formatDate(item.requestedAt)}</p>
        <p className="mt-1">Available {formatDate(item.availableAt)}</p>
        {seasonLabel && (
          <p className="mt-1 truncate text-xs text-base-content/45" title={seasonLabel}>
            Scope: {seasonLabel}
          </p>
        )}
      </div>
      <div className="pl-14 sm:pl-0">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium ${
            item.watchedAt === null
              ? "border-error/25 bg-error/8 text-error"
              : "border-success/25 bg-success/8 text-success"
          }`}
        >
          {item.watchedAt === null
            ? <Clock3 className="size-3" />
            : <CheckCircle2 className="size-3" />}
          {item.watchedAt === null ? "No later watch" : "Watched"}
        </span>
        <p className="mt-1.5 text-xs text-base-content/50">
          {item.watchedAt === null
            ? `${daysWithoutWatch.toLocaleString()} days since availability`
            : formatDate(item.watchedAt)}
        </p>
      </div>
    </li>
  );
}

export function RequestEvidenceLedgerSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-xl border border-base-300"
      aria-label="Loading request breakdown"
    >
      <div className="flex gap-2 border-b border-base-300 p-3">
        <div className="skeleton h-7 w-16" />
        <div className="skeleton h-7 w-24" />
        <div className="skeleton h-7 w-28" />
      </div>
      <div className="divide-y divide-base-300/60">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="grid grid-cols-[1.45fr_1fr_1.15fr] gap-4 p-4">
            <div className="flex gap-3">
              <div className="skeleton h-16 w-11" />
              <div className="flex-1 space-y-2 py-1">
                <div className="skeleton h-3 w-3/4" />
                <div className="skeleton h-3 w-1/2" />
              </div>
            </div>
            <div className="space-y-2 py-1">
              <div className="skeleton h-3 w-3/4" />
              <div className="skeleton h-3 w-2/3" />
            </div>
            <div className="space-y-2 py-1">
              <div className="skeleton h-5 w-24" />
              <div className="skeleton h-3 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
