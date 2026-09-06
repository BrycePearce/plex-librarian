import type { ArrCleanupTarget, DownloadCleanupJob } from "@shared/types";
import { useState } from "react";
import { DeletionPathAccess, needsDeletionPathAccess } from "./DeletionPathAccess.tsx";
import { type PlexAccessSample, ServicePathAccess } from "./ServicePathAccess.tsx";

/** Access samples are read-only hints; the refreshed backend preview grants authority. */
export function DeletionAccessResolver(
  { libraryKey, ratingKey, target, selectedPath, reason, plexSample, job, onResolved }: {
    libraryKey: string;
    ratingKey: string;
    target?: ArrCleanupTarget;
    selectedPath?: string;
    reason?: string;
    plexSample?: PlexAccessSample;
    job?: DownloadCleanupJob;
    onResolved: () => void;
  },
) {
  const [choice, setChoice] = useState<{ reason?: string; arr: boolean }>();
  const arr = choice && choice.reason === reason ? choice.arr : Boolean(
    target &&
      (!/Plex|qBittorrent|torrent|download/i.test(reason ?? "") ||
        /Sonarr library|Radarr|Arr.*mapping/i.test(reason ?? "")),
  );
  if (!needsDeletionPathAccess(reason)) return null;
  const prompt = arr && target
    ? (
      <DeletionPathAccess
        libraryKey={libraryKey}
        ratingKey={ratingKey}
        target={target}
        selectedPath={selectedPath}
        reason={reason}
        onResolved={onResolved}
      />
    )
    : (
      <ServicePathAccess
        libraryKey={libraryKey}
        reason={reason}
        plexSample={plexSample}
        job={job}
        onResolved={onResolved}
      />
    );
  return (
    <>
      {prompt}
      {target && (plexSample || job) && reason && (
        <button
          type="button"
          className="btn btn-ghost btn-xs mt-1"
          onClick={() => setChoice({ reason, arr: !arr })}
        >
          {arr
            ? "Check Plex or qBittorrent path access"
            : `Check ${target.type === "sonarr" ? "Sonarr" : "Radarr"} path access`}
        </button>
      )}
    </>
  );
}
