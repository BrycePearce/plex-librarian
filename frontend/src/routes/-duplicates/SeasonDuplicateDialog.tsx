import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { ChevronDown, Layers3, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { compareDuplicateVersions } from "@shared/mediaComparison";
import type { DuplicateDifferenceCode } from "@shared/mediaComparison";
import type {
  DuplicateEpisodeGroup,
  DuplicateSeasonGroup,
  SeasonVersionProfile,
  SmartDuplicateEpisodeCandidate,
} from "../../lib/api.ts";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { versionLabel } from "../../lib/mediaVersion.ts";
import { ErrorAlert } from "../../components/ErrorAlert.tsx";
import { HoverPopover } from "../../components/HoverPopover.tsx";
import { CandidateFileDetails } from "../../features/quickCleanup/CandidateFileDetails.tsx";
import { DestinationOptions } from "../../features/mediaDeletion/DeletionPlanSummary.tsx";
import { largestVersionId } from "./versionDeletionState.ts";

type ReviewMode = "profiles" | "episodes";

export function seasonDeletionConfirmationDisabled(input: {
  pending: boolean;
  selectionCount: number;
  mode: ReviewMode;
  profileReady: boolean;
  previewLoading: boolean;
  previewError: boolean;
  previewAvailable: boolean;
  blockerCount: number;
}): boolean {
  return input.pending || input.selectionCount === 0 ||
    (input.mode === "profiles" && !input.profileReady) || input.previewLoading ||
    input.previewError || !input.previewAvailable || input.blockerCount > 0;
}

const SEASON_DELETION_PREVIEW_MIN_VALIDITY_SECONDS = 5;

export function seasonDeletionPreviewIsUsable(
  expiresAt: number,
  now = Math.floor(Date.now() / 1000),
): boolean {
  return Number.isSafeInteger(expiresAt) &&
    expiresAt > now + SEASON_DELETION_PREVIEW_MIN_VALIDITY_SECONDS;
}

export async function refreshExpiredSeasonDeletionPreview<T extends { expiresAt: number }>(
  preview: T | undefined,
  refetch: () => Promise<{ data?: T }>,
  now = Math.floor(Date.now() / 1000),
): Promise<T | undefined> {
  if (preview && seasonDeletionPreviewIsUsable(preview.expiresAt, now)) return preview;
  const refreshed = (await refetch()).data;
  return refreshed && seasonDeletionPreviewIsUsable(refreshed.expiresAt) ? refreshed : undefined;
}

export function seasonDeletionAuthorizationKey(
  selections: readonly { ratingKey: string; deleteMediaIds: readonly number[] }[],
): string {
  return JSON.stringify(
    selections.map((selection) => ({
      ratingKey: selection.ratingKey,
      deleteMediaIds: [...selection.deleteMediaIds].sort((left, right) => left - right),
    })).sort((left, right) => left.ratingKey.localeCompare(right.ratingKey)),
  );
}
type EpisodeFilter = "all" | "different" | "same-profile" | "unknown" | DuplicateDifferenceCode;

// Keep this aligned with the authoritative backend season-planning bound. Larger
// seasons can still be handled through the existing per-episode review workflow.
export const MAX_SEASON_CLEANUP_EPISODES = 500;

interface EpisodeCoverageLabel {
  compact: string;
  full: string;
  truncated: boolean;
}

export function episodeCoverageLabel(
  episodeIndexes: readonly number[],
  maxSegments = 4,
): EpisodeCoverageLabel {
  const indexes = [...new Set(episodeIndexes.filter(Number.isSafeInteger))].sort(
    (left, right) => left - right,
  );
  if (indexes.length === 0) {
    return { compact: "No episodes", full: "No episodes", truncated: false };
  }

  const ranges: Array<{ start: number; end: number; count: number }> = [];
  for (const index of indexes) {
    const previous = ranges.at(-1);
    if (previous && index === previous.end + 1) {
      previous.end = index;
      previous.count += 1;
    } else {
      ranges.push({ start: index, end: index, count: 1 });
    }
  }

  const rangeLabel = (range: (typeof ranges)[number]) =>
    range.start === range.end ? `E${range.start}` : `E${range.start}–E${range.end}`;
  const full = ranges.map(rangeLabel).join(", ");
  if (ranges.length <= maxSegments) {
    return { compact: full, full, truncated: false };
  }

  const visibleCount = Math.max(1, maxSegments - 1);
  const visible = ranges.slice(0, visibleCount).map(rangeLabel).join(", ");
  const hiddenEpisodeCount = ranges
    .slice(visibleCount)
    .reduce((sum, range) => sum + range.count, 0);
  return {
    compact: `${visible}, +${hiddenEpisodeCount} more`,
    full,
    truncated: true,
  };
}

interface EpisodePlan {
  episode: DuplicateEpisodeGroup;
  candidate: SmartDuplicateEpisodeCandidate;
  comparison: ReturnType<typeof compareDuplicateVersions>;
}

function recommendationFor(episode: DuplicateEpisodeGroup): EpisodePlan {
  const ids = episode.versions.map((version) => version.mediaId);
  const keepMediaId = largestVersionId(episode.versions) ?? ids[0]!;
  const deleteMediaIds = ids.filter((id) => id !== keepMediaId);
  const deleted = episode.versions.filter((version) => deleteMediaIds.includes(version.mediaId));
  const comparison = compareDuplicateVersions(episode.versions);
  return {
    episode,
    comparison,
    candidate: {
      mediaType: "episode",
      libraryKey: episode.libraryKey,
      ratingKey: episode.episodeRatingKey,
      title: episode.showTitle,
      context: `S${episode.seasonIndex}E${episode.episodeIndex} · ${episode.episodeTitle}`,
      confidence: comparison.kind === "same-profile" ? "obvious" : "review",
      keepMediaId,
      deleteMediaIds,
      reclaimableSize: deleted.every((version) => version.fileSize !== null)
        ? deleted.reduce((total, version) => total + version.fileSize!, 0)
        : null,
      reasons: comparison.reasons,
      versions: episode.versions,
      showRatingKey: episode.showRatingKey,
      seasonRatingKey: episode.seasonRatingKey,
      seasonIndex: episode.seasonIndex,
      episodeIndex: episode.episodeIndex,
      episodeTitle: episode.episodeTitle,
    },
  };
}

function planKey(plan: EpisodePlan): string {
  return plan.episode.episodeRatingKey;
}

export function initialSeasonSelectionKeys(keys: readonly string[]): Set<string> {
  return new Set(keys.slice(0, MAX_SEASON_CLEANUP_EPISODES));
}

export function initialIndividualSelectionKeys(): Set<string> {
  return new Set();
}

export function seasonProfileSelection(
  profile: SeasonVersionProfile,
  episodeRatingKeys: readonly string[],
): { selected: Set<string>; deleteMediaIds: Map<string, number[]> } {
  const eligible = new Set(episodeRatingKeys);
  const selected = new Set<string>();
  const deleteMediaIds = new Map<string, number[]>();
  for (const member of profile.members) {
    if (!eligible.has(member.episodeRatingKey)) continue;
    selected.add(member.episodeRatingKey);
    deleteMediaIds.set(member.episodeRatingKey, [member.mediaId]);
  }
  return { selected, deleteMediaIds };
}

export function seasonProfilesDeletionPlan(
  profiles: readonly SeasonVersionProfile[],
  selectedProfileIds: ReadonlySet<string>,
  episodes: readonly DuplicateEpisodeGroup[],
): { selected: Set<string>; deleteMediaIds: Map<string, number[]>; safe: boolean } {
  const versionsByEpisode = new Map(
    episodes.map((episode) => [
      episode.episodeRatingKey,
      new Set(episode.versions.map((version) => version.mediaId)),
    ]),
  );
  const deleteSets = new Map<string, Set<number>>();
  let safe = true;
  for (const profile of profiles) {
    if (!selectedProfileIds.has(profile.id)) continue;
    for (const member of profile.members) {
      const available = versionsByEpisode.get(member.episodeRatingKey);
      if (!available) continue;
      if (!available.has(member.mediaId)) {
        safe = false;
        continue;
      }
      const ids = deleteSets.get(member.episodeRatingKey) ?? new Set<number>();
      ids.add(member.mediaId);
      deleteSets.set(member.episodeRatingKey, ids);
    }
  }
  const deleteMediaIds = new Map<string, number[]>();
  for (const [episodeRatingKey, ids] of deleteSets) {
    const available = versionsByEpisode.get(episodeRatingKey)!;
    if (ids.size >= available.size) safe = false;
    deleteMediaIds.set(episodeRatingKey, [...ids].sort((left, right) => left - right));
  }
  return { selected: new Set(deleteMediaIds.keys()), deleteMediaIds, safe };
}

function initialSelection(_plans: readonly EpisodePlan[]): Set<string> {
  // Individual review is the fail-closed escape hatch for ambiguous episodes.
  return initialIndividualSelectionKeys();
}

export function SeasonDuplicateDialog({
  dialogRef,
  season,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  season: DuplicateSeasonGroup | null;
  pending: boolean;
  error: unknown;
  onConfirm: (request: {
    selections: Array<{ ratingKey: string; deleteMediaIds: number[] }>;
    analysisFingerprint: string;
    expiresAt: number;
    coordinateSonarr: boolean;
    cleanupDownloads: boolean;
  }) => void;
  onClose: () => void;
}) {
  const seasonKey = season ? `${season.showRatingKey}:${season.seasonRatingKey}` : "none";
  const analysisEpisodeKeys = useMemo(
    () =>
      season?.episodes.slice(0, MAX_SEASON_CLEANUP_EPISODES).map((episode) =>
        episode.episodeRatingKey
      ) ?? [],
    [seasonKey, season?.episodes],
  );
  const analysis = useQuery({
    queryKey: queryKeys.duplicates.seasonAnalysis(
      season?.seasonRatingKey ?? "none",
      analysisEpisodeKeys,
    ),
    queryFn: () =>
      api.duplicates.analyzeSeasonVersions(
        season!.seasonRatingKey,
        analysisEpisodeKeys,
        season!.duplicateGroupCount,
      ),
    enabled: season !== null && analysisEpisodeKeys.length > 0,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const analyzedEpisodes = analysis.data?.episodes ??
    season?.episodes.slice(0, MAX_SEASON_CLEANUP_EPISODES) ?? [];
  const plans = useMemo(
    () => analyzedEpisodes.map(recommendationFor),
    [analyzedEpisodes, seasonKey],
  );
  const episodeIndexByRatingKey = useMemo(
    () =>
      new Map(
        analyzedEpisodes.map((episode) => [episode.episodeRatingKey, episode.episodeIndex]),
      ),
    [analyzedEpisodes, seasonKey],
  );
  const [selectedState, setSelectedState] = useState<{ key: string; ids: Set<string> }>({
    key: seasonKey,
    ids: initialSelection(plans),
  });
  const [keepersState, setKeepersState] = useState<{
    key: string;
    values: Map<string, number>;
  }>({
    key: seasonKey,
    values: new Map(plans.map((plan) => [planKey(plan), plan.candidate.keepMediaId])),
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mode, setMode] = useState<ReviewMode>("profiles");
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<string>>(new Set());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [coordinateSonarr, setCoordinateSonarr] = useState(false);
  const [cleanupDownloads, setCleanupDownloads] = useState(false);
  const [destinationAvailability, setDestinationAvailability] = useState({
    key: seasonKey,
    sonarr: false,
    qbittorrent: false,
  });
  const [filter, setFilter] = useState<EpisodeFilter>("all");
  const allCheckboxRef = useRef<HTMLInputElement>(null);
  const initializedSeasonKeyRef = useRef<string | null>(null);
  const selected = selectedState.key === seasonKey ? selectedState.ids : initialSelection(plans);
  const keepers = keepersState.key === seasonKey
    ? keepersState.values
    : new Map(plans.map((plan) => [planKey(plan), plan.candidate.keepMediaId]));

  useLayoutEffect(() => {
    if (season && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [dialogRef, season]);

  useEffect(() => {
    if (initializedSeasonKeyRef.current === seasonKey) return;
    initializedSeasonKeyRef.current = seasonKey;
    setSelectedState({ key: seasonKey, ids: initialSelection(plans) });
    setKeepersState({
      key: seasonKey,
      values: new Map(plans.map((plan) => [planKey(plan), plan.candidate.keepMediaId])),
    });
    setExpanded(null);
    setMode("profiles");
    setSelectedProfileIds(new Set());
    setPreviewOpen(false);
    setCoordinateSonarr(false);
    setCleanupDownloads(false);
    setDestinationAvailability({ key: seasonKey, sonarr: false, qbittorrent: false });
    setFilter("all");
  }, [plans, seasonKey]);

  function toggleProfile(profile: SeasonVersionProfile) {
    const next = new Set(selectedProfileIds);
    if (next.has(profile.id)) next.delete(profile.id);
    else next.add(profile.id);
    const nextPlan = seasonProfilesDeletionPlan(
      analysis.data?.profiles ?? [],
      next,
      analyzedEpisodes,
    );
    if (!nextPlan.safe) return;
    setSelectedProfileIds(next);
    if (next.size === 0) setPreviewOpen(false);
    setExpanded(null);
  }

  function changeMode(nextMode: ReviewMode) {
    setMode(nextMode);
    setSelectedProfileIds(new Set());
    setPreviewOpen(false);
    setSelectedState({ key: seasonKey, ids: new Set() });
    setKeepersState({
      key: seasonKey,
      values: new Map(plans.map((plan) => [planKey(plan), plan.candidate.keepMediaId])),
    });
    setExpanded(null);
  }

  const selectableEpisodeCount = Math.min(plans.length, MAX_SEASON_CLEANUP_EPISODES);
  const allSelected = selectableEpisodeCount > 0 && selected.size === selectableEpisodeCount;
  useEffect(() => {
    if (allCheckboxRef.current) {
      allCheckboxRef.current.indeterminate = selected.size > 0 && !allSelected;
    }
  }, [allSelected, selected.size]);

  const profilePlan = seasonProfilesDeletionPlan(
    analysis.data?.profiles ?? [],
    selectedProfileIds,
    analyzedEpisodes,
  );
  const analysisComplete = (analysis.data?.omittedEpisodeCount ?? 0) === 0;
  const selectedEpisodeKeys = mode === "profiles" ? profilePlan.selected : selected;
  const selectedPlans = plans.filter((plan) => selectedEpisodeKeys.has(planKey(plan)));
  const profileDeleteIds = profilePlan.deleteMediaIds;
  const visiblePlans = plans.filter((plan) => {
    if (filter === "all") return true;
    if (filter === "different" || filter === "same-profile" || filter === "unknown") {
      return plan.comparison.kind === filter;
    }
    return plan.comparison.differenceCodes.includes(filter);
  });
  const selections = selectedPlans.map((plan) => {
    if (mode === "profiles") {
      return {
        ratingKey: plan.episode.episodeRatingKey,
        deleteMediaIds: profileDeleteIds.get(planKey(plan)) ?? [],
      };
    }
    const keepMediaId = keepers.get(planKey(plan)) ?? plan.candidate.keepMediaId;
    return {
      ratingKey: plan.episode.episodeRatingKey,
      deleteMediaIds: plan.episode.versions
        .filter((version) => version.mediaId !== keepMediaId)
        .map((version) => version.mediaId)
        .sort((left, right) => left - right),
    };
  });
  const authorizationKey = seasonDeletionAuthorizationKey(selections);
  const authorizationKeyRef = useRef(authorizationKey);
  useEffect(() => {
    if (authorizationKeyRef.current === authorizationKey) return;
    authorizationKeyRef.current = authorizationKey;
  }, [authorizationKey]);
  const deleteVersionCount = selections.reduce(
    (total, selection) => total + selection.deleteMediaIds.length,
    0,
  );
  const deletedVersions = selectedPlans.flatMap((plan) => {
    if (mode === "profiles") {
      const deleteIds = new Set(profileDeleteIds.get(planKey(plan)) ?? []);
      return plan.episode.versions.filter((version) => deleteIds.has(version.mediaId));
    }
    const keepMediaId = keepers.get(planKey(plan)) ?? plan.candidate.keepMediaId;
    return plan.episode.versions.filter((version) => version.mediaId !== keepMediaId);
  });
  const reclaimable = deletedVersions.every((version) => version.fileSize !== null)
    ? deletedVersions.reduce((total, version) => total + version.fileSize!, 0)
    : null;
  const deletionPreview = useQuery({
    queryKey: [
      "duplicates",
      "season-deletion-preview",
      season?.seasonRatingKey ?? "none",
      selections,
      coordinateSonarr,
      cleanupDownloads,
    ],
    queryFn: () =>
      api.duplicates.seasonDeletionPreview(
        season!.seasonRatingKey,
        selections.map((selection) => ({
          episodeRatingKey: selection.ratingKey,
          mediaIds: selection.deleteMediaIds,
        })),
        { coordinateSonarr, cleanupDownloads },
      ),
    enabled: season !== null && selections.length > 0 && analysisComplete,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!deletionPreview.data) return;
    setDestinationAvailability({
      key: seasonKey,
      sonarr: deletionPreview.data.sonarrConfigured,
      qbittorrent: deletionPreview.data.cleanupConfigured,
    });
  }, [deletionPreview.data, seasonKey]);
  if (!season) return <dialog ref={dialogRef} className="modal" onClose={onClose} />;

  async function confirmWithFreshPreview() {
    const preview = await refreshExpiredSeasonDeletionPreview(
      deletionPreview.data,
      deletionPreview.refetch,
    );
    if (!preview) return;
    onConfirm({
      selections,
      analysisFingerprint: preview.fingerprint,
      expiresAt: preview.expiresAt,
      coordinateSonarr,
      cleanupDownloads,
    });
  }

  function toggleEpisode(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else if (next.size < MAX_SEASON_CLEANUP_EPISODES) next.add(key);
    setSelectedState({ key: seasonKey, ids: next });
  }

  function setAll(checked: boolean) {
    setSelectedState({
      key: seasonKey,
      ids: checked ? initialSelection(plans) : new Set(),
    });
  }

  function setKeeper(key: string, mediaId: number) {
    const next = new Map(keepers);
    next.set(key, mediaId);
    setKeepersState({ key: seasonKey, values: next });
  }

  const destinationPreview = selections.length > 0 &&
    (deletionPreview.isLoading || deletionPreview.isError ||
      (deletionPreview.data?.automaticAdoptionCount ?? 0) > 0) &&
    (
      <div className="season-profile-note" aria-live="polite">
        {deletionPreview.isLoading && "Verifying Plex and Sonarr destinations…"}
        {deletionPreview.isError && (
          <span className="text-error">
            {deletionPreview.error instanceof Error
              ? deletionPreview.error.message
              : "Authoritative preview failed"}
          </span>
        )}
        {coordinateSonarr && deletionPreview.data &&
          deletionPreview.data.automaticAdoptionCount > 0 && (
          <span className="badge badge-info">
            Sonarr adopts {deletionPreview.data.automaticAdoptionCount}
          </span>
        )}
      </div>
    );

  const destinationOptions = (
    <DestinationOptions
      options={[
        ...(destinationAvailability.key === seasonKey && destinationAvailability.sonarr
          ? [{
            id: "arr" as const,
            service: "sonarr" as const,
            label: "Delete through Sonarr",
            info:
              "Let Sonarr coordinate managed files. If a selected version is not managed by Sonarr, deletion safely falls back to Plex.",
            checked: coordinateSonarr,
            disabled: pending || deletionPreview.isFetching,
            warning: false,
            onChange: (checked: boolean) => {
              setCoordinateSonarr(checked);
              if (!checked) setCleanupDownloads(false);
            },
          }]
          : []),
        ...(destinationAvailability.key === seasonKey && destinationAvailability.qbittorrent
          ? [{
            id: "cleanup" as const,
            service: "qbittorrent" as const,
            label: "Delete downloads",
            info:
              "Delete only qBittorrent jobs and files that can be matched exactly to selected versions.",
            checked: cleanupDownloads,
            disabled: pending || deletionPreview.isFetching || !coordinateSonarr,
            warning: cleanupDownloads &&
              (deletionPreview.data?.cleanupEligibleVersionCount ?? 0) === 0,
            onChange: setCleanupDownloads,
          }]
          : []),
      ]}
    />
  );

  return (
    <dialog
      ref={dialogRef}
      className="modal season-batch-dialog"
      onClose={onClose}
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      <div className="modal-box polished-modal season-batch-modal max-w-4xl p-0">
        <header className="season-batch-header">
          <span className="season-batch-header-icon">
            <Layers3 className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-primary/70">
              {season.showTitle}
            </div>
            <h2 className="mt-1 text-xl font-bold">
              Delete a Season {season.seasonIndex} version
            </h2>
            <p className="mt-1 text-sm text-base-content/55">
              {season.duplicateGroupCount}{" "}
              {season.duplicateGroupCount === 1 ? "episode" : "episodes"} with multiple versions
            </p>
            {(season.comparisonSummary.sameProfileEpisodeCount > 0 ||
              season.comparisonSummary.needsReviewEpisodeCount > 0) && (
              <p className="season-batch-header-summary">
                {season.comparisonSummary.sameProfileEpisodeCount > 0 && (
                  <span>{season.comparisonSummary.sameProfileEpisodeCount} matching profiles</span>
                )}
                {season.comparisonSummary.needsReviewEpisodeCount > 0 && (
                  <span>{season.comparisonSummary.needsReviewEpisodeCount} need review</span>
                )}
              </p>
            )}
          </div>
        </header>

        <div className="season-batch-body">
          <div className="season-batch-toolbar season-batch-toolbar-actions">
            <div
              className="join season-batch-mode"
              role="group"
              aria-label="Deletion selection view"
            >
              {([
                ["profiles", "Season versions"],
                ["episodes", "Episode versions"],
              ] as const).map(([candidate, label]) => (
                <button
                  key={candidate}
                  type="button"
                  className={`join-item btn btn-xs h-6 min-h-0 border-0 px-2.5 ${
                    mode === candidate
                      ? "bg-base-100 text-base-content shadow-sm"
                      : "bg-transparent text-base-content/45 shadow-none"
                  }`}
                  aria-pressed={mode === candidate}
                  onClick={() => candidate !== mode && changeMode(candidate)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {(analysis.data?.omittedEpisodeCount ?? 0) > 0 && (
            <div className="alert alert-warning text-sm" role="alert">
              Season-version deletion is unavailable because this season exceeds the 50-episode
              analysis limit. No partial lane will be deleted. Switch to Episode versions for a
              narrower cleanup.
            </div>
          )}

          {mode === "profiles"
            ? (
              <div className="season-profile-panel">
                {analysis.isLoading && (
                  <div className="season-profile-loading" role="status">
                    <span className="loading loading-spinner loading-sm" />
                    Analyzing season versions…
                  </div>
                )}
                {analysis.isError && (
                  <ErrorAlert
                    message={analysis.error instanceof Error
                      ? analysis.error.message
                      : "Season versions could not be analyzed"}
                    onRetry={() => analysis.refetch()}
                  />
                )}
                {analysis.data && analysis.data.profiles.length === 0 && (
                  <div className="season-profile-empty">
                    No repeating season-wide versions could be identified safely. Use Individual
                    episodes to review these files.
                  </div>
                )}
                {analysisComplete && analysis.data && (
                  <div className="season-profile-lanes">
                    {analysis.data.profiles.map((profile) => {
                      const active = selectedProfileIds.has(profile.id);
                      const coveragePercent = plans.length === 0
                        ? 0
                        : Math.min(100, (profile.coverageCount / plans.length) * 100);
                      const coverage = episodeCoverageLabel(
                        profile.members.flatMap((member) => {
                          const episodeIndex = episodeIndexByRatingKey.get(member.episodeRatingKey);
                          return episodeIndex === undefined ? [] : [episodeIndex];
                        }),
                      );
                      const candidateIds = new Set(selectedProfileIds);
                      candidateIds.add(profile.id);
                      const unsafe = !active && !seasonProfilesDeletionPlan(
                        analysis.data.profiles,
                        candidateIds,
                        analyzedEpisodes,
                      ).safe;
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          className={`season-profile-card ${active ? "is-selected" : ""}`}
                          aria-pressed={active}
                          aria-label={`${
                            active ? "Do not delete" : "Delete"
                          } ${profile.label} from ${coverage.full}${
                            profile.technicalVariantCount > 1
                              ? `, ${profile.technicalVariantCount} technical variants`
                              : ""
                          }`}
                          disabled={unsafe}
                          title={unsafe
                            ? "Selecting this lane would remove every version from at least one episode"
                            : coverage.truncated
                            ? `Episodes ${coverage.full}`
                            : undefined}
                          onClick={() => toggleProfile(profile)}
                        >
                          <span className="season-profile-radio" aria-hidden="true">
                            {active ? "✓" : ""}
                          </span>
                          <span className="season-profile-copy">
                            <span className="season-profile-heading">
                              <strong>{profile.label}</strong>
                              {profile.technicalVariantCount > 1 && (
                                <HoverPopover
                                  anchorClassName="inline-flex shrink-0"
                                  content={
                                    <div className="space-y-1.5">
                                      <strong className="block">
                                        {profile.technicalVariantCount}{" "}
                                        technical variants in this lane
                                      </strong>
                                      <p className="text-base-content/70">
                                        These {profile.coverageCount} files resolve to{" "}
                                        {profile.technicalVariantCount}{" "}
                                        exact Plex technical signatures. Their combined technical
                                        and filename/path evidence still makes them the best match
                                        for one season version.
                                      </p>
                                      <p className="text-base-content/55">
                                        Minor metadata can vary between episodes. Each episode
                                        contributes at most one file to this lane.
                                      </p>
                                    </div>
                                  }
                                >
                                  <span className="season-profile-variants">
                                    {profile.technicalVariantCount} variants
                                  </span>
                                </HoverPopover>
                              )}
                            </span>
                            <small>
                              {profile.audioSummary.length > 0
                                ? profile.audioSummary.join(", ")
                                : "Audio details unavailable"}
                              {profile.subtitleSummary.length > 0
                                ? ` · ${profile.subtitleSummary.length} subtitle track${
                                  profile.subtitleSummary.length === 1 ? "" : "s"
                                }`
                                : ""}
                            </small>
                            <span className="season-profile-coverage">
                              <span className="season-profile-coverage-range" title={coverage.full}>
                                {coverage.compact}
                              </span>
                              <span className="season-profile-coverage-meter" aria-hidden="true">
                                <span style={{ width: `${coveragePercent}%` }} />
                              </span>
                              <span className="season-profile-coverage-count">
                                {profile.coverageCount} / {plans.length} episodes
                              </span>
                              <span className="season-profile-size">
                                {profile.totalFileSize === null
                                  ? "Unknown size"
                                  : formatKilobytes(profile.totalFileSize)}
                              </span>
                            </span>
                          </span>
                          <span className="season-profile-guard">
                            {unsafe && (
                              <span className="badge badge-ghost badge-sm">Must keep one</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {selectedProfileIds.size > 0 && (
                  <div
                    className={`season-version-preview ${previewOpen ? "is-open" : ""}`}
                  >
                    <button
                      type="button"
                      className="season-version-preview-summary"
                      aria-expanded={previewOpen}
                      onClick={(event) => {
                        const nextOpen = !previewOpen;
                        const panel = event.currentTarget.parentElement;
                        setPreviewOpen(nextOpen);
                        let scroller = panel?.parentElement ?? null;
                        while (scroller) {
                          const overflowY = globalThis.getComputedStyle(scroller).overflowY;
                          if (overflowY === "auto" || overflowY === "scroll") break;
                          scroller = scroller.parentElement;
                        }
                        if (!nextOpen || !scroller) {
                          return;
                        }
                        const reducedMotion = globalThis.matchMedia(
                          "(prefers-reduced-motion: reduce)",
                        ).matches;
                        const reveal = () => {
                          scroller.scrollTop = Math.max(
                            0,
                            scroller.scrollHeight - scroller.clientHeight,
                          );
                        };
                        if (reducedMotion) {
                          globalThis.requestAnimationFrame(reveal);
                          return;
                        }
                        let startedAt: number | null = null;
                        const followExpansion = (timestamp: number) => {
                          startedAt ??= timestamp;
                          reveal();
                          if (timestamp - startedAt < 240) {
                            globalThis.requestAnimationFrame(followExpansion);
                          }
                        };
                        globalThis.requestAnimationFrame(followExpansion);
                      }}
                    >
                      <ChevronDown
                        className={`size-3.5 transition-transform ${
                          previewOpen ? "rotate-180" : ""
                        }`}
                      />
                      <span>
                        Preview {selectedPlans.length} affected{" "}
                        {selectedPlans.length === 1 ? "episode" : "episodes"}
                      </span>
                    </button>
                    <div className="season-version-preview-content" aria-hidden={!previewOpen}>
                      <div className="season-version-preview-clip">
                        <div className="season-version-preview-list">
                          {selectedPlans.map((plan) => {
                            const mediaIds = new Set(profileDeleteIds.get(planKey(plan)) ?? []);
                            const versions = plan.episode.versions.filter((item) =>
                              mediaIds.has(item.mediaId)
                            );
                            const size = versions.every((version) => version.fileSize !== null)
                              ? versions.reduce((total, version) => total + version.fileSize!, 0)
                              : null;
                            return (
                              <div key={planKey(plan)} className="season-version-preview-row">
                                <span>
                                  E{String(plan.episode.episodeIndex).padStart(2, "0")} —{" "}
                                  {plan.episode.episodeTitle}
                                </span>
                                <span>
                                  {versions.length > 0
                                    ? versions.map(versionLabel).join(" + ")
                                    : "Version unavailable"}
                                </span>
                                <strong>
                                  {size === null ? "Unknown" : formatKilobytes(size)}
                                </strong>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {destinationPreview}
              </div>
            )
            : (
              <>
                <div className="season-batch-individual-toolbar">
                  <label className="season-batch-select-all">
                    <input
                      ref={allCheckboxRef}
                      type="checkbox"
                      className="checkbox checkbox-sm checkbox-primary"
                      checked={allSelected}
                      aria-checked={selected.size > 0 && !allSelected ? "mixed" : allSelected}
                      onChange={(event) => setAll(event.currentTarget.checked)}
                    />
                    <span>{selected.size} of {plans.length} selected</span>
                  </label>
                  <label className="season-batch-filter">
                    <span className="sr-only">Filter episodes by technical comparison</span>
                    <select
                      className="select select-bordered select-xs"
                      value={filter}
                      onChange={(event) => setFilter(event.currentTarget.value as EpisodeFilter)}
                      aria-label="Filter episodes by technical comparison"
                    >
                      <option value="all">All episodes</option>
                      <option value="different">With differences</option>
                      <option value="unknown">Needs review</option>
                      <option value="same-profile">Matching profiles</option>
                      {season.comparisonSummary.differences.map((difference) => (
                        <option key={difference.code} value={difference.code}>
                          {difference.code.replaceAll("-", " ")} ({difference.episodeCount})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {filter !== "all" && (
                  <div className="season-batch-filter-status" role="status">
                    Showing {visiblePlans.length} of {plans.length}{" "}
                    episodes. Selection is unchanged.
                    <button type="button" className="link" onClick={() => setFilter("all")}>
                      Clear
                    </button>
                  </div>
                )}
                <div className="season-batch-list">
                  {visiblePlans.map((plan) => {
                    const key = planKey(plan);
                    const checked = selected.has(key);
                    const open = expanded === key;
                    const keepMediaId = keepers.get(key) ?? plan.candidate.keepMediaId;
                    const removed = plan.episode.versions.filter((version) =>
                      version.mediaId !== keepMediaId
                    );
                    const savings = removed.every((version) => version.fileSize !== null)
                      ? removed.reduce((total, version) => total + version.fileSize!, 0)
                      : null;
                    const activeCandidate = {
                      ...plan.candidate,
                      keepMediaId,
                      deleteMediaIds: removed.map((version) => version.mediaId),
                    };
                    return (
                      <div
                        key={key}
                        className={`season-batch-episode ${checked ? "is-selected" : ""}`}
                      >
                        <label className="season-batch-episode-toggle" title="Include this episode">
                          <input
                            type="checkbox"
                            className="checkbox checkbox-sm checkbox-primary"
                            checked={checked}
                            disabled={!checked && selected.size >= MAX_SEASON_CLEANUP_EPISODES}
                            onChange={() => toggleEpisode(key)}
                          />
                        </label>
                        <button
                          type="button"
                          className="season-batch-episode-summary"
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : key)}
                        >
                          <span className="season-batch-episode-copy">
                            <strong>
                              E{String(plan.episode.episodeIndex).padStart(2, "0")} —{" "}
                              {plan.episode.episodeTitle}
                            </strong>
                            <small>
                              Remove {removed.length} of {plan.episode.versions.length} · Keep{" "}
                              {versionLabel(
                                plan.episode.versions.find((version) =>
                                  version.mediaId === keepMediaId
                                )!,
                              )}
                            </small>
                          </span>
                          <span className={`season-batch-comparison is-${plan.comparison.kind}`}>
                            {plan.comparison.kind === "same-profile"
                              ? "Likely equivalent"
                              : plan.comparison.kind === "different"
                              ? "Differences"
                              : "Needs review"}
                          </span>
                          <span className="season-batch-savings">
                            {savings === null ? "Unknown" : formatKilobytes(savings)}
                          </span>
                          <ChevronDown
                            className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
                          />
                        </button>
                        {open && (
                          <div className="season-batch-episode-details">
                            <CandidateFileDetails
                              candidate={activeCandidate}
                              keepMediaId={keepMediaId}
                              onKeepChange={(mediaId) => setKeeper(key, mediaId)}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

          {mode === "episodes" && destinationPreview}

          {destinationOptions}

          {cleanupDownloads && deletionPreview.data?.cleanupEligibleVersionCount === 0 && (
            <div className="alert alert-warning text-sm" role="alert">
              {deletionPreview.data.cleanupReason ??
                "No selected version has an exactly verified qBittorrent download association."}
            </div>
          )}

          {error !== null && error !== undefined && (
            <ErrorAlert
              message={error instanceof Error
                ? error.message
                : "Season cleanup could not be queued"}
              onRetry={confirmWithFreshPreview}
            />
          )}
        </div>

        <footer className="season-batch-footer">
          <div className="season-batch-total">
            <span>{selectedPlans.length} episodes · {deleteVersionCount} versions to delete</span>
            <strong>
              {reclaimable === null
                ? "Unknown savings"
                : `${formatKilobytes(reclaimable)} reclaimable`}
            </strong>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending}
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-error"
            disabled={seasonDeletionConfirmationDisabled({
              pending: pending || deletionPreview.isFetching,
              selectionCount: selections.length,
              mode,
              profileReady: !analysis.isLoading && selectedProfileIds.size > 0 &&
                analysisComplete && profilePlan.safe,
              previewLoading: deletionPreview.isLoading,
              previewError: deletionPreview.isError,
              previewAvailable: deletionPreview.data !== undefined,
              blockerCount: (deletionPreview.data?.blockers.length ?? 0) +
                (cleanupDownloads &&
                    (deletionPreview.data?.cleanupEligibleVersionCount ?? 0) === 0
                  ? 1
                  : 0),
            })}
            onClick={confirmWithFreshPreview}
          >
            {pending || deletionPreview.isFetching
              ? <span className="loading loading-spinner loading-sm" />
              : <Trash2 className="size-4" />}
            Delete {deleteVersionCount} {deleteVersionCount === 1 ? "version" : "versions"}
          </button>
        </footer>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit" disabled={pending}>close</button>
      </form>
    </dialog>
  );
}
