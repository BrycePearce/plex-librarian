import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { api } from "./api";

/** Shared protected-route guard. The query cache keeps normal navigations local while
 * still validating a hard refresh or an expired auth-status entry. */
export async function requireAuth(queryClient: QueryClient): Promise<void> {
  const status = await queryClient.ensureQueryData({
    queryKey: ["auth", "status"],
    queryFn: api.auth.status,
    staleTime: 60_000,
  });

  if (!status.configured) throw redirect({ to: "/setup" });
}
