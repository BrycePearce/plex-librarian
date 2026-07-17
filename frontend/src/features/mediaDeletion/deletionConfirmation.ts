export type DeletionPreviewState = "loading" | "ready" | "error";

export interface DeletionConfirmationRequirements {
  pending: boolean;
  hasSelection: boolean;
  preview: DeletionPreviewState;
  semanticBlock?: boolean;
  fallbackRequired: boolean;
  fallbackAcknowledged: boolean;
}

export function deletionConfirmationBlocked(
  requirements: DeletionConfirmationRequirements,
): boolean {
  return requirements.pending || !requirements.hasSelection ||
    requirements.preview !== "ready" || requirements.semanticBlock === true ||
    (requirements.fallbackRequired && !requirements.fallbackAcknowledged);
}
