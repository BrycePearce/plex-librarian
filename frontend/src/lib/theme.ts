import { useState } from "react";

// Curated subset of daisyUI's built-in themes — the full ~30-theme list is overkill for
// a dropdown. Two dark variants (this app defaults to dark) plus one light, one playful.
export const THEMES = ["dark", "night", "dracula", "light"] as const;
export type Theme = typeof THEMES[number];

const STORAGE_KEY = "theme";
const DEFAULT_THEME: Theme = "dark";

function isTheme(value: string | null): value is Theme {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

// Applied synchronously by the inline script in index.html before React mounts (avoids a
// flash of the wrong theme), so the initial state here just needs to read what's already
// on the DOM rather than race it.
function currentTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (isTheme(attr)) return attr;
  const stored = localStorage.getItem(STORAGE_KEY);
  return isTheme(stored) ? stored : DEFAULT_THEME;
}

// Not yet in every lib.dom.d.ts — feature-detected below rather than relied on statically.
interface ViewTransitionDocument extends Document {
  startViewTransition?(callback: () => void): { ready: Promise<void> };
}

// Screen coordinates the reveal animation expands outward from — pass the click event's
// clientX/clientY so the transition originates from whatever the user actually clicked.
export interface ThemeChangeOrigin {
  x: number;
  y: number;
}

export function useTheme(): [
  Theme,
  (theme: Theme, origin?: ThemeChangeOrigin) => void,
] {
  const [theme, setThemeState] = useState<Theme>(currentTheme);

  const setTheme = (next: Theme, origin?: ThemeChangeOrigin) => {
    const apply = () => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem(STORAGE_KEY, next);
      setThemeState(next);
    };

    const startViewTransition = (document as ViewTransitionDocument)
      .startViewTransition
      ?.bind(document);
    const reducedMotion = globalThis.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (!startViewTransition || reducedMotion) {
      apply();
      return;
    }

    if (origin) {
      const endRadius = Math.hypot(
        Math.max(origin.x, innerWidth - origin.x),
        Math.max(origin.y, innerHeight - origin.y),
      );
      const root = document.documentElement.style;
      root.setProperty("--theme-reveal-x", `${origin.x}px`);
      root.setProperty("--theme-reveal-y", `${origin.y}px`);
      root.setProperty("--theme-reveal-radius", `${endRadius}px`);
    }
    startViewTransition(apply);
  };

  return [theme, setTheme];
}
