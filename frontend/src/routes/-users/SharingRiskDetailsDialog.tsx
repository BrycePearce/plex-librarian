import type { RefObject } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Info,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import type { PlexUser } from "../../lib/api";
import { formatDate } from "../../lib/format";
import "../../components/dataSurfaces.css";

type MonitorStatus = "starting" | "connected" | "polling" | "disconnected";
type Assessment = PlexUser["sharingRisk"];

const riskPresentation = {
  insufficient_data: {
    label: "Limited data",
    badge: "badge-ghost",
    progress: "progress-neutral",
    icon: Info,
  },
  low: {
    label: "Low",
    badge: "badge-success",
    progress: "progress-success",
    icon: CheckCircle2,
  },
  watch: {
    label: "Watch",
    badge: "badge-warning",
    progress: "progress-warning",
    icon: AlertTriangle,
  },
  review: {
    label: "Review",
    badge: "badge-error",
    progress: "progress-error",
    icon: ShieldAlert,
  },
} as const;

const confidenceCopy = {
  none: "No playback observations have been collected for this user yet.",
  low: "This is an early picture based on a small amount of playback activity.",
  medium:
    "There is enough activity to identify recurring patterns, but the picture may still change.",
  high: "This assessment is based on a broad, established history of playback observations.",
} as const;

function ScoreSummary({ assessment }: { assessment: Assessment }) {
  const presentation = riskPresentation[assessment.riskLevel];
  const RiskIcon = presentation.icon;

  return (
    <div className="rounded-xl border border-base-300 bg-base-200/55 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-base-100 shadow-sm">
            <RiskIcon className="size-5 text-base-content/70" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`badge badge-outline ${presentation.badge}`}>
                {presentation.label}
              </span>
              <span className="text-sm text-base-content/55">sharing risk</span>
            </div>
            <p className="mt-1 text-xs text-base-content/50">
              A review aid based on recent playback patterns
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <span className="text-3xl font-semibold tabular-nums">
            {assessment.riskScore}
          </span>
          <span className="text-sm text-base-content/40">/100</span>
        </div>
      </div>
      <progress
        className={`progress mt-4 h-1.5 w-full ${presentation.progress}`}
        value={assessment.riskScore}
        max="100"
        aria-label={`Risk score ${assessment.riskScore} out of 100`}
      />
    </div>
  );
}

export function SharingRiskDetailsDialog({
  dialogRef,
  user,
  monitorStatus,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  user: PlexUser | null;
  monitorStatus: MonitorStatus;
  onClose: () => void;
}) {
  const assessment = user?.sharingRisk;

  return (
    <dialog ref={dialogRef} className="modal" onClose={onClose}>
      <div className="modal-box polished-modal max-w-xl p-0">
        <div className="border-b border-base-300 px-6 pb-4 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-base-content/45">
            Sharing risk assessment
          </p>
          <h3 className="mt-1 truncate text-xl font-semibold">{user?.username}</h3>
          {user?.email && <p className="truncate text-sm text-base-content/45">{user.email}</p>}
        </div>

        {assessment && (
          <div className="space-y-5 px-6 py-5">
            <ScoreSummary assessment={assessment} />

            <div className="grid grid-cols-3 gap-2">
              <EvidenceStat
                icon={Activity}
                value={assessment.observationCount.toLocaleString()}
                label="observations"
              />
              <EvidenceStat
                icon={CalendarDays}
                value={assessment.activeDays.toLocaleString()}
                label="active days"
              />
              <EvidenceStat
                icon={CalendarDays}
                value={assessment.observationSpanDays.toLocaleString()}
                label="day span"
              />
            </div>

            <section aria-labelledby="risk-reasons-heading">
              <div className="flex items-center justify-between gap-3">
                <h4 id="risk-reasons-heading" className="font-semibold">
                  What contributed
                </h4>
                <span className="text-xs capitalize text-base-content/45">
                  {assessment.dataConfidence} confidence
                </span>
              </div>
              {assessment.signals.length > 0
                ? (
                  <ul className="mt-2 space-y-2">
                    {assessment.signals.map((signal) => (
                      <li
                        key={signal.type}
                        className="flex items-start gap-3 rounded-lg border border-base-300 px-3 py-2.5"
                      >
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                        <span className="min-w-0 flex-1 text-sm text-base-content/75">
                          {signal.summary}
                        </span>
                        <span className="badge badge-ghost badge-sm shrink-0 tabular-nums">
                          +{signal.weight}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
                : (
                  <div className="mt-2 flex gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                    <p className="text-sm text-base-content/65">
                      {assessment.dataConfidence === "none" ||
                          assessment.riskLevel === "insufficient_data"
                        ? "No sharing signals are visible yet. More playback activity is needed before drawing a conclusion."
                        : "No sharing-risk signals were observed in the current assessment window."}
                    </p>
                  </div>
                )}
            </section>

            <div className="rounded-lg bg-base-200/45 p-3 text-sm text-base-content/60">
              <p>{confidenceCopy[assessment.dataConfidence]}</p>
              {assessment.observedSince && (
                <p className="mt-1 text-xs text-base-content/45">
                  Observing since {formatDate(assessment.observedSince)}
                </p>
              )}
            </div>

            {monitorStatus === "disconnected" && (
              <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
                <WifiOff className="mt-0.5 size-4 shrink-0 text-warning" />
                <p>
                  Playback monitoring is disconnected, so this assessment cannot collect new
                  observations right now.
                </p>
              </div>
            )}

            <p className="flex gap-2 text-xs leading-relaxed text-base-content/40">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              The score is the sum of the signal weights above, capped at 100. It is not a
              probability or proof that an account is being shared.
            </p>
          </div>
        )}

        <div className="modal-action m-0 px-6 py-4">
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit">close</button>
      </form>
    </dialog>
  );
}

function EvidenceStat({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof Activity;
  value: string;
  label: string;
}) {
  return (
    <div className="rounded-lg border border-base-300 px-3 py-2.5">
      <Icon className="mb-1 size-3.5 text-base-content/35" />
      <div className="font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-base-content/45">{label}</div>
    </div>
  );
}
