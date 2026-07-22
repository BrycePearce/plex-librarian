import type { RefObject } from "react";
import { CalendarClock, CheckCircle2, Clock3, Info, PlayCircle, XCircle } from "lucide-react";
import type { PlexUser } from "../../lib/api";

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
  const statusLabel = assessment?.status === "healthy"
    ? "Healthy"
    : assessment?.status === "watch"
    ? "Watch"
    : assessment?.status === "review"
    ? "Review"
    : assessment?.status === "insufficient_data"
    ? "Collecting data"
    : "Unavailable";
  const badgeClass = assessment?.status === "review"
    ? "badge-error"
    : assessment?.status === "watch"
    ? "badge-warning"
    : assessment?.status === "healthy"
    ? "badge-success"
    : "badge-ghost";
  return (
    <dialog ref={dialogRef} className="modal" onClose={onClose}>
      <div className="modal-box polished-modal max-w-xl p-0">
        <div className="border-b border-base-300 px-6 pb-4 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-base-content/45">
            Request follow-through
          </p>
          <h3 className="mt-1 truncate text-xl font-semibold">{user?.username}</h3>
          {user?.email && <p className="truncate text-sm text-base-content/45">{user.email}</p>}
        </div>

        {assessment && (
          <div className="space-y-5 px-6 py-5">
            <div className="rounded-xl border border-base-300 bg-base-200/55 p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span
                    className={`badge badge-outline ${badgeClass}`}
                  >
                    {statusLabel}
                  </span>
                  <p className="mt-2 text-sm text-base-content/55">
                    Requests not watched after becoming available
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-3xl font-semibold tabular-nums">
                    {assessment.nonWatchPercent === null ? "—" : `${assessment.nonWatchPercent}%`}
                  </span>
                  {assessment.status === "insufficient_data"
                    ? (
                      <div className="text-xs text-base-content/40">
                        starts at {assessment.minimumRequests} requests
                      </div>
                    )
                    : assessment.status === "unavailable"
                    ? <div className="text-xs text-base-content/40">measurement paused</div>
                    : <div className="text-xs text-base-content/40">not watched</div>}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Stat icon={PlayCircle} value={assessment.eligibleRequestCount} label="eligible" />
              <Stat icon={CheckCircle2} value={assessment.watchedRequestCount} label="watched" />
              <Stat icon={XCircle} value={assessment.unwatchedRequestCount} label="not watched" />
            </div>

            {assessment.status !== "unavailable" &&
              assessment.status !== "insufficient_data" && (
              <p className="text-sm text-base-content/70">
                {assessment.unwatchedRequestCount} of {assessment.eligibleRequestCount}{" "}
                eligible requests were not watched.
              </p>
            )}

            <section aria-labelledby="follow-through-reasons-heading">
              <h4 id="follow-through-reasons-heading" className="font-semibold">
                How this was assessed
              </h4>
              <ul className="mt-2 space-y-2">
                {assessment.reasons.map((reason) => (
                  <li
                    key={reason.type}
                    className="flex items-start gap-3 rounded-lg border border-base-300 px-3 py-2.5"
                  >
                    <Info className="mt-0.5 size-4 shrink-0 text-info" />
                    <span className="text-sm text-base-content/70">{reason.summary}</span>
                  </li>
                ))}
              </ul>
            </section>

            <div className="flex gap-3 rounded-lg bg-base-200/45 p-3 text-sm text-base-content/60">
              <CalendarClock className="mt-0.5 size-4 shrink-0" />
              <p>
                Requests enter the measurement {assessment.graceDays}{" "}
                days after availability. The assessment uses requests whose grace period ended in
                the latest {assessment.windowDays}{" "}
                days. If an estimated availability date has no confirmed watch at or after it, the
                assessment pauses instead of treating the request as not watched. For TV requests,
                watching an episode from any requested season counts as follow-through.
              </p>
            </div>
          </div>
        )}

        <div className="modal-action m-0 px-6 py-4">
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit">close</button>
      </form>
    </dialog>
  );
}

function Stat({ icon: Icon, value, label }: {
  icon: typeof Clock3;
  value: number | null;
  label: string;
}) {
  return (
    <div className="rounded-lg border border-base-300 px-3 py-2.5">
      <Icon className="mb-1 size-3.5 text-base-content/35" />
      <div className="font-semibold tabular-nums">
        {value === null ? "—" : value.toLocaleString()}
      </div>
      <div className="text-[11px] text-base-content/45">{label}</div>
    </div>
  );
}
