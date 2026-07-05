import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Palette } from "lucide-react";
import { THEMES, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { useClickOutside } from "../lib/useClickOutside";

const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  night: "Night",
  dracula: "Dracula",
  light: "Light",
};

export function ThemeSwitcher() {
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useClickOutside(rootRef, () => setOpen(false), open);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="btn btn-ghost btn-circle btn-sm"
        onClick={() => setOpen((o) => !o)}
        title="Change theme"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Palette className="w-4 h-4" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ type: "spring", stiffness: 400, damping: 28 }}
            className="menu absolute right-0 mt-2 w-40 origin-top-right rounded-box bg-base-200 shadow-xl z-50 p-2"
          >
            {THEMES.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  role="menuitem"
                  className="flex items-center justify-between leading-none"
                  onClick={(e) => {
                    setTheme(t, { x: e.clientX, y: e.clientY });
                    setOpen(false);
                  }}
                >
                  {THEME_LABELS[t]}
                  {theme === t && (
                    <Check className="w-3.5 h-3.5 text-primary" />
                  )}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
