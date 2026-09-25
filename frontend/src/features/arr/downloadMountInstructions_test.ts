import { assertEquals } from "@std/assert";
import { downloadMountInstructions } from "./downloadMountInstructions.ts";

Deno.test("mount instructions use the selected container path and quote literal Compose paths", () => {
  const yaml = downloadMountInstructions("compose", '/mnt/My $media/"downloads"', "/downloads");
  assertEquals(
    yaml,
    '- type: bind\n  source: "/mnt/My $$media/\\"downloads\\""\n  target: "/downloads"\n  read_only: false\n  bind:\n    create_host_path: false',
  );
  assertEquals(
    downloadMountInstructions("unraid", "/mnt/downloads", "/custom-downloads"),
    "Host Path: /mnt/downloads\nContainer Path: /custom-downloads\nAccess Mode: Read/Write",
  );
});

Deno.test("mount help does not generate runnable mounts for missing or unsafe paths", () => {
  for (
    const path of [
      "",
      "/",
      "relative",
      "/data",
      "/data/nested",
      "/downloads/../data",
      "/downloads\ninjected",
    ]
  ) {
    assertEquals(downloadMountInstructions("compose", "/mnt/downloads", path), null);
  }
  assertEquals(downloadMountInstructions("compose", "", "/downloads"), null);
});
