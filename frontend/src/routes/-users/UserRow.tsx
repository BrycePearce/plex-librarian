import { ChevronRight, User, UserX } from "lucide-react";
import type { PlexUser } from "../../lib/api.ts";
import { avatarUrl } from "../../lib/avatar.ts";
import { formatDate } from "../../lib/format.ts";
import { getRequestFollowThroughPresentation } from "./requestFollowThroughPresentation.ts";

export type MonitorStatus = "starting" | "connected" | "polling" | "disconnected";

export function UserRow({
  user,
  monitorStatus,
  requestFollowThroughAvailable,
  onOpenRiskDetails,
  onOpenFollowThrough,
  onRemove,
}: {
  user: PlexUser;
  monitorStatus: MonitorStatus;
  requestFollowThroughAvailable: boolean;
  onOpenRiskDetails: (user: PlexUser) => void;
  onOpenFollowThrough: (user: PlexUser) => void;
  onRemove: (user: PlexUser) => void;
}) {
  return (
    <tr className="group polished-row">
      <td>
        <div className="flex items-center gap-3">
          {user.thumb
            ? (
              <img
                loading="lazy"
                src={avatarUrl(user.thumb)}
                alt=""
                className="w-8 h-8 rounded-full object-cover bg-base-300 shrink-0"
              />
            )
            : (
              <div className="w-8 h-8 rounded-full bg-base-300 shrink-0 flex items-center justify-center">
                <User className="w-4 h-4 text-base-content/40" />
              </div>
            )}
          <div className="min-w-0">
            <div className="font-medium flex items-center gap-1.5">
              <span className="truncate">{user.username}</span>
              {user.isOwner && (
                <span className="badge badge-outline badge-sm shrink-0">
                  Owner
                </span>
              )}
            </div>
            {user.email && (
              <div className="text-xs text-base-content/40 truncate">
                {user.email}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="text-sm text-base-content/70">
        {user.activityStatus === "watched" && user.lastViewedAt
          ? (
            formatDate(user.lastViewedAt)
          )
          : user.activityStatus === "never"
          ? (
            <span className="badge badge-error badge-outline badge-sm">
              never
            </span>
          )
          : user.activityStatus === "history_pending"
          ? (
            <span
              className="tooltip tooltip-right activity-status-tooltip"
              data-tip="Watch history is still syncing. This status will update when the history walk finishes."
              tabIndex={0}
              aria-label="Watch history is still syncing."
            >
              <span className="badge badge-info badge-outline badge-sm">
                pending
              </span>
            </span>
          )
          : (
            <span
              className="tooltip tooltip-right activity-status-tooltip"
              data-tip="Plex has not exposed a playback identity that can be matched to this user."
              tabIndex={0}
              aria-label="Playback identity unresolved. Plex has not exposed an identity that can be matched to this user."
            >
              <span className="badge badge-warning badge-outline badge-sm">
                unresolved
              </span>
            </span>
          )}
      </td>
      <td>
        <SharingRiskCell
          assessment={user.sharingRisk}
          monitorStatus={monitorStatus}
          onOpen={() => onOpenRiskDetails(user)}
        />
      </td>
      {requestFollowThroughAvailable && (
        <td>
          <RequestFollowThroughCell
            assessment={user.requestFollowThrough}
            onOpen={() => onOpenFollowThrough(user)}
          />
        </td>
      )}
      <td className="text-right">
        {!user.isOwner && (
          <button
            type="button"
            className="btn btn-ghost btn-square size-10 min-h-10 rounded-lg text-error/70 transition-colors hover:bg-error/10 hover:text-error group-hover:text-error group-focus-within:text-error"
            onClick={() => onRemove(user)}
            aria-label={`Remove ${user.username}'s access`}
            title="Remove access"
          >
            <UserX className="w-4 h-4" />
          </button>
        )}
      </td>
    </tr>
  );
}

function SharingRiskCell({
  assessment,
  monitorStatus,
  onOpen,
}: {
  assessment: PlexUser["sharingRisk"];
  monitorStatus: MonitorStatus;
  onOpen: () => void;
}) {
  const label = assessment.riskLevel === "insufficient_data"
    ? assessment.observationCount > 0 ? "Limited data" : "Not enough data"
    : assessment.riskLevel === "review"
    ? "Review"
    : assessment.riskLevel === "watch"
    ? "Watch"
    : "Low";
  const badgeClass = assessment.riskLevel === "review"
    ? "badge-error"
    : assessment.riskLevel === "watch"
    ? "badge-warning"
    : assessment.riskLevel === "low"
    ? "badge-success"
    : "badge-ghost";
  const supportingText = assessment.dataConfidence === "none"
    ? monitorStatus === "disconnected" ? "Monitoring disconnected" : "No observations yet"
    : `${assessment.dataConfidence} confidence · ${assessment.signals.length} ${
      assessment.signals.length === 1 ? "signal" : "signals"
    }`;

  return (
    <button
      type="button"
      className="group/risk flex min-h-12 w-full min-w-48 items-center justify-between gap-3 rounded-lg border border-transparent bg-transparent px-3 py-1.5 text-left transition-colors hover:border-base-300 hover:bg-base-200/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      onClick={onOpen}
      aria-label={`View sharing risk details: ${label}, score ${assessment.riskScore} out of 100`}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className={`badge badge-sm badge-outline ${badgeClass}`}>
            {label}
          </span>
          {assessment.riskLevel !== "insufficient_data" && (
            <span className="text-xs font-semibold tabular-nums text-base-content/70">
              {assessment.riskScore}
              <span className="font-normal text-base-content/35">/100</span>
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[11px] capitalize text-base-content/45 whitespace-nowrap">
          {supportingText}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-base-content/30 transition-all group-hover/risk:translate-x-0.5 group-hover/risk:text-base-content/65" />
    </button>
  );
}

function RequestFollowThroughCell({
  assessment,
  onOpen,
}: {
  assessment: PlexUser["requestFollowThrough"];
  onOpen: () => void;
}) {
  const { label, detail, badgeClass } = getRequestFollowThroughPresentation(assessment);
  return (
    <button
      type="button"
      className="group/follow flex min-h-12 w-full min-w-48 items-center justify-between gap-3 rounded-lg border border-transparent bg-transparent px-3 py-1.5 text-left transition-colors hover:border-base-300 hover:bg-base-200/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      onClick={onOpen}
      aria-label={`View request follow-through details: ${label}`}
    >
      <span className="min-w-0">
        <span
          className={`badge badge-sm badge-outline ${badgeClass}`}
        >
          {label}
        </span>
        <span className="mt-0.5 block whitespace-nowrap text-[11px] text-base-content/45">
          {detail}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-base-content/30 transition-all group-hover/follow:translate-x-0.5 group-hover/follow:text-base-content/65" />
    </button>
  );
}
