import { useState } from "react";
import type { UsersActivityFilter, UsersRiskFilter, UsersSortKey } from "../../lib/api.ts";
import { CustomDaysInput } from "../../components/CustomDaysInput.tsx";
import { FilterSurface } from "../../components/Workspace.tsx";

const MAX_INACTIVITY_DAYS = 36_500;
const INACTIVE_PRESETS = [30, 60, 90, 180, 365];

export function UsersFilters({
  filter,
  inactiveDays,
  risk,
  sort,
  order,
  defaultInactiveDays,
  resolvedInactiveDays,
  onActivityChange,
  onRiskChange,
  onSortChange,
  onOrderChange,
}: {
  filter: UsersActivityFilter;
  inactiveDays: number | undefined;
  risk: UsersRiskFilter;
  sort: UsersSortKey;
  order: "asc" | "desc";
  defaultInactiveDays: number | undefined;
  resolvedInactiveDays: number | undefined;
  onActivityChange: (next: { filter: UsersActivityFilter; inactiveDays?: number }) => void;
  onRiskChange: (risk: UsersRiskFilter) => void;
  onSortChange: (sort: UsersSortKey) => void;
  onOrderChange: (order: "asc" | "desc") => void;
}) {
  const [customActivityFilter, setCustomActivityFilter] = useState<
    UsersActivityFilter | null
  >(null);

  const activityMode = filter === "all"
    ? "all"
    : filter === "never"
    ? "never"
    : filter === "unknown"
    ? "unknown"
    : customActivityFilter === filter ||
        (inactiveDays !== undefined && !INACTIVE_PRESETS.includes(inactiveDays))
    ? `${filter}:custom`
    : inactiveDays === undefined
    ? `${filter}:default`
    : `${filter}:${inactiveDays}`;

  function setActivityMode(value: string) {
    if (value === "all") {
      setCustomActivityFilter(null);
      onActivityChange({ filter: "all", inactiveDays: undefined });
      return;
    }
    if (value === "never") {
      setCustomActivityFilter(null);
      onActivityChange({ filter: "never", inactiveDays: undefined });
      return;
    }
    if (value === "unknown") {
      setCustomActivityFilter(null);
      onActivityChange({ filter: "unknown", inactiveDays: undefined });
      return;
    }
    const [nextFilter, threshold] = value.split(":") as [
      Exclude<UsersActivityFilter, "all">,
      string,
    ];
    setCustomActivityFilter(threshold === "custom" ? nextFilter : null);
    if (threshold === "default" || threshold === "custom") {
      onActivityChange({ filter: nextFilter, inactiveDays: undefined });
      return;
    }
    onActivityChange({ filter: nextFilter, inactiveDays: Number(threshold) });
  }

  return (
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
          <option value="unknown">Pending or unresolved</option>
          <optgroup label="Inactive">
            <option value="inactive:default">
              Default{defaultInactiveDays !== undefined ? ` (${defaultInactiveDays} days)` : ""}
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
            initialDays={inactiveDays ?? resolvedInactiveDays ?? 90}
            maxDays={MAX_INACTIVITY_DAYS}
            label="Custom inactivity threshold in days"
            onChange={(nextInactiveDays) => {
              setCustomActivityFilter(null);
              onActivityChange({ filter, inactiveDays: nextInactiveDays });
            }}
          />
        </label>
      )}
      <label className="form-control gap-1">
        <span className="label-text text-xs">Sharing risk</span>
        <select
          className="select select-bordered select-sm"
          value={risk}
          onChange={(e) => onRiskChange(e.target.value as UsersRiskFilter)}
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
          value={sort}
          onChange={(e) => onSortChange(e.target.value as UsersSortKey)}
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
          value={order}
          onChange={(e) => onOrderChange(e.target.value as "asc" | "desc")}
        >
          {sort === "username"
            ? (
              <>
                <option value="asc">A–Z</option>
                <option value="desc">Z–A</option>
              </>
            )
            : sort === "lastViewedAt"
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
  );
}
