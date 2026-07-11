import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle, TriangleAlert, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

// Shared alert chrome for post-delete result banners on the stale and duplicates
// pages — the message content differs per page (whole items vs. duplicate versions),
// so callers own their own text, but the wrapper/variant/dismiss button was two
// copy-pasted `<div className="alert">` blocks.
export function DeleteResultAlert({
  variant,
  onDismiss,
  children,
}: {
  variant: "success" | "warning";
  onDismiss: () => void;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(true);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(false), 5_000);
    return () => window.clearTimeout(timeout);
  }, []);

  const Icon = variant === "warning" ? TriangleAlert : CheckCircle;

  return (
    <motion.div
      role="status"
      aria-live="polite"
      initial={reduceMotion ? false : { opacity: 0, x: 16, scale: 0.98 }}
      animate={visible
        ? { opacity: 1, x: 0, scale: 1 }
        : { opacity: 0, x: 12, scale: 0.98 }}
      transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
      onAnimationComplete={() => {
        if (!visible) onDismiss();
      }}
      className={`alert ${
        variant === "warning" ? "alert-warning" : "alert-success"
      } fixed top-20 right-6 z-50 w-auto max-w-md shadow-xl border border-base-content/10`}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="text-sm">{children}</span>
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square"
        onClick={() => setVisible(false)}
        aria-label="Dismiss notification"
      >
        <X className="w-3 h-3" />
      </button>
    </motion.div>
  );
}
