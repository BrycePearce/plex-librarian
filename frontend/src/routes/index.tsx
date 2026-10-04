import { createFileRoute, redirect } from "@tanstack/react-router";
import { api } from "../lib/api.ts";
import { queryKeys } from "../lib/queryKeys.ts";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery({
      queryKey: queryKeys.auth.configuration,
      queryFn: api.auth.configuration,
      staleTime: 60_000,
    });
    throw redirect({ to: status.configured ? "/dashboard" : "/setup" });
  },
  component: () => null,
});
