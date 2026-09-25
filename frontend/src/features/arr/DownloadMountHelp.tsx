import { useState } from "react";
import { downloadMountInstructions, type MountPlatform } from "./downloadMountInstructions.ts";

export function DownloadMountHelp(
  { platform, onPlatform, host, onHost, localRoot, onSaveDraft, saving }: {
    platform: MountPlatform;
    onPlatform: (platform: MountPlatform) => void;
    host: string;
    onHost: (host: string) => void;
    localRoot: string;
    onSaveDraft?: () => void;
    saving: boolean;
  },
) {
  const [copyResult, setCopyResult] = useState("");
  const instructions = downloadMountInstructions(platform, host, localRoot);
  return (
    <div className="mt-3 space-y-3 text-xs leading-relaxed text-base-content/65">
      <div className="flex gap-2" role="group" aria-label="Installation type">
        {(["unraid", "compose"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={platform === value}
            className={`btn btn-xs ${platform === value ? "btn-primary" : "btn-ghost"}`}
            onClick={() => {
              onPlatform(value);
              setCopyResult("");
            }}
          >
            {value === "unraid" ? "Unraid" : "Docker Compose"}
          </button>
        ))}
      </div>
      <p>
        Mount the same host folder used for completed downloads by Sonarr/Radarr. Keep Librarian’s
        existing <code>/data</code> mount unchanged.
      </p>
      <label className="flex flex-col gap-1.5">
        Host completed-downloads folder
        <input
          className="input input-bordered input-sm w-full font-mono"
          value={host}
          placeholder="/mnt/user/downloads/complete"
          onChange={(event) => {
            onHost(event.target.value);
            setCopyResult("");
          }}
        />
      </label>
      <p>
        {platform === "unraid"
          ? (
            <>
              Docker → Plex Librarian → Edit →{" "}
              <strong>Completed downloads folder</strong>. Enter these values, then Apply.
            </>
          )
          : (
            <>
              Add this entry under Plex Librarian’s{" "}
              <code>volumes:</code>, then recreate the container.
            </>
          )}
      </p>
      {instructions
        ? (
          <>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-base-300/50 p-3 text-xs">{instructions}</pre>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(instructions);
                  setCopyResult("Copied.");
                } catch {
                  setCopyResult("Clipboard unavailable. Select and copy the values above.");
                }
              }}
            >
              Copy {platform === "unraid" ? "mount values" : "configuration"}
            </button>
          </>
        )
        : (
          <p>
            Enter absolute host and Librarian folder paths to generate the mount configuration. The
            Librarian path must be outside <code>/data</code>.
          </p>
        )}
      {copyResult && <p role="status">{copyResult}</p>}
      {onSaveDraft && (
        <div className="border-t border-base-300 pt-3">
          <p>
            Save your progress before restarting the container. Cleanup stays off until you finish
            setup.
          </p>
          <button
            type="button"
            className="btn btn-soft btn-xs mt-2"
            disabled={saving}
            onClick={onSaveDraft}
          >
            Save draft before restart
          </button>
        </div>
      )}
      <p>After applying the mount, return here to finish setup. Folder cleanup requires Linux.</p>
    </div>
  );
}
