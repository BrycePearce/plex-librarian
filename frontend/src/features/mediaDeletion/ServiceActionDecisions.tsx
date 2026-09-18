import type { ServiceActionDecision } from "../../../../shared/serviceOwnedDeletion.ts";
import { ServiceIcon } from "../../components/ServiceIcons.tsx";

const serviceNames = { plex: "Plex", sonarr: "Sonarr", radarr: "Radarr", qb: "qBittorrent" };

export function serviceActionLabel(action: ServiceActionDecision): string {
  if (action.state === "kept" || action.outcome === "kept") return "Kept";
  if (action.state === "not_applicable" || action.outcome === "not_applicable") {
    return "Not applicable";
  }
  if (action.outcome === "accepted") return "Awaiting service verification";
  if (action.outcome === "uncertain") return "Outcome uncertain";
  if (action.outcome === "failed") return "Failed";
  if (action.outcome === "succeeded") return "Service removal confirmed";
  return action.state === "held" ? "Held" : "Requested deletion";
}

export function ServiceActionDecisions({ actions }: { actions: readonly ServiceActionDecision[] }) {
  if (!actions.length) return null;
  const groups = new Map<string, ServiceActionDecision[]>();
  for (const action of actions) {
    const key = JSON.stringify([action.service, serviceActionLabel(action), action.reason]);
    const group = groups.get(key) ?? [];
    group.push(action);
    groups.set(key, group);
  }
  return (
    <ul className="space-y-2" aria-label="Service decisions">
      {[...groups.values()].map((group) => {
        const action = group[0];
        return (
          <li key={action.actionId} className="rounded-box border border-base-300 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 font-medium">
                <ServiceIcon
                  service={action.service === "qb" ? "qbittorrent" : action.service}
                  className="h-4 w-4 shrink-0"
                />
                <span>
                  {serviceNames[action.service]}
                  {group.length > 1 ? ` · ${group.length} actions` : ""}
                </span>
              </span>
              <span className="badge badge-outline">{serviceActionLabel(action)}</span>
            </div>
            <p className="mt-1 break-words text-base-content/70">{action.reason}</p>
            {action.state === "kept" && action.service === "plex" && (
              <p className="mt-1">This media will remain in Plex.</p>
            )}
            {group.length > 1 && (
              <details className="mt-2 text-xs text-base-content/70">
                <summary className="cursor-pointer">Technical details</summary>
                <ul className="mt-1 max-h-40 overflow-y-auto break-all font-mono">
                  {group.map((entry) => <li key={entry.actionId}>{entry.actionId}</li>)}
                </ul>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
