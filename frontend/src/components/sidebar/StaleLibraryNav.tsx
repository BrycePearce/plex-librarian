import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArchiveRestore, ChevronRight, Film, Music, Search, Tv, X } from "lucide-react";
import type { Library } from "../../lib/api";
import { api } from "../../lib/api";
import "./StaleLibraryNav.css";

const INLINE_LIMIT = 8;
const RECENT_LIMIT = 3;
const RECENT_STORAGE_KEY = "plex-librarian:recent-stale-libraries";

export function StaleLibraryNav({ collapsed }: { collapsed: boolean }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeKey = libraryKeyFromPath(pathname);
  const [expanded, setExpanded] = useState(activeKey !== null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recentKeys, setRecentKeys] = useState<string[]>(readRecentKeys);
  const { data } = useQuery({
    queryKey: ["libraries"],
    queryFn: () => api.libraries.list(),
  });
  const libraries = data?.libraries ?? [];
  const hasMany = libraries.length > INLINE_LIMIT;

  useEffect(() => {
    if (activeKey !== null && !collapsed) setExpanded(true);
  }, [activeKey, collapsed]);

  const quickLibraries = useMemo(() => {
    if (!hasMany) return libraries;
    const byKey = new Map(libraries.map((library) => [library.key, library]));
    const recent = recentKeys.flatMap((key) => {
      const library = byKey.get(key);
      return library ? [library] : [];
    });
    const fallback = libraries.filter((library) => !recentKeys.includes(library.key));
    return [...recent, ...fallback].slice(0, RECENT_LIMIT);
  }, [hasMany, libraries, recentKeys]);

  const filteredLibraries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return libraries;
    return libraries.filter((library) => library.title.toLowerCase().includes(normalized));
  }, [libraries, query]);

  function rememberLibrary(key: string) {
    setRecentKeys((current) => {
      const next = [key, ...current.filter((value) => value !== key)].slice(0, RECENT_LIMIT);
      try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Navigation should still work when storage is disabled.
      }
      return next;
    });
    setPickerOpen(false);
    setQuery("");
  }

  function toggle() {
    if (collapsed) {
      setPickerOpen(true);
      return;
    }
    if (libraries.length === 1) return;
    setExpanded((value) => !value);
  }

  if (libraries.length === 1) {
    const library = libraries[0];
    return (
      <Link
        to="/libraries/$key/stale"
        params={{ key: library.key }}
        className={`sidebar-link ${activeKey === library.key ? "is-active" : ""}`}
        aria-current={activeKey === library.key ? "page" : undefined}
        title={collapsed ? `Stale content · ${library.title}` : undefined}
        onClick={() => rememberLibrary(library.key)}
      >
        <span className="sidebar-link-icon"><ArchiveRestore className="size-[18px]" /></span>
        <span className="sidebar-link-label">Stale content</span>
        <span className="sidebar-active-dot" />
      </Link>
    );
  }

  return (
    <div className={`stale-sidebar-nav ${activeKey !== null ? "has-active-library" : ""}`}>
      <button
        type="button"
        className={`sidebar-link stale-sidebar-trigger ${activeKey !== null ? "is-active" : ""}`}
        aria-expanded={collapsed ? pickerOpen : expanded}
        onClick={toggle}
        title={collapsed ? "Stale content" : undefined}
      >
        <span className="sidebar-link-icon"><ArchiveRestore className="size-[18px]" /></span>
        <span className="sidebar-link-label">Stale content</span>
        <ChevronRight className={`stale-sidebar-chevron ${expanded ? "rotate-90" : ""}`} />
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && expanded && (
          <motion.div
            className="stale-sidebar-children"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: .18, ease: "easeOut" }}
          >
            {hasMany && <div className="stale-sidebar-caption">Recent</div>}
            {quickLibraries.map((library) => (
              <StaleLibraryLink
                key={library.key}
                library={library}
                active={activeKey === library.key}
                onOpen={() => rememberLibrary(library.key)}
              />
            ))}
            {hasMany && (
              <button type="button" className="stale-sidebar-browse" onClick={() => setPickerOpen(true)}>
                <Search className="size-3.5" /> Browse all {libraries.length}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {pickerOpen && createPortal(
        <dialog open className="modal stale-library-picker" aria-labelledby="stale-picker-title">
          <div className="modal-box stale-picker-box">
            <div className="stale-picker-header">
              <div>
                <small>Cleanup workspace</small>
                <h2 id="stale-picker-title">Review stale content</h2>
              </div>
              <button type="button" className="btn btn-ghost btn-circle btn-sm" onClick={() => setPickerOpen(false)} aria-label="Close library picker">
                <X className="size-4" />
              </button>
            </div>
            <label className="stale-picker-search">
              <Search className="size-4" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${libraries.length} libraries…`}
                aria-label="Search libraries"
              />
            </label>
            <div className="stale-picker-results">
              {filteredLibraries.map((library) => (
                <StaleLibraryLink
                  key={library.key}
                  library={library}
                  active={activeKey === library.key}
                  picker
                  onOpen={() => rememberLibrary(library.key)}
                />
              ))}
              {filteredLibraries.length === 0 && <div className="stale-picker-empty">No libraries match “{query}”.</div>}
            </div>
          </div>
          <button type="button" className="modal-backdrop" onClick={() => setPickerOpen(false)} aria-label="Close library picker" />
        </dialog>,
        document.body,
      )}
    </div>
  );
}

function StaleLibraryLink({
  library,
  active,
  picker = false,
  onOpen,
}: {
  library: Library;
  active: boolean;
  picker?: boolean;
  onOpen: () => void;
}) {
  const Icon = library.type === "show" ? Tv : library.type === "artist" ? Music : Film;
  return (
    <Link
      to="/libraries/$key/stale"
      params={{ key: library.key }}
      className={`${picker ? "stale-picker-result" : "stale-sidebar-child"} ${active ? "is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onOpen}
    >
      <span className={`stale-library-type stale-library-${library.type}`}><Icon className="size-3.5" /></span>
      <span>{library.title}</span>
      {picker && <small>{library.itemCount.toLocaleString()} items</small>}
    </Link>
  );
}

function libraryKeyFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/libraries\/([^/]+)\/stale/);
  return match ? decodeURIComponent(match[1]) : null;
}

function readRecentKeys(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}
