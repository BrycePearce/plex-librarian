/// <reference lib="dom" />

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

const VIEWPORT_GAP = 8;

interface PositionedRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function placePopover(
  anchor: PositionedRect,
  popover: Pick<PositionedRect, "width" | "height">,
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const unclampedLeft = anchor.left + anchor.width / 2 - popover.width / 2;
  const left = Math.min(
    Math.max(VIEWPORT_GAP, unclampedLeft),
    viewport.width - popover.width - VIEWPORT_GAP,
  );
  const below = anchor.bottom + VIEWPORT_GAP;
  const top = below + popover.height <= viewport.height - VIEWPORT_GAP
    ? below
    : Math.max(VIEWPORT_GAP, anchor.top - popover.height - VIEWPORT_GAP);
  return { left, top };
}

export function HoverPopover({
  content,
  children,
  openOnClick = false,
  anchorClassName,
  anchorTabIndex,
}: {
  content: ReactNode;
  children: ReactNode;
  openOnClick?: boolean;
  anchorClassName?: string;
  anchorTabIndex?: number;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: -10_000, top: -10_000 });

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const popover = popoverRef.current?.getBoundingClientRect();
      if (!anchor || !popover) return;
      setPosition(placePopover(anchor, popover, {
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
      }));
    };

    updatePosition();
    globalThis.addEventListener("resize", updatePosition);
    // Capture scroll events from the modal's nested overflow regions too.
    globalThis.addEventListener("scroll", updatePosition, true);
    return () => {
      globalThis.removeEventListener("resize", updatePosition);
      globalThis.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, content]);

  useEffect(() => {
    if (!pinned) return;
    const dismiss = (event: PointerEvent) => {
      if (anchorRef.current?.contains(event.target as Node)) return;
      setPinned(false);
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [pinned]);

  const portalRoot = anchorRef.current?.closest("dialog") ??
    (typeof document === "undefined" ? null : document.body);

  return (
    <>
      <span
        ref={anchorRef}
        className={anchorClassName ?? "inline-flex shrink-0"}
        tabIndex={anchorTabIndex}
        aria-describedby={open ? id : undefined}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => {
          if (!pinned) setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          if (!pinned) setOpen(false);
        }}
        onClick={openOnClick
          ? (event) => {
            event.stopPropagation();
            setPinned((current) => {
              setOpen(!current);
              return !current;
            });
          }
          : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setPinned(false);
            setOpen(false);
          }
        }}
      >
        {children}
      </span>
      {open && portalRoot && createPortal(
        <div
          ref={popoverRef}
          id={id}
          role="tooltip"
          className="pointer-events-none fixed z-[1000] max-w-72 rounded-md border border-base-300 bg-base-100 px-2.5 py-2 text-left text-xs font-normal normal-case tracking-normal text-base-content shadow-xl"
          style={{ left: position.left, top: position.top }}
        >
          {content}
        </div>,
        portalRoot,
      )}
    </>
  );
}
