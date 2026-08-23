import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, ChevronDown, Trash2 } from "lucide-react";

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
  embedded = false,
  title,
  summary,
  children,
  onClose,
  modalBoxClassName = "max-w-2xl",
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  pending: boolean;
  embedded?: boolean;
  title: ReactNode;
  summary: ReactNode;
  children: ReactNode;
  onClose: () => void;
  modalBoxClassName?: string;
}) {
  const content = (
    <>
      <div className="deletion-dialog-intro">
        <h3 className="flex items-center gap-2 text-lg font-bold">
          <AlertTriangle className="size-5 text-error" /> {title}
        </h3>
        <div className="py-2 text-sm text-base-content/70">{summary}</div>
      </div>
      {children}
    </>
  );

  if (embedded) {
    return <div className="quick-cleanup-review flex h-full w-full flex-col">{content}</div>;
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onClose={onClose}
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      <div className={`modal-box polished-modal ${modalBoxClassName}`}>
        {content}
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit" disabled={pending}>close</button>
      </form>
    </dialog>
  );
}

export function DeletionDialogLayout({
  status,
  review,
  destinations,
  footer,
}: {
  status?: ReactNode;
  review: ReactNode;
  destinations?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <>
      {status}
      {review}
      {destinations}
      {footer}
    </>
  );
}

export function DeletionPreviewDisclosure({
  label = "Deletion preview",
  meta,
  controls,
  children,
}: {
  label?: ReactNode;
  meta?: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="group deletion-preview mt-3 overflow-hidden rounded-lg border border-base-300 bg-base-100/40">
      <div className="relative">
        <summary
          className={`flex h-8 cursor-pointer list-none items-center gap-1.5 px-2.5 text-xs text-base-content/50 ${
            controls ? "group-open:pr-40" : ""
          }`}
        >
          <ChevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform group-open:rotate-0" />
          <span className="font-medium">{label}</span>
          {meta && <span className="ml-auto">{meta}</span>}
        </summary>
        {controls && (
          <div className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 group-open:block">
            {controls}
          </div>
        )}
      </div>
      <div className="border-t border-base-300/70 px-2.5 pb-2">
        {children}
      </div>
    </details>
  );
}

export function DeletionPreview({
  mode,
  onModeChange,
  basic,
  advanced,
  collapsible = false,
}: {
  mode: DeletionPreviewMode;
  onModeChange: (mode: DeletionPreviewMode) => void;
  basic: ReactNode;
  advanced: ReactNode;
  collapsible?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const hasMounted = useRef(false);
  useEffect(() => {
    hasMounted.current = true;
  }, []);
  const modePicker = (
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
  );
  const content = (
    <>
      <motion.div
        className="deletion-preview-content"
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
  if (collapsible) {
    return (
      <DeletionPreviewDisclosure controls={modePicker}>
        {content}
      </DeletionPreviewDisclosure>
    );
  }
  return (
    <div className="deletion-preview">
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-base-content/50">Deletion preview</span>
        {modePicker}
      </div>
      {content}
    </div>
  );
}

export function BasicDeletionList({ children }: { children: ReactNode }) {
  return (
    <ul className="deletion-basic-list mt-2 max-h-56 divide-y divide-base-300/50 overflow-y-auto rounded-lg border border-base-300 bg-base-200/40 py-1 text-sm">
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
