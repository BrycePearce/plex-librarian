import { useState } from "react";
import type { StaleItem } from "../../lib/api";

export function useItemSelection(pageItems: StaleItem[]) {
  const [selected, setSelected] = useState<Map<string, StaleItem>>(new Map());

  function toggleOne(item: StaleItem) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.ratingKey)) next.delete(item.ratingKey);
      else next.set(item.ratingKey, item);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelected((prev) => {
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
    setSelected(new Map());
  }

  // Prunes deleted items out of the selection without clearing the rest — called from
  // the delete mutation's onSuccess so a partial-failure delete leaves the still-present
  // items selected.
  function remove(ratingKeys: string[]) {
    setSelected((prev) => {
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
