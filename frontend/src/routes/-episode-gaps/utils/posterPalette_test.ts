import { assertEquals } from "@std/assert";
import { derivePosterPalette } from "./posterPalette.ts";

Deno.test("derivePosterPalette samples and normalizes four poster regions", () => {
  const width = 4;
  const height = 4;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const colors = {
    topLeft: [220, 80, 120],
    topRight: [50, 160, 220],
    bottomRight: [70, 190, 100],
    bottomLeft: [210, 130, 40],
  } as const;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = y < 2
        ? x < 2 ? colors.topLeft : colors.topRight
        : x < 2
        ? colors.bottomLeft
        : colors.bottomRight;
      pixels.set([...color, 255], (y * width + x) * 4);
    }
  }

  assertEquals(derivePosterPalette(pixels, width, height), {
    topLeft: "rgb(77 14 32)",
    topRight: "rgb(8 53 77)",
    bottomRight: "rgb(14 77 30)",
    bottomLeft: "rgb(77 44 8)",
  });
});

Deno.test("derivePosterPalette rejects unusable pixel buffers", () => {
  assertEquals(derivePosterPalette(new Uint8ClampedArray(), 0, 0), null);
});
