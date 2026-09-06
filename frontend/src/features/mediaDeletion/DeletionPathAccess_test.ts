/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import { deletionAccessMapping, needsDeletionPathAccess } from "./DeletionPathAccess.tsx";
import type { ArrInstance } from "@shared/types";
import type { DownloadCleanupJob } from "@shared/types";
import { currentJobAccessFile } from "./ServicePathAccess.tsx";
const instance: ArrInstance = {
  id: 1,
  type: "sonarr",
  name: "Sonarr",
  url: "http://sonarr",
  apiKeyConfigured: true,
  pathMappings: [{ kind: "library", arrPath: "/data/TV", localPath: "/media/TV" }],
};
Deno.test("deletion path access reuses specific saved mapping without guessing local access", () => {
  assertEquals(deletionAccessMapping(instance, "/data/TV/Mad Men"), instance.pathMappings[0]);
  assertEquals(deletionAccessMapping(instance, "/data/TV-other/Mad Men"), {
    kind: "library",
    arrPath: "/data/TV-other/Mad Men",
    localPath: "",
  });
  assertEquals(instance.pathMappings.length, 1);
});
Deno.test("focused access prompts require a concrete access blocker", () => {
  assertEquals(needsDeletionPathAccess("Missing local mapping for current file"), true);
  assertEquals(needsDeletionPathAccess("qBittorrent unreachable"), false);
  assertEquals(needsDeletionPathAccess(undefined), false);
});

Deno.test("QB mapping verification samples use current save path and reject traversal", () => {
  const job = {
    savePath: "/downloads/current",
    files: [{ path: "Mad Men/episode.mkv", size: 123 }],
  } as DownloadCleanupJob;
  assertEquals(currentJobAccessFile(job), {
    path: "/downloads/current/Mad Men/episode.mkv",
    size: 123,
  });
  job.files = [{ path: "../old/episode.mkv", size: 123 }];
  assertEquals(currentJobAccessFile(job), undefined);
  job.files = [{ path: "/old/episode.mkv", size: 123 }];
  assertEquals(currentJobAccessFile(job), undefined);
});
