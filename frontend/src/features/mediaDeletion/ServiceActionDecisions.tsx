import type { ServiceActionDecision } from "../../../../shared/serviceOwnedDeletion.ts";

const serviceNames = { plex: "Plex", sonarr: "Sonarr", radarr: "Radarr", qb: "qBittorrent" };

export function serviceActionLabel(action: ServiceActionDecision): string {
  if (action.state === "kept" || action.outcome === "kept") return "Kept";
  if (action.state === "not_applicable" || action.outcome === "not_applicable") {
    return "Not applicable";
  }
  if (action.outcome === "accepted") return "Awaiting confirmation";
  if (action.outcome === "uncertain") return "Outcome uncertain";
  if (action.outcome === "failed") return "Failed";
  if (action.outcome === "succeeded") return "Service removal confirmed";
  return action.state === "held" ? "Held" : "Requested deletion";
}

export function ServiceActionDecisions({ actions }: { actions: readonly ServiceActionDecision[] }) {
  if (!actions.length) return null;
  return (
    <ul className="space-y-2" aria-label="Service decisions">
      {actions.map((action) => (
        <li key={action.actionId} className="rounded-box border border-base-300 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{serviceNames[action.service]}</span>
            <span className="badge badge-outline">{serviceActionLabel(action)}</span>
          </div>
          <p className="mt-1 break-words text-base-content/70">{action.reason}</p>
          {action.state === "kept" && action.service === "plex" && (
            <p className="mt-1">This media will remain in Plex.</p>
          )}
        </li>
      ))}
    </ul>
  );
}
