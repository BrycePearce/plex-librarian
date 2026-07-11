import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { api } from "../lib/api";
import type { Settings } from "../lib/api";

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ["auth", "status"],
      queryFn: api.auth.status,
      staleTime: 60_000,
    });
    if (!status.configured) throw redirect({ to: "/setup" });
  },
  component: SettingsPage,
});

function SettingsPage() {
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings.get,
  });

  return (
    <div className="space-y-6 max-w-md">
      <div className="flex items-center gap-4">
        <Link to="/dashboard" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <div className="card bg-base-200">
        <div className="card-body gap-4">
          <div className="space-y-3">
            <div>
              <h2 className="font-medium">
                Default grace period for new items
              </h2>
              <p className="text-sm text-base-content/40 mt-0.5">
                Unwatched items added within this many days are not considered
                stale. Libraries without their own override use this default.
              </p>
            </div>
            {data
              ? (
                <DebouncedDaysInput
                  initialDays={data.staleMinAgeDays}
                  mutationFn={(value) =>
                    api.settings.update({ staleMinAgeDays: value })}
                  getSavedValue={(updated) => updated.staleMinAgeDays}
                />
              )
              : (
                <input
                  type="number"
                  className="input input-bordered input-sm w-24"
                  disabled
                  aria-label="Loading default grace period"
                />
              )}
          </div>
        </div>
      </div>

      <div className="card bg-base-200">
        <div className="card-body gap-4">
          <div className="space-y-3">
            <div>
              <h2 className="font-medium">Inactive user threshold</h2>
              <p className="text-sm text-base-content/40 mt-0.5">
                Users not watched anything in at least this many days are
                flagged inactive on the Users page.
              </p>
            </div>
            {data
              ? (
                <DebouncedDaysInput
                  initialDays={data.inactiveUserDays}
                  mutationFn={(value) =>
                    api.settings.update({ inactiveUserDays: value })}
                  getSavedValue={(updated) => updated.inactiveUserDays}
                  invalidateQueryKey={["users"]}
                />
              )
              : (
                <input
                  type="number"
                  className="input input-bordered input-sm w-24"
                  disabled
                  aria-label="Loading inactive user threshold"
                />
              )}
          </div>
        </div>
      </div>

      <div className="card bg-base-200">
        <div className="card-body gap-4">
          <div className="space-y-3">
            <div>
              <h2 className="font-medium">IP history retention</h2>
              <p className="text-sm text-base-content/40 mt-0.5">
                Keep user IP transitions for this many days. Set to 0 to keep
                them forever.
              </p>
            </div>
            {data
              ? (
                <DebouncedDaysInput
                  initialDays={data.ipHistoryRetentionDays}
                  mutationFn={(value) =>
                    api.settings.update({ ipHistoryRetentionDays: value })}
                  getSavedValue={(updated) => updated.ipHistoryRetentionDays}
                />
              )
              : (
                <input
                  type="number"
                  className="input input-bordered input-sm w-24"
                  disabled
                  aria-label="Loading IP history retention"
                />
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Only rendered once `data` has loaded (see SettingsPage above), so local editing state
// can be initialized directly from the server value on mount — no Effect syncing data
// into state, and so no frame where "not loaded yet" could be misread as "invalid".
// Generic over which settings key it saves (see api.settings.update's comment for why
// two of these can save independently without clobbering each other).
function DebouncedDaysInput(
  { initialDays, mutationFn, getSavedValue, invalidateQueryKey }: {
    initialDays: number;
    mutationFn: (value: number) => Promise<Settings>;
    getSavedValue: (updated: Settings) => number;
    // Other cached queries that read this setting's value and need to be refetched on
    // save (e.g. the Users page reads inactiveUserDays) — settings itself is patched
    // straight into the cache below via setQueryData, but dependent queries have no
    // such direct link and would otherwise keep serving a stale threshold.
    invalidateQueryKey?: unknown[];
  },
) {
  const qc = useQueryClient();
  const [days, setDays] = useState(String(initialDays));
  const lastSavedRef = useRef(initialDays);

  const [justSaved, setJustSaved] = useState(false);
  const savedTimeoutRef = useRef<number | undefined>(undefined);

  const update = useMutation({
    mutationFn,
    onSuccess: (updated) => {
      qc.setQueryData(["settings"], updated);
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
  const valid = days !== "" && Number.isInteger(parsed) && parsed >= 0;

  // Debounced auto-save: waits for typing to settle so we don't PATCH on every keystroke.
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
        step={1}
        className={`input input-bordered input-sm w-24 ${
          !valid ? "input-error" : ""
        }`}
        value={days}
        onChange={(e) => setDays(e.target.value)}
      />
      <span className="text-sm text-base-content/40">days</span>
      {update.isPending && (
        <span className="loading loading-spinner loading-xs text-base-content/40" />
      )}
      <span
        className={`flex items-center gap-1 text-xs text-success transition-opacity duration-300 ${
          justSaved && !update.isPending ? "opacity-100" : "opacity-0"
        }`}
      >
        <Check className="w-3.5 h-3.5" /> Saved
      </span>
      {update.isError && (
        <span className="text-xs text-error">
          {update.error instanceof Error
            ? update.error.message
            : "Failed to save"}
        </span>
      )}
    </div>
  );
}
