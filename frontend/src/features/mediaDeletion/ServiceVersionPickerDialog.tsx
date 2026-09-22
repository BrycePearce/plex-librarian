import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Layers3, LoaderCircle } from "lucide-react";
import { api } from "../../lib/api.ts";
import type { DuplicateGroup, DuplicateSeasonGroup } from "../../lib/api.ts";
import type { ServiceDeletionSelection } from "../../../../shared/serviceOwnedDeletion.ts";
import { compareDuplicateVersions } from "@shared/mediaComparison";
import {
  comparisonIcon,
  comparisonToneClass,
} from "../../routes/-duplicates/duplicatePresentation.ts";
import { defaultVersionSelection } from "../../routes/-duplicates/versionDeletionState.ts";
import {
  episodeCoverageLabel,
  LanePathsPopover,
  seasonLaneMatchBasisLabel,
} from "../../routes/-duplicates/SeasonDuplicateDialog.tsx";
import { BasicDeletionList, BasicDeletionRow, DeletionModalShell } from "./DeletionDialog.tsx";
import { ServiceOwnedDeletionDialog } from "./ServiceOwnedDeletionDialog.tsx";
import { ServiceDeletionPreviewList } from "./ServiceDeletionPreviewList.tsx";
import { VersionTechnicalInfo } from "./VersionTechnicalInfo.tsx";
import { formatKilobytes } from "../../lib/format.ts";
import { needsTechnicalDetailRefresh, versionLabel } from "../../lib/mediaVersion.ts";

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
    ) return [{ ratingKey }];
    return versions.map((version) => ({ ratingKey, mediaId: version.mediaId }));
  });
}

export function serviceVersionSelectionValid(
  groups: readonly DuplicateGroup[],
  selected: ReadonlySet<string>,
): boolean {
  return groups.every((group) =>
    group.mediaType === "movie" ||
    group.versions.some((version) => !selected.has(`${group.episodeRatingKey}:${version.mediaId}`))
  );
}

export function initialServiceVersionSelection(
  groups: readonly DuplicateGroup[],
  season: boolean,
): Set<string> {
  if (season) return new Set();
  return new Set(groups.flatMap((group) => {
    const key = group.mediaType === "movie" ? group.ratingKey : group.episodeRatingKey;
    return [...defaultVersionSelection(group.versions)].map((id) => `${key}:${id}`);
  }));
}

export function ServiceVersionPickerDialog(
  { dialogRef, groups, season, onCreated, onCancel, onPendingChange }: {
    dialogRef: RefObject<HTMLDialogElement | null>;
    groups: DuplicateGroup[];
    season?: DuplicateSeasonGroup;
    onCreated: (operationId: string) => void;
    onCancel: () => void;
    onPendingChange?: (pending: boolean) => void;
  },
) {
  const [selected, setSelected] = useState(() => initialServiceVersionSelection(groups, !!season));
  const [mode, setMode] = useState<"profiles" | "episodes">(
    season && groups.length > 1 ? "profiles" : "episodes",
  );
  const [pending, setPending] = useState(false);
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);
  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, [dialogRef]);
  const analysis = useQuery({
    queryKey: [
      "service-version-season-analysis",
      season?.seasonRatingKey,
      groups.map((g) => g.mediaType === "episode" ? g.episodeRatingKey : g.ratingKey),
    ],
    queryFn: () =>
      api.duplicates.analyzeSeasonVersions(
        season!.seasonRatingKey,
        season!.episodes.map((e) => e.episodeRatingKey),
        season!.totalEpisodeCount ?? season!.duplicateGroupCount,
        { selectionOnly: true },
      ),
    enabled: !!season && mode === "profiles",
    retry: false,
    staleTime: 30_000,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const first = groups[0];
  const firstKey = first.mediaType === "movie" ? first.ratingKey : first.episodeRatingKey;
  const technical = useQuery({
    queryKey: ["service-version-technical", first.mediaType, firstKey],
    queryFn: () => api.duplicates.refreshTechnicalDetails(first.mediaType, firstKey),
    enabled: !season && needsTechnicalDetailRefresh(first.versions),
    retry: false,
    staleTime: Infinity,
  });
  const displayGroups = season
    ? [...(analysis.data?.episodes ?? groups)].sort((a, b) =>
      (a.mediaType === "episode" ? a.episodeIndex : 0) -
      (b.mediaType === "episode" ? b.episodeIndex : 0)
    )
    : [{
      ...first,
      versions: first.versions.map((v) =>
        technical.data?.versions.find((fresh) => fresh.mediaId === v.mediaId) ?? v
      ),
    }];
  const targets = selectedServiceVersions(displayGroups, selected);
  const valid = serviceVersionSelectionValid(displayGroups, selected);
  const count = displayGroups.reduce(
    (sum, g) =>
      sum +
      g.versions.filter((v) =>
        selected.has(`${g.mediaType === "movie" ? g.ratingKey : g.episodeRatingKey}:${v.mediaId}`)
      ).length,
    0,
  );
  const size = displayGroups.reduce(
    (sum, g) =>
      sum +
      g.versions.filter((v) =>
        selected.has(`${g.mediaType === "movie" ? g.ratingKey : g.episodeRatingKey}:${v.mediaId}`)
      ).reduce((s, v) => s + (v.fileSize ?? 0), 0),
    0,
  );
  function toggle(key: string) {
    if (pending) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function versionRows(group: DuplicateGroup) {
    const key = group.mediaType === "movie" ? group.ratingKey : group.episodeRatingKey;
    return (
      <BasicDeletionList>
        {group.versions.map((version) => (
          <BasicDeletionRow
            key={version.mediaId}
            selected={selected.has(`${key}:${version.mediaId}`)}
            selection={
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={selected.has(`${key}:${version.mediaId}`)}
                disabled={pending ||
                  (group.mediaType === "episode" && !selected.has(`${key}:${version.mediaId}`) &&
                    group.versions.filter((v) => !selected.has(`${key}:${v.mediaId}`)).length <= 1)}
                onChange={() => toggle(`${key}:${version.mediaId}`)}
                aria-label={`Delete ${versionLabel(version)}`}
              />
            }
            title={versionLabel(version)}
            titleText={versionLabel(version)}
            badges={<VersionTechnicalInfo version={version} />}
            size={version.fileSize == null ? "—" : formatKilobytes(version.fileSize)}
          />
        ))}
      </BasicDeletionList>
    );
  }
  const comparison = compareDuplicateVersions(displayGroups[0].versions);
  const ComparisonIcon = comparisonIcon(comparison.kind);
  const picker = (
    <>
      {season
        ? (
          <div className="version-picker-toolbar">
            <div
              className="join rounded-md border border-base-300 bg-base-200/50 p-0.5"
              role="group"
              aria-label="Deletion selection view"
            >
              {([["profiles", "Season versions"], ["episodes", "Episode versions"]] as const).map((
                [candidate, label],
              ) => (
                <button
                  type="button"
                  key={candidate}
                  disabled={pending || (candidate === "profiles" && groups.length < 2)}
                  aria-pressed={mode === candidate}
                  className={`join-item btn btn-xs h-6 min-h-0 border-0 px-2.5 ${
                    mode === candidate
                      ? "bg-base-100 text-base-content shadow-sm"
                      : "bg-transparent text-base-content/45 shadow-none"
                  }`}
                  onClick={() => {
                    if (candidate === mode) return;
                    setMode(candidate);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )
        : (
          <div
            className={`alert items-start gap-2.5 py-2 text-sm duplicates-review-comparison duplicates-review-comparison-${comparison.kind}`}
          >
            <ComparisonIcon
              className={`mt-0.5 size-4 shrink-0 ${comparisonToneClass(comparison.kind)}`}
            />
            <div>
              <div className="font-semibold">{comparison.label}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {comparison.reasons.map((reason) => (
                  <span className="duplicates-quality-chip" key={reason}>{reason}</span>
                ))}
              </div>
              {technical.isFetching && (
                <p className="text-xs opacity-70">Checking Plex for more detail…</p>
              )}
            </div>
          </div>
        )}
      {season && mode === "profiles"
        ? (
          <div className="season-profile-panel">
            {analysis.isLoading && (
              <div role="status" className="season-profile-loading">Analyzing season versions…</div>
            )}
            {analysis.isError && (
              <p role="alert" className="text-error">
                Season versions could not be read. Use Episode versions to review individual files.
              </p>
            )}
            {analysis.data?.profiles.length === 0 && (
              <div className="season-profile-empty">
                No repeating season-wide versions could be identified safely. Use Episode versions
                to review these files.
              </div>
            )}
            <div className="season-profile-lanes">
              {analysis.data?.profiles.map((profile) => {
                const active = profile.members.every((m) =>
                  selected.has(`${m.episodeRatingKey}:${m.mediaId}`)
                );
                const next = new Set(selected);
                for (const member of profile.members) {
                  const key = `${member.episodeRatingKey}:${member.mediaId}`;
                  if (active) next.delete(key);
                  else next.add(key);
                }
                const unsafe = !active && !serviceVersionSelectionValid(displayGroups, next);
                const coverage = episodeCoverageLabel(profile.members.flatMap((m) => {
                  const e = analysis.data.episodes.find((e) =>
                    e.episodeRatingKey === m.episodeRatingKey
                  );
                  return e ? [e.episodeIndex] : [];
                }));
                return (
                  <div
                    key={profile.id}
                    className={`season-profile-card ${active ? "is-selected" : ""} ${
                      unsafe ? "is-disabled" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="season-profile-toggle"
                      disabled={pending || unsafe}
                      aria-pressed={active}
                      aria-label={`Delete ${profile.label}`}
                      onClick={() => {
                        setSelected(next);
                      }}
                    >
                      <span className="season-profile-radio" aria-hidden="true">
                        {active ? "✓" : ""}
                      </span>
                    </button>
                    <div className="season-profile-select">
                      <span className="season-profile-copy">
                        <span className="season-profile-heading">
                          <strong>{profile.sourceHints.join(" · ") || "Season version"}</strong>
                          <span className="badge badge-ghost badge-xs">
                            {seasonLaneMatchBasisLabel(profile.matchBasis)}
                          </span>
                        </span>
                        <small className="season-profile-technical" title={profile.label}>
                          {profile.label}
                        </small>
                        <small>
                          {profile.audioSummary.join(", ") || "Audio details unavailable"}
                          {profile.subtitleSummary.length > 0 &&
                            ` · ${profile.subtitleSummary.length} subtitle tracks`}
                        </small>
                        <span className="season-profile-coverage">
                          <span className="season-profile-coverage-range" title={coverage.full}>
                            {coverage.compact}
                          </span>
                          <span className="season-profile-coverage-count">
                            {profile.coverageCount} /{" "}
                            {season.totalEpisodeCount ?? displayGroups.length} episodes
                          </span>
                          <span className="season-profile-size">
                            Total: {profile.totalFileSize == null
                              ? "Unknown size"
                              : formatKilobytes(profile.totalFileSize)}
                          </span>
                        </span>
                      </span>
                    </div>
                    <span className="season-profile-actions">
                      <LanePathsPopover
                        profile={profile}
                        episodeIndexByRatingKey={new Map(
                          analysis.data.episodes.map((
                            episode,
                          ) => [episode.episodeRatingKey, episode.episodeIndex]),
                        )}
                      />
                      {unsafe && <span className="badge badge-ghost badge-sm">Must keep one</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )
        : season
        ? (
          <div className="season-batch-list">
            {displayGroups.map((group) => (
              <details
                className="version-picker-episode"
                key={group.mediaType === "episode" ? group.episodeRatingKey : group.ratingKey}
              >
                <summary className="version-picker-episode-summary">
                  <span className="season-batch-episode-copy">
                    <strong>
                      {group.mediaType === "episode"
                        ? `E${String(group.episodeIndex).padStart(2, "0")} — ${group.episodeTitle}`
                        : group.title}
                    </strong>
                    <small>
                      {group.versions.length} versions · {group.versions.filter((v) =>
                        selected.has(
                          `${
                            group.mediaType === "episode" ? group.episodeRatingKey : group.ratingKey
                          }:${v.mediaId}`,
                        )
                      ).length} selected for removal
                    </small>
                  </span>
                  <ChevronDown className="size-4" />
                </summary>
                <div className="version-picker-episode-details">{versionRows(group)}</div>
              </details>
            ))}
          </div>
        )
        : versionRows(displayGroups[0])}
      {!valid && (
        <p role="alert" className="text-warning">
          At least one version must be kept — uncheck one to continue.
        </p>
      )}
    </>
  );
  return (
    <DeletionModalShell
      dialogRef={dialogRef}
      pending={pending}
      title={season
        ? (
          <>
            <Layers3 className="size-5" />Resolve season duplicates
          </>
        )
        : "Resolve duplicate versions"}
      summary={season
        ? `${season.showTitle} — Season ${season.seasonIndex}. Choose the versions to remove.`
        : `${
          first.mediaType === "movie"
            ? first.title
            : `${first.showTitle} — S${first.seasonIndex}E${first.episodeIndex} "${first.episodeTitle}"`
        } has ${first.versions.length} versions synced from Plex. Review exactly where the selected files will be removed.`}
      onClose={onCancel}
      modalBoxClassName="max-w-5xl version-picker-modal"
    >
      <div className="version-picker-scroll">
        <p className="version-picker-guidance">
          Select the copies to remove.{first.mediaType === "episode" &&
            " Keep at least one version of every episode."}
        </p>
        {picker}
        <div className="version-picker-review">
          <ServiceOwnedDeletionDialog
            dialogRef={dialogRef}
            embedded
            hideIntro
            libraryKey={first.libraryKey}
            targets={targets}
            onPendingChange={setPending}
            onCreated={onCreated}
            onCancel={onCancel}
            selectionDisabled={!valid || targets.length === 0}
            previewDelayMs={300}
            focusCancel={false}
            renderPreview={(preview, state) =>
              preview
                ? (
                  <ServiceDeletionPreviewList
                    preview={preview}
                    historical={state.historical}
                    showWarnings={false}
                  />
                )
                : (
                  <section
                    className="version-picker-checking"
                    aria-live="polite"
                    aria-busy={state.loading && targets.length > 0}
                  >
                    {targets.length > 0 && state.loading && (
                      <LoaderCircle className="size-5 animate-spin text-primary" />
                    )}
                    <strong>
                      {targets.length === 0
                        ? "Deletion preview"
                        : state.error
                        ? "Preview unavailable"
                        : "Checking selected versions"}
                    </strong>
                    <p>
                      {targets.length === 0
                        ? "Select versions above to preview their removal."
                        : state.error
                        ? "Retry the checks below to review current files and services."
                        : "Checking current files, service ownership, and retained copies."}
                    </p>
                  </section>
                )}
            confirmLabel={
              <>
                Delete {count} {count === 1 ? "version" : "versions"} ({formatKilobytes(size)}{" "}
                logical media)
              </>
            }
          />
        </div>
      </div>
    </DeletionModalShell>
  );
}
