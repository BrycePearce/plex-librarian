import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";
import { Loader2, Sparkles, X } from "lucide-react";
import { ErrorAlert } from "../../components/ErrorAlert.tsx";
import { useDeletionOperationTracker } from "../deletionOperations/DeletionOperationCoordinator.tsx";
import { api } from "../../lib/api.ts";
import type { SmartDuplicateAnalysisResponse, SmartDuplicateCandidate } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { CleanupResults } from "./CleanupResults.tsx";
import { candidateKey, selectedSize } from "./model.ts";
import "./quickCleanup.css";

type Phase = "configure" | "results";

export interface SmartCleanupDialogHandle {
  open: () => void;
}

export const SmartCleanupDialog = forwardRef<SmartCleanupDialogHandle>(
  function SmartCleanupDialog(_props, ref) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const { trackDeletionOperation } = useDeletionOperationTracker();
    const [phase, setPhase] = useState<Phase>("configure");
    const [analysis, setAnalysis] = useState<SmartDuplicateAnalysisResponse | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [keepSelections, setKeepSelections] = useState<Map<string, number>>(new Map());
    const [expandedCandidate, setExpandedCandidate] = useState<string | null>(null);
    const cleanupRequestId = useRef(uuidv4());

    const analyze = useMutation({
      mutationFn: () => api.duplicates.smartAnalysis({ movies: true, tv: true }),
      onSuccess: (result) => {
        setAnalysis(result);
        setSelected(
          new Set(
            result.candidates
              .filter((candidate) => candidate.confidence !== "review")
              .map(candidateKey),
          ),
        );
        setKeepSelections(
          new Map(
            result.candidates.map((candidate) => [candidateKey(candidate), candidate.keepMediaId]),
          ),
        );
        setPhase("results");
      },
    });
    const chosen = useMemo(
      () => analysis?.candidates.filter((candidate) => selected.has(candidateKey(candidate))) ?? [],
      [analysis, selected],
    );
    const chosenPlans = useMemo(
      () =>
        chosen.map((candidate) => {
          const keepMediaId = keepSelections.get(candidateKey(candidate)) ??
            candidate.keepMediaId;
          return {
            candidate,
            deleteMediaIds: candidate.versions
              .filter((version) => version.mediaId !== keepMediaId)
              .map((version) => version.mediaId)
              .sort((left, right) => left - right),
          };
        }),
      [chosen, keepSelections],
    );
    const reclaimableSize = analysis
      ? selectedSize(analysis.candidates, selected, keepSelections)
      : null;
    const deleteVersionCount = chosenPlans.reduce(
      (total, plan) => total + plan.deleteMediaIds.length,
      0,
    );
    const cleanup = useMutation({
      mutationFn: () =>
        api.duplicates.smartCleanup(
          cleanupRequestId.current,
          chosenPlans.map(({ candidate, deleteMediaIds }) => ({
            mediaType: candidate.mediaType,
            ratingKey: candidate.ratingKey,
            deleteMediaIds,
          })),
          chosen.some((candidate) => candidate.confidence === "near-identical"),
        ),
      onSuccess: (result) => {
        const invalidations = [
          queryKeys.duplicates.all,
          queryKeys.stale.all,
          queryKeys.libraries.all,
          queryKeys.events.all,
          queryKeys.mediaRemovals.all,
        ];
        for (const operationId of result.operationIds) {
          trackDeletionOperation(operationId, invalidations);
        }
        dialogRef.current?.close();
        reset();
      },
    });

    function reset() {
      setPhase("configure");
      setAnalysis(null);
      setSelected(new Set());
      setKeepSelections(new Map());
      setExpandedCandidate(null);
      analyze.reset();
      cleanup.reset();
    }

    useImperativeHandle(ref, () => ({
      open() {
        reset();
        cleanupRequestId.current = uuidv4();
        dialogRef.current?.showModal();
        analyze.mutate();
      },
    }));

    function toggleCandidate(candidate: SmartDuplicateCandidate) {
      const key = candidateKey(candidate);
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }

    function setConfidenceSelection(
      confidence: "obvious" | "near-identical",
      included: boolean,
    ) {
      if (!analysis) return;
      const confidenceKeys = analysis.candidates
        .filter((candidate) => candidate.confidence === confidence)
        .map(candidateKey);
      setSelected((current) => {
        const next = new Set(current);
        for (const key of confidenceKeys) {
          if (included) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    }

    function updateKeeper(candidate: SmartDuplicateCandidate, mediaId: number) {
      setKeepSelections((current) => {
        const next = new Map(current);
        next.set(candidateKey(candidate), mediaId);
        return next;
      });
    }

    function close() {
      if (cleanup.isPending) return;
      dialogRef.current?.close();
      reset();
    }

    return (
      <dialog
        ref={dialogRef}
        className="modal"
        onClose={reset}
        onCancel={(event) => {
          if (cleanup.isPending) event.preventDefault();
        }}
      >
        <div className="modal-box smart-cleanup-modal max-w-4xl p-0">
          <header className="smart-cleanup-header">
            <div className="smart-cleanup-header-icon">
              <Sparkles className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] opacity-55">
                Storage intelligence
              </div>
              <h2 className="mt-1 text-xl font-semibold">Quick cleanup</h2>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square ml-auto"
              aria-label="Close"
              disabled={cleanup.isPending}
              onClick={close}
            >
              <X className="size-4" />
            </button>
          </header>

          <div className="smart-cleanup-body">
            {phase === "configure" && analyze.isPending && (
              <div className="smart-cleanup-analyzing">
                <div className="smart-cleanup-analyzing-orbit">
                  <Sparkles className="size-6" />
                </div>
                <strong>Finding the largest safe cleanup candidates</strong>
                <span>
                  Checking cuts, video profiles, HDR, audio, subtitles, and reclaimable space across
                  the selected libraries.
                </span>
              </div>
            )}

            {phase === "configure" && analyze.isError && (
              <ErrorAlert
                message={analyze.error instanceof Error
                  ? analyze.error.message
                  : "Duplicate analysis failed"}
                onRetry={() => analyze.mutate()}
              />
            )}

            {phase === "results" && analysis && (
              <>
                <CleanupResults
                  analysis={analysis}
                  selected={selected}
                  keepSelections={keepSelections}
                  expandedCandidate={expandedCandidate}
                  reclaimableSize={reclaimableSize}
                  onToggleCandidate={toggleCandidate}
                  onSetConfidenceSelection={setConfidenceSelection}
                  onExpandedCandidateChange={setExpandedCandidate}
                  onKeepChange={updateKeeper}
                />
                {cleanup.isError && (
                  <ErrorAlert
                    message={cleanup.error instanceof Error
                      ? cleanup.error.message
                      : "Cleanup could not be queued"}
                    onRetry={() => cleanup.mutate()}
                  />
                )}
              </>
            )}
          </div>

          <footer className="smart-cleanup-footer">
            {phase === "configure" && (
              <button type="button" className="btn btn-ghost" onClick={close}>
                Cancel
              </button>
            )}
            {phase === "results" && (
              <button
                type="button"
                className="btn btn-error min-w-44"
                disabled={chosen.length === 0 || cleanup.isPending}
                onClick={() => cleanup.mutate()}
              >
                {cleanup.isPending
                  ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Queuing cleanup…
                    </>
                  )
                  : `Remove ${deleteVersionCount.toLocaleString()} ${
                    deleteVersionCount === 1 ? "version" : "versions"
                  }`}
              </button>
            )}
          </footer>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="submit" disabled={cleanup.isPending}>close</button>
        </form>
      </dialog>
    );
  },
);
