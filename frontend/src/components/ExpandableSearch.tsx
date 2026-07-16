import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, Search, X } from "lucide-react";
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH } from "@shared/search";
import "./expandableSearch.css";

export function ExpandableSearch({
  search,
  pending,
  onSearchChange,
  placeholder = "Search...",
  label = "Search",
}: {
  search: string;
  pending: boolean;
  onSearchChange: (search: string) => void;
  placeholder?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(Boolean(search));
  const [value, setValue] = useState(search);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef(search);
  const onSearchChangeRef = useRef(onSearchChange);
  const hintId = useId();
  const inputId = useId();
  searchRef.current = search;
  onSearchChangeRef.current = onSearchChange;

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setValue(search);
    if (search) setOpen(true);
  }, [search]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    function openWithShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches(
        "input, textarea, select, [contenteditable='true']",
      );
      if (
        event.key === "/" && !isTyping && !event.metaKey && !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", openWithShortcut);
    return () => document.removeEventListener("keydown", openWithShortcut);
  }, []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  function commit(nextValue: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const normalized = nextValue.trim();
    if (
      (normalized.length > 0 && normalized.length < SEARCH_MIN_LENGTH) ||
      normalized === searchRef.current
    ) return;
    onSearchChangeRef.current(normalized);
  }

  function update(nextValue: string) {
    setValue(nextValue);
    if (timerRef.current) clearTimeout(timerRef.current);
    const normalizedLength = nextValue.trim().length;
    if (normalizedLength > 0 && normalizedLength < SEARCH_MIN_LENGTH) return;
    timerRef.current = setTimeout(() => commit(nextValue), 350);
  }

  function clearAndClose() {
    setValue("");
    setOpen(false);
    commit("");
  }

  const normalizedLength = value.trim().length;
  const waitingForMore = normalizedLength > 0 &&
    normalizedLength < SEARCH_MIN_LENGTH;
  return (
    <div className={`expandable-search ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="expandable-search-trigger"
        onClick={() => setOpen(true)}
        aria-label={label}
        aria-expanded={open}
        aria-controls={inputId}
        tabIndex={open ? -1 : 0}
        title={`${label} (/)`}
      >
        <Search />
        <span>Search</span>
        <kbd>/</kbd>
      </button>
      <div className="expandable-search-field" aria-hidden={!open}>
        {pending
          ? <LoaderCircle className="expandable-search-icon animate-spin" />
          : <Search className="expandable-search-icon" />}
        <input
          id={inputId}
          ref={inputRef}
          type="search"
          className="input input-bordered input-sm"
          placeholder={placeholder}
          value={value}
          maxLength={SEARCH_MAX_LENGTH}
          tabIndex={open ? 0 : -1}
          aria-label={label}
          aria-describedby={waitingForMore
            ? hintId
            : undefined}
          onChange={(event) => update(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              clearAndClose();
            }
          }}
        />
        <button
          type="button"
          className="expandable-search-clear"
          aria-label={value ? "Clear search" : "Close search"}
          tabIndex={open ? 0 : -1}
          onClick={clearAndClose}
        >
          <X />
        </button>
      </div>
      <span
        id={hintId}
        className={`expandable-search-hint ${
          waitingForMore ? "is-visible" : ""
        }`}
      >
        Enter at least {SEARCH_MIN_LENGTH} characters
      </span>
    </div>
  );
}
