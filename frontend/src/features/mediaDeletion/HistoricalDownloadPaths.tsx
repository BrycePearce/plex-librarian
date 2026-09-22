/// <reference lib="dom" />
import { useState } from "react";
import type { HistoricalDownloadPreview } from "../../../../shared/historicalDownloads.ts";
import type { DeletionOperation } from "../../../../shared/types.ts";

const PAGE_SIZE = 50;
/** Bound rendered rows without dropping any path from the review or consent scope. */
export function HistoricalDownloadPaths(
  props:
    | { preview: HistoricalDownloadPreview; exclusionsOnly?: boolean }
    | { outcomes: NonNullable<DeletionOperation["historicalDownloads"]> },
) {
  const exclusionsOnly = "exclusionsOnly" in props && props.exclusionsOnly;
  const preview = "preview" in props ? props.preview : undefined;
  const outcomes = "outcomes" in props ? props.outcomes : undefined;
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const total = preview
    ? preview.candidates.length + preview.skipped.length + (preview.handled?.length ?? 0)
    : outcomes!.length;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
  const start = currentPage * PAGE_SIZE;
  const end = Math.min(total, start + PAGE_SIZE);
  const rows = [];
  if (open) {
    for (let i = start; i < end; i++) {
      const candidate = preview?.candidates[i];
      const skipped = preview?.skipped[i - preview.candidates.length];
      const handled = preview?.handled?.[i - preview.candidates.length - preview.skipped.length];
      const outcome = outcomes?.[i];
      rows.push(
        <div key={i} className="break-all">
          <p>
            {outcome
              ? `${outcome.path}: ${outcome.status.replaceAll("_", " ")}${
                outcome.reason ? ` — ${outcome.reason}` : ""
              }`
              : candidate
              ? `${candidate.path} · ${candidate.ownerCount} episode owners`
              : handled
              ? `${handled.source}: Handled by qBittorrent (selected eligible action)`
              : `${skipped!.source}: ${skipped!.reason}`}
          </p>
          {skipped?.details && (
            <details>
              <summary>Technical details</summary>
              <pre className="whitespace-pre-wrap">{skipped.details}</pre>
            </details>
          )}
        </div>,
      );
    }
  }
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {exclusionsOnly
          ? "Download paths not included"
          : preview
          ? "Review exact paths and coverage"
          : "Review exact file outcomes"}
      </summary>
      {open && (
        <>
          <p>
            {preview && !exclusionsOnly
              ? `Consent includes all ${preview.candidates.length} listed paths. `
              : ""}
            {total ? start + 1 : 0}–{end} of {total} paths shown.
          </p>
          {rows}
          {total > PAGE_SIZE && (
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-sm"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous paths
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={end === total}
                onClick={() => setPage(currentPage + 1)}
              >
                Next paths
              </button>
            </div>
          )}
        </>
      )}
    </details>
  );
}
