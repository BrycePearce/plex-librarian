import { assertEquals } from "@std/assert";
import { suggestedSeerrUrl } from "./seerrUrl.ts";

Deno.test("suggests Seerr on the common media-connection LAN host", () => {
  assertEquals(
    suggestedSeerrUrl([
      { url: "http://192.168.1.10:7878" },
      { url: "http://192.168.1.10:8989" },
      { url: "http://192.168.1.10:8080" },
    ]),
    "http://192.168.1.10:5055",
  );
});

Deno.test("does not invent a Seerr hostname from Compose-style service names", () => {
  assertEquals(
    suggestedSeerrUrl([
      { url: "http://radarr:7878" },
      { url: "http://sonarr:8989" },
      { url: "http://qbittorrent:8080" },
    ]),
    "",
  );
});

Deno.test("does not suggest a shared host from only one connection", () => {
  assertEquals(
    suggestedSeerrUrl([
      { url: "https://media.lan:8080" },
    ]),
    "",
  );
});

Deno.test("does not guess when connection hosts disagree or use reverse-proxy paths", () => {
  assertEquals(
    suggestedSeerrUrl([
      { url: "http://192.168.1.10:7878" },
      { url: "http://192.168.1.11:8989" },
    ]),
    "",
  );
  assertEquals(
    suggestedSeerrUrl([
      { url: "https://media.example/radarr" },
    ]),
    "",
  );
});
