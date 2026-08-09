import { useRef } from "react";
import { Sparkles } from "lucide-react";
import { SmartCleanupDialog, type SmartCleanupDialogHandle } from "./SmartCleanupDialog.tsx";

export function QuickCleanupAction({ disabled = false }: { disabled?: boolean }) {
  const dialogRef = useRef<SmartCleanupDialogHandle>(null);

  return (
    <>
      <button
        type="button"
        className="btn btn-primary quick-cleanup-launch"
        onClick={() => dialogRef.current?.open()}
        disabled={disabled}
        title={disabled ? "Available when the current sync finishes" : undefined}
      >
        <Sparkles className="quick-cleanup-launch-sparkle size-4" />
        Quick cleanup
      </button>
      <SmartCleanupDialog ref={dialogRef} />
    </>
  );
}
