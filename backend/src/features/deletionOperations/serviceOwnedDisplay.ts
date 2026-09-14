import type { ServiceDeletionPreviewFile } from '../../../../shared/serviceOwnedDeletion.ts';
import type { ServiceOwnedPlannedAction } from '../mediaDeletion/serviceOwnedPlanning.ts';

/** These limits affect presentation only; execution retains the complete original plan. */
export const SERVICE_PREVIEW_FILE_LIMIT = 1000;
export const SERVICE_PREVIEW_TOTAL_FILE_LIMIT = 5000;

export function serviceOwnedDisplayFiles(
  actions: readonly ServiceOwnedPlannedAction[],
  remaining: number,
): { files: ServiceDeletionPreviewFile[]; fileCount: number; filesTruncated: boolean } {
  const files: ServiceDeletionPreviewFile[] = [];
  let fileCount = 0;
  const limit = Math.max(0, Math.min(SERVICE_PREVIEW_FILE_LIMIT, remaining));
  for (const action of actions) {
    fileCount += action.files.length;
    for (const file of action.files) {
      if (files.length >= limit) break;
      // Deliberate allowlist: never spread a plan, connection, job, or credential here.
      files.push({
        path: file.path,
        size: file.size,
        service: action.service,
        actionId: action.id,
      });
    }
  }
  return { files, fileCount, filesTruncated: fileCount > files.length };
}
