import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Activity, AlertTriangle, UserCheck, Users } from "lucide-react";
import { api } from "../lib/api.ts";
import type { PlexUser, UsersActivityFilter, UsersRiskFilter, UsersSortKey } from "../lib/api.ts";
import { queryKeys } from "../lib/queryKeys.ts";
import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { HistorySyncWarning } from "../components/HistorySyncWarning.tsx";
import { DeleteResultAlert } from "../components/DeleteResultAlert.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { RemoveUserConfirmDialog } from "./-users/RemoveUserConfirmDialog.tsx";
import { SharingRiskDetailsDialog } from "./-users/SharingRiskDetailsDialog.tsx";
import { RequestFollowThroughDialog } from "./-users/RequestFollowThroughDialog.tsx";
import { PendingInvitationsPanel } from "./-users/PendingInvitationsPanel.tsx";
import { UsersFilters } from "./-users/UsersFilters.tsx";
import { UsersTable } from "./-users/UsersTable.tsx";
import { UsersTableSkeleton } from "../components/Skeletons.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import "../components/dataSurfaces.css";
import { requireAuth } from "../lib/requireAuth.ts";
import { CollectionToolbar, PageHeader } from "../components/Workspace.tsx";
import { ExpandableSearch } from "../components/ExpandableSearch.tsx";
import { normalizeSearchQuery } from "@shared/search";

const PAGE_SIZE = 100;
const MAX_INACTIVITY_DAYS = 36_500;

type SortOrder = "asc" | "desc";

interface UsersSearch {
  search?: string;
  filter?: UsersActivityFilter;
  inactiveDays?: number;
  risk?: UsersRiskFilter;
  sort?: UsersSortKey;
  order?: SortOrder;
}

function validateUsersSearch(search: Record<string, unknown>): UsersSearch {
  const inactiveDays = Number(search.inactiveDays);
  const riskValues: UsersRiskFilter[] = [
    "all",
    "attention",
    "review",
    "watch",
    "low",
    "insufficient_data",
  ];
  const sortValues: UsersSortKey[] = ["username", "lastViewedAt", "sharingRisk"];
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
    risk: riskValues.includes(search.risk as UsersRiskFilter)
      ? (search.risk as UsersRiskFilter)
      : "all",
    sort: sortValues.includes(search.sort as UsersSortKey)
      ? (search.sort as UsersSortKey)
      : "username",
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

  function setSort(sort: UsersSortKey) {
    updateSearch({ sort, order: sort === "sharingRisk" ? "desc" : "asc" });
  }

  function toggleSort(sort: UsersSortKey) {
    if (search.sort === sort) {
      updateSearch({ order: search.order === "asc" ? "desc" : "asc" });
      return;
    }
    setSort(sort);
  }

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: queryKeys.users.list({ ...search, offset }),
    queryFn: () => api.users.list({ ...search, limit: PAGE_SIZE, offset }),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });

  const [reviewUser, setReviewUser] = useState<PlexUser | null>(null);
  const [riskDetailsUser, setRiskDetailsUser] = useState<PlexUser | null>(null);
  const [followThroughUser, setFollowThroughUser] = useState<PlexUser | null>(null);
  const [removeResult, setRemoveResult] = useState<{ username: string } | null>(
    null,
  );
  const dialogRef = useRef<HTMLDialogElement>(null);
  const riskDialogRef = useRef<HTMLDialogElement>(null);
  const followThroughDialogRef = useRef<HTMLDialogElement>(null);

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

  function openFollowThrough(user: PlexUser) {
    setFollowThroughUser(user);
    followThroughDialogRef.current?.showModal();
  }

  function closeFollowThrough() {
    followThroughDialogRef.current?.close();
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

        <UsersFilters
          filter={search.filter}
          inactiveDays={search.inactiveDays}
          risk={search.risk}
          sort={search.sort}
          order={search.order}
          defaultInactiveDays={data?.defaultInactiveDays}
          resolvedInactiveDays={data?.inactiveDays}
          onActivityChange={updateSearch}
          onRiskChange={(risk) => updateSearch({ risk })}
          onSortChange={setSort}
          onOrderChange={(order) => updateSearch({ order })}
        />
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
                data && (
                  <UsersTable
                    users={data.users}
                    sort={search.sort}
                    order={search.order}
                    onSort={toggleSort}
                    requestFollowThroughAvailable={data.requestFollowThroughAvailable}
                    monitorStatus={data.monitor.status}
                    onOpenRiskDetails={openRiskDetails}
                    onOpenFollowThrough={openFollowThrough}
                    onRemove={openReview}
                  />
                )
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
      <RequestFollowThroughDialog
        dialogRef={followThroughDialogRef}
        user={followThroughUser}
        onClose={closeFollowThrough}
      />
    </div>
  );
}
