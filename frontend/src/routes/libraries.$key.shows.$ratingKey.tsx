import {
  createFileRoute,
  Link,
  useCanGoBack,
  useRouter,
} from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { api } from "../lib/api";
import { formatDate, formatDuration, formatKilobytes } from "../lib/format";
import type { Season } from "../lib/api";
import { ShowDetailSkeleton } from "../components/Skeletons";
import { NotSyncedYetCard } from "../components/NotSyncedYetCard";
import { ErrorAlert } from "../components/ErrorAlert";
import { HistorySyncWarning } from "../components/HistorySyncWarning";
import { PosterThumb } from "../components/PosterThumb";
import { requireAuth } from "../lib/requireAuth";
import { DetailStat } from "../components/DetailStat";
import { useSyncedDetail } from "../lib/useSyncedDetail";
import { DataSurface } from "../components/Workspace";

export const Route = createFileRoute("/libraries/$key/shows/$ratingKey")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: ShowDetailPage,
});

function ShowDetailPage() {
  const { key, ratingKey } = Route.useParams();
  const router = useRouter();
  // `false` exactly when this is the first history entry (a direct link/bookmark/refresh) —
  // real browser-back there would leave the SPA entirely, so fall back to a plain link to the
  // library's stale list instead. Otherwise `history.back()` returns to whatever exact stale-
  // list URL (filters/sort/page included) the user actually came from, since that list's own
  // navigations use `replace: true` and collapse into a single history entry per visit.
  const canGoBack = useCanGoBack();

  // A 404 for this show is only worth treating as "not synced yet" while a sync is
  // plausibly still running or hasn't been checked yet — otherwise a genuinely deleted
  // show or a stale/invalid link would poll forever on the same 404 a real "not found"
  // would produce (the backend can't tell the two apart). No `useLibrarySync` on this
  // page to invalidate us once a sync lands, so this falls back to the lightweight
  // shared history query already used elsewhere just to know whether anything's running.
  const { data, isLoading, isError, error, refetch, isNotFoundYet } =
    useSyncedDetail(
      ["show", key, ratingKey],
      () => api.libraries.showDetail(key, ratingKey),
    );

  const show = data?.show;

  return (
    <div className="workspace-page media-detail-page space-y-6">
      <div className="media-detail-header flex items-center gap-4">
        {canGoBack
          ? (
            <button
              type="button"
              className="workspace-back-button"
              aria-label="Back"
              title="Back"
              onClick={() => router.history.back()}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )
          : (
            <Link
              to="/libraries/$key/stale"
              params={{ key }}
              className="workspace-back-button"
              aria-label="Back to stale items"
              title="Back to stale items"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
          )}
        <div className="workspace-page-copy">
          <span className="workspace-eyebrow">TV show details</span>
          <h1 className="text-2xl font-bold">{show?.title ?? "…"}</h1>
          {show?.year && (
            <p className="text-base-content/50 text-sm">{show.year}</p>
          )}
        </div>
      </div>

      {isLoading && <ShowDetailSkeleton />}

      {isNotFoundYet
        ? (
          <NotSyncedYetCard
            title="Not synced yet"
            message="This show hasn't shown up in a sync yet — it may still be importing, or the link may be out of date. This page will update automatically once it's available."
          />
        )
        : isError
        ? (
          <ErrorAlert
            message={error instanceof Error
              ? error.message
              : "Failed to load show"}
            onRetry={() => void refetch()}
          />
        )
        : data && (
          <>
            <HistorySyncWarning
              historySyncedAt={data.historySyncedAt}
              warningMessage={
                <>
                  Watch-history sync hasn't completed for this library yet —
                  "Last viewed" below may show Unknown even if this show has
                  been watched. Avoid deleting based on watch status until this
                  clears.
                </>
              }
            />

            <DataSurface className="media-detail-surface flex gap-6 items-start">
              <PosterThumb
                thumb={show?.thumb ?? null}
                width={120}
                height={180}
                className="w-24 h-36"
              />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-3">
                <DetailStat
                  label="Total size"
                  value={show?.fileSize != null
                    ? formatKilobytes(show.fileSize)
                    : "—"}
                />
                <DetailStat label="Seasons" value={String(data.seasons.length)} />
                <DetailStat
                  label="Last viewed"
                  value={show?.lastViewedAt
                    ? formatDate(show.lastViewedAt)
                    : data.historySyncedAt === null
                    ? "Unknown"
                    : "Never"}
                />
                <DetailStat label="Plays" value={String(show?.viewCount ?? 0)} />
              </div>
            </DataSurface>

            <DataSurface className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th className="w-12">#</th>
                    <th>Season</th>
                    <th>Size</th>
                    <th>Duration</th>
                    <th>Episodes</th>
                    <th>Plays</th>
                  </tr>
                </thead>
                <tbody>
                  {data.seasons.map((season) => (
                    <SeasonRow key={season.ratingKey} season={season} />
                  ))}
                </tbody>
              </table>
              {data.seasons.length === 0 && (
                <p className="text-center text-base-content/40 py-12">
                  No season data yet — run a sync to populate sizes.
                </p>
              )}
            </DataSurface>
          </>
        )}
    </div>
  );
}

function SeasonRow({ season }: { season: Season }) {
  return (
    <tr>
      <td className="text-base-content/40 font-mono text-sm">
        {season.seasonIndex}
      </td>
      <td className="font-medium">{season.title}</td>
      <td className="text-sm font-mono whitespace-nowrap">
        {season.fileSize != null ? formatKilobytes(season.fileSize) : "—"}
      </td>
      <td className="text-sm text-base-content/70 whitespace-nowrap">
        {season.duration != null
          ? formatDuration(Math.floor(season.duration / 1000))
          : "—"}
      </td>
      <td className="text-sm font-mono">{season.leafCount ?? 0}</td>
      <td className="text-sm font-mono">{season.viewCount ?? 0}</td>
    </tr>
  );
}
