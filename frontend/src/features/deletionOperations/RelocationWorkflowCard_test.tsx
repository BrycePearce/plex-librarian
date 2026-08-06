import { assert, assertFalse, assertStringIncludes } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  DeletionOperationTarget,
  RadarrMovieRelocationGuidanceV1,
} from "../../../../shared/types.ts";
import { RelocationWorkflowCard } from "./RelocationWorkflowCard.tsx";

const guidance: RadarrMovieRelocationGuidanceV1 = {
  schemaVersion: 1,
  workflow: "retained_version_relocation",
  service: "radarr",
  mediaType: "movie",
  reason: "retained_parent_mismatch",
  guidanceId: "00000000-0000-4000-8000-000000000000",
  selectedMediaId: 11,
  selectedPlexPath: "/plex/Movie/selected.mkv",
  selectedArrPath: "/movies/Movie/selected.mkv",
  retainedMediaId: 12,
  retainedPlexPath: "/archive/retained.mkv",
  retainedFileSize: 50_000,
  managedDirectoryPath: "/movies/Movie",
  sourceArrPath: "/archive/retained.mkv",
  destinationArrPath: "/movies/Movie/retained.mkv",
  destinationPlexPath: "/plex/Movie/retained.mkv",
  arrInstanceId: 1,
  arrInstanceName: "Radarr",
  arrRecordId: 7,
  arrManagedFileId: 8,
  mappingIdentity: "mapping",
  observedAt: 100,
};

const base = {
  id: 1,
  ordinal: 0,
  targetKind: "movie_version",
  targetKey: "movie:11",
  title: "Movie",
  status: "needs_attention",
  attemptCount: 1,
  phase: "validating",
  removalConfirmedAt: null,
  plexReconciledAt: null,
  plexAttemptCount: 0,
  warning: null,
  downloadCleanupSelected: false,
  arrCoordinationConfigured: true,
  nextRetryAt: null,
  error: null,
  logicalSize: 50_000,
  supersededReason: null,
} as const;

function render(target: DeletionOperationTarget): string {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RelocationWorkflowCard
        operationId="operation"
        target={target}
        recoveryDefersSync={false}
      />
    </QueryClientProvider>,
  );
}

async function renderWithRouter(target: DeletionOperationTarget): Promise<string> {
  const client = new QueryClient();
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <RelocationWorkflowCard
          operationId="operation"
          target={target}
          recoveryDefersSync={false}
        />
      </QueryClientProvider>
    ),
  });
  const duplicatesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/duplicates",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([duplicatesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

Deno.test(
  "active Radarr relocation renders distinct Arr and Plex instructions",
  () => {
    const html = render({
      ...base,
      relocationGuidanceState: "valid",
      relocationGuidance: guidance,
      relocationSyncBarrierState: "none",
    });
    for (
      const expected of [
        "Copy from (Radarr-visible; remove only after successful Plex playback)",
        "/archive/retained.mkv",
        "Copy to (Radarr-visible)",
        "/movies/Movie/retained.mkv",
        "Plex destination Part path to select and play",
        "/plex/Movie/retained.mkv",
        "no-overwrite copy",
        "Empty trash automatically after every scan",
        "hardlinks cannot span filesystems",
        "disrupt seeding",
        "Finish relocation and re-run cleanup",
      ]
    ) {
      assertStringIncludes(html, expected);
    }
    assert(html.indexOf("/plex/Movie/retained.mkv") !== -1);
  },
);

Deno.test("invalid relocation state is diagnostic-only", () => {
  const html = render({
    ...base,
    relocationGuidanceState: "invalid",
    relocationSyncBarrierState: "none",
  });
  assertStringIncludes(html, "Invalid durable relocation guidance");
  assertStringIncludes(html, "No relocation action is available");
  assertFalse(html.includes("Finish relocation"));
  assertFalse(html.includes("Run targeted sync"));
});

Deno.test("invalid barriers override otherwise valid guidance and remain diagnostic-only", () => {
  const html = render({
    ...base,
    relocationGuidanceState: "valid",
    relocationGuidance: guidance,
    relocationSyncBarrierState: "invalid",
  });
  assertStringIncludes(html, "Invalid durable relocation sync barrier");
  assertFalse(html.includes("Finish relocation"));
  assertFalse(html.includes("Run targeted sync"));
});

Deno.test("incomplete and completed barriers expose only their next safe action", async () => {
  const incomplete = render({
    ...base,
    status: "cancelled",
    relocationGuidanceState: "valid",
    relocationGuidance: guidance,
    relocationSyncBarrierState: "incomplete",
    relocationSyncBarrier: {
      guidanceId: guidance.guidanceId,
      supersededAt: 101,
    },
  });
  assertStringIncludes(incomplete, "Run targeted sync");
  assertFalse(incomplete.includes("Finish relocation"));

  const completed = await renderWithRouter({
    ...base,
    status: "cancelled",
    relocationGuidanceState: "valid",
    relocationGuidance: guidance,
    relocationSyncBarrierState: "completed",
    relocationSyncBarrier: {
      guidanceId: guidance.guidanceId,
      supersededAt: 101,
      syncId: 7,
      finishedAt: 102,
    },
  });
  assertStringIncludes(completed, "Targeted sync completed");
  assertStringIncludes(completed, "Review duplicates");
  assertFalse(completed.includes("Finish relocation"));
  assertFalse(completed.includes("Run targeted sync"));
});

Deno.test("remaining recovery work changes the finish action without weakening acknowledgement", () => {
  const html = (() => {
    const client = new QueryClient();
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RelocationWorkflowCard
          operationId="operation"
          target={{
            ...base,
            relocationGuidanceState: "valid",
            relocationGuidance: guidance,
            relocationSyncBarrierState: "none",
          }}
          recoveryDefersSync
        />
      </QueryClientProvider>,
    );
  })();
  assertStringIncludes(html, "Finish relocation");
  assertFalse(html.includes("Finish relocation and re-run cleanup"));
  assertStringIncludes(html, "I explicitly selected the copied Plex version");
});
