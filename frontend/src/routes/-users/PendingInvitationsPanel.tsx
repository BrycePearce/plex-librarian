import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Mail } from "lucide-react";
import { api } from "../../lib/api.ts";
import type { PendingInvitation } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { ErrorAlert } from "../../components/ErrorAlert.tsx";
import { Pagination } from "../../components/Pagination.tsx";
import { DataSurface } from "../../components/Workspace.tsx";
import { PendingInvitationRow } from "./PendingInvitationRow.tsx";

type InvitationFilter = "all" | "attention" | "current" | "stale" | "critical";
type InvitationSort = "createdAt" | "username" | "libraryCount";
const INVITATION_PAGE_SIZE = 25;

export function PendingInvitationsPanel() {
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
