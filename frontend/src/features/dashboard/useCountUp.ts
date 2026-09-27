import { useEffect, useRef, useState } from "react";

// `skipAnimation` snaps straight to `target` instead of easing towards it — used once a
// library/sync has already reached its "done" state, so the displayed count doesn't keep
// visibly climbing after the checkmark/"done" label has already appeared.
export function useCountUp(target: number, duration = 800, skipAnimation = false) {
  const [display, setDisplay] = useState(target);
  const prevRef = useRef(target);

  useEffect(() => {
    if (skipAnimation) {
      setDisplay(target);
      prevRef.current = target;
      return;
    }

    const start = prevRef.current;
    const diff = target - start;
    if (diff <= 0) {
      setDisplay(target);
      prevRef.current = target;
      return;
    }

    const startTime = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(start + diff * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else prevRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, skipAnimation]);

  return display;
}
