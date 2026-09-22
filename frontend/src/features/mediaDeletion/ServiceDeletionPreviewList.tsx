import type { HistoricalDownloadPreview } from "../../../../shared/historicalDownloads.ts";
import { HistoricalDownloadPaths } from "./HistoricalDownloadPaths.tsx";
import { useState } from "react";
import { ActiveServiceMark, PathTreeRoot } from "./DeletionTree.tsx";
import { DeletionPreview } from "./DeletionDialog.tsx";
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
      target.decisions.some((action) =>
        action.service === service && action.presence === "current" &&
        (service !== "qb" || action.matchedToSelection === true)
      )
    )
  );
}

/** One row per selected item/version; episode-level execution details stay out of ordinary review. */
export function ServiceDeletionPreviewList(
  { preview, historical, collapsible = false, showWarnings = true }: {
    preview: ServiceDeletionPreview;
    historical?: HistoricalDownloadPreview;
    collapsible?: boolean;
    showWarnings?: boolean;
  },
) {
  const [mode, setMode] = useState<"basic" | "advanced">("basic");
  return (
    <div>
      <DeletionPreview
        mode={mode}
        onModeChange={setMode}
        collapsible={collapsible}
        basic={
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
                  marks={
                    <span className="flex gap-1">
                      {[
                        ...new Set(
                          target.decisions.filter((action) =>
                            action.requested && action.state === "delete_candidate"
                          ).map((action) => action.service),
                        ),
                      ].map((service) => (
                        <ActiveServiceMark
                          key={service}
                          service={service === "qb" ? "qbittorrent" : service}
                          label={deletionServiceNames[service] + " deletion"}
                        />
                      ))}
                    </span>
                  }
                  size={target.fileSize == null ? "" : formatKilobytes(target.fileSize)}
                />
              );
            })}
            {!!historical?.candidates.length && (
              <BasicDeletionRow
                title="Leftover download files"
                titleText="Exact files linked by Sonarr import history"
                badges={<span className="badge badge-ghost badge-xs">Downloads</span>}
                marks={
                  <span className="text-xs text-base-content/60">
                    {historical.candidates.length} files
                  </span>
                }
                size={historical.discovery ? "Size not yet checked" : formatKilobytes(
                  historical.candidates.reduce((sum, file) => sum + file.size / 1000, 0),
                )}
              />
            )}
          </BasicDeletionList>
        }
        advanced={<ServiceDeletionFileTree preview={preview} historical={historical} />}
      />
      {!!historical?.candidates.length && (
        <p className="mt-2 text-xs text-base-content/60">
          Includes leftover download files linked by Sonarr history. Only listed files are
          considered; parent folders are kept.
        </p>
      )}
      {!!historical?.skipped.length && (
        <div className="mt-2 text-xs text-base-content/60">
          <HistoricalDownloadPaths
            exclusionsOnly
            preview={{ ...historical, candidates: [], handled: [] }}
          />
        </div>
      )}
      {showWarnings && <ServiceDeletionWarnings preview={preview} />}
    </div>
  );
}

export function ServiceDeletionWarnings({ preview }: { preview: ServiceDeletionPreview }) {
  return (
    <>
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
    </>
  );
}

export function ServiceDeletionFileTree({ preview, historical }: {
  preview: ServiceDeletionPreview;
  historical?: HistoricalDownloadPreview;
}) {
  const downloadGroups = new Map<string, Array<{ path: string; size: number | null }>>();
  for (const file of historical?.candidates ?? []) {
    const separator = Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\"));
    const root = file.path.slice(0, separator) || "/";
    const files = downloadGroups.get(root) ?? [];
    files.push({
      path: file.path.slice(separator + 1),
      size: historical?.discovery ? null : file.size,
    });
    downloadGroups.set(root, files);
  }
  return (
    <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-base-300 bg-base-200/40 p-3">
      {preview.targets.map((target) => {
        const decisions = new Map(target.decisions.map((action) => [action.actionId, action]));
        const groups = new Map<
          string,
          {
            root: string;
            service: "plex" | "sonarr" | "radarr" | "qb";
            state: string;
            files: Array<{ path: string; size: number | null }>;
          }
        >();
        for (const file of target.files ?? []) {
          const action = decisions.get(file.actionId);
          if (!action?.requested) continue;
          const separator = Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\"));
          const root = separator >= 0 ? file.path.slice(0, separator) || "/" : file.path;
          const name = separator >= 0 ? file.path.slice(separator + 1) : file.path;
          const key = file.service + "\0" + action.state + "\0" + root;
          const group = groups.get(key) ??
            { root, service: file.service, state: action.state, files: [] };
          if (!group.files.some((entry) => entry.path === name)) {
            group.files.push({ path: name, size: file.size });
          }
          groups.set(key, group);
        }
        return (
          <div
            key={target.ratingKey + ":" + (target.mediaId ?? "whole")}
            className="mb-2 last:mb-0"
          >
            <p className="mb-1 text-xs font-medium">{target.title}</p>
            {[...groups.entries()].map(([key, group]) => (
              <PathTreeRoot
                key={key}
                path={group.root}
                source={deletionServiceNames[group.service]}
                warning={group.state !== "delete_candidate"}
                marks={
                  <ActiveServiceMark
                    service={group.service === "qb" ? "qbittorrent" : group.service}
                    label={deletionServiceNames[group.service] + (group.state === "delete_candidate"
                      ? " deletion"
                      : group.state === "kept"
                      ? " retained"
                      : " held")}
                  />
                }
                files={group.files}
                totalFiles={group.files.length}
                note={group.state === "kept"
                  ? "These files will be kept"
                  : group.state === "held"
                  ? "Deletion held for these files"
                  : undefined}
              />
            ))}
            {groups.size === 0 && (
              <p className="text-xs text-base-content/50">
                No file paths reported for selected services.
              </p>
            )}
            {target.filesTruncated && (
              <p className="text-xs text-base-content/50">
                Showing a limited preview of {target.fileCount} known files.
              </p>
            )}
            {target.linkedExtrasIncluded && target.decisions.some((action) =>
              action.service === "sonarr" && action.requested && action.state === "delete_candidate"
            ) && (
              <p className="mt-1 text-xs text-base-content/50">
                Sonarr also handles service-linked extras; they may not all be listed here.
              </p>
            )}
          </div>
        );
      })}
      {[...downloadGroups].map(([root, files]) => (
        <PathTreeRoot
          key={root}
          path={root}
          source="Downloads"
          files={files}
          totalFiles={files.length}
          info="Intended leftover files linked by Sonarr history; eligibility is checked after confirmation."
        />
      ))}
    </div>
  );
}
