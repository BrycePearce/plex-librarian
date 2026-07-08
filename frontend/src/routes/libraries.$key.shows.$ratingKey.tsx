import {
  createFileRoute,
  Link,
  redirect,
  useCanGoBack,
  useRouter,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import { api, isNotFoundError } from "../lib/api";
import { formatDate, formatDuration, formatKilobytes } from "../lib/format";
import type { Season } from "../lib/api";
import { ShowDetailSkeleton } from "../components/Skeletons";
import { useSyncHistory } from "../lib/useLibrarySync";

export const Route = createFileRoute("/libraries/$key/shows/$ratingKey")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ["auth", "status"],
      queryFn: api.auth.status,
      staleTime: 60_000,
    });
    if (!status.configured) throw redirect({ to: "/setup" });
  },
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
  const { data: history, isLoading: isHistoryLoading } = useSyncHistory();
  const anySyncPending = history?.some((h) => h.status === "pending") ?? false;
  const syncMightResolveThis = anySyncPending || isHistoryLoading;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["show", key, ratingKey],
    queryFn: () => api.libraries.showDetail(key, ratingKey),
    retry: (failureCount, err) => !isNotFoundError(err) && failureCount < 2,
    refetchInterval: (query) =>
      isNotFoundError(query.state.error) && syncMightResolveThis ? 4000 : false,
  });

  const isNotFoundYet = isError && isNotFoundError(error) &&
    syncMightResolveThis;

  const show = data?.show;

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
          <h1 className="text-2xl font-bold">{show?.title ?? "…"}</h1>
          {show?.year && (
            <p className="text-base-content/50 text-sm">{show.year}</p>
          )}
        </div>
      </div>

      {isLoading && <ShowDetailSkeleton />}

      {isNotFoundYet
        ? (
          <div className="card bg-base-200 shadow-xl">
            <div className="card-body items-center text-center gap-4 py-14">
              <span className="loading loading-ring w-12 text-primary" />
              <div>
                <h2 className="card-title text-xl justify-center">
                  Not synced yet
                </h2>
                <p className="text-base-content/60 max-w-md">
                  This show hasn't shown up in a sync yet — it may still be
                  importing, or the link may be out of date. This page will
                  update automatically once it's available.
                </p>
              </div>
            </div>
          </div>
        )
        : isError
        ? (
          <div className="alert alert-error">
            <AlertCircle className="w-4 h-4" />
            <span>
              {error instanceof Error ? error.message : "Failed to load show"}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-xs gap-1"
              onClick={() => void refetch()}
            >
              <RefreshCw className="w-3 h-3" /> Try again
            </button>
          </div>
        )
        : data && (
          <>
            {data.historySyncedAt === null && (
              <div className="alert alert-warning">
                <AlertTriangle className="w-4 h-4" />
                <span>
                  Watch-history sync hasn't completed for this library yet —
                  "Last viewed" below may show Unknown even if this show has
                  been watched. Avoid deleting based on watch status until this
                  clears.
                </span>
              </div>
            )}

            <div className="flex gap-6 items-start">
              {show?.thumb
                ? (
                  <img
                    src={`/api/proxy/thumb?path=${
                      encodeURIComponent(show.thumb)
                    }&width=120&height=180`}
                    alt=""
                    className="w-24 h-36 object-cover rounded bg-base-300 shrink-0"
                  />
                )
                : <div className="w-24 h-36 rounded bg-base-300 shrink-0" />}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-3">
                <Stat
                  label="Total size"
                  value={show?.fileSize != null
                    ? formatKilobytes(show.fileSize)
                    : "—"}
                />
                <Stat label="Seasons" value={String(data.seasons.length)} />
                <Stat
                  label="Last viewed"
                  value={show?.lastViewedAt
                    ? formatDate(show.lastViewedAt)
                    : data.historySyncedAt === null
                    ? "Unknown"
                    : "Never"}
                />
                <Stat label="Plays" value={String(show?.viewCount ?? 0)} />
              </div>
            </div>

            <div className="overflow-x-auto">
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
