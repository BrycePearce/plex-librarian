import { type RefObject, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Info, ListVideo } from "lucide-react";
import type { PlexUser } from "../../../lib/api.ts";
import { api } from "../../../lib/api.ts";
import { queryKeys } from "../../../lib/queryKeys.ts";
import {
  type OutcomeFilter,
  RequestEvidenceLedger,
  RequestEvidenceLedgerSkeleton,
} from "./RequestEvidenceLedger.tsx";
import { getRequestFollowThroughPresentation } from "./presentation.ts";

const DETAIL_LIMIT = 200;

export function RequestFollowThroughDialog({
  dialogRef,
  user,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  user: PlexUser | null;
  onClose: () => void;
}) {
  const assessment = user?.requestFollowThrough;
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const presentation = assessment ? getRequestFollowThroughPresentation(assessment) : null;
  const canShowBreakdown = assessment !== undefined && assessment.status !== "unavailable";
  const detailsQuery = useQuery({
    queryKey: queryKeys.users.requestFollowThrough(user?.accountId ?? null),
    queryFn: () => api.users.requestFollowThrough(user!.accountId, DETAIL_LIMIT),
    enabled: Boolean(user && canShowBreakdown),
    staleTime: 30_000,
  });
  const watchedItems = detailsQuery.data?.items.filter((item) => item.watchedAt !== null) ?? [];
  const unwatchedItems = detailsQuery.data?.items.filter((item) => item.watchedAt === null) ?? [];
  const visibleItems = outcomeFilter === "watched"
    ? watchedItems
    : outcomeFilter === "unwatched"
    ? unwatchedItems
    : detailsQuery.data?.items ?? [];
  const explanatoryReasons =
    assessment?.reasons.filter((reason) =>
      reason.type !== "followed_through" &&
      reason.type !== "not_watched" &&
      reason.type !== "habit_assessment"
    ) ?? [];
  const watchedPercent = assessment?.eligibleRequestCount
    ? ((assessment.watchedRequestCount ?? 0) / assessment.eligibleRequestCount) * 100
    : 0;

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onClose={() => {
        setOutcomeFilter("all");
        onClose();
      }}
    >
      <div className="modal-box polished-modal flex max-h-[90vh] max-w-5xl flex-col p-0">
        <div className="shrink-0 border-b border-base-300 px-6 pb-4 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-base-content/45">
            Request follow-through
          </p>
          <h3 className="mt-1 truncate text-xl font-semibold">{user?.username}</h3>
          {user?.email && <p className="truncate text-sm text-base-content/45">{user.email}</p>}
        </div>

        {assessment && (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <section className="rounded-xl border border-base-300 bg-base-200/55 p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className={`badge badge-outline ${presentation!.badgeClass}`}>
                    {presentation!.label}
                  </span>
                  <p className="mt-2 text-sm text-base-content/55">
                    Requests not watched after becoming available
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-3xl font-semibold tabular-nums">
                    {assessment.nonWatchPercent === null ? "—" : `${assessment.nonWatchPercent}%`}
                  </span>
                  <div className="text-xs text-base-content/40">
                    {assessment.nonWatchPercent === null ? presentation!.detail : "not watched"}
                  </div>
                </div>
              </div>

              {assessment.watchedRequestCount !== null &&
                assessment.unwatchedRequestCount !== null && (
                <div className="mt-4">
                  <div
                    className="flex h-2.5 overflow-hidden rounded-full bg-error/70"
                    role="img"
                    aria-label={`${assessment.watchedRequestCount} watched and ${assessment.unwatchedRequestCount} not watched`}
                  >
                    <div
                      className="bg-success transition-[width] duration-500"
                      style={{ width: `${watchedPercent}%` }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 text-success">
                      <span className="size-2 rounded-full bg-success" />
                      {assessment.watchedRequestCount.toLocaleString()} followed through
                    </span>
                    <span className="flex items-center gap-1.5 text-error">
                      <span className="size-2 rounded-full bg-error" />
                      {assessment.unwatchedRequestCount.toLocaleString()} not watched
                    </span>
                  </div>
                </div>
              )}
            </section>

            {explanatoryReasons.length > 0 && (
              <details className="group rounded-xl border border-base-300 bg-base-200/25">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                  <Info className="size-4 shrink-0 text-info" />
                  <span className="flex-1 text-sm font-medium">Assessment notes</span>
                  <span className="badge badge-ghost badge-sm">
                    {explanatoryReasons.length}
                  </span>
                </summary>
                <ul className="space-y-2 border-t border-base-300 p-3">
                  {explanatoryReasons.map((reason) => (
                    <li
                      key={reason.type}
                      className="rounded-lg border border-base-300 bg-base-100/35 px-3 py-2.5 text-sm text-base-content/70"
                    >
                      {reason.summary}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex gap-3 rounded-lg bg-base-200/45 p-3 text-sm text-base-content/60">
              <CalendarClock className="mt-0.5 size-4 shrink-0" />
              <p>
                Requests enter measurement {assessment.graceDays}{" "}
                days after availability and remain in the rolling view for {assessment.windowDays}
                {" "}
                days. For TV requests, watching an episode from any requested season counts as
                follow-through.
              </p>
            </div>

            {canShowBreakdown && (
              <section aria-labelledby="follow-through-breakdown-heading">
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div>
                    <h4 id="follow-through-breakdown-heading" className="font-semibold">
                      Request breakdown
                    </h4>
                    <p className="mt-0.5 text-sm text-base-content/50">
                      What was requested, and whether Plex recorded a later watch.
                    </p>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-base-content/40">
                    {assessment.eligibleRequestCount.toLocaleString()} eligible
                  </span>
                </div>

                {detailsQuery.isLoading
                  ? <RequestEvidenceLedgerSkeleton />
                  : detailsQuery.isError
                  ? (
                    <div className="rounded-xl border border-error/30 bg-error/5 p-4 text-sm">
                      <p className="text-error">Could not load the request-level breakdown.</p>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs mt-2"
                        onClick={() => void detailsQuery.refetch()}
                      >
                        Try again
                      </button>
                    </div>
                  )
                  : detailsQuery.data?.items.length
                  ? (
                    <>
                      <RequestEvidenceLedger
                        items={visibleItems}
                        filter={outcomeFilter}
                        watchedCount={assessment.watchedRequestCount ?? watchedItems.length}
                        unwatchedCount={assessment.unwatchedRequestCount ?? unwatchedItems.length}
                        onFilterChange={setOutcomeFilter}
                      />
                      {detailsQuery.data.total > detailsQuery.data.items.length && (
                        <p className="mt-2 text-center text-xs text-base-content/45">
                          Showing the newest {detailsQuery.data.items.length.toLocaleString()} of
                          {" "}
                          {detailsQuery.data.total.toLocaleString()} eligible requests.
                        </p>
                      )}
                    </>
                  )
                  : (
                    <div className="rounded-xl border border-dashed border-base-300 p-6 text-center">
                      <ListVideo className="mx-auto size-5 text-base-content/30" />
                      <p className="mt-2 text-sm text-base-content/55">
                        No request-level details are available yet.
                      </p>
                    </div>
                  )}
              </section>
            )}
          </div>
        )}

        <div className="modal-action m-0 shrink-0 border-t border-base-300 px-6 py-4">
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit">close</button>
      </form>
    </dialog>
  );
}
