import type { ServiceDeletionPreview } from "../../../../shared/serviceOwnedDeletion.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { BasicDeletionList, BasicDeletionRow } from "./DeletionDialog.tsx";

export const deletionServiceNames = {
  plex: "Plex",
  sonarr: "Sonarr",
  radarr: "Radarr",
  qb: "qBittorrent",
};

/** Applicability comes from live inventory, independently of optional consent. */
export function detectedDestinations(preview: ServiceDeletionPreview | undefined) {
  return (["sonarr", "radarr", "qb"] as const).filter((service) =>
    preview?.targets.some((target) =>
      target.decisions.some((action) => action.service === service && action.presence === "current")
    )
  );
}

/** One row per selected item/version; episode-level execution details stay out of ordinary review. */
export function ServiceDeletionPreviewList({ preview }: { preview: ServiceDeletionPreview }) {
  return (
    <div>
      <BasicDeletionList>
        {preview.targets.map((target) => {
          const context = [
            target.showTitle,
            target.episodeIndex != null
              ? `S${String(target.seasonIndex ?? 0).padStart(2, "0")}E${
                String(target.episodeIndex).padStart(2, "0")
              }`
              : undefined,
            target.title,
          ].filter(Boolean).join(" · ");
          return (
            <BasicDeletionRow
              key={`${target.ratingKey}:${target.mediaId ?? "whole"}`}
              title={target.fileName
                ? (
                  <span>
                    {context}
                    <span className="block truncate text-xs text-base-content/60">
                      {target.fileName}
                    </span>
                  </span>
                )
                : context}
              titleText={[context, target.fileName].filter(Boolean).join(" · ")}
              badges={target.mediaId !== undefined && (
                <span className="badge badge-sm badge-outline">
                  {target.videoResolution || "Selected version"}
                </span>
              )}
              size={target.fileSize == null ? "" : formatKilobytes(target.fileSize)}
            />
          );
        })}
      </BasicDeletionList>
      {preview.targets.map((target) => {
        const warnings = new Map<string, string>();
        for (const action of target.decisions) {
          if (
            action.state === "held" || action.presence === "unknown" ||
            (action.requested && action.state === "kept")
          ) {
            const message = `${deletionServiceNames[action.service]}: ${action.reason}${
              action.service === "plex" && action.state === "kept"
                ? ". This media will remain in Plex."
                : ""
            }`;
            warnings.set(message, message);
          }
        }
        return warnings.size > 0 && (
          <div
            key={`${target.ratingKey}:${target.mediaId ?? "whole"}`}
            className="mt-2 space-y-1 text-xs text-warning"
            role="status"
          >
            {preview.targets.length > 1 && (
              <p className="font-medium">
                {target.title}
                {target.mediaId !== undefined
                  ? ` · ${target.fileName ?? target.videoResolution ?? "Selected version"}`
                  : ""}
              </p>
            )}
            {[...warnings.values()].map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        );
      })}
    </div>
  );
}
