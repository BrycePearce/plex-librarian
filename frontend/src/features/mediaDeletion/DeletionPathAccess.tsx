import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArrCleanupTarget, ArrInstance, ArrPathMapping } from "@shared/types";
import { api } from "../../lib/api.ts";

export function needsDeletionPathAccess(reason: string | undefined): boolean {
  return Boolean(
    reason &&
      /mapping|mount|local|access|filesystem|file identity|inode|payload ownership could not be verified/i
        .test(reason),
  );
}

export function deletionAccessMapping(instance: ArrInstance, remoteFolder: string): ArrPathMapping {
  const existing = instance.pathMappings.filter((mapping) =>
    mapping.kind === "library" &&
    (remoteFolder === mapping.arrPath ||
      remoteFolder.startsWith(
        mapping.arrPath.replace(/[\\/]$/, "") + (mapping.arrPath.includes("\\") ? "\\" : "/"),
      ))
  )
    .sort((a, b) => b.arrPath.length - a.arrPath.length)[0];
  return existing ?? { kind: "library", arrPath: remoteFolder, localPath: "" };
}

export function DeletionPathAccess(
  { libraryKey, ratingKey, target, reason, selectedPath, onResolved }: {
    libraryKey: string;
    ratingKey: string;
    target?: ArrCleanupTarget;
    reason?: string;
    selectedPath?: string;
    onResolved: () => void;
  },
) {
  const client = useQueryClient();
  const enabled = Boolean(target?.path && needsDeletionPathAccess(reason));
  const settings = useQuery({
    queryKey: ["deletion-path-access", libraryKey],
    queryFn: api.arr.get,
    enabled,
  });
  if (!enabled || !target?.path || !settings.data) return null;
  const matches = settings.data.instances.filter((instance) =>
    instance.name === target.instanceName && instance.type === target.type &&
    settings.data.mappings.some((mapping) =>
      mapping.instanceId === instance.id && mapping.libraryKey === libraryKey
    )
  );
  if (matches.length !== 1) return null;
  const instance = matches[0]!;
  const mapping = deletionAccessMapping(instance, target.path);
  return (
    <MappingPrompt
      key={JSON.stringify([instance.id, mapping, ratingKey, selectedPath])}
      instance={instance}
      mapping={mapping}
      libraryKey={libraryKey}
      ratingKey={ratingKey}
      selectedPath={selectedPath}
      onResolved={async () => {
        await client.invalidateQueries({ queryKey: ["deletion-path-access", libraryKey] });
        onResolved();
      }}
    />
  );
}

function MappingPrompt({ instance, mapping, libraryKey, ratingKey, selectedPath, onResolved }: {
  instance: ArrInstance;
  mapping: ArrPathMapping;
  libraryKey: string;
  ratingKey: string;
  selectedPath?: string;
  onResolved: () => void;
}) {
  const [localPath, setLocalPath] = useState(mapping.localPath);
  const [mountNeeded, setMountNeeded] = useState(false);
  const check = useMutation({
    mutationFn: async () => {
      const proposed = { ...mapping, localPath: localPath.trim() };
      const current = await api.arr.get();
      const liveInstance = current.instances.find((value) => value.id === instance.id);
      if (!liveInstance || liveInstance.url !== instance.url) {
        throw new Error("Connection changed. Reopen this preview before saving path access.");
      }
      const pathMappings = [
        ...liveInstance.pathMappings.filter((value) =>
          !(value.kind === "library" && value.arrPath === proposed.arrPath)
        ),
        proposed,
      ];
      const result = await api.arr.verifyStorage({
        instanceId: instance.id,
        url: instance.url,
        pathMappings,
        libraryKeys: [libraryKey],
        ratingKey,
        ...(selectedPath ? { selectedPath } : {}),
      });
      if (result.library?.status !== "verified") {
        setMountNeeded(result.roots?.some((root) => root.status !== "accessible") ?? false);
        throw new Error(result.library?.reason ?? result.reason);
      }
      await api.arr.savePathMappings(instance.id, pathMappings);
    },
    onSuccess: () => {
      setMountNeeded(false);
      onResolved();
    },
  });
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-warning/30 p-3 text-sm">
      <p className="font-semibold">Where can Plex Librarian access this folder?</p>
      <p className="break-all">
        {instance.type === "sonarr" ? "Sonarr" : "Radarr"} folder: <code>{mapping.arrPath}</code>
      </p>
      <label className="flex flex-col gap-1">
        Librarian folder
        <input
          className="input input-bordered input-sm font-mono"
          value={localPath}
          disabled={check.isPending}
          placeholder="Path inside the Librarian container"
          onChange={(event) => {
            setLocalPath(event.target.value);
            check.reset();
            setMountNeeded(false);
          }}
        />
      </label>
      <p className="text-xs text-base-content/60">
        Checks a current file from this selection and saves the mapping for later previews.
      </p>
      {check.error && <p role="alert" className="text-error">{check.error.message}</p>}
      {mountNeeded && (
        <p className="text-xs">
          If this folder is not exposed, edit the Librarian container and mount the host folder that
          {" "}
          {instance.name} sees as <code>{mapping.arrPath}</code> at{" "}
          <code>{localPath}</code>, read-only. Keep the app-data mount unchanged, apply, then check
          again.
        </p>
      )}
      <button
        type="button"
        className="btn btn-sm"
        disabled={check.isPending || !localPath.trim()}
        onClick={() => check.mutate()}
      >
        {check.isPending ? "Checking selected file..." : "Check and save mapping"}
      </button>
    </div>
  );
}
