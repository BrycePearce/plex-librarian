import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MissingContentResponse } from "../../../shared/missingContent.ts";
import { requireAuth } from "../lib/requireAuth.ts";
import { apiFetch } from "../lib/api/client.ts";
import { PageHeader, workspaceToneClass } from "../components/Workspace.tsx";
import { ScanLine } from "lucide-react";
import { MissingContentView } from "./-missing-content/MissingContentView.tsx";
import "./missing-content.css";

export const Route = createFileRoute("/tools/missing-content")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: MissingContentPage,
});
export function MissingContentPage() {
  const [filters, setFilters] = useState({
    type: "",
    library: "",
    instance: "",
    dismissed: false,
    offset: 0,
  });
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["missing-content", filters],
    // Preserve the controls/options while a new filter or page is loading.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      apiFetch<MissingContentResponse>(
        `/tools/missing-content?${new URLSearchParams({
          ...filters,
          dismissed: String(filters.dismissed),
          offset: String(filters.offset),
        })}`,
        { signal },
      ),
  });
  const dismissal = useMutation({
    mutationFn: (row: MissingContentResponse["rows"][number]) =>
      apiFetch("/tools/missing-content/dismiss", {
        method: "POST",
        body: JSON.stringify({
          instanceId: row.instanceId,
          libraryKey: row.libraryKey,
          movieId: row.movieId,
          dismissed: !row.dismissed,
        }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["missing-content"] }),
  });
  return (
    <div className={`workspace-page ${workspaceToneClass("coral")} missing-page`}>
      <PageHeader
        eyebrow="Library health"
        title="Missing Content"
        icon={ScanLine}
        description="Radarr imports, checked against Plex."
      />
      {query.isPending && (
        <div className="missing-loading" role="status">
          <span className="loading loading-spinner loading-sm" />Loading your audit…
        </div>
      )}
      {query.error && (
        <div role="alert" className="missing-error">
          Couldn’t load findings.<button type="button" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      )}
      {query.data && (
        <MissingContentView
          data={query.data}
          filters={filters}
          busy={query.isFetching}
          update={(next) => setFilters((current) => ({ ...current, offset: 0, ...next }))}
          dismiss={(row) => dismissal.mutate(row)}
          dismissing={dismissal.isPending}
          dismissalError={!!dismissal.error}
        />
      )}
    </div>
  );
}
