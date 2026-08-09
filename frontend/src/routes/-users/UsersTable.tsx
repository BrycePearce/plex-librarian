import { ArrowDown, ArrowUp } from "lucide-react";
import type { PlexUser, UsersSortKey } from "../../lib/api.ts";
import { DataSurface } from "../../components/Workspace.tsx";
import { UserRow } from "./UserRow.tsx";
import type { MonitorStatus } from "./UserRow.tsx";

function UserSortTh({
  label,
  field,
  sort,
  order,
  onSort,
  disabled = false,
}: {
  label: string;
  field: UsersSortKey;
  sort: UsersSortKey;
  order: "asc" | "desc";
  onSort: (field: UsersSortKey) => void;
  disabled?: boolean;
}) {
  const active = sort === field;
  return (
    <th>
      <button
        type="button"
        className="flex items-center gap-1 transition-colors enabled:hover:text-primary disabled:cursor-default disabled:opacity-50"
        onClick={() => onSort(field)}
        disabled={disabled}
        title={disabled ? "Available when the current sync finishes" : undefined}
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

export function UsersTable({
  users,
  sort,
  order,
  onSort,
  requestFollowThroughAvailable,
  monitorStatus,
  onOpenRiskDetails,
  onOpenFollowThrough,
  onRemove,
  insightsUpdating,
}: {
  users: PlexUser[];
  sort: UsersSortKey;
  order: "asc" | "desc";
  onSort: (field: UsersSortKey) => void;
  requestFollowThroughAvailable: boolean;
  monitorStatus: MonitorStatus;
  onOpenRiskDetails: (user: PlexUser) => void;
  onOpenFollowThrough: (user: PlexUser) => void;
  onRemove: (user: PlexUser) => void;
  insightsUpdating: boolean;
}) {
  return (
    <DataSurface className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <UserSortTh label="User" field="username" sort={sort} order={order} onSort={onSort} />
            <UserSortTh
              label="Last watched"
              field="lastViewedAt"
              sort={sort}
              order={order}
              onSort={onSort}
            />
            <UserSortTh
              label="Sharing risk"
              field="sharingRisk"
              sort={sort}
              order={order}
              onSort={onSort}
              disabled={insightsUpdating}
            />
            {requestFollowThroughAvailable && (
              <th className="normal-case">Request follow-through</th>
            )}
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <UserRow
              key={user.accountId}
              user={user}
              monitorStatus={monitorStatus}
              requestFollowThroughAvailable={requestFollowThroughAvailable}
              onOpenRiskDetails={onOpenRiskDetails}
              onOpenFollowThrough={onOpenFollowThrough}
              onRemove={onRemove}
              insightsUpdating={insightsUpdating}
            />
          ))}
        </tbody>
      </table>
    </DataSurface>
  );
}
