import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Mail,
  MailX,
  User,
  UserCheck,
  Users,
  UserX,
} from "lucide-react";
import { api } from "../lib/api";
import type { PendingInvitation, PlexUser } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import { avatarUrl } from "../lib/avatar";
import { formatDate, formatRelativeTime } from "../lib/format";
import { ErrorAlert } from "../components/ErrorAlert";
import { HistorySyncWarning } from "../components/HistorySyncWarning";
import { DeleteResultAlert } from "../components/DeleteResultAlert";
import { Pagination } from "../components/Pagination";
import { RemoveUserConfirmDialog } from "./-users/RemoveUserConfirmDialog";
import { SharingRiskDetailsDialog } from "./-users/SharingRiskDetailsDialog";
import { UsersTableSkeleton } from "../components/Skeletons";
import { EmptyState } from "../components/EmptyState";
import "../components/dataSurfaces.css";
import { requireAuth } from "../lib/requireAuth";
import { CollectionToolbar, DataSurface, FilterSurface, PageHeader } from "../components/Workspace";
import { ExpandableSearch } from "../components/ExpandableSearch";
import { CustomDaysInput } from "../components/CustomDaysInput";
import { normalizeSearchQuery } from "@shared/search";

const PAGE_SIZE = 100;
const MAX_INACTIVITY_DAYS = 36_500;

type ActivityFilter = "all" | "inactive" | "never" | "unknown";
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
  search?: string;
  filter?: ActivityFilter;
  inactiveDays?: number;
  risk?: RiskFilter;
  sort?: SortKey;
  order?: SortOrder;
}

function validateUsersSearch(search: Record<string, unknown>): UsersSearch {
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
    search: normalizeSearchQuery(search.search),
    filter: search.filter === "inactive" ||
        search.filter === "never" ||
        search.filter === "unknown"
      ? search.filter
      : "all",
    ...(Number.isInteger(inactiveDays) &&
        inactiveDays >= 0 &&
        inactiveDays <= MAX_INACTIVITY_DAYS
      ? { inactiveDays }
      : {}),
    risk: riskValues.includes(search.risk as RiskFilter) ? (search.risk as RiskFilter) : "all",
    sort: sortValues.includes(search.sort as SortKey) ? (search.sort as SortKey) : "username",
    order: search.order === "desc" ? "desc" : "asc",
  };
}

export const Route = createFileRoute("/users")({
  validateSearch: validateUsersSearch,
  search: {
    middlewares: [
      stripSearchParams({
        search: "",
        filter: "all",
        risk: "all",
        sort: "username",
        order: "asc",
      }),
    ],
  },
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: UsersPage,
});

function UsersPage() {
  const routeSearch = Route.useSearch();
  const search = {
    ...routeSearch,
    search: routeSearch.search ?? "",
    filter: routeSearch.filter ?? "all",
    risk: routeSearch.risk ?? "all",
    sort: routeSearch.sort ?? "username",
    order: routeSearch.order ?? "asc",
  };
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
  const [customActivityFilter, setCustomActivityFilter] = useState<
    ActivityFilter | null
  >(null);
  const activityMode = search.filter === "all"
    ? "all"
    : search.filter === "never"
    ? "never"
    : search.filter === "unknown"
    ? "unknown"
    : customActivityFilter === search.filter ||
        (search.inactiveDays !== undefined &&
          !inactivePresets.includes(search.inactiveDays))
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
    if (value === "unknown") {
      setCustomActivityFilter(null);
      updateSearch({ filter: "unknown", inactiveDays: undefined });
      return;
    }
    const [filter, threshold] = value.split(":") as [
      Exclude<ActivityFilter, "all">,
      string,
    ];
    setCustomActivityFilter(threshold === "custom" ? filter : null);
    if (threshold === "default" || threshold === "custom") {
      updateSearch({ filter, inactiveDays: undefined });
      return;
    }
    updateSearch({ filter, inactiveDays: Number(threshold) });
  }

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: queryKeys.users.list({ ...search, offset }),
    queryFn: () => api.users.list({ ...search, limit: PAGE_SIZE, offset }),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });

  const [reviewUser, setReviewUser] = useState<PlexUser | null>(null);
  const [riskDetailsUser, setRiskDetailsUser] = useState<PlexUser | null>(null);
  const [removeResult, setRemoveResult] = useState<{ username: string } | null>(
    null,
  );
  const dialogRef = useRef<HTMLDialogElement>(null);
  const riskDialogRef = useRef<HTMLDialogElement>(null);

  const removeMutation = useMutation({
    mutationFn: (accountId: number) => api.users.remove(accountId),
    onSuccess: (res) => {
      setRemoveResult({ username: res.username });
      setReviewUser(null);
      dialogRef.current?.close();
      void qc.invalidateQueries({ queryKey: queryKeys.users.all });
      void qc.invalidateQueries({ queryKey: queryKeys.events.all });
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

  function openRiskDetails(user: PlexUser) {
    setRiskDetailsUser(user);
    riskDialogRef.current?.showModal();
  }

  function closeRiskDetails() {
    riskDialogRef.current?.close();
  }

  const page = Math.floor(offset / PAGE_SIZE);
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="workspace-page space-y-6">
      <div className="workspace-sticky-header sticky top-0 z-20 space-y-4">
        <PageHeader
          eyebrow="Plex access"
          title="Users"
          icon={Users}
          description={data
            ? (
              `${data.total.toLocaleString()} ${
                search.filter === "all" && search.risk === "all" &&
                  !search.search
                  ? "with access to this server"
                  : "matching users"
              }`
            )
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
              <option value="unknown">Unknown activity</option>
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
              <CustomDaysInput
                initialDays={search.inactiveDays ?? data?.inactiveDays ?? 90}
                maxDays={MAX_INACTIVITY_DAYS}
                label="Custom inactivity threshold in days"
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

      {data?.monitor.status === "starting" && (
        <div className="alert alert-info alert-soft py-2 text-sm">
          <Activity className="w-4 h-4 animate-pulse" />
          <span>Connecting to Plex live-session monitoring…</span>
        </div>
      )}
      {data?.monitor.status === "polling" && (
        <div className="alert alert-info alert-soft py-2 text-sm">
          <Activity className="w-4 h-4" />
          <span>
            Session polling is active, but Plex live notifications are unavailable. Very short plays
            may be missed.
          </span>
        </div>
      )}
      {data?.monitor.status === "disconnected" && (
        <div className="alert alert-warning py-2 text-sm">
          <AlertTriangle className="w-4 h-4" />
          <span>
            Sharing-risk monitoring cannot currently reach Plex
            {data.monitor.message ? `: ${data.monitor.message}` : "."}
          </span>
        </div>
      )}

      <PendingInvitationsPanel />

      <CollectionToolbar
        eyebrow="Access directory"
        title="Server users"
        actions={
          <ExpandableSearch
            search={search.search}
            pending={isFetching}
            onSearchChange={(userSearch) => updateSearch({ search: userSearch })}
            label="Search server users"
            placeholder="Search username or email..."
          />
        }
        meta={data
          ? search.search
            ? `${data.total.toLocaleString()} match${data.total === 1 ? "" : "es"}`
            : `${data.total.toLocaleString()} users`
          : undefined}
      />

      {isError
        ? (
          <ErrorAlert
            message={error instanceof Error ? error.message : "Failed to load users"}
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

            {isLoading ? <UsersTableSkeleton /> : data && data.users.length === 0
              ? (
                <EmptyState
                  icon={UserCheck}
                  title={search.search
                    ? "No matching server users"
                    : search.risk !== "all"
                    ? "No users match this risk filter"
                    : search.filter === "never"
                    ? "Everyone has watched something"
                    : search.filter === "unknown"
                    ? "All user activity is resolved"
                    : search.filter === "inactive"
                    ? "Everyone looks active"
                    : "No users found"}
                  description={search.search
                    ? `No usernames or email addresses match “${search.search}”.`
                    : search.risk !== "all"
                    ? "Try another risk level or broaden the activity filter."
                    : search.filter === "never"
                    ? "No users with access are currently marked as never watched."
                    : search.filter === "unknown"
                    ? "Every user's Plex identity and watch history could be reconciled."
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
                                    loading="lazy"
                                    src={avatarUrl(u.thumb)}
                                    alt=""
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
                            {u.activityStatus === "watched" && u.lastViewedAt
                              ? (
                                formatDate(u.lastViewedAt)
                              )
                              : u.activityStatus === "never"
                              ? (
                                <span className="badge badge-error badge-outline badge-sm">
                                  never
                                </span>
                              )
                              : (
                                <span
                                  className="tooltip tooltip-right activity-status-tooltip"
                                  data-tip="Activity unknown — Plex hasn't provided enough information to match this user with their playback history."
                                  tabIndex={0}
                                  aria-label="Activity unknown. Plex hasn't provided enough information to match this user with their playback history."
                                >
                                  <span className="badge badge-warning badge-outline badge-sm">
                                    unknown
                                  </span>
                                </span>
                              )}
                          </td>
                          <td>
                            <SharingRiskCell
                              assessment={u.sharingRisk}
                              monitorStatus={data!.monitor.status}
                              onOpen={() => openRiskDetails(u)}
                            />
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
        onConfirm={() => reviewUser && removeMutation.mutate(reviewUser.accountId)}
        onCancel={closeReview}
      />
      <SharingRiskDetailsDialog
        dialogRef={riskDialogRef}
        user={riskDetailsUser}
        monitorStatus={data?.monitor.status ?? "starting"}
        onClose={closeRiskDetails}
      />
    </div>
  );
}

type InvitationFilter = "all" | "attention" | "current" | "stale" | "critical";
type InvitationSort = "createdAt" | "username" | "libraryCount";
const INVITATION_PAGE_SIZE = 25;

function PendingInvitationsPanel() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<InvitationFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<InvitationSort>("createdAt");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  const query = useQuery({
    queryKey: queryKeys.users.invitationList({
      filter,
      search,
      sort,
      order,
      offset,
    }),
    queryFn: () =>
      api.users.invitations({
        filter,
        search,
        sort,
        order,
        limit: INVITATION_PAGE_SIZE,
        offset,
      }),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  });
  const { data, isLoading: loading, error } = query;
  const [revokeInvitation, setRevokeInvitation] = useState<
    PendingInvitation | null
  >(null);
  const revokeDialogRef = useRef<HTMLDialogElement>(null);
  const revokeMutation = useMutation({
    mutationFn: api.users.cancelInvitation,
    onSuccess: () => {
      revokeDialogRef.current?.close();
      setRevokeInvitation(null);
      if (data?.invitations.length === 1 && offset > 0) {
        setOffset(Math.max(0, offset - INVITATION_PAGE_SIZE));
      }
      void qc.invalidateQueries({ queryKey: queryKeys.users.invitations });
    },
  });

  function openRevoke(invitation: PendingInvitation) {
    revokeMutation.reset();
    setRevokeInvitation(invitation);
    revokeDialogRef.current?.showModal();
  }

  if (loading) {
    return (
      <DataSurface className="p-4" aria-label="Loading pending invitations">
        <div className="skeleton h-5 w-44" />
      </DataSurface>
    );
  }
  if (error) {
    return (
      <ErrorAlert
        message="Pending invitations could not be loaded from Plex."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!data) return null;

  if (data.serverMatch !== "matched") {
    return (
      <div className="alert border border-warning/30 bg-warning/5 text-sm">
        <AlertTriangle className="h-4 w-4 text-warning" />
        <span>
          {data.serverMatch === "ambiguous"
            ? "Pending invitations could not be assigned because multiple owned Plex servers share this server's name."
            : "Plex did not provide enough server identity information to assign pending invitations."}
        </span>
      </div>
    );
  }
  if (data.overallTotal === 0) return null;

  const page = Math.floor(offset / INVITATION_PAGE_SIZE);
  const totalPages = Math.ceil(data.total / INVITATION_PAGE_SIZE);

  return (
    <DataSurface className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-content/10 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning/10 text-warning">
            <Mail className="h-4 w-4" />
          </div>
          <div>
            <h2 className="font-medium">Pending invitations</h2>
            <p className="text-xs text-base-content/45">
              {data.overallTotal} awaiting acceptance
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.staleCount > 0 && (
            <span className="badge badge-warning badge-outline badge-sm">
              {data.staleCount} over {data.staleAfterDays} days
            </span>
          )}
          {data.criticalCount > 0 && (
            <span className="badge badge-error badge-outline badge-sm">
              {data.criticalCount} over {data.criticalAfterDays} days
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3 border-b border-base-content/10 bg-base-200/35 px-4 py-3">
        <label className="form-control gap-1">
          <span className="label-text text-xs">Status</span>
          <select
            className="select select-bordered select-sm"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as InvitationFilter);
              setOffset(0);
            }}
          >
            <option value="all">All invitations</option>
            <option value="attention">Needs attention</option>
            <option value="current">Current</option>
            <option value="stale">Aging</option>
            <option value="critical">Overdue</option>
          </select>
        </label>
        <label className="form-control min-w-52 flex-1 gap-1">
          <span className="label-text text-xs">Search</span>
          <input
            type="search"
            className="input input-bordered input-sm w-full"
            placeholder="Username or email"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>
        <label className="form-control gap-1">
          <span className="label-text text-xs">Sort by</span>
          <select
            className="select select-bordered select-sm"
            value={`${sort}:${order}`}
            onChange={(event) => {
              const [nextSort, nextOrder] = event.target.value.split(":") as [
                InvitationSort,
                "asc" | "desc",
              ];
              setSort(nextSort);
              setOrder(nextOrder);
              setOffset(0);
            }}
          >
            <option value="createdAt:asc">Oldest first</option>
            <option value="createdAt:desc">Newest first</option>
            <option value="username:asc">Name A–Z</option>
            <option value="username:desc">Name Z–A</option>
            <option value="libraryCount:desc">Most libraries</option>
            <option value="libraryCount:asc">Fewest libraries</option>
          </select>
        </label>
      </div>
      <div className="overflow-x-auto">
        {data.invitations.length === 0
          ? (
            <div className="px-4 py-8 text-center text-sm text-base-content/45">
              No pending invitations match these filters.
            </div>
          )
          : (
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Invitee</th>
                  <th>Libraries</th>
                  <th>Invitation sent</th>
                  <th>Status</th>
                  <th className="w-14 pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.invitations.map((invitation) => (
                  <PendingInvitationRow
                    key={invitation.inviteId}
                    invitation={invitation}
                    onRevoke={openRevoke}
                  />
                ))}
              </tbody>
            </table>
          )}
      </div>
      {totalPages > 1 && (
        <div className="border-t border-base-content/10 px-4 py-2">
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={(nextPage) => setOffset(nextPage * INVITATION_PAGE_SIZE)}
          />
        </div>
      )}
      <dialog ref={revokeDialogRef} className="modal">
        <div className="modal-box polished-modal max-w-md">
          <h3 className="text-lg font-semibold">Revoke invitation?</h3>
          <p className="mt-2 text-sm text-base-content/60">
            Cancel the pending Plex invitation for{" "}
            <strong className="text-base-content">
              {revokeInvitation?.username ||
                revokeInvitation?.email ||
                "this user"}
            </strong>
            ? This cancels the pending Plex invitation. They will need a new invitation to gain
            access.
          </p>
          {revokeMutation.isError && (
            <div className="alert alert-error mt-4 text-sm">
              {revokeMutation.error instanceof Error
                ? revokeMutation.error.message
                : "Unable to revoke invitation"}
            </div>
          )}
          <div className="modal-action">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={revokeMutation.isPending}
              onClick={() => revokeDialogRef.current?.close()}
            >
              Keep invitation
            </button>
            <button
              type="button"
              className="btn btn-error"
              disabled={!revokeInvitation || revokeMutation.isPending}
              onClick={() =>
                revokeInvitation &&
                revokeMutation.mutate(revokeInvitation.inviteId)}
            >
              {revokeMutation.isPending && <span className="loading loading-spinner loading-xs" />}
              Revoke invitation
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="submit" disabled={revokeMutation.isPending}>
            Close
          </button>
        </form>
      </dialog>
    </DataSurface>
  );
}

function PendingInvitationRow({
  invitation,
  onRevoke,
}: {
  invitation: PendingInvitation;
  onRevoke: (invitation: PendingInvitation) => void;
}) {
  const displayName = invitation.username || invitation.email ||
    "Plex invitation";
  return (
    <tr className="polished-row">
      <td>
        <div className="flex min-w-0 items-center gap-3">
          {invitation.thumb
            ? (
              <img
                loading="lazy"
                src={avatarUrl(invitation.thumb)}
                alt=""
                className="h-8 w-8 shrink-0 rounded-full bg-base-300 object-cover"
              />
            )
            : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-base-300">
                <Mail className="h-3.5 w-3.5 text-base-content/40" />
              </div>
            )}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{displayName}</div>
            {invitation.username && invitation.email && (
              <div className="truncate text-xs text-base-content/40">
                {invitation.email}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="text-sm text-base-content/60">
        {invitation.libraryCount ?? "Unknown"}
      </td>
      <td>
        <div
          className="min-w-20 whitespace-nowrap tabular-nums"
          title={`Invited ${formatDate(invitation.createdAt)}`}
        >
          <div
            className={`text-sm ${
              invitation.ageStatus === "critical"
                ? "font-semibold text-error"
                : invitation.ageStatus === "stale"
                ? "font-medium text-warning"
                : ""
            }`}
          >
            {formatRelativeTime(invitation.createdAt)}
          </div>
          <div className="text-xs text-base-content/40">invitation sent</div>
        </div>
      </td>
      <td>
        <span
          className={`badge badge-sm badge-outline ${
            invitation.ageStatus === "critical"
              ? "badge-error"
              : invitation.ageStatus === "stale"
              ? "badge-warning"
              : "badge-ghost"
          }`}
        >
          {invitation.ageStatus === "critical"
            ? "Overdue"
            : invitation.ageStatus === "stale"
            ? "Aging"
            : "Current"}
        </span>
      </td>
      <td className="w-14 pr-4 text-right">
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square shrink-0 text-error"
          onClick={() => onRevoke(invitation)}
          aria-label={`Revoke invitation for ${displayName}`}
          title="Revoke invitation"
        >
          <MailX className="h-4 w-4" />
        </button>
      </td>
    </tr>
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
          ? (
            order === "desc" ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />
          )
          : (
            <span className="w-3 h-3 opacity-0">
              <ArrowDown className="w-3 h-3" />
            </span>
          )}
      </button>
    </th>
  );
}

function SharingRiskCell({
  assessment,
  monitorStatus,
  onOpen,
}: {
  assessment: PlexUser["sharingRisk"];
  monitorStatus: "starting" | "connected" | "polling" | "disconnected";
  onOpen: () => void;
}) {
  const label = assessment.riskLevel === "insufficient_data"
    ? assessment.observationCount > 0 ? "Limited data" : "Not enough data"
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
  const supportingText = assessment.dataConfidence === "none"
    ? monitorStatus === "disconnected" ? "Monitoring disconnected" : "No observations yet"
    : `${assessment.dataConfidence} confidence · ${assessment.signals.length} ${
      assessment.signals.length === 1 ? "signal" : "signals"
    }`;

  return (
    <button
      type="button"
      className="group/risk flex min-w-44 items-center justify-between gap-3 rounded-lg px-2 py-1.5 -mx-2 text-left transition-colors hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      onClick={onOpen}
      aria-label={`View sharing risk details: ${label}, score ${assessment.riskScore} out of 100`}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className={`badge badge-sm badge-outline ${badgeClass}`}>
            {label}
          </span>
          {assessment.riskLevel !== "insufficient_data" && (
            <span className="text-xs font-semibold tabular-nums text-base-content/70">
              {assessment.riskScore}
              <span className="font-normal text-base-content/35">/100</span>
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[11px] capitalize text-base-content/45 whitespace-nowrap">
          {supportingText}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-base-content/30 transition-transform group-hover/risk:translate-x-0.5 group-hover/risk:text-base-content/60" />
    </button>
  );
}
