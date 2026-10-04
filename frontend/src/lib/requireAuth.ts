import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { api } from "./api.ts";
import { queryKeys } from "./queryKeys.ts";

/** Keep setup detection local; the root checks the Plex account after rendering. */
export async function requireAuth(queryClient: QueryClient): Promise<void> {
  const status = await queryClient.fetchQuery({
    queryKey: queryKeys.auth.configuration,
    queryFn: api.auth.configuration,
    staleTime: 60_000,
  });

  if (!status.configured) throw redirect({ to: "/setup" });
}
