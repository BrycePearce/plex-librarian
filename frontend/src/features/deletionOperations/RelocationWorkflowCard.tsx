import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { useState } from "react";
import type {
  DeletionOperationTarget,
  RadarrMovieRelocationGuidanceV1,
} from "../../../../shared/types.ts";
import { hasValidRelocationGuidance } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";

export function RelocationWorkflowCard({
  operationId,
  target,
  recoveryDefersSync,
}: {
  operationId: string;
  target: DeletionOperationTarget;
  recoveryDefersSync: boolean;
}) {
  if (target.relocationGuidanceState === "invalid") {
    return <InvalidRelocationDiagnostic label="durable relocation guidance" />;
  }
  if (target.relocationSyncBarrierState === "invalid") {
    return <InvalidRelocationDiagnostic label="durable relocation sync barrier" />;
  }
  if (!hasValidRelocationGuidance(target)) return null;
  switch (target.relocationGuidance.service) {
    case "radarr":
      return (
        <RadarrMovieRelocationCard
          operationId={operationId}
          target={target}
          recoveryDefersSync={recoveryDefersSync}
        />
      );
  }
}

function InvalidRelocationDiagnostic({ label }: { label: string }) {
  return (
    <div className="mx-4 mb-4 rounded-lg border border-error/40 bg-error/5 p-4 text-sm">
      <h3 className="font-semibold">Invalid {label}</h3>
      <p className="mt-2 text-base-content/70">
        This workflow state is unsupported or corrupted. No relocation action is available. Restore
        a compatible application/database backup or repair the database deliberately before cleanup.
      </p>
    </div>
  );
}

function RadarrMovieRelocationCard({
  operationId,
  target,
  recoveryDefersSync,
}: {
  operationId: string;
  target: DeletionOperationTarget & {
    relocationGuidanceState: "valid";
    relocationGuidance: RadarrMovieRelocationGuidanceV1;
  };
  recoveryDefersSync: boolean;
}) {
  const guidance = target.relocationGuidance;
  const [confirmed, setConfirmed] = useState(false);
  const qc = useQueryClient();
  const queryKey = queryKeys.deletionOperations.detail(operationId);
  const finish = useMutation({
    mutationFn: () =>
      api.deletionOperations.finishRelocation(
        operationId,
        target.id,
        guidance.guidanceId,
        confirmed,
      ),
    onSuccess: (data) => qc.setQueryData(queryKey, data.operation),
  });
  const runSync = useMutation({
    mutationFn: () => api.deletionOperations.runRelocationSync(operationId, target.id),
    onSuccess: (data) => qc.setQueryData(queryKey, data.operation),
  });
  const active = target.relocationGuidanceState === "valid" &&
    target.relocationSyncBarrierState === "none";

  return (
    <div className="mx-4 mb-4 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
      <h3 className="font-semibold">
        Move the retained copy into Radarr's movie folder
      </h3>
      <p className="mt-2 text-base-content/70">
        Radarr can adopt the retained version only after it is inside the existing movie folder.
        Plex Librarian attempted no deletion for this target and will never move the file itself.
      </p>
      <PathRow
        label="Copy from (Radarr-visible; remove only after successful Plex playback)"
        value={guidance.sourceArrPath}
      />
      <PathRow
        label="Copy to (Radarr-visible)"
        value={guidance.destinationArrPath}
      />
      <PathRow
        label="Plex destination Part path to select and play"
        value={guidance.destinationPlexPath}
      />
      <PathRow
        label="Do not touch (Radarr-managed selected file)"
        value={guidance.selectedArrPath}
      />
      {active && (
        <>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-base-content/75">
            <li>
              Temporarily disable Plex's{" "}
              <strong>Empty trash automatically after every scan</strong>.
            </li>
            <li>
              Stop playback, then copy only the retained file using a no-overwrite copy. Stop if the
              destination already exists. Do not delete, overwrite, or rename the existing
              Radarr-managed selected file.
            </li>
            <li>
              Run <strong>Scan Library Files</strong> in Plex.
            </li>
            <li>
              In Plex, explicitly choose the copied destination version—not an ordinary Play action.
              Verify its displayed Part path is exactly{" "}
              <code>{guidance.destinationPlexPath}</code>, then play it successfully. If Plex cannot
              distinguish that version and path, stop.
            </li>
            <li>
              Only after that playback succeeds, remove the original retained path without touching
              the selected Radarr-managed file, then scan the library again.
            </li>
            <li>
              Do not empty Plex trash. If Plex still reports the original retained Part path after
              the second scan, Plex has not reconciled the relocation; stop and investigate.
            </li>
          </ol>
          <div className="alert alert-warning mt-4 text-xs">
            A copy needs temporary free space and can leave an incomplete destination if
            interrupted. It does not preserve hardlink identity; hardlinks cannot span filesystems.
            Removing a torrent-tracked path can disrupt seeding. Run these steps only where the
            displayed Radarr-visible paths refer to the writable library.
          </div>
          <label className="mt-4 flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="checkbox checkbox-sm mt-0.5"
              checked={confirmed}
              onChange={(event) =>
                setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)}
            />
            <span>
              I explicitly selected the copied Plex version, verified its Part path exactly matches
              {" "}
              <code>{guidance.destinationPlexPath}</code>, and it played successfully.
            </span>
          </label>
          <button
            type="button"
            className="btn btn-warning btn-sm mt-4"
            disabled={!confirmed || finish.isPending}
            onClick={() => finish.mutate()}
          >
            {recoveryDefersSync ? "Finish relocation" : "Finish relocation and re-run cleanup"}
          </button>
        </>
      )}
      {target.relocationSyncBarrierState === "incomplete" && (
        <div className="mt-4">
          <p className="text-base-content/70">
            The original target is permanently superseded. A newer targeted sync must complete
            pruning before any fresh cleanup preview can be accepted.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm mt-3"
            disabled={runSync.isPending}
            onClick={() => runSync.mutate()}
          >
            Run targeted sync
          </button>
        </div>
      )}
      {target.relocationSyncBarrierState === "completed" && (
        <div className="mt-4">
          <p className="text-success">
            Targeted sync completed. Build a fresh cleanup preview.
          </p>
          <Link
            to="/duplicates"
            search={{ type: "all", comparison: "all" }}
            className="btn btn-primary btn-sm mt-3"
          >
            Review duplicates
          </Link>
        </div>
      )}
      {(finish.error || runSync.error) && (
        <p className="mt-3 text-error">
          {(finish.error ?? runSync.error) instanceof Error
            ? (finish.error ?? runSync.error)!.message
            : "Relocation action failed"}
        </p>
      )}
    </div>
  );
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-3 rounded-md bg-base-100 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-base-content/50">
        {label}
      </p>
      <div className="mt-1 flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all">{value}</code>
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          aria-label={`Copy ${label}`}
          onClick={() =>
            void (navigator as unknown as {
              clipboard: { writeText(value: string): Promise<void> };
            }).clipboard.writeText(value)}
        >
          <Copy className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
