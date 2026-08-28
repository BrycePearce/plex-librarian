import { ArrowDownUp } from "lucide-react";
import type { EpisodeGapsSort } from "@shared/types";
import { ExpandableSearch } from "../../../components/ExpandableSearch.tsx";
import type { EpisodeGapsSearch } from "../types/index.ts";

export function EpisodeGapsFilters(
  { search, audits, pending, update }: {
    search: EpisodeGapsSearch;
    audits: Array<{ libraryKey: string; libraryTitle: string }>;
    pending: boolean;
    update: (next: Partial<EpisodeGapsSearch>) => void;
  },
) {
  return (
    <div className="episode-gaps-filters" aria-label="Gap filters">
      <ExpandableSearch
        search={search.search ?? ""}
        pending={pending}
        onSearchChange={(value) => update({ search: value })}
        label="Search by show title"
        placeholder="Search show titles..."
      />
      <label>
        <span>Library</span>
        <select
          value={search.libraryKey ?? ""}
          onChange={(event) => update({ libraryKey: event.target.value || undefined })}
        >
          <option value="">All TV libraries</option>
          {audits.map((audit) => (
            <option key={audit.libraryKey} value={audit.libraryKey}>{audit.libraryTitle}</option>
          ))}
        </select>
      </label>
      <fieldset className="episode-gaps-status">
        <legend>Status</legend>
        <div>
          {(["gaps", "irregular", "all"] as const).map((status) => (
            <button
              key={status}
              type="button"
              className={search.status === status ? "is-active" : ""}
              onClick={() => update({ status })}
            >
              {status === "gaps" ? "Gaps" : status === "irregular" ? "Irregular" : "All"}
            </button>
          ))}
        </div>
      </fieldset>
      <label>
        <span>Sort</span>
        <select
          value={search.sort}
          onChange={(event) => update({ sort: event.target.value as EpisodeGapsSort })}
        >
          <option value="missingCount">Most missing</option>
          <option value="title">Show title</option>
          {search.scope === "episode" && <option value="seasonIndex">Season number</option>}
          <option value="auditSyncedAt">Recently synced</option>
        </select>
      </label>
      <button
        className="episode-sort-order"
        type="button"
        onClick={() => update({ order: search.order === "asc" ? "desc" : "asc" })}
        aria-label={`Sort ${search.order === "asc" ? "descending" : "ascending"}`}
      >
        <ArrowDownUp /> {search.order === "asc" ? "Asc" : "Desc"}
      </button>
    </div>
  );
}
