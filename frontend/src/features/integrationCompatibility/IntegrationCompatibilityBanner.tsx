import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import type { IntegrationCompatibilityCheck } from "@plex-librarian/shared/types.ts";

export function globalCompatibilityWarnings(
  checks: readonly IntegrationCompatibilityCheck[] | undefined,
) {
  return checks?.filter((check) => check.status === "limited" || check.status === "incompatible") ??
    [];
}

export function IntegrationCompatibilityBanner() {
  const { data } = useQuery({
    queryKey: queryKeys.integrationCompatibility.all,
    queryFn: api.integrationCompatibility.get,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const warnings = globalCompatibilityWarnings(data?.checks);
  if (warnings.length === 0) return null;

  return (
    <div role="alert" className="alert alert-warning mb-6 items-start text-sm">
      <TriangleAlert className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <strong>
          {warnings.length === 1
            ? `${warnings[0]!.name} has a compatibility warning`
            : `${warnings.length} media connections have compatibility warnings`}
        </strong>
        <p className="mt-0.5 text-xs opacity-75">
          {warnings.length === 1
            ? warnings[0]!.message
            : "Some connected versions may limit coordinated cleanup. Review Media connections for details."}
        </p>
      </div>
      <Link to="/settings/sonarr-radarr" className="btn btn-sm btn-ghost shrink-0">
        Review
      </Link>
    </div>
  );
}
