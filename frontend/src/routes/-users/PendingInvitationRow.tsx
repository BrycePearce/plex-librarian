import { Mail, MailX } from "lucide-react";
import type { PendingInvitation } from "../../lib/api.ts";
import { avatarUrl } from "../../lib/avatar.ts";
import { formatDate, formatRelativeTime } from "../../lib/format.ts";

export function PendingInvitationRow({
  invitation,
  onRevoke,
}: {
  invitation: PendingInvitation;
  onRevoke: (invitation: PendingInvitation) => void;
}) {
  const displayName = invitation.username || invitation.email ||
    "Plex invitation";
  return (
    <tr className="polished-row">
      <td>
        <div className="flex min-w-0 items-center gap-3">
          {invitation.thumb
            ? (
              <img
                loading="lazy"
                src={avatarUrl(invitation.thumb)}
                alt=""
                className="h-8 w-8 shrink-0 rounded-full bg-base-300 object-cover"
              />
            )
            : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-base-300">
                <Mail className="h-3.5 w-3.5 text-base-content/40" />
              </div>
            )}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{displayName}</div>
            {invitation.username && invitation.email && (
              <div className="truncate text-xs text-base-content/40">
                {invitation.email}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="text-sm text-base-content/60">
        {invitation.libraryCount ?? "Unknown"}
      </td>
      <td>
        <div
          className="min-w-20 whitespace-nowrap tabular-nums"
          title={`Invited ${formatDate(invitation.createdAt)}`}
        >
          <div
            className={`text-sm ${
              invitation.ageStatus === "critical"
                ? "font-semibold text-error"
                : invitation.ageStatus === "stale"
                ? "font-medium text-warning"
                : ""
            }`}
          >
            {formatRelativeTime(invitation.createdAt)}
          </div>
          <div className="text-xs text-base-content/40">invitation sent</div>
        </div>
      </td>
      <td>
        <span
          className={`badge badge-sm badge-outline ${
            invitation.ageStatus === "critical"
              ? "badge-error"
              : invitation.ageStatus === "stale"
              ? "badge-warning"
              : "badge-ghost"
          }`}
        >
          {invitation.ageStatus === "critical"
            ? "Overdue"
            : invitation.ageStatus === "stale"
            ? "Aging"
            : "Current"}
        </span>
      </td>
      <td className="w-14 pr-4 text-right">
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square shrink-0 text-error"
          onClick={() => onRevoke(invitation)}
          aria-label={`Revoke invitation for ${displayName}`}
          title="Revoke invitation"
        >
          <MailX className="h-4 w-4" />
        </button>
      </td>
    </tr>
  );
}
