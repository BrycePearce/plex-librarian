import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, User, UserCheck, UserX, Users } from "lucide-react";
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
import { requireAuth } from "../lib/requireAuth";
import { DataSurface, FilterSurface, PageHeader } from "../components/Workspace";

const PAGE_SIZE = 100;
const MAX_INACTIVITY_DAYS = 36_500;

type ActivityFilter = "all" | "inactive" | "never";
type RiskFilter =
  | "all"
  | "attention"
  | "review"
  | "watch"
  | "low"
  | "insufficient_data";
type SortKey = "username" | "lastViewedAt" | "sharingRisk";
type SortOrder = "asc" | "desc";

interface UsersSearch {
  filter: ActivityFilter;
  inactiveDays?: number;
  risk: RiskFilter;
  sort: SortKey;
  order: SortOrder;
}

function validateUsersSearch(
  search: Record<string, unknown>,
): UsersSearch {
  const inactiveDays = Number(search.inactiveDays);
  const riskValues: RiskFilter[] = [
    "all",
    "attention",
    "review",
    "watch",
    "low",
    "insufficient_data",
  ];
  const sortValues: SortKey[] = ["username", "lastViewedAt", "sharingRisk"];
  return {
    filter: search.filter === "inactive" || search.filter === "never"
      ? search.filter
      : "all",
    ...(Number.isInteger(inactiveDays) && inactiveDays >= 0 &&
        inactiveDays <= MAX_INACTIVITY_DAYS
      ? { inactiveDays }
      : {}),
    risk: riskValues.includes(search.risk as RiskFilter) ? search.risk as RiskFilter : "all",
    sort: sortValues.includes(search.sort as SortKey) ? search.sort as SortKey : "username",
    order: search.order === "desc" ? "desc" : "asc",
  };
}

export const Route = createFileRoute("/users")({
  validateSearch: validateUsersSearch,
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: UsersPage,
});

function UsersPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();

  const [offset, setOffset] = useState(0);

  function updateSearch(next: Partial<UsersSearch>) {
    setOffset(0);
    void navigate({ search: { ...search, ...next }, replace: true });
  }

  function setSort(sort: SortKey) {
    updateSearch({ sort, order: sort === "sharingRisk" ? "desc" : "asc" });
  }

  function toggleSort(sort: SortKey) {
    if (search.sort === sort) {
      updateSearch({ order: search.order === "asc" ? "desc" : "asc" });
      return;
    }
    setSort(sort);
  }

  const inactivePresets = [30, 60, 90, 180, 365];
  const [customActivityFilter, setCustomActivityFilter] = useState<ActivityFilter | null>(null);
  const activityMode = search.filter === "all"
    ? "all"
    : search.filter === "never"
    ? "never"
    : customActivityFilter === search.filter ||
        (search.inactiveDays !== undefined && !inactivePresets.includes(search.inactiveDays))
    ? `${search.filter}:custom`
    : search.inactiveDays === undefined
    ? `${search.filter}:default`
    : `${search.filter}:${search.inactiveDays}`;

  function setActivityMode(value: string) {
    if (value === "all") {
      setCustomActivityFilter(null);
      updateSearch({ filter: "all", inactiveDays: undefined });
      return;
    }
    if (value === "never") {
      setCustomActivityFilter(null);
      updateSearch({ filter: "never", inactiveDays: undefined });
      return;
    }
    const [filter, threshold] = value.split(":") as [Exclude<ActivityFilter, "all">, string];
    setCustomActivityFilter(threshold === "custom" ? filter : null);
    if (threshold === "default" || threshold === "custom") {
      updateSearch({ filter, inactiveDays: undefined });
      return;
    }
    updateSearch({ filter, inactiveDays: Number(threshold) });
  }

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["users", { ...search, offset }],
    queryFn: () => api.users.list({ ...search, limit: PAGE_SIZE, offset }),
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
    <div className="workspace-page space-y-6">
      <div className="workspace-sticky-header sticky top-0 z-20 space-y-4">
        <PageHeader
          eyebrow="Access intelligence"
          title="Users"
          icon={Users}
          description={data
            ? `${data.total.toLocaleString()} ${
              search.filter === "all" && search.risk === "all"
                ? "with access to this server"
                : "matching users"
            }`
            : <span className="skeleton inline-block h-3 w-40 align-middle" />}
        />

        <FilterSurface>
        <label className="form-control gap-1">
          <span className="label-text text-xs">Activity</span>
          <select
            className="select select-bordered select-sm"
            value={activityMode}
            onChange={(e) => setActivityMode(e.target.value)}
          >
            <option value="all">Any activity</option>
            <option value="never">Never watched</option>
            <optgroup label="Inactive">
              <option value="inactive:default">
                Default{data ? ` (${data.defaultInactiveDays} days)` : ""}
              </option>
              <option value="inactive:30">30 days</option>
              <option value="inactive:60">60 days</option>
              <option value="inactive:90">90 days</option>
              <option value="inactive:180">180 days</option>
              <option value="inactive:365">1 year</option>
              <option value="inactive:custom">Custom…</option>
            </optgroup>
          </select>
        </label>
        {activityMode.endsWith(":custom") && (
          <label className="flex flex-col items-start gap-1">
            <span className="label-text text-xs">Custom days</span>
            <CustomInactiveDaysInput
              initialDays={search.inactiveDays ?? data?.inactiveDays ?? 90}
              onChange={(inactiveDays) => {
                setCustomActivityFilter(null);
                updateSearch({ inactiveDays });
              }}
            />
          </label>
        )}
        <label className="form-control gap-1">
          <span className="label-text text-xs">Sharing risk</span>
          <select
            className="select select-bordered select-sm"
            value={search.risk}
            onChange={(e) => updateSearch({ risk: e.target.value as RiskFilter })}
          >
            <option value="all">Any risk</option>
            <option value="attention">Needs attention</option>
            <option value="review">Review</option>
            <option value="watch">Watch</option>
            <option value="low">Low</option>
            <option value="insufficient_data">Insufficient data</option>
          </select>
        </label>
        <label className="form-control gap-1">
          <span className="label-text text-xs">Sort by</span>
          <select
            className="select select-bordered select-sm"
            value={search.sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="username">User</option>
            <option value="lastViewedAt">Last watched</option>
            <option value="sharingRisk">Sharing risk</option>
          </select>
        </label>
        <label className="form-control gap-1">
          <span className="label-text text-xs">Order</span>
          <select
            className="select select-bordered select-sm"
            value={search.order}
            onChange={(e) => updateSearch({ order: e.target.value as SortOrder })}
          >
            {search.sort === "username"
              ? (
                <>
                  <option value="asc">A–Z</option>
                  <option value="desc">Z–A</option>
                </>
              )
              : search.sort === "lastViewedAt"
              ? (
                <>
                  <option value="asc">Oldest first</option>
                  <option value="desc">Newest first</option>
                </>
              )
              : (
                <>
                  <option value="desc">Highest first</option>
                  <option value="asc">Lowest first</option>
                </>
              )}
          </select>
        </label>
        </FilterSurface>
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
                  title={search.risk !== "all"
                    ? "No users match this risk filter"
                    : search.filter === "never"
                    ? "Everyone has watched something"
                    : search.filter === "inactive"
                    ? "Everyone looks active"
                    : "No users found"}
                  description={search.risk !== "all"
                    ? "Try another risk level or broaden the activity filter."
                    : search.filter === "never"
                    ? "No users with access are currently marked as never watched."
                    : search.filter === "inactive"
                    ? "No one has crossed your inactive-user threshold."
                    : "Users with access will appear here after the roster syncs."}
                />
              )
              : (
                <DataSurface className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <UserSortTh
                          label="User"
                          field="username"
                          sort={search.sort}
                          order={search.order}
                          onSort={toggleSort}
                        />
                        <UserSortTh
                          label="Last watched"
                          field="lastViewedAt"
                          sort={search.sort}
                          order={search.order}
                          onSort={toggleSort}
                        />
                        <UserSortTh
                          label="Sharing risk"
                          field="sharingRisk"
                          sort={search.sort}
                          order={search.order}
                          onSort={toggleSort}
                        />
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
                </DataSurface>
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

function UserSortTh({
  label,
  field,
  sort,
  order,
  onSort,
}: {
  label: string;
  field: SortKey;
  sort: SortKey;
  order: SortOrder;
  onSort: (field: SortKey) => void;
}) {
  const active = sort === field;
  return (
    <th>
      <button
        type="button"
        className="flex items-center gap-1 hover:text-primary transition-colors"
        onClick={() => onSort(field)}
      >
        {label}
        {active
          ? order === "desc"
            ? <ArrowDown className="w-3 h-3" />
            : <ArrowUp className="w-3 h-3" />
          : (
            <span className="w-3 h-3 opacity-0">
              <ArrowDown className="w-3 h-3" />
            </span>
          )}
      </button>
    </th>
  );
}

function CustomInactiveDaysInput({
  initialDays,
  onChange,
}: {
  initialDays: number;
  onChange: (days: number) => void;
}) {
  const [value, setValue] = useState(String(initialDays));
  const lastApplied = useRef(initialDays);
  const onChangeRef = useRef(onChange);
  const parsed = Number(value);
  const valid = value !== "" && Number.isInteger(parsed) && parsed >= 0 &&
    parsed <= MAX_INACTIVITY_DAYS;

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!valid || parsed === lastApplied.current) return;
    const timer = setTimeout(() => {
      lastApplied.current = parsed;
      onChangeRef.current(parsed);
    }, 400);
    return () => clearTimeout(timer);
  }, [parsed, valid]);

  return (
    <div className="join">
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={5}
        className={`input input-bordered input-sm join-item w-24 ${
          !valid ? "input-error" : ""
        }`}
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 5))}
        aria-label="Custom inactivity threshold in days"
        title={`Enter 0–${MAX_INACTIVITY_DAYS.toLocaleString()} whole days`}
      />
      <span className="btn btn-sm join-item pointer-events-none font-normal">
        days
      </span>
    </div>
  );
}

function SharingRiskCell({
  assessment,
}: {
  assessment: PlexUser["sharingRisk"];
}) {
  const label = assessment.riskLevel === "insufficient_data"
    ? "Not enough data"
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
    <div
      className="inline-flex items-center"
      title={`${title} Confidence: ${assessment.dataConfidence}.`}
    >
      {assessment.riskLevel === "insufficient_data"
        ? <span className="text-xs text-base-content/40">{label}</span>
        : (
          <span className={`badge badge-sm badge-outline ${badgeClass}`}>
            {label} · {assessment.riskScore}
          </span>
        )}
    </div>
  );
}
