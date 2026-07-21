import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Settings } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

// Only rendered once settings data has loaded, so local editing state can be
// initialized directly from the server value on mount. The component is generic
// over which settings key it saves so independent fields cannot clobber each other.
export function DebouncedDaysInput({
  initialDays,
  mutationFn,
  getSavedValue,
  invalidateQueryKey,
  maxDays,
  minimumNonZero,
}: {
  initialDays: number;
  mutationFn: (value: number) => Promise<Settings>;
  getSavedValue: (updated: Settings) => number;
  invalidateQueryKey?: QueryKey;
  maxDays?: number;
  minimumNonZero?: number;
}) {
  const qc = useQueryClient();
  const [days, setDays] = useState(String(initialDays));
  const lastSavedRef = useRef(initialDays);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const update = useMutation({
    mutationFn,
    onSuccess: (updated) => {
      qc.setQueryData(queryKeys.settings.all, updated);
      if (invalidateQueryKey) {
        void qc.invalidateQueries({ queryKey: invalidateQueryKey });
      }
      lastSavedRef.current = getSavedValue(updated);
      setJustSaved(true);
      clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = setTimeout(() => setJustSaved(false), 2000);
    },
  });

  useEffect(() => () => clearTimeout(savedTimeoutRef.current), []);

  const parsed = Number(days);
  const valid = days !== "" &&
    Number.isInteger(parsed) &&
    parsed >= 0 &&
    (minimumNonZero === undefined ||
      parsed === 0 ||
      parsed >= minimumNonZero) &&
    (maxDays === undefined || parsed <= maxDays);

  // Wait for typing to settle so changing a field does not PATCH every keystroke.
  useEffect(() => {
    if (!valid || parsed === lastSavedRef.current) return;
    const timer = setTimeout(() => update.mutate(parsed), 500);
    return () => clearTimeout(timer);
  }, [days, valid, parsed]);

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={0}
        max={maxDays}
        step={1}
        className={`input input-bordered input-sm w-24 ${!valid ? "input-error" : ""}`}
        value={days}
        onChange={(event) => setDays(event.target.value)}
        title={minimumNonZero === undefined
          ? undefined
          : `Enter 0 or at least ${minimumNonZero} days`}
      />
      <span className="text-sm text-base-content/40">days</span>
      {update.isPending && (
        <span className="loading loading-spinner loading-xs text-base-content/40" />
      )}
      <span
        className={`flex items-center gap-1 text-xs text-success transition-opacity duration-300 ${
          justSaved && !update.isPending ? "opacity-100" : "opacity-0"
        } ${justSaved && !update.isPending ? "settings-save-status-visible" : ""}`}
      >
        <Check className="w-3.5 h-3.5" /> Saved
      </span>
      {update.isError && (
        <span className="text-xs text-error">
          {update.error instanceof Error ? update.error.message : "Failed to save"}
        </span>
      )}
    </div>
  );
}
