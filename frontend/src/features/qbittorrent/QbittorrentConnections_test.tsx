import { assertEquals, assertStringIncludes } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import type { QbittorrentIntegrationSettings } from "@shared/types";
import { queryKeys } from "../../lib/queryKeys.ts";
import { QbittorrentConnections } from "./QbittorrentConnections.tsx";

for (const saved of [false, true]) {
  Deno.test(`qB connections ${saved ? "retain read-only overrides and edit access" : "allow connection without path entry"}`, async () => {
    const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prior = globals.IS_REACT_ACT_ENVIRONMENT;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } },
    });
    const instance = {
      id: 1,
      name: "Fixture QB",
      url: "http://qb:8080",
      usernameConfigured: true,
      passwordConfigured: true,
    };
    const data: QbittorrentIntegrationSettings = {
      envConfigured: false,
      instances: saved ? [instance] : [],
      targets: saved ? [{ instanceKey: "db:1", name: instance.name, environmentOwned: false }] : [],
      pathMappings: saved
        ? [{
          id: 1,
          instanceKey: "db:1",
          qbittorrentPath: "/downloads",
          localPath: "/local-downloads",
          caseSensitive: true,
          revision: 7,
          validationQbittorrentPath: "/downloads/file",
          validationLocalPath: "/local-downloads/file",
          validationSize: 5,
        }]
        : [],
    };
    client.setQueryData(queryKeys.qbittorrentIntegrations.all, data);
    client.setQueryData(queryKeys.integrationCompatibility.all, { checks: [] });
    const configured: unknown[] = [];
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = TestRenderer.create(
          <QueryClientProvider client={client}>
            <QbittorrentConnections
              onConfigure={(value) => configured.push(value)}
              onRemove={() => {}}
            />
          </QueryClientProvider>,
        );
      });
      assertEquals(renderer!.root.findAllByType("input").length, 0);
      assertEquals(renderer!.root.findAllByType("select").length, 0);
      const button = renderer!.root.findAllByType("button").find((node) =>
        node.children.includes(saved ? "Edit" : " Add qBittorrent")
      );
      await act(() => button!.props.onClick());
      assertEquals(configured, [saved ? instance : undefined]);
      if (saved) {
        const text = JSON.stringify(renderer!.toJSON());
        assertStringIncludes(text, "Saved path mappings");
        assertStringIncludes(text, "/local-downloads");
        assertStringIncludes(text, "Host discovery");
        assertEquals(client.getQueryData(queryKeys.qbittorrentIntegrations.all), data);
      }
    } finally {
      if (renderer) await act(() => renderer!.unmount());
      client.clear();
      globals.IS_REACT_ACT_ENVIRONMENT = prior;
    }
  });
}
