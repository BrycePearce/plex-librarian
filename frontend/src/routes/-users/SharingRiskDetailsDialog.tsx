import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type RefObject, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Info,
  ShieldAlert,
  TrendingDown,
  WifiOff,
} from "lucide-react";
import { api } from "../../lib/api.ts";
import type { PlexUser, SharingRiskTrendPoint, SharingRiskTrendResponse } from "../../lib/api.ts";
import { formatDate } from "../../lib/format.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import "../../components/dataSurfaces.css";
import "./sharingRiskTrend.css";

type Assessment = PlexUser["sharingRisk"];
type MonitorStatus = "starting" | "connected" | "polling" | "disconnected";
const presentation = {
  insufficient_data: {
    label: "Limited data",
    badge: "badge-ghost",
    progress: "progress-neutral",
    icon: Info,
  },
  low: { label: "Low", badge: "badge-success", progress: "progress-success", icon: CheckCircle2 },
  watch: {
    label: "Watch",
    badge: "badge-warning",
    progress: "progress-warning",
    icon: AlertTriangle,
  },
  review: { label: "Review", badge: "badge-error", progress: "progress-error", icon: ShieldAlert },
} as const;
const confidenceCopy = {
  none: "No playback observations have been collected for this user yet.",
  low: "This is an early picture based on a small amount of playback activity.",
  medium:
    "There is enough activity to identify recurring patterns, but the picture may still change.",
  high: "This assessment is based on a broad, established history of playback observations.",
} as const;

export function SharingRiskDetailsDialog({ dialogRef, user, monitorStatus, onClose }: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  user: PlexUser | null;
  monitorStatus: MonitorStatus;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"current" | "trend">("current");
  const reduceMotion = useReducedMotion();
  const trend = useQuery({
    queryKey: queryKeys.users.sharingRiskTrend(user?.accountId ?? null),
    queryFn: () => api.users.sharingRiskTrend(user!.accountId),
    enabled: user !== null,
    staleTime: 60_000,
  });
  useEffect(() => setTab("current"), [user?.accountId]);
  const observedSince = trend.data?.observedSince ?? user?.sharingRisk.observedSince ?? null;

  return (
    <dialog ref={dialogRef} className="modal" onClose={onClose}>
      <div className="modal-box polished-modal flex max-h-[90vh] max-w-3xl flex-col p-0">
        <header className="shrink-0 border-b border-base-300 px-6 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-base-content/45">
            Sharing risk assessment
          </p>
          <h3 className="mt-1 truncate text-xl font-semibold">{user?.username}</h3>
          <div className="flex flex-wrap items-end justify-between gap-3 pb-4">
            <div>
              {user?.email && <p className="truncate text-sm text-base-content/45">{user.email}</p>}
              {observedSince && (
                <p className="mt-1 text-xs text-base-content/40">
                  Observing since {formatDate(observedSince)}
                </p>
              )}
            </div>
            <div
              className="relative flex rounded-lg border border-base-300 bg-base-200/65 p-1"
              role="tablist"
            >
              {(["current", "trend"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  className={`relative z-10 min-w-20 rounded-md px-3 py-1.5 text-xs font-medium capitalize ${
                    tab === value ? "text-base-content" : "text-base-content/45"
                  }`}
                  onClick={() => setTab(value)}
                >
                  {tab === value && (
                    <motion.span
                      layoutId="sharing-risk-tab"
                      className="absolute inset-0 -z-10 rounded-md bg-base-100 shadow-sm"
                      transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    />
                  )}
                  {value}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              role="tabpanel"
              initial={reduceMotion ? false : { opacity: 0, x: tab === "trend" ? 18 : -18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: reduceMotion ? 0 : tab === "trend" ? -12 : 12 }}
              transition={{ duration: reduceMotion ? 0 : 0.18 }}
            >
              {tab === "current" && user && (
                <Current assessment={user.sharingRisk} monitorStatus={monitorStatus} />
              )}
              {tab === "trend" && (
                <TrendPanel
                  data={trend.data}
                  loading={trend.isLoading}
                  error={trend.error}
                  retry={() => void trend.refetch()}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="modal-action m-0 shrink-0 px-6 py-4">
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit">close</button>
      </form>
    </dialog>
  );
}

function Score({ assessment }: { assessment: Assessment }) {
  const style = presentation[assessment.riskLevel];
  const Icon = style.icon;
  return (
    <div className="rounded-xl border border-base-300 bg-base-200/55 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-base-100 shadow-sm">
            <Icon className="size-5 text-base-content/70" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className={`badge badge-outline ${style.badge}`}>{style.label}</span>
              <span className="text-sm text-base-content/55">sharing risk</span>
            </div>
            <p className="mt-1 text-xs text-base-content/50">Based on the latest rolling 30 days</p>
          </div>
        </div>
        <div>
          <span className="text-3xl font-semibold tabular-nums">{assessment.riskScore}</span>
          <span className="text-sm text-base-content/40">/100</span>
        </div>
      </div>
      <progress
        className={`progress mt-4 h-1.5 w-full ${style.progress}`}
        value={assessment.riskScore}
        max="100"
      />
    </div>
  );
}

function Current(
  { assessment, monitorStatus }: { assessment: Assessment; monitorStatus: MonitorStatus },
) {
  return (
    <div className="space-y-5 px-6 py-5">
      <Score assessment={assessment} />
      <div className="grid grid-cols-3 gap-2">
        <Stat icon={Activity} value={assessment.observationCount} label="observations" />
        <Stat icon={CalendarDays} value={assessment.activeDays} label="active days" />
        <Stat icon={CalendarDays} value={assessment.observationSpanDays} label="day span" />
      </div>
      <section>
        <div className="flex justify-between gap-3">
          <h4 className="font-semibold">What contributed</h4>
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
                  <span className="flex-1 text-sm text-base-content/75">{signal.summary}</span>
                  <span className="badge badge-ghost badge-sm">+{signal.weight}</span>
                </li>
              ))}
            </ul>
          )
          : (
            <div className="mt-2 flex gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3">
              <CheckCircle2 className="mt-0.5 size-4 text-success" />
              <p className="text-sm text-base-content/65">
                {assessment.riskLevel === "insufficient_data"
                  ? "No sharing signals are visible yet. More playback activity is needed before drawing a conclusion."
                  : "No sharing-risk signals were observed in the current assessment window."}
              </p>
            </div>
          )}
      </section>
      <div className="rounded-lg bg-base-200/45 p-3 text-sm text-base-content/60">
        <p>{confidenceCopy[assessment.dataConfidence]}</p>
        <p className="mt-1 text-xs text-base-content/45">
          Current assessment covers the latest rolling 30-day window.
        </p>
      </div>
      {monitorStatus === "disconnected" && (
        <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
          <WifiOff className="mt-0.5 size-4 text-warning" />
          <p>
            Playback monitoring is disconnected, so this assessment cannot collect new observations
            right now.
          </p>
        </div>
      )}
      <Disclaimer>
        The score is a review aid, not a probability or proof that an account is being shared.
      </Disclaimer>
    </div>
  );
}

function TrendPanel(
  { data, loading, error, retry }: {
    data?: SharingRiskTrendResponse;
    loading: boolean;
    error: Error | null;
    retry: () => void;
  },
) {
  if (loading) {
    return (
      <div className="space-y-4 px-6 py-5">
        <div className="skeleton h-20 rounded-xl" />
        <div className="skeleton h-72 rounded-xl" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-6 py-8 text-center">
        <AlertTriangle className="mx-auto size-5 text-error" />
        <p className="mt-2 text-sm">The sharing-risk history could not be loaded.</p>
        <button type="button" className="btn btn-sm mt-4" onClick={retry}>Try again</button>
      </div>
    );
  }
  if (!data || data.points.every((p) => !p.assessment)) {
    return (
      <div className="px-6 py-12 text-center">
        <Activity className="mx-auto size-6 text-base-content/25" />
        <h4 className="mt-3 font-semibold">No trend yet</h4>
        <p className="mt-1 text-sm text-base-content/50">
          Playback observations will build a weekly history here.
        </p>
      </div>
    );
  }
  const available = data.points.filter((p) => p.assessment);
  const current = available.at(-1)!;
  const peak = available.reduce((a, b) =>
    b.assessment!.riskScore > a.assessment!.riskScore ? b : a
  );
  const improved = peak.assessment!.riskScore - current.assessment!.riskScore;
  return (
    <div className="space-y-3 px-6 py-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <Summary
          label="Current"
          value={current.assessment!.riskScore}
          detail={presentation[current.assessment!.riskLevel].label}
        />
        <Summary label="Peak" value={peak.assessment!.riskScore} detail={month(peak.periodEnd)} />
        <Summary
          label={improved > 0 ? "Improved" : "Change"}
          value={improved > 0 ? `${improved} pts` : "—"}
          detail="from the recorded peak"
          improved={improved > 0}
        />
      </div>
      <TrendChart points={data.points} />
      <div className="flex flex-wrap justify-between gap-2 text-xs text-base-content/45">
        <span>Weekly samples · each point covers the preceding {data.windowDays} days</span>
        <span>{formatDate(data.trendStart)}–{formatDate(data.trendEnd)}</span>
      </div>
      <Disclaimer>
        Gaps mean no evidence was collected. Historical scores use the current assessment model for
        a consistent comparison.
      </Disclaimer>
    </div>
  );
}

function Summary(
  { label, value, detail, improved }: {
    label: string;
    value: string | number;
    detail: string;
    improved?: boolean;
  },
) {
  return (
    <div className="rounded-xl border border-base-300 bg-base-200/40 px-3.5 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-base-content/40">
        {label}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-xl font-semibold tabular-nums">
        {value}
        {improved && <TrendingDown className="size-4 text-success" />}
      </div>
      <div className="text-[11px] text-base-content/45">{detail}</div>
    </div>
  );
}

// Keep the complete trend view inside the dialog at common laptop heights. The center
// pane still scrolls as a safety net on genuinely short screens.
const W = 680, H = 244, L = 42, R = 16, T = 14, B = 32;
function TrendChart({ points }: { points: SharingRiskTrendPoint[] }) {
  const reduceMotion = useReducedMotion();
  const indexes = useMemo(() => points.flatMap((p, i) => p.assessment ? [i] : []), [points]);
  const [selected, setSelected] = useState(indexes.at(-1) ?? 0);
  useEffect(() => setSelected(indexes.at(-1) ?? 0), [indexes]);
  const x = (i: number) =>
    L + (points.length <= 1 ? (W - L - R) / 2 : i / (points.length - 1) * (W - L - R));
  const y = (score: number) => T + (100 - score) / 100 * (H - T - B);
  const segments = contiguous(points);
  const chosen = points[selected];
  const ticks = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  return (
    <div className="sharing-trend-card overflow-hidden rounded-xl border border-base-300 bg-base-100/40">
      <svg
        className="block h-auto w-full"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Sharing risk score over time"
      >
        <rect
          className="trend-band trend-review"
          x={L}
          y={y(100)}
          width={W - L - R}
          height={y(35) - y(100)}
        />
        <rect
          className="trend-band trend-watch"
          x={L}
          y={y(35)}
          width={W - L - R}
          height={y(15) - y(35)}
        />
        <rect
          className="trend-band trend-low"
          x={L}
          y={y(15)}
          width={W - L - R}
          height={y(0) - y(15)}
        />
        {[0, 15, 35, 100].map((score) => (
          <g key={score}>
            <line className="trend-grid" x1={L} x2={W - R} y1={y(score)} y2={y(score)} />
            <text className="trend-axis" x={L - 8} y={y(score) + 4} textAnchor="end">{score}</text>
          </g>
        ))}
        {segments.map((segment) => (
          <motion.path
            key={segment[0]}
            className="trend-line"
            d={segment.map((i, n) =>
              `${n ? "L" : "M"} ${x(i)} ${y(points[i].assessment!.riskScore)}`
            ).join(" ")}
            initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: reduceMotion ? 0 : .55 }}
          />
        ))}
        {indexes.map((i) => (
          <motion.circle
            key={points[i].periodEnd}
            className={`trend-point trend-${points[i].assessment!.riskLevel}`}
            cx={x(i)}
            cy={y(points[i].assessment!.riskScore)}
            r={i === selected ? 6 : 3.5}
            tabIndex={0}
            role="button"
            aria-label={`${formatDate(points[i].periodEnd)}: score ${
              points[i].assessment!.riskScore
            }`}
            initial={reduceMotion ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            onMouseEnter={() => setSelected(i)}
            onFocus={() => setSelected(i)}
            onClick={() => setSelected(i)}
          />
        ))}
        {ticks.map((i) => (
          <text
            key={i}
            className="trend-axis"
            x={x(i)}
            y={H - 12}
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
          >
            {month(points[i].periodEnd)}
          </text>
        ))}
      </svg>
      {chosen?.assessment && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-300 bg-base-200/35 px-4 py-3">
          <div>
            <div className="text-xs font-semibold">
              {formatDate(chosen.periodStart)}–{formatDate(chosen.periodEnd)}
            </div>
            <div className="text-[11px] text-base-content/45">
              {chosen.assessment.observationCount} observations · {chosen.assessment.dataConfidence}
              {" "}
              confidence
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`badge badge-outline ${presentation[chosen.assessment.riskLevel].badge}`}
            >
              {presentation[chosen.assessment.riskLevel].label}
            </span>
            <span className="text-xl font-semibold">{chosen.assessment.riskScore}</span>
            <span className="text-xs text-base-content/35">/100</span>
          </div>
        </div>
      )}
    </div>
  );
}

function contiguous(points: SharingRiskTrendPoint[]) {
  const result: number[][] = [];
  let run: number[] = [];
  points.forEach((p, i) => {
    if (p.assessment) run.push(i);
    else {
      if (run.length) result.push(run);
      run = [];
    }
  });
  if (run.length) result.push(run);
  return result;
}
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
function month(value: number) {
  return monthFormatter.format(value * 1000);
}
function Stat(
  { icon: Icon, value, label }: { icon: typeof Activity; value: number; label: string },
) {
  return (
    <div className="rounded-lg border border-base-300 px-3 py-2.5">
      <Icon className="mb-1 size-3.5 text-base-content/35" />
      <div className="font-semibold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-[11px] text-base-content/45">{label}</div>
    </div>
  );
}
function Disclaimer({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 text-xs leading-relaxed text-base-content/40">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      {children}
    </p>
  );
}
