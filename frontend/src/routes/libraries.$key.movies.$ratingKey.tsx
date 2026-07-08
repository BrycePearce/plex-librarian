import {
  createFileRoute,
  Link,
  redirect,
  useCanGoBack,
  useRouter,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api, isNotFoundError } from "../lib/api";
import { formatDate, formatDuration, formatKilobytes } from "../lib/format";
import { MovieDetailSkeleton } from "../components/Skeletons";
import { NotSyncedYetCard } from "../components/NotSyncedYetCard";
import { ErrorAlert } from "../components/ErrorAlert";
import { HistorySyncWarning } from "../components/HistorySyncWarning";
import { PosterThumb } from "../components/PosterThumb";
import { useSyncHistory } from "../lib/useLibrarySync";
import { useNotSyncedYet } from "../lib/useNotSyncedYet";

export const Route = createFileRoute("/libraries/$key/movies/$ratingKey")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ["auth", "status"],
      queryFn: api.auth.status,
      staleTime: 60_000,
    });
    if (!status.configured) throw redirect({ to: "/setup" });
  },
  component: MovieDetailPage,
});

function MovieDetailPage() {
  const { key, ratingKey } = Route.useParams();
  const router = useRouter();
  // See the same note in libraries.$key.shows.$ratingKey.tsx — `false` exactly when this
  // is the first history entry (direct link/bookmark/refresh), so fall back to a plain
  // link to the library's stale list instead of a real browser-back.
  const canGoBack = useCanGoBack();

  const { data: history, isLoading: isHistoryLoading } = useSyncHistory();
  const anySyncPending = history?.some((h) => h.status === "pending") ?? false;
  const syncMightResolveThis = anySyncPending || isHistoryLoading;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["movie", key, ratingKey],
    queryFn: () => api.libraries.movieDetail(key, ratingKey),
    retry: (failureCount, err) => !isNotFoundError(err) && failureCount < 2,
    refetchInterval: (query) =>
      isNotFoundError(query.state.error) && syncMightResolveThis ? 4000 : false,
  });

  const isNotFoundYet = useNotSyncedYet(isError, error, syncMightResolveThis);

  const movie = data?.movie;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        {canGoBack
          ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm gap-1"
              onClick={() => router.history.back()}
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
          )
          : (
            <Link
              to="/libraries/$key/stale"
              params={{ key }}
              className="btn btn-ghost btn-sm gap-1"
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </Link>
          )}
        <div>
          <h1 className="text-2xl font-bold">{movie?.title ?? "…"}</h1>
          {movie?.year && (
            <p className="text-base-content/50 text-sm">{movie.year}</p>
          )}
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
            message={error instanceof Error
              ? error.message
              : "Failed to load movie"}
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
                  "Last viewed" below may show Unknown even if this movie has
                  been watched. Avoid deleting based on watch status until this
                  clears.
                </>
              }
            />

            <div className="flex gap-6 items-start">
              <PosterThumb
                thumb={movie?.thumb ?? null}
                width={120}
                height={180}
                className="w-24 h-36"
              />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-3">
                <Stat
                  label="Size"
                  value={movie?.fileSize != null
                    ? formatKilobytes(movie.fileSize)
                    : "—"}
                />
                <Stat
                  label="Duration"
                  value={movie?.duration != null
                    ? formatDuration(Math.floor(movie.duration / 1000))
                    : "—"}
                />
                <Stat
                  label="Last viewed"
                  value={movie?.lastViewedAt
                    ? formatDate(movie.lastViewedAt)
                    : data.historySyncedAt === null
                    ? "Unknown"
                    : "Never"}
                />
                <Stat label="Plays" value={String(movie?.viewCount ?? 0)} />
              </div>
            </div>
          </>
        )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-base-content/40">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
