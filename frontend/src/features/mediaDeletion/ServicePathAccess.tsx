import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DownloadCleanupJob, MediaVersionPathPreview } from "@shared/types";
import { api } from "../../lib/api.ts";
import { needsDeletionPathAccess } from "./DeletionPathAccess.tsx";

export interface PlexAccessSample {
  ratingKey: string;
  mediaId: number;
  path: string;
}

export function versionAccessSample(
  ratingKey: string,
  selected: readonly MediaVersionPathPreview[],
  available: readonly MediaVersionPathPreview[],
  reason?: string,
): PlexAccessSample | undefined {
  const samples = (versions: readonly MediaVersionPathPreview[]) =>
    versions.flatMap((version) =>
      version.plexPaths.map((path) => ({ ratingKey, mediaId: version.mediaId, path }))
    );
  // Retained versions can need a different mount. A concrete blocker identifies
  // that verification sample; it never changes the selected deletion versions.
  return samples(available).sort((a, b) => b.path.length - a.path.length)
    .find((sample) => reason?.includes(sample.path)) ?? samples(selected)[0];
}
export function parentFolder(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "");
}

// qBittorrent manifests contain paths relative to the job's current save folder.
// This supplies a verification sample only; it grants no deletion authority.
export function currentJobAccessFile(job: DownloadCleanupJob | undefined) {
  if (!job || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(job.savePath)) return undefined;
  const file = job.files.find((entry) => entry.size !== null && entry.size > 0);
  if (!file || /^(?:[\\/]|[a-zA-Z]:)/.test(file.path)) return undefined;
  const parts = file.path.split(/[\\/]+/);
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return { ...file, path: job.savePath.replace(/[\\/]$/, "") + "/" + parts.join("/") };
}

interface ServicePathAccessProps {
  libraryKey: string;
  reason?: string;
  plexSample?: PlexAccessSample;
  job?: DownloadCleanupJob;
  onResolved: () => void;
}

export function ServicePathAccess(props: ServicePathAccessProps) {
  const [choice, setChoice] = useState<{ reason?: string; service: "Plex" | "qBittorrent" }>();
  if (!needsDeletionPathAccess(props.reason)) return null;
  const service = choice?.reason === props.reason ? choice?.service : undefined;
  return (
    <div>
      {props.plexSample && currentJobAccessFile(props.job) && (
        <div className="flex gap-2 mt-2" aria-label="Folder access service">
          {(["Plex", "qBittorrent"] as const).map((value) => (
            <button
              type="button"
              className="btn btn-xs"
              key={value}
              onClick={() => setChoice({ reason: props.reason, service: value })}
            >
              {value} folder access
            </button>
          ))}
        </div>
      )}
      <ServiceAccessMapping {...props} service={service} />
    </div>
  );
}

function ServiceAccessMapping(
  { libraryKey, reason, plexSample, job, onResolved, service }: ServicePathAccessProps & {
    service?: "Plex" | "qBittorrent";
  },
) {
  const client = useQueryClient();
  const resolved = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["deletion-plex-path-access", libraryKey] }),
      client.invalidateQueries({ queryKey: ["deletion-qb-path-access"] }),
    ]);
    onResolved();
  };
  const enabled = needsDeletionPathAccess(reason);
  const plexMappings = useQuery({
    queryKey: ["deletion-plex-path-access", libraryKey],
    queryFn: api.settings.plexPathMappings,
    enabled: enabled && Boolean(plexSample),
  });
  const qbSettings = useQuery({
    queryKey: ["deletion-qb-path-access"],
    queryFn: api.qbittorrent.get,
    enabled: enabled && Boolean(job),
  });
  if (!enabled) return null;
  // Resolve one missing capability at a time, preserving the backend ownership checks.
  const plexMapping = plexMappings.data?.find((mapping) =>
    mapping.libraryKey === libraryKey &&
    plexSample?.path.startsWith(
      mapping.plexPath.replace(/[\\/]$/, "") + (mapping.plexPath.includes("\\") ? "\\" : "/"),
    )
  );
  const preferQb = service
    ? service === "qBittorrent"
    : /(?:qBittorrent (?:path|namespace) mapping|live download path)/i.test(reason ?? "");
  if (!preferQb && plexSample && plexMappings.data && !plexMapping) {
    return (
      <ServiceMappingPrompt
        key={plexSample.path}
        service="Plex"
        remoteFolder={parentFolder(plexSample.path)}
        samplePath={plexSample.path}
        onSave={async (localPath) => {
          await api.settings.createPlexPathMapping({
            libraryKey,
            plexPath: parentFolder(plexSample.path),
            localPath,
            caseSensitive: true,
            sampleRatingKey: plexSample.ratingKey,
            sampleMediaId: plexSample.mediaId,
          });
        }}
        onResolved={resolved}
      />
    );
  }
  const file = currentJobAccessFile(job);
  const jobFolder = job && file && file.path.startsWith(job.contentPath.replace(/[\\/]$/, "") + "/")
    ? job.contentPath
    : file
    ? parentFolder(file.path)
    : "";
  const qbMapping = qbSettings.data?.pathMappings.find((mapping) =>
    mapping.instanceKey === job?.instanceKey &&
    file?.path.startsWith(
      mapping.qbittorrentPath.replace(/[\\/]$/, "") +
        (mapping.qbittorrentPath.includes("\\") ? "\\" : "/"),
    )
  );
  if (service !== "Plex" && job && file && qbSettings.data && !qbMapping) {
    return (
      <ServiceMappingPrompt
        key={file.path}
        service="qBittorrent"
        remoteFolder={jobFolder}
        samplePath={file.path}
        onSave={async (localPath) => {
          const remoteFolder = jobFolder;
          await api.qbittorrent.createPathMapping({
            instanceKey: job.instanceKey,
            qbittorrentPath: remoteFolder,
            localPath,
            caseSensitive: true,
            validationQbittorrentPath: file.path,
            validationLocalPath: localPath.replace(/[/]$/, "") + "/" +
              file.path.slice(remoteFolder.length + 1),
            validationSize: file.size!,
          });
        }}
        onResolved={resolved}
      />
    );
  }
  if (!preferQb && plexMapping && plexSample) {
    return (
      <ServiceMappingPrompt
        key={`plex-${plexMapping.id}`}
        service="Plex"
        remoteFolder={plexMapping.plexPath}
        samplePath={plexSample.path}
        initialLocalPath={plexMapping.localPath}
        onSave={async (localPath) => {
          await api.settings.updatePlexPathMapping(plexMapping.id, {
            libraryKey,
            plexPath: plexMapping.plexPath,
            localPath,
            caseSensitive: plexMapping.caseSensitive,
            sampleRatingKey: plexSample.ratingKey,
            sampleMediaId: plexSample.mediaId,
          });
        }}
        onResolved={resolved}
      />
    );
  }
  if (qbMapping && job && file) {
    return (
      <ServiceMappingPrompt
        key={`qb-${qbMapping.id}`}
        service="qBittorrent"
        remoteFolder={qbMapping.qbittorrentPath}
        samplePath={file.path}
        initialLocalPath={qbMapping.localPath}
        onSave={async (localPath) => {
          await api.qbittorrent.updatePathMapping(qbMapping.id, {
            instanceKey: job.instanceKey,
            qbittorrentPath: qbMapping.qbittorrentPath,
            localPath,
            caseSensitive: qbMapping.caseSensitive,
            validationQbittorrentPath: file.path,
            validationLocalPath: localPath.replace(/\/$/, "") + "/" +
              file.path.slice(qbMapping.qbittorrentPath.replace(/[\\/]$/, "").length + 1),
            validationSize: file.size!,
          });
        }}
        onResolved={resolved}
      />
    );
  }
  return null;
}

function ServiceMappingPrompt({
  service,
  remoteFolder,
  samplePath,
  initialLocalPath = "",
  onSave,
  onResolved,
}: {
  service: string;
  remoteFolder: string;
  samplePath: string;
  initialLocalPath?: string;
  onSave: (localPath: string) => Promise<void>;
  onResolved: () => void;
}) {
  const [localPath, setLocalPath] = useState(initialLocalPath);
  const save = useMutation({ mutationFn: () => onSave(localPath.trim()), onSuccess: onResolved });
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-warning/30 p-3 text-sm">
      <p className="font-semibold">Where can Plex Librarian access this folder?</p>
      <p className="break-all">
        {service} folder: <code>{remoteFolder}</code>
      </p>
      <label className="flex flex-col gap-1">
        Librarian folder<input
          className="input input-bordered input-sm font-mono"
          value={localPath}
          disabled={save.isPending}
          onChange={(event) => {
            setLocalPath(event.target.value);
            save.reset();
          }}
          placeholder="Path inside the Librarian container"
        />
      </label>
      <p className="text-xs text-base-content/60">
        Verifies a current file from this selection before saving.
      </p>
      <details>
        <summary className="cursor-pointer text-xs">Advanced: selected file</summary>
        <code className="break-all text-xs">{samplePath}</code>
      </details>
      {save.error && (
        <>
          <p role="alert" className="text-error">{save.error.message}</p>
          <p className="text-xs">
            If this folder is not exposed, mount the host folder that {service} sees as{" "}
            <code>{remoteFolder}</code> at{" "}
            <code>{localPath}</code>, read-only. Keep app-data unchanged, apply, and check again.
          </p>
        </>
      )}
      <button
        type="button"
        className="btn btn-sm"
        disabled={save.isPending || !localPath.trim()}
        onClick={() => save.mutate()}
      >
        {save.isPending ? "Checking selected file..." : "Check and save mapping"}
      </button>
    </div>
  );
}
