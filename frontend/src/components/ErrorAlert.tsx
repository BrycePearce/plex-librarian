import { AlertCircle, RefreshCw } from "lucide-react";

export function ErrorAlert({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="alert alert-error">
      <AlertCircle className="w-4 h-4" />
      <span>{message}</span>
      <button
        type="button"
        className="btn btn-ghost btn-xs gap-1"
        onClick={onRetry}
      >
        <RefreshCw className="w-3 h-3" /> Try again
      </button>
    </div>
  );
}
