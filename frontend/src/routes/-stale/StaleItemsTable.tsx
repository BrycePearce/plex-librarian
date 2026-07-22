import { ArrowDown, ArrowUp, SearchX, Sparkles } from "lucide-react";
import type { SortKey, StaleItem, StaleParams } from "../../lib/api.ts";
import { StaleItemRow } from "./StaleItemRow.tsx";
import { DataSurface } from "../../components/Workspace.tsx";

function SortTh({
  label,
  field,
  params,
  onSort,
}: {
  label: string;
  field: SortKey;
  params: StaleParams;
  onSort: (f: SortKey) => void;
}) {
  const active = params.sort === field;
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
            params.order === "desc"
              ? <ArrowDown className="w-3 h-3" />
              : <ArrowUp className="w-3 h-3" />
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

export function StaleItemsTable({
  items,
  params,
  onSort,
  isFetching,
  selected,
  onToggle,
  onToggleAll,
  onDeleteOne,
  hasAnimatedIn,
  historySyncedAt,
  isSyncing,
  thisLibraryItemCount,
}: {
  items: StaleItem[];
  params: StaleParams;
  onSort: (f: SortKey) => void;
  isFetching: boolean;
  selected: Map<string, StaleItem>;
  onToggle: (item: StaleItem) => void;
  onToggleAll: () => void;
  onDeleteOne: (item: StaleItem) => void;
  hasAnimatedIn: boolean;
  historySyncedAt: number | null;
  isSyncing: boolean;
  thisLibraryItemCount: number;
}) {
  const maxFileSize = Math.max(1, ...items.map((i) => i.fileSize ?? 0));
  const allOnPageSelected = items.length > 0 &&
    items.every((i) => selected.has(i.ratingKey));
  const someOnPageSelected = items.some((i) => selected.has(i.ratingKey));

  const rows = items.map((item, index) => (
    <StaleItemRow
      key={item.ratingKey}
      item={item}
      index={index}
      animateIn={!hasAnimatedIn}
      maxFileSize={maxFileSize}
      selected={selected.has(item.ratingKey)}
      onToggle={() => onToggle(item)}
      onDelete={() => onDeleteOne(item)}
      historyUnknown={historySyncedAt === null}
    />
  ));

  return (
    <DataSurface className="stale-results-surface overflow-x-auto">
      <progress
        className={`progress progress-primary w-full h-0.5 mb-1 transition-opacity ${
          isFetching ? "opacity-100" : "opacity-0"
        }`}
      />
      <table className="table table-sm table-fixed overflow-hidden">
        <colgroup>
          <col className="w-8" />
          <col />
          <col className="w-24" />
          <col className="w-32" />
          <col className="w-32" />
          <col className="w-16" />
          <col className="w-10" />
        </colgroup>
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={allOnPageSelected}
                ref={(el) => {
                  if (el) {
                    el.indeterminate = !allOnPageSelected && someOnPageSelected;
                  }
                }}
                onChange={onToggleAll}
                aria-label="Select all on this page"
              />
            </th>
            <SortTh
              label="Title"
              field="title"
              params={params}
              onSort={onSort}
            />
            <SortTh
              label="Size"
              field="fileSize"
              params={params}
              onSort={onSort}
            />
            <SortTh
              label="Last viewed"
              field="lastViewedAt"
              params={params}
              onSort={onSort}
            />
            <SortTh
              label="Added"
              field="addedAt"
              params={params}
              onSort={onSort}
            />
            <SortTh
              label="Plays"
              field="viewCount"
              params={params}
              onSort={onSort}
            />
            <th />
          </tr>
        </thead>
        <tbody>
          {rows}
        </tbody>
      </table>
      {items.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-20 text-base-content/40">
          {isSyncing && thisLibraryItemCount === 0
            ? (
              <>
                <span className="loading loading-spinner loading-md" />
                <p className="font-medium text-base-content/60">
                  Still importing this library
                </p>
                <p className="text-sm">
                  Items will show up here once the sync finishes.
                </p>
              </>
            )
            : (
              <>
                {params.search ? <SearchX className="w-8 h-8" /> : <Sparkles className="w-8 h-8" />}
                <p className="font-medium text-base-content/60">
                  {params.search ? "No matching titles" : "All caught up"}
                </p>
                <p className="text-sm">
                  {params.search
                    ? `Nothing in this stale result set matches “${params.search}”.`
                    : "No stale items match these filters."}
                </p>
              </>
            )}
        </div>
      )}
    </DataSurface>
  );
}
