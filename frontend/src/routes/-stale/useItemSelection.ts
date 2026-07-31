import { useState } from "react";
import type { StaleItem } from "../../lib/api.ts";

const EMPTY_SELECTION = new Map<string, StaleItem>();

interface SelectionState {
  scopeKey: string;
  selected: Map<string, StaleItem>;
}

export function useItemSelection(pageItems: StaleItem[], scopeKey: string) {
  const [state, setState] = useState<SelectionState>(() => ({
    scopeKey,
    selected: new Map(),
  }));
  // A search/filter/sort/page navigation can reuse this mounted route component. Treat a
  // changed result set as a fresh selection immediately, before an effect has a chance to
  // run, so hidden items can never leak into the next page's deletion review.
  const selected = state.scopeKey === scopeKey ? state.selected : EMPTY_SELECTION;

  function updateSelected(updater: (current: Map<string, StaleItem>) => Map<string, StaleItem>) {
    setState((prev) => ({
      scopeKey,
      selected: updater(prev.scopeKey === scopeKey ? prev.selected : EMPTY_SELECTION),
    }));
  }

  function toggleOne(item: StaleItem) {
    updateSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.ratingKey)) next.delete(item.ratingKey);
      else next.set(item.ratingKey, item);
      return next;
    });
  }

  function toggleAllOnPage() {
    updateSelected((prev) => {
      const allSelected = pageItems.length > 0 &&
        pageItems.every((i) => prev.has(i.ratingKey));
      const next = new Map(prev);
      if (allSelected) {
        for (const item of pageItems) next.delete(item.ratingKey);
      } else {
        for (const item of pageItems) next.set(item.ratingKey, item);
      }
      return next;
    });
  }

  function clear() {
    setState({ scopeKey, selected: new Map() });
  }

  // Prunes deleted items out of the selection without clearing the rest — called from
  // the delete mutation's onSuccess so a partial-failure delete leaves the still-present
  // items selected.
  function remove(ratingKeys: string[]) {
    updateSelected((prev) => {
      const next = new Map(prev);
      for (const key of ratingKeys) next.delete(key);
      return next;
    });
  }

  const selectedItems = Array.from(selected.values());
  const selectedTotalSize = selectedItems.reduce(
    (sum, i) => sum + (i.fileSize ?? 0),
    0,
  );

  return {
    selected,
    toggleOne,
    toggleAllOnPage,
    clear,
    remove,
    selectedItems,
    selectedTotalSize,
  };
}
