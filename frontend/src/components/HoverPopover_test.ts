import { assertEquals } from "@std/assert";
import { placePopover } from "./HoverPopover.tsx";

const popover = { width: 120, height: 60 };

Deno.test("popover placement clamps to the viewport edges", () => {
  assertEquals(
    placePopover(
      { left: 0, right: 20, top: 30, bottom: 50, width: 20, height: 20 },
      popover,
      { width: 300, height: 200 },
    ),
    { left: 8, top: 58 },
  );
  assertEquals(
    placePopover(
      { left: 290, right: 300, top: 30, bottom: 50, width: 10, height: 20 },
      popover,
      { width: 300, height: 200 },
    ),
    { left: 172, top: 58 },
  );
});

Deno.test("popover placement flips above an anchor near the viewport bottom", () => {
  assertEquals(
    placePopover(
      { left: 100, right: 120, top: 170, bottom: 190, width: 20, height: 20 },
      popover,
      { width: 300, height: 200 },
    ),
    { left: 50, top: 102 },
  );
});
