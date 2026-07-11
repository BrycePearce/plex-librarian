import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ArrowLeft, User, UserCheck, UserX } from "lucide-react";
import { api } from "../lib/api";
import type { PlexUser } from "../lib/api";
import { formatDate } from "../lib/format";
import { ErrorAlert } from "../components/ErrorAlert";
import { HistorySyncWarning } from "../components/HistorySyncWarning";
import { DeleteResultAlert } from "../components/DeleteResultAlert";
import { Pagination } from "../components/Pagination";
import { RemoveUserConfirmDialog } from "./-users/RemoveUserConfirmDialog";
import { UsersTableSkeleton } from "../components/Skeletons";
import { EmptyState } from "../components/EmptyState";
import "../components/dataSurfaces.css";

const PAGE_SIZE = 100;

type Filter = "all" | "inactive";

function validateUsersSearch(
  search: Record<string, unknown>,
): { filter: Filter } {
  const filter = search.filter;
  return { filter: filter === "inactive" ? "inactive" : "all" };
}

export const Route = createFileRoute("/users")({
  validateSearch: validateUsersSearch,
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ["auth", "status"],
      queryFn: api.auth.status,
      staleTime: 60_000,
    });
    if (!status.configured) throw redirect({ to: "/setup" });
  },
  component: UsersPage,
});

function UsersPage() {
  const { filter } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();

  const [offset, setOffset] = useState(0);

  function setFilter(newFilter: Filter) {
    setOffset(0);
    void navigate({ search: { filter: newFilter }, replace: true });
  }

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["users", { filter, offset }],
    queryFn: () => api.users.list({ filter, limit: PAGE_SIZE, offset }),
    placeholderData: (prev) => prev,
  });

  const [reviewUser, setReviewUser] = useState<PlexUser | null>(null);
  const [removeResult, setRemoveResult] = useState<{ username: string } | null>(
    null,
  );
  const dialogRef = useRef<HTMLDialogElement>(null);

  const removeMutation = useMutation({
    mutationFn: (accountId: number) => api.users.remove(accountId),
    onSuccess: (res) => {
      setRemoveResult({ username: res.username });
      setReviewUser(null);
      dialogRef.current?.close();
      void qc.invalidateQueries({ queryKey: ["users"] });
      void qc.invalidateQueries({ queryKey: ["events"] });
    },
  });

  function openReview(user: PlexUser) {
    setRemoveResult(null);
    removeMutation.reset();
    setReviewUser(user);
    dialogRef.current?.showModal();
  }

  function closeReview() {
    dialogRef.current?.close();
  }

  const page = Math.floor(offset / PAGE_SIZE);
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/dashboard" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-base-content/50 text-sm">
            {data
              ? `${data.total.toLocaleString()} with access to this server`
              : <span className="skeleton inline-block h-3 w-40 align-middle" />}
          </p>
        </div>
        <select
          className="select select-bordered select-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          aria-label="Filter by activity"
        >
          <option value="all">All</option>
          <option value="inactive">
            Inactive{data ? ` (${data.inactiveDays}+ days)` : ""}
          </option>
        </select>
      </div>

      {data && (
        <HistorySyncWarning
          historySyncedAt={data.usersSyncedAt}
          warningMessage="The user roster hasn't synced yet — this list may be incomplete or stale. Run a sync to populate it."
        />
      )}

      {isError
        ? (
          <ErrorAlert
            message={error instanceof Error
              ? error.message
              : "Failed to load users"}
            onRetry={() => void refetch()}
          />
        )
        : (
          <>
            {removeResult && (
              <DeleteResultAlert
                variant="success"
                onDismiss={() => setRemoveResult(null)}
              >
                Removed {removeResult.username}'s access to this server.
              </DeleteResultAlert>
            )}

            {isLoading
              ? <UsersTableSkeleton />
              : data && data.users.length === 0
              ? (
                <EmptyState
                  icon={UserCheck}
                  title={filter === "inactive"
                    ? "Everyone looks active"
                    : "No users found"}
                  description={filter === "inactive"
                    ? "No one has crossed your inactive-user threshold."
                    : "Users with access will appear here after the roster syncs."}
                />
              )
              : (
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th>User</th>
                        <th>Last watched</th>
                        <th>Sharing risk</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data!.users.map((u) => (
                        <tr key={u.accountId} className="group polished-row">
                          <td>
                            <div className="flex items-center gap-3">
                              {u.thumb
                                ? (
                                  <img
                                    src={u.thumb}
                                    alt=""
                                    referrerPolicy="no-referrer"
                                    className="w-8 h-8 rounded-full object-cover bg-base-300 shrink-0"
                                  />
                                )
                                : (
                                  <div className="w-8 h-8 rounded-full bg-base-300 shrink-0 flex items-center justify-center">
                                    <User className="w-4 h-4 text-base-content/40" />
                                  </div>
                                )}
                              <div className="min-w-0">
                                <div className="font-medium flex items-center gap-1.5">
                                  <span className="truncate">{u.username}</span>
                                  {u.isOwner && (
                                    <span className="badge badge-outline badge-sm shrink-0">
                                      Owner
                                    </span>
                                  )}
                                </div>
                                {u.email && (
                                  <div className="text-xs text-base-content/40 truncate">
                                    {u.email}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="text-sm text-base-content/70">
                            {u.lastViewedAt
                              ? formatDate(u.lastViewedAt)
                              : (
                                <span className="badge badge-error badge-outline badge-sm">
                                  never
                                </span>
                              )}
                          </td>
                          <td>
                            <SharingRiskCell assessment={u.sharingRisk} />
                          </td>
                          <td className="text-right">
                            {!u.isOwner && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-xs btn-square text-error opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                                onClick={() => openReview(u)}
                                aria-label={`Remove ${u.username}'s access`}
                                title="Remove access"
                              >
                                <UserX className="w-4 h-4" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={(p) => setOffset(p * PAGE_SIZE)}
            />
          </>
        )}

      <RemoveUserConfirmDialog
        dialogRef={dialogRef}
        user={reviewUser}
        pending={removeMutation.isPending}
        error={removeMutation.error}
        onConfirm={() =>
          reviewUser && removeMutation.mutate(reviewUser.accountId)}
        onCancel={closeReview}
      />
    </div>
  );
}

function SharingRiskCell({
  assessment,
}: {
  assessment: PlexUser["sharingRisk"];
}) {
  const label = assessment.riskLevel === "insufficient_data"
    ? "Insufficient data"
    : assessment.riskLevel === "review"
    ? "Review"
    : assessment.riskLevel === "watch"
    ? "Watch"
    : "Low";
  const badgeClass = assessment.riskLevel === "review"
    ? "badge-error"
    : assessment.riskLevel === "watch"
    ? "badge-warning"
    : assessment.riskLevel === "low"
    ? "badge-success"
    : "badge-ghost";
  const signalSummary = assessment.signals.length > 0
    ? assessment.signals.map((signal) => signal.summary).join("; ")
    : "No sharing signals observed";
  const title = assessment.dataConfidence === "none"
    ? "No playback observations have been collected for this user yet."
    : `${assessment.observationCount} observations across ${assessment.activeDays} active days. ${signalSummary}.`;

  return (
    <div className="flex flex-col items-start gap-1" title={title}>
      <span className={`badge badge-sm badge-outline ${badgeClass}`}>
        {label}
        {assessment.riskLevel !== "insufficient_data" &&
          ` · ${assessment.riskScore}`}
      </span>
      <span className="text-[11px] text-base-content/40 capitalize">
        {assessment.dataConfidence} confidence
      </span>
    </div>
  );
}
