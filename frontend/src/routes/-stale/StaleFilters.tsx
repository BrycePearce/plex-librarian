import type { StaleParams } from "../../lib/api";

export function StaleFilters({
  days,
  filter,
  onDaysChange,
  onFilterChange,
  gracePeriodValue,
  defaultGraceDays,
  onGracePeriodChange,
  libraryType,
  duplicatesOnly,
  onDuplicatesOnlyChange,
}: {
  days: number;
  filter: StaleParams["filter"];
  onDaysChange: (days: number) => void;
  onFilterChange: (filter: StaleParams["filter"]) => void;
  gracePeriodValue: string;
  defaultGraceDays?: number;
  onGracePeriodChange: (value: string) => void;
  libraryType: string;
  duplicatesOnly: boolean;
  onDuplicatesOnlyChange: (value: boolean) => void;
}) {
  return (
    <div className="stale-filter-controls flex flex-wrap items-end gap-x-3 gap-y-2">
      <label className="form-control gap-1">
        <span className="label-text text-xs">Watch status</span>
        <select
          className="select select-bordered select-sm"
          value={filter}
          onChange={(e) =>
            onFilterChange(e.target.value as StaleParams["filter"])}
        >
          <option value="all">Any status</option>
          <option value="watched">Previously watched</option>
          <option value="unwatched">Never watched</option>
        </select>
      </label>
      <label className="form-control gap-1">
        <span className="label-text text-xs">Inactive at least</span>
        <select
          className="select select-bordered select-sm"
          value={days}
          onChange={(e) => onDaysChange(Number(e.target.value))}
        >
          <option value={90}>3 months</option>
          <option value={180}>6 months</option>
          <option value={365}>1 year</option>
          <option value={730}>2 years</option>
          <option value={1095}>3 years</option>
        </select>
      </label>
      <label className="form-control gap-1">
        <span className="label-text text-xs">Never-watched age floor</span>
        <select
          className="select select-bordered select-sm"
          value={gracePeriodValue}
          onChange={(e) => onGracePeriodChange(e.target.value)}
          disabled={filter === "watched"}
          title={filter === "watched"
            ? "Not used when showing previously watched items"
            : "The stricter inactivity or age requirement wins"}
        >
          <option value="default">
            {gracePeriodValue === "default" && defaultGraceDays != null
              ? `Default (${defaultGraceDays} days)`
              : "Default"}
          </option>
          <option value={0}>No additional minimum</option>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
          <option value={180}>180 days</option>
          <option value={365}>1 year</option>
        </select>
      </label>
      {(libraryType === "movie" || libraryType === "show") && (
        <div className="form-control gap-1">
          <span className="label-text text-xs">Storage copies</span>
          <div className="flex items-center gap-2 h-8">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={duplicatesOnly}
              onChange={(e) => onDuplicatesOnlyChange(e.target.checked)}
              id="duplicates-only"
            />
            <label htmlFor="duplicates-only" className="text-sm cursor-pointer">
              {libraryType === "movie"
                ? "Multiple versions"
                : "Duplicate episodes"}
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
