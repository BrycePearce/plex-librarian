import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Server } from "lucide-react";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";

// Pure navigation to /settings/sonarr-radarr — the dialog itself (ArrIntegrationDialog)
// mounts only while that route is active, so there's no local open/close state here.
export function ArrIntegrationTrigger() {
  const { data } = useQuery({
    queryKey: queryKeys.arrIntegrations.all,
    queryFn: api.arr.get,
  });
  const { data: qbit } = useQuery({
    queryKey: queryKeys.qbittorrentIntegrations.all,
    queryFn: api.qbittorrent.get,
  });
  const connectionCount = (data?.instances.length ?? 0) +
    (qbit?.envConfigured ? 1 : qbit?.instances.length ?? 0);

  return (
    <Link
      to="/settings/sonarr-radarr"
      className={`btn btn-sm ${connectionCount ? "btn-ghost" : "btn-primary"}`}
    >
      <Server className="size-4" /> Media connections
      {!!connectionCount && <span className="badge badge-sm">{connectionCount}</span>}
    </Link>
  );
}
