import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { loadPosterPalette, type PosterPalette } from "../utils/posterPalette.ts";

export function usePosterPalette(url: string | null): {
  palette: PosterPalette | null;
  rowRef: RefObject<HTMLElement | null>;
} {
  const [palette, setPalette] = useState<PosterPalette | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const rowRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = rowRef.current;
    if (!node || nearViewport) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: "320px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    let current = true;
    setPalette(null);
    if (url && nearViewport) {
      void loadPosterPalette(url).then((next) => current && setPalette(next));
    }
    return () => {
      current = false;
    };
  }, [nearViewport, url]);

  return { palette, rowRef };
}
