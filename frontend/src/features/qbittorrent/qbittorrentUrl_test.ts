import { assertEquals } from "@std/assert";
import { suggestedQbittorrentUrl } from "./qbittorrentUrl.ts";

function instance(
  type: "radarr" | "sonarr",
  url: string,
): { type: "radarr" | "sonarr"; url: string } {
  return { type, url };
}

Deno.test("suggests qBittorrent on the common Arr LAN host", () => {
  assertEquals(
    suggestedQbittorrentUrl([
      instance("radarr", "http://192.168.1.10:7878"),
      instance("sonarr", "http://192.168.1.10:8989"),
    ]),
    "http://192.168.1.10:8080",
  );
});

Deno.test("suggests the qBittorrent service name for Compose-style Arr URLs", () => {
  assertEquals(
    suggestedQbittorrentUrl([
      instance("radarr", "http://radarr:7878"),
      instance("sonarr", "http://sonarr:8989"),
    ]),
    "http://qbittorrent:8080",
  );
});

Deno.test("does not guess when Arr hosts disagree or use reverse-proxy paths", () => {
  assertEquals(
    suggestedQbittorrentUrl([
      instance("radarr", "http://192.168.1.10:7878"),
      instance("sonarr", "http://192.168.1.11:8989"),
    ]),
    "",
  );
  assertEquals(
    suggestedQbittorrentUrl([
      instance("radarr", "https://media.example/radarr"),
    ]),
    "",
  );
});
