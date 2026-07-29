import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCircle2, Gauge, HardDrive, ShieldCheck } from "lucide-react";
import { ErrorAlert } from "../../components/ErrorAlert.tsx";
import { HistorySyncWarning } from "../../components/HistorySyncWarning.tsx";
import { HoverPopover } from "../../components/HoverPopover.tsx";
import { DeleteConfirmDialog } from "../../features/mediaDeletion/DeleteConfirmDialog.tsx";
import { api } from "../../lib/api.ts";
import type {
  StaleQuickCleanupCandidate,
  StaleQuickCleanupOrder,
  StaleQuickCleanupSort,
} from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { useDeleteItems } from "../../lib/useDeleteItems.ts";
import { QuickCleanupCandidateRow } from "./QuickCleanupCandidateRow.tsx";
import { formatQuickCleanupLibraryShare } from "./quickCleanupPresentation.ts";
import { selectedQuickCleanupKeys, updateQuickCleanupExclusions } from "./quickCleanupSelection.ts";

const THRESHOLDS = [
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
  { days: 730, label: "2 years" },
  { days: 1_095, label: "3 years" },
] as const;

export function QuickCleanupPanel({
  libraryKey,
  libraryItemCount,
  isSyncing,
  isSyncStatusLoading,
  onClose,
}: {
  libraryKey: string;
  libraryItemCount: number;
  isSyncing: boolean;
  isSyncStatusLoading: boolean;
  onClose: () => void;
}) {
  const [thresholdDays, setThresholdDays] = useState(730);
  const [sort, setSort] = useState<StaleQuickCleanupSort>("fileSize");
  const [order, setOrder] = useState<StaleQuickCleanupOrder>("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedRatingKey, setExpandedRatingKey] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const exclusionsByScope = useRef(new Map<string, Set<string>>());
  const dialogRef = useRef<HTMLDialogElement>(null);
  const quickKey = queryKeys.staleQuickCleanup.analysis(
    libraryKey,
    thresholdDays,
    sort,
    order,
  );
  const analysis = useQuery({
    queryKey: quickKey,
    queryFn: () => api.libraries.staleQuickCleanup(libraryKey, thresholdDays, sort, order),
    placeholderData: (previousData) => previousData,
    staleTime: 30_000,
    retry: 1,
  });
  const deleteMutation = useDeleteItems([
    queryKeys.staleQuickCleanup.library(libraryKey),
    queryKeys.stale.library(libraryKey),
    queryKeys.libraries.all,
    queryKeys.events.all,
    queryKeys.mediaRemovals.all,
  ]);

  useEffect(() => {
    if (!analysis.data || analysis.isPlaceholderData) return;
    const scope = `${libraryKey}:${thresholdDays}`;
    const available = analysis.data.candidates.map((candidate) => candidate.ratingKey);
    setSelected(
      selectedQuickCleanupKeys(
        available,
        exclusionsByScope.current.get(scope) ?? new Set(),
      ),
    );
  }, [analysis.data, analysis.isPlaceholderData, libraryKey, thresholdDays]);

  useEffect(() => {
    if (reviewOpen) dialogRef.current?.showModal();
  }, [reviewOpen]);

  const selectedItems = useMemo(
    () => analysis.data?.candidates.filter((candidate) => selected.has(candidate.ratingKey)) ?? [],
    [analysis.data, selected],
  );
  const selectedSize = selectedItems.reduce((total, item) => total + (item.fileSize ?? 0), 0);
  const unknownSelectedSize = selectedItems.filter((item) => item.fileSize == null).length;

  function toggle(candidate: StaleQuickCleanupCandidate) {
    const scope = `${libraryKey}:${thresholdDays}`;
    const excluded = updateQuickCleanupExclusions(
      exclusionsByScope.current.get(scope) ?? new Set(),
      [candidate.ratingKey],
      selected.has(candidate.ratingKey),
    );
    exclusionsByScope.current.set(scope, excluded);
    setSelected(
      selectedQuickCleanupKeys(
        analysis.data?.candidates.map((item) => item.ratingKey) ?? [],
        excluded,
      ),
    );
  }

  function toggleAll() {
    if (!analysis.data) return;
    const allSelected = analysis.data.candidates.length > 0 &&
      analysis.data.candidates.every((candidate) => selected.has(candidate.ratingKey));
    const scope = `${libraryKey}:${thresholdDays}`;
    const ratingKeys = analysis.data.candidates.map((candidate) => candidate.ratingKey);
    const excluded = updateQuickCleanupExclusions(
      exclusionsByScope.current.get(scope) ?? new Set(),
      ratingKeys,
      allSelected,
    );
    exclusionsByScope.current.set(scope, excluded);
    setSelected(selectedQuickCleanupKeys(ratingKeys, excluded));
  }

  function changeSort(nextSort: StaleQuickCleanupSort) {
    setExpandedRatingKey(null);
    if (sort === nextSort) {
      setOrder((current) => current === "desc" ? "asc" : "desc");
      return;
    }
    setSort(nextSort);
    setOrder("desc");
  }

  if (analysis.isLoading) {
    return (
      <div className="quick-stale-loading">
        <span className="loading loading-spinner loading-lg text-primary" />
        <strong>Finding likely cleanup candidates</strong>
        <span>Checking cross-user activity, requests, duplicates, and reclaimable space.</span>
      </div>
    );
  }

  if (analysis.isError) {
    return (
      <ErrorAlert
        message={analysis.error instanceof Error
          ? analysis.error.message
          : "Quick cleanup analysis failed"}
        onRetry={() => void analysis.refetch()}
      />
    );
  }

  const data = analysis.data;
  if (!data) return null;

  if (!data.eligible) {
    return (
      <div className="space-y-4">
        {data.unavailableReason === "history-incomplete"
          ? (
            <HistorySyncWarning
              historySyncedAt={data.historySyncedAt}
              isSyncing={isSyncing}
              isSyncStatusLoading={isSyncStatusLoading}
              syncingMessage="Quick cleanup will unlock when cross-user watch history finishes syncing."
              warningMessage="Quick cleanup needs complete cross-user watch history before it can recommend whole-title removals."
            />
          )
          : (
            <div className="quick-stale-empty">
              <ShieldCheck className="size-9 text-info" />
              <strong>Quick cleanup is designed for movies and shows</strong>
              <span>Use the full stale-item browser to review this library.</span>
            </div>
          )}
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Back to stale items
        </button>
      </div>
    );
  }

  const protectedCount = data.duplicateProtectedCount + data.recentRequestProtectedCount +
    data.activePlaybackProtectedCount;
  const shownCount = data.candidates.length;
  const allShownSelected = shownCount > 0 &&
    data.candidates.every((candidate) => selected.has(candidate.ratingKey));
  const thresholdFilter = (
    <div className="quick-stale-filter-row">
      {analysis.isPlaceholderData && (
        <span
          className="loading loading-spinner loading-xs text-primary"
          aria-label="Updating recommendations"
        />
      )}
      <label>
        <span>Inactive at least</span>
        <select
          className="select select-bordered select-sm"
          value={thresholdDays}
          onChange={(event) => {
            setExpandedRatingKey(null);
            setThresholdDays(Number(event.target.value));
          }}
        >
          {THRESHOLDS.map((threshold) => (
            <option key={threshold.days} value={threshold.days}>{threshold.label}</option>
          ))}
        </select>
      </label>
    </div>
  );

  return (
    <div className="quick-stale-workspace space-y-4">
      <div className="quick-stale-intro">
        <h2>Likely ready to let go</h2>
        <p>Inactive whole titles that passed every cleanup safeguard.</p>
      </div>

      <div className="quick-stale-stats">
        <HoverPopover
          content="Inactive titles that passed every cleanup safeguard and are recommended for removal at the selected threshold."
          anchorClassName="quick-stale-stat"
          anchorTabIndex={0}
        >
          <CheckCircle2 className="size-4 text-success" />
          <span>Recommended</span>
          <strong>{data.candidateTotal.toLocaleString()}</strong>
        </HoverPopover>
        <HoverPopover
          content="Combined synced size of all recommended titles. Titles whose size is unavailable are reported separately."
          anchorClassName="quick-stale-stat"
          anchorTabIndex={0}
        >
          <HardDrive className="size-4 text-primary" />
          <span>Potential savings</span>
          <strong>
            {formatKilobytes(data.candidateFileSize)}
            {data.unknownSizeCount > 0 &&
              ` + ${data.unknownSizeCount.toLocaleString()} unknown-size`}
          </strong>
        </HoverPopover>
        <HoverPopover
          content="Inactive titles excluded because they have multiple versions, a recent approved or completed Seerr request, or active playback."
          anchorClassName="quick-stale-stat"
          anchorTabIndex={0}
        >
          <ShieldCheck className="size-4 text-info" />
          <span>Protected</span>
          <strong>{protectedCount.toLocaleString()}</strong>
        </HoverPopover>
        <HoverPopover
          content="Recommended titles as a percentage of every title in this library."
          anchorClassName="quick-stale-stat"
          anchorTabIndex={0}
        >
          <Gauge className="size-4 text-secondary" />
          <span>Of library</span>
          <strong>{formatQuickCleanupLibraryShare(data.candidateTotal, libraryItemCount)}</strong>
        </HoverPopover>
      </div>

      {shownCount === 0
        ? (
          <>
            <div className="quick-stale-empty">
              <ShieldCheck className="size-9 text-success" />
              <strong>No recommended cleanup candidates</strong>
              <span>Try a shorter inactivity window or browse all stale items manually.</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
                Back to stale items
              </button>
            </div>
            {thresholdFilter}
          </>
        )
        : (
          <>
            <div className="quick-stale-list-header">
              <span>
                {shownCount < data.candidateTotal
                  ? `${shownCount.toLocaleString()} of ${data.candidateTotal.toLocaleString()} recommendations`
                  : "Recommended titles"}
              </span>
              <span>{selected.size.toLocaleString()} selected</span>
            </div>
            <div className="quick-stale-list">
              <div className="quick-stale-column-header">
                <label
                  title={allShownSelected ? "Deselect all shown titles" : "Select all shown titles"}
                >
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={allShownSelected}
                    disabled={analysis.isPlaceholderData}
                    onChange={toggleAll}
                  />
                </label>
                <span>Title</span>
                {(["inactiveSince", "fileSize"] as const).map((option) => {
                  const active = sort === option;
                  const label = option === "inactiveSince" ? "Inactive" : "Size";
                  const DirectionIcon = order === "desc" ? ArrowDown : ArrowUp;
                  return (
                    <button
                      key={option}
                      type="button"
                      className={active ? "is-active" : ""}
                      aria-pressed={active}
                      disabled={analysis.isPlaceholderData}
                      title={active
                        ? `Sorted by ${label.toLowerCase()} ${
                          order === "desc" ? "descending" : "ascending"
                        }; click to reverse`
                        : `Sort by ${label.toLowerCase()}`}
                      onClick={() => changeSort(option)}
                    >
                      {label}
                      {active && <DirectionIcon className="size-3.5" aria-hidden="true" />}
                    </button>
                  );
                })}
                <span className="sr-only">File paths</span>
              </div>
              {data.candidates.map((candidate) => {
                const checked = selected.has(candidate.ratingKey);
                return (
                  <QuickCleanupCandidateRow
                    key={candidate.ratingKey}
                    candidate={candidate}
                    checked={checked}
                    disabled={analysis.isPlaceholderData}
                    expanded={expandedRatingKey === candidate.ratingKey}
                    onToggle={() => toggle(candidate)}
                    onExpandedChange={() =>
                      setExpandedRatingKey((current) =>
                        current === candidate.ratingKey ? null : candidate.ratingKey
                      )}
                  />
                );
              })}
            </div>
            {thresholdFilter}
            <div className="quick-stale-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={analysis.isPlaceholderData || selectedItems.length === 0}
                onClick={() => setReviewOpen(true)}
              >
                Review cleanup · {formatKilobytes(selectedSize)}
                {unknownSelectedSize > 0 &&
                  ` + ${unknownSelectedSize.toLocaleString()} unknown-size`}
              </button>
            </div>
          </>
        )}

      {reviewOpen && (
        <DeleteConfirmDialog
          dialogRef={dialogRef}
          libraryKey={libraryKey}
          items={selectedItems}
          pending={deleteMutation.isPending}
          error={deleteMutation.error}
          onConfirm={({ coordinatedRatingKeys, cleanupDownloads }) =>
            deleteMutation.mutate(
              {
                libraryKey,
                ratingKeys: selectedItems.map((item) => item.ratingKey),
                coordinatedRatingKeys,
                cleanupDownloads,
                quickCleanupThresholdDays: thresholdDays,
              },
              {
                onSuccess: () => {
                  setReviewOpen(false);
                  const scope = `${libraryKey}:${thresholdDays}`;
                  const submittedKeys = selectedItems.map((item) => item.ratingKey);
                  const excluded = updateQuickCleanupExclusions(
                    exclusionsByScope.current.get(scope) ?? new Set(),
                    submittedKeys,
                    true,
                  );
                  exclusionsByScope.current.set(scope, excluded);
                  setSelected(
                    selectedQuickCleanupKeys(
                      analysis.data?.candidates.map((item) => item.ratingKey) ?? [],
                      excluded,
                    ),
                  );
                  onClose();
                },
              },
            )}
          onCancel={() => setReviewOpen(false)}
        />
      )}
    </div>
  );
}
