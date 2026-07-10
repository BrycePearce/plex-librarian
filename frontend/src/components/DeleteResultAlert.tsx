import type { ReactNode } from "react";
import { X } from "lucide-react";

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
  return (
    <div
      className={`alert ${
        variant === "warning" ? "alert-warning" : "alert-success"
      }`}
    >
      <span>{children}</span>
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={onDismiss}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
