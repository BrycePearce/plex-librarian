import { createFileRoute, Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDate, formatDuration, formatKilobytes } from "../lib/format.ts";
import { MovieDetailSkeleton } from "../components/Skeletons.tsx";
import { NotSyncedYetCard } from "../components/NotSyncedYetCard.tsx";
import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { HistorySyncWarning } from "../components/HistorySyncWarning.tsx";
import { PosterThumb } from "../components/PosterThumb.tsx";
import { requireAuth } from "../lib/requireAuth.ts";
import { DetailStat } from "../components/DetailStat.tsx";
import { useSyncedDetail } from "../lib/useSyncedDetail.ts";
import { queryKeys } from "../lib/queryKeys.ts";
import { DataSurface } from "../components/Workspace.tsx";

export const Route = createFileRoute("/libraries/$key/movies/$ratingKey")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: MovieDetailPage,
});

function MovieDetailPage() {
  const { key, ratingKey } = Route.useParams();
  const router = useRouter();
  // See the same note in libraries.$key.shows.$ratingKey.tsx — `false` exactly when this
  // is the first history entry (direct link/bookmark/refresh), so fall back to a plain
  // link to the library's stale list instead of a real browser-back.
  const canGoBack = useCanGoBack();

  const { data, isLoading, isError, error, refetch, isNotFoundYet } = useSyncedDetail(
    queryKeys.movie.detail(key, ratingKey),
    () => api.libraries.movieDetail(key, ratingKey),
  );

  const movie = data?.movie;

  return (
    <div className="workspace-page workspace-tone-primary media-detail-page space-y-6">
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
          <span className="workspace-eyebrow">Movie details</span>
          <h1 className="text-2xl font-bold">{movie?.title ?? "…"}</h1>
          {movie?.year && <p className="text-base-content/50 text-sm">{movie.year}</p>}
        </div>
      </div>

      {isLoading && <MovieDetailSkeleton />}

      {isNotFoundYet
        ? (
          <NotSyncedYetCard
            title="Not synced yet"
            message="This movie hasn't shown up in a sync yet — it may still be importing, or the link may be out of date. This page will update automatically once it's available."
          />
        )
        : isError
        ? (
          <ErrorAlert
            message={error instanceof Error ? error.message : "Failed to load movie"}
            onRetry={() => void refetch()}
          />
        )
        : data && (
          <>
            <HistorySyncWarning
              historySyncedAt={data.historySyncedAt}
              warningMessage={
                <>
                  Watch-history sync hasn't completed for this library yet — "Last viewed" below may
                  show Unknown even if this movie has been watched. Avoid deleting based on watch
                  status until this clears.
                </>
              }
            />

            <DataSurface className="media-detail-surface flex gap-6 items-start">
              <PosterThumb
                thumb={movie?.thumb ?? null}
                width={120}
                height={180}
                className="w-24 h-36"
              />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-3">
                <DetailStat
                  label="Size"
                  value={movie?.fileSize != null ? formatKilobytes(movie.fileSize) : "—"}
                />
                <DetailStat
                  label="Duration"
                  value={movie?.duration != null
                    ? formatDuration(Math.floor(movie.duration / 1000))
                    : "—"}
                />
                <DetailStat
                  label="Last viewed"
                  value={movie?.lastViewedAt
                    ? formatDate(movie.lastViewedAt)
                    : data.historySyncedAt === null
                    ? "Unknown"
                    : "Never"}
                />
                <DetailStat label="Plays" value={String(movie?.viewCount ?? 0)} />
              </div>
            </DataSurface>
          </>
        )}
    </div>
  );
}
