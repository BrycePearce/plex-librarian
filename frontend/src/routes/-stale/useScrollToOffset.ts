import { useEffect, useRef } from "react";

// `<main>` (not the window) is the app's sole scroll container (see __root.tsx) —
// Previous and Next both jump to its top rather than one of them preserving scroll
// position, since the page below is entirely different content either direction; leaving
// Previous scrolled to the bottom would land the user mid-list on a page they haven't
// looked at yet.
//
// The scroll only starts once React has actually committed a render reflecting the new
// offset — tracked via `scrollTargetRef` rather than assuming the offset update applies
// synchronously, which a router `navigate` doesn't reliably do (navigation is async
// internally, so a `flushSync` wrapped around it would silently do nothing and let the
// scroll race a mid-flight DOM change). A page swap isn't just a possible height change (a
// partial last page), it's ~50 rows worth of file-size bars each animating `width` from 0
// on mount, which forces a layout recalculation every frame for ~500ms — any of that
// landing mid-flight can clamp or visibly stutter an in-progress smooth scroll. Keying off
// the committed offset instead means the effect can't fire until the DOM has already
// settled, no matter how the update was scheduled internally.
//
// The scroll itself is deferred one more frame (`requestAnimationFrame`) past that commit
// because a commit only guarantees the DOM update, not that the browser has painted/
// rasterized it yet — starting the scroll in the same tick could composite into rows that
// don't have painted tiles ready, which briefly showed as a black flash. Waiting a frame
// lets that paint happen first.
export function useScrollToOffset(
  committedOffset: number,
  setOffset: (offset: number) => void,
): (offset: number) => void {
  const scrollTargetRef = useRef<number | null>(null);

  function goToOffset(offset: number) {
    scrollTargetRef.current = offset;
    setOffset(offset);
  }

  useEffect(() => {
    if (scrollTargetRef.current !== committedOffset) return;
    scrollTargetRef.current = null;
    const reducedMotion = globalThis.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    requestAnimationFrame(() => {
      document
        .querySelector(".scroll-area")
        ?.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
    });
  }, [committedOffset]);

  return goToOffset;
}
