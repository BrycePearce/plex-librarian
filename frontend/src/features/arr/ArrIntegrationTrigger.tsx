import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Server } from "lucide-react";
import { api } from "../../lib/api";

// Pure navigation to /settings/sonarr-radarr — the dialog itself (ArrIntegrationDialog)
// mounts only while that route is active, so there's no local open/close state here.
export function ArrIntegrationTrigger() {
  const { data } = useQuery({
    queryKey: ["arr-integrations"],
    queryFn: api.arr.get,
  });

  return (
    <Link
      to="/settings/sonarr-radarr"
      className={`btn btn-sm ${data?.instances.length ? "btn-ghost" : "btn-primary"}`}
    >
      <Server className="size-4" /> Sonarr &amp; Radarr
      {!!data?.instances.length && <span className="badge badge-sm">{data.instances.length}</span>}
    </Link>
  );
}
