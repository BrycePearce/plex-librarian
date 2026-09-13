import { useEffect, useState } from "react";
import type { RefObject } from "react";
import type { DuplicateGroup } from "../../lib/api.ts";
import type { ServiceDeletionSelection } from "../../../../shared/serviceOwnedDeletion.ts";
import { DeletionModalShell } from "./DeletionDialog.tsx";
import { ServiceOwnedDeletionDialog } from "./ServiceOwnedDeletionDialog.tsx";
import { VersionTechnicalInfo } from "./VersionTechnicalInfo.tsx";
import { formatKilobytes } from "../../lib/format.ts";

export function selectedServiceVersions(
  groups: readonly DuplicateGroup[],
  selected: ReadonlySet<string>,
): ServiceDeletionSelection[] {
  return groups.flatMap((group) => {
    const ratingKey = group.mediaType === "movie" ? group.ratingKey : group.episodeRatingKey;
    const versions = group.versions.filter((version) =>
      selected.has(`${ratingKey}:${version.mediaId}`)
    );
    if (
      group.mediaType === "movie" && versions.length > 0 &&
      versions.length === group.versions.length
    ) {
      return [{ ratingKey }];
    }
    return versions.map((version) => ({ ratingKey, mediaId: version.mediaId }));
  });
}

export function ServiceVersionPickerDialog(
  { dialogRef, groups, onCreated, onCancel, onPendingChange }: {
    dialogRef: RefObject<HTMLDialogElement | null>;
    groups: DuplicateGroup[];
    onCreated: (operationId: string) => void;
    onCancel: () => void;
    onPendingChange?: (pending: boolean) => void;
  },
) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);
  useEffect(() => {
    dialogRef.current?.showModal();
  }, [dialogRef]);
  const targets = selectedServiceVersions(groups, selected);
  const selectionValid = groups.every((group) =>
    group.mediaType === "movie" ||
    group.versions.some((version) => !selected.has(`${group.episodeRatingKey}:${version.mediaId}`))
  );
  return (
    <DeletionModalShell
      dialogRef={dialogRef}
      pending={pending}
      title="Review duplicate versions"
      summary="Choose the versions to remove, then review current service actions. Keep at least one version of every episode."
      onClose={onCancel}
    >
      {review
        ? (
          <ServiceOwnedDeletionDialog
            dialogRef={dialogRef}
            embedded
            libraryKey={groups[0].libraryKey}
            targets={targets}
            onPendingChange={setPending}
            onCreated={onCreated}
            onCancel={() => setReview(false)}
          />
        )
        : (
          <>
            <div className="max-h-[55vh] space-y-4 overflow-y-auto">
              {groups.map((group) => {
                const ratingKey = group.mediaType === "movie"
                  ? group.ratingKey
                  : group.episodeRatingKey;
                return (
                  <section key={ratingKey}>
                    <h4 className="mb-2 font-semibold">
                      {group.mediaType === "movie"
                        ? group.title
                        : `${group.showTitle} · Episode ${group.episodeIndex}: ${group.episodeTitle}`}
                    </h4>
                    {group.versions.map((version) => {
                      const key = `${ratingKey}:${version.mediaId}`;
                      return (
                        <label
                          key={key}
                          className="mb-2 flex items-start gap-3 rounded-box border border-base-300 p-3"
                        >
                          <input
                            type="checkbox"
                            className="checkbox checkbox-sm"
                            checked={selected.has(key)}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelected((current) => {
                                const next = new Set(current);
                                if (checked) next.add(key);
                                else next.delete(key);
                                return next;
                              });
                            }}
                          />
                          <span>
                            <span className="block text-sm font-medium">
                              Version {version.mediaId} · {formatKilobytes(version.fileSize ?? 0)}
                            </span>
                            <VersionTechnicalInfo version={version} />
                          </span>
                        </label>
                      );
                    })}
                  </section>
                );
              })}
            </div>
            {!selectionValid && (
              <p role="alert" className="text-sm text-error">
                Keep at least one version of every episode.
              </p>
            )}
            <div className="modal-action">
              <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!targets.length || !selectionValid}
                onClick={() => setReview(true)}
              >
                Review service decisions
              </button>
            </div>
          </>
        )}
    </DeletionModalShell>
  );
}
