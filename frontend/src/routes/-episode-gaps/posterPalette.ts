/// <reference lib="dom" />

export interface PosterPalette {
  topLeft: string;
  topRight: string;
  bottomRight: string;
  bottomLeft: string;
}

const SAMPLE_WIDTH = 24;
const SAMPLE_HEIGHT = 36;
const MAX_CACHE_ENTRIES = 256;
const DARK_VALUE = 77;
const paletteCache = new Map<string, Promise<PosterPalette | null>>();

export function loadPosterPalette(url: string): Promise<PosterPalette | null> {
  const cached = paletteCache.get(url);
  if (cached) return cached;

  if (paletteCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = paletteCache.keys().next().value;
    if (oldest) paletteCache.delete(oldest);
  }

  const pending = extractPosterPalette(url).catch(() => null);
  paletteCache.set(url, pending);
  return pending;
}

async function extractPosterPalette(url: string): Promise<PosterPalette | null> {
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("poster failed to load"));
    image.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  return derivePosterPalette(
    context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data,
    SAMPLE_WIDTH,
    SAMPLE_HEIGHT,
  );
}

export function derivePosterPalette(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): PosterPalette | null {
  if (width < 2 || height < 2 || pixels.length !== width * height * 4) return null;
  const middleX = Math.floor(width / 2);
  const middleY = Math.floor(height / 2);
  return {
    topLeft: sampleRegion(pixels, width, 0, 0, middleX, middleY),
    topRight: sampleRegion(pixels, width, middleX, 0, width, middleY),
    bottomRight: sampleRegion(pixels, width, middleX, middleY, width, height),
    bottomLeft: sampleRegion(pixels, width, 0, middleY, middleX, height),
  };
}

function sampleRegion(
  pixels: Uint8ClampedArray,
  width: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): string {
  let red = 0;
  let green = 0;
  let blue = 0;
  let weightTotal = 0;

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const offset = (y * width + x) * 4;
      const alpha = pixels[offset + 3]! / 255;
      if (alpha === 0) continue;
      const r = pixels[offset]!;
      const g = pixels[offset + 1]!;
      const b = pixels[offset + 2]!;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      // Give distinctive pixels more influence without letting a tiny accent overpower
      // the broad poster color field.
      const weight = alpha * (0.4 + saturation * saturation);
      red += r * weight;
      green += g * weight;
      blue += b * weight;
      weightTotal += weight;
    }
  }

  if (weightTotal === 0) return "rgb(42 42 42)";
  return darkenForText(red / weightTotal, green / weightTotal, blue / weightTotal);
}

function darkenForText(red: number, green: number, blue: number): string {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max === 0) return "rgb(0 0 0)";

  // Plex's observed detail gradients cap their strongest channel at 77. Preserve hue,
  // gently strengthen colorful artwork, and normalize to the same text-safe ceiling.
  const saturation = (max - min) / max;
  const targetSaturation = saturation < 0.08 ? 0 : Math.min(0.9, saturation * 1.2 + 0.06);
  const normalized = [red, green, blue].map((channel) => channel / max);
  const adjusted = saturation === 0
    ? normalized
    : normalized.map((channel) => Math.max(0, 1 - (1 - channel) / saturation * targetSaturation));
  const strongest = Math.max(...adjusted);
  const channels = adjusted.map((channel) => Math.round(channel / strongest * DARK_VALUE));
  return `rgb(${channels[0]} ${channels[1]} ${channels[2]})`;
}
