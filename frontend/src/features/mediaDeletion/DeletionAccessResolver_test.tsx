/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { DeletionAccessResolver } from "./DeletionAccessResolver.tsx";
import { DeletionPathAccess } from "./DeletionPathAccess.tsx";
import { ServicePathAccess } from "./ServicePathAccess.tsx";
import { api } from "../../lib/api.ts";

Deno.test("season and duplicate access resolves Plex without Arr and keeps Arr repair selectable", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = api.settings.plexPathMappings;
  const originalArr = api.arr.get;
  api.settings.plexPathMappings = () => Promise.resolve([]);
  api.arr.get = () => Promise.resolve({ instances: [], mappings: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const sample = { ratingKey: "selected-episode", mediaId: 12, path: "/tv/selected.mkv" };
  const target = {
    instanceName: "Custom Sonarr",
    type: "sonarr" as const,
    title: "Selected",
    path: "/data/tv/selected",
    seasons: null,
    mediaFiles: null,
    extraFiles: null,
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const render = (withArr: boolean) => (
    <QueryClientProvider client={client}>
      <DeletionAccessResolver
        libraryKey="tv"
        ratingKey="selected-show"
        reason="Verify the Plex library path mapping"
        plexSample={sample}
        target={withArr ? target : undefined}
        onResolved={() => {}}
      />
    </QueryClientProvider>
  );
  try {
    await act(() => {
      renderer = TestRenderer.create(render(false));
    });
    assertEquals(renderer!.root.findByType(ServicePathAccess).props.plexSample, sample);
    assertEquals(renderer!.root.findAllByType(DeletionPathAccess).length, 0);
    await act(() => renderer!.update(render(true)));
    await act(() =>
      renderer!.root.findAllByType("button")
        .find((button) => button.children.join("") === "Check Sonarr path access")!.props.onClick()
    );
    assertEquals(renderer!.root.findByType(DeletionPathAccess).props.target, target);
    assertEquals(renderer!.root.findAllByType(ServicePathAccess).length, 0);
  } finally {
    if (renderer) await act(() => renderer!.unmount());
    client.clear();
    api.settings.plexPathMappings = original;
    api.arr.get = originalArr;
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
