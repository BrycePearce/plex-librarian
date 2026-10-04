import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { clearServerScopedQueries } from "../../lib/queryCache.ts";

/** Validate credentials without holding up local library pages. Shares the account
 * query with UserMenu, including when both desktop and mobile menus are mounted. */
export function AuthStatusCoordinator() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: status } = useQuery({
    queryKey: queryKeys.auth.status,
    queryFn: api.auth.status,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!status || status.configured) return;
    queryClient.setQueryData(queryKeys.auth.configuration, status);
    void navigate({ to: "/setup", replace: true }).then(() =>
      clearServerScopedQueries(queryClient)
    );
  }, [status, queryClient, navigate]);

  return null;
}
