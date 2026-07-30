import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Trash2 } from "lucide-react";

export type DeletionPreviewMode = "basic" | "advanced";

export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timeout = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timeout);
  }, [active, delayMs]);

  return active && visible;
}

export function useDeletionDialogCancelFocus(
  dialogRef: RefObject<HTMLDialogElement | null>,
  focusKey: unknown,
) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (dialogRef.current?.open) {
      cancelButtonRef.current?.focus({ preventScroll: true });
    }
  }, [dialogRef, focusKey]);
  return cancelButtonRef;
}

export function DeletionModalShell({
  dialogRef,
  pending,
  title,
  summary,
  children,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  pending: boolean;
  title: ReactNode;
  summary: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <dialog ref={dialogRef} className="modal" onClose={onClose}>
      <div className="modal-box polished-modal max-w-2xl">
        <h3 className="flex items-center gap-2 text-lg font-bold">
          <AlertTriangle className="size-5 text-error" /> {title}
        </h3>
        <div className="py-2 text-sm text-base-content/70">{summary}</div>
        {children}
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit" disabled={pending}>close</button>
      </form>
    </dialog>
  );
}

export function DeletionPreview({
  mode,
  onModeChange,
  basic,
  advanced,
}: {
  mode: DeletionPreviewMode;
  onModeChange: (mode: DeletionPreviewMode) => void;
  basic: ReactNode;
  advanced: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const hasMounted = useRef(false);
  useEffect(() => {
    hasMounted.current = true;
  }, []);
  return (
    <>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-base-content/50">
          Deletion preview
        </span>
        <div
          className="join rounded-md border border-base-300 bg-base-200/50 p-0.5"
          role="group"
          aria-label="Deletion preview detail"
        >
          {(["basic", "advanced"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={`join-item btn btn-xs h-6 min-h-0 border-0 px-2.5 capitalize ${
                mode === candidate
                  ? "bg-base-100 text-base-content shadow-sm"
                  : "bg-transparent text-base-content/45 shadow-none"
              }`}
              aria-pressed={mode === candidate}
              onClick={() => onModeChange(candidate)}
            >
              {candidate}
            </button>
          ))}
        </div>
      </div>
      <motion.div
        key={mode}
        initial={reduceMotion || !hasMounted.current ? false : { opacity: 0, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: reduceMotion ? 0 : 0.12,
          ease: "easeOut",
        }}
      >
        {mode === "basic" ? basic : advanced}
      </motion.div>
    </>
  );
}

export function BasicDeletionList({ children }: { children: ReactNode }) {
  return (
    <ul className="mt-2 max-h-56 divide-y divide-base-300/50 overflow-y-auto rounded-lg border border-base-300 bg-base-200/40 py-1 text-sm">
      {children}
    </ul>
  );
}

export function BasicDeletionRow({
  selection,
  selected = false,
  title,
  titleText,
  badges,
  marks,
  size,
}: {
  selection?: ReactNode;
  selected?: boolean;
  title: ReactNode;
  titleText?: string;
  badges?: ReactNode;
  marks?: ReactNode;
  size: ReactNode;
}) {
  const content = (
    <>
      {selection}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate" title={titleText}>
            {title}
          </span>
          {badges}
        </span>
        {marks}
      </span>
      <span className="shrink-0 font-mono text-xs text-base-content/50">
        {size}
      </span>
    </>
  );

  return (
    <li className={selection && selected ? "bg-primary/10" : undefined}>
      {selection
        ? (
          <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 transition-colors hover:bg-primary/5 focus-within:bg-primary/5">
            {content}
          </label>
        )
        : <div className="flex items-center gap-3 px-3 py-1.5">{content}</div>}
    </li>
  );
}

export function DeletionPreviewStatus({
  error,
  warnings = [],
  onRetry,
  retrying = false,
}: {
  error: string | null;
  warnings?: string[];
  onRetry?: () => void;
  retrying?: boolean;
}) {
  if (!error && warnings.length === 0) return null;

  return (
    <div className="mt-2 space-y-1 text-xs">
      {error && (
        <div className="flex items-center justify-between gap-3 text-error">
          <p>Could not verify this deletion: {error}</p>
          {onRetry && (
            <button
              type="button"
              className="btn btn-ghost btn-xs h-6 min-h-0 w-14 shrink-0"
              onClick={onRetry}
              disabled={retrying}
              aria-label={retrying ? "Retrying deletion verification" : undefined}
            >
              {retrying ? <span className="loading loading-spinner loading-xs" /> : "Retry"}
            </button>
          )}
        </div>
      )}
      {!error &&
        warnings.map((warning) => <p key={warning} className="text-warning">{warning}</p>)}
    </div>
  );
}

export function DeletionDialogFooter({
  cancelButtonRef,
  pending,
  preparing,
  confirmDisabled,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  cancelButtonRef?: RefObject<HTMLButtonElement | null>;
  pending: boolean;
  preparing: boolean;
  confirmDisabled: boolean;
  confirmLabel: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const showPreparing = preparing && !pending;

  return (
    <div className="modal-action mt-3">
      <button
        ref={cancelButtonRef}
        type="button"
        className="btn btn-sm"
        onClick={onCancel}
        disabled={pending}
      >
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-sm btn-error relative min-w-40 transition-[color,background-color,border-color,opacity] duration-200"
        onClick={onConfirm}
        disabled={confirmDisabled}
        aria-label={showPreparing ? "Checking deletion safety" : undefined}
      >
        <span
          className={`flex items-center gap-2 ${showPreparing ? "invisible" : ""}`}
          aria-hidden={showPreparing}
        >
          {pending
            ? <span className="loading loading-spinner loading-xs" />
            : <Trash2 className="size-4" />}
          {confirmLabel}
        </span>
        {showPreparing && (
          <span
            className="absolute inset-0 flex items-center justify-center gap-2"
            role="status"
          >
            <span className="loading loading-spinner loading-xs" />
            Checking safety…
          </span>
        )}
      </button>
    </div>
  );
}
