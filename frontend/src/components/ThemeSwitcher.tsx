import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronUp, Palette } from "lucide-react";
import { THEMES, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { useClickOutside } from "../lib/useClickOutside";

const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  night: "Night",
  dracula: "Dracula",
  light: "Light",
};

export function ThemeSwitcher({ sidebar = false }: { sidebar?: boolean }) {
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useClickOutside(rootRef, () => setOpen(false), open);

  return (
    <div className={`relative ${sidebar ? "sidebar-control" : ""}`} ref={rootRef}>
      <button
        type="button"
        className={sidebar ? "sidebar-control-button" : "btn btn-ghost btn-circle btn-sm"}
        onClick={() => setOpen((o) => !o)}
        title="Change theme"
        aria-label="Change theme"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Palette className="w-4 h-4" />
        {sidebar && (
          <>
            <span className="sidebar-control-copy">
              <strong>Appearance</strong>
              <small>{THEME_LABELS[theme]} theme</small>
            </span>
            <ChevronUp className={`size-4 sidebar-control-chevron ${open ? "is-open" : ""}`} />
          </>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ type: "spring", stiffness: 400, damping: 28 }}
            className={`menu absolute z-50 w-40 rounded-box bg-base-200 shadow-xl p-2 ${sidebar ? "bottom-full left-0 mb-2 origin-bottom-left" : "right-0 mt-2 origin-top-right"}`}
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
