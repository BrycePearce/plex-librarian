import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { ChevronDown, Layers3, Trash2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { compareDuplicateVersions, summarizeDuplicateComparisons } from "@shared/mediaComparison";
import type { DuplicateDifferenceCode } from "@shared/mediaComparison";
import type {
  DuplicateEpisodeGroup,
  DuplicateSeasonGroup,
  SeasonDeletionPreviewResponse,
  SeasonVersionProfile,
  SmartDuplicateEpisodeCandidate,
} from "../../lib/api.ts";
import { api, ApiError } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { versionLabel } from "../../lib/mediaVersion.ts";
import { ErrorAlert } from "../../components/ErrorAlert.tsx";
import { HoverPopover } from "../../components/HoverPopover.tsx";
import { ServiceIcon } from "../../components/ServiceIcons.tsx";
import { CandidateFileDetails } from "../../features/quickCleanup/CandidateFileDetails.tsx";
import { DestinationOptions } from "../../features/mediaDeletion/DeletionPlanSummary.tsx";
import { largestVersionId } from "./versionDeletionState.ts";

type ReviewMode = "profiles" | "episodes";

export function seasonDeletionConflictOperationId(error: unknown): string | null {
  return error instanceof ApiError && error.code === "DELETION_CONFLICT" && error.operationId
    ? error.operationId
    : null;
}

export function seasonDownloadCleanupVisible(
  preview: { cleanupConfigured: boolean; cleanupEligibleVersionCount: number } | undefined,
): boolean {
  return preview?.cleanupConfigured === true && preview.cleanupEligibleVersionCount > 0;
}

function LaneDestinationMark({
  service,
  count,
  total,
}: {
  service: "sonarr" | "qbittorrent";
  count: number;
  total: number;
}) {
  if (count === 0) return null;
  const name = service === "sonarr" ? "Sonarr" : "qBittorrent";
  const action = service === "sonarr" ? "manages" : "is seeding";
  return (
    <HoverPopover
      anchorClassName="inline-flex shrink-0"
      content={
        <div className="space-y-1">
          <strong className="block">{name}</strong>
          <p className="text-base-content/70">
            {count === total
              ? `${name} ${action} this season version.`
              : `${name} ${action} ${count} of this version's ${total} files.`}
          </p>
        </div>
      }
    >
      <span
        className="season-profile-service-mark"
        role="img"
        tabIndex={0}
        aria-label={`${name} ${action} this season version`}
      >
        <ServiceIcon service={service} className="size-4" />
      </span>
    </HoverPopover>
  );
}

export function seasonSonarrVisible(
  authorizationKey: string,
  availability: { key: string; sonarr: boolean } | undefined,
): boolean {
  return availability?.key === authorizationKey && availability.sonarr;
}

export function seasonDestinationChoice(
  authorizationKey: string,
  choice: {
    key: string;
    sonarrMode: "none" | "adopt_retained" | "remove_and_unmonitor";
    cleanupDownloads: boolean;
  },
): {
  sonarrMode: "none" | "adopt_retained" | "remove_and_unmonitor";
  cleanupDownloads: boolean;
} {
  return choice.key === authorizationKey
    ? {
      sonarrMode: choice.sonarrMode,
      cleanupDownloads: choice.cleanupDownloads,
    }
    : { sonarrMode: "none", cleanupDownloads: false };
}

export function seasonChoiceWithoutSonarr(
  authorizationKey: string,
  choice: {
    key: string;
    sonarrMode: "none" | "adopt_retained" | "remove_and_unmonitor";
    cleanupDownloads: boolean;
  },
): { key: string; sonarrMode: "none"; cleanupDownloads: boolean } {
  return {
    key: authorizationKey,
    sonarrMode: "none",
    cleanupDownloads: choice.key === authorizationKey && choice.cleanupDownloads,
  };
}

export function seasonBreakGlassVisible(
  preview: SeasonDeletionPreviewResponse | undefined,
  sonarrMode: "none" | "adopt_retained" | "remove_and_unmonitor",
): boolean {
  return preview?.breakGlassAvailable === true ||
    (sonarrMode === "remove_and_unmonitor" &&
      (preview?.removedAndUnmonitoredCount ?? 0) > 0);
}

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

export async function refreshAuthorizedSeasonDeletionPreview<T extends { expiresAt: number }>(
  preview: T | undefined,
  refetch: () => Promise<{ data?: T }>,
  acceptedSubmissionKey: string,
  currentSubmissionKey: () => string,
): Promise<T | undefined> {
  const refreshed = await refreshExpiredSeasonDeletionPreview(preview, refetch);
  return currentSubmissionKey() === acceptedSubmissionKey ? refreshed : undefined;
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

export function countedLabels(labels: readonly string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count }));
}

export function seasonLaneMatchBasisLabel(
  basis: SeasonVersionProfile["matchBasis"],
): string {
  switch (basis) {
    case "release-root":
      return "Folder matched";
    case "filename-family":
      return "Filename matched";
    case "mixed":
      return "Mixed evidence";
    case "technical-only":
      return "Technical match";
  }
}

interface SeasonLanePathEntry {
  episodeRatingKey: string;
  episodeIndex: number | null;
  filePath: string | null;
}

export interface SeasonLanePathGroup {
  directory: string;
  files: Array<SeasonLanePathEntry & { filename: string }>;
}

export function groupSeasonLanePaths(
  entries: readonly SeasonLanePathEntry[],
): SeasonLanePathGroup[] {
  const groups = new Map<string, SeasonLanePathGroup>();
  for (const entry of entries) {
    if (!entry.filePath) continue;
    const originalPath = entry.filePath.trim();
    const separator = Math.max(originalPath.lastIndexOf("/"), originalPath.lastIndexOf("\\"));
    const directory = separator >= 0 ? originalPath.slice(0, separator) || "/" : "No folder";
    const filename = separator >= 0 ? originalPath.slice(separator + 1) : originalPath;
    const directoryKey = directory.replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase();
    const group = groups.get(directoryKey) ?? { directory, files: [] };
    group.files.push({ ...entry, filePath: originalPath, filename });
    groups.set(directoryKey, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    files: group.files.sort((left, right) =>
      (left.episodeIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.episodeIndex ?? Number.MAX_SAFE_INTEGER) ||
      left.episodeRatingKey.localeCompare(right.episodeRatingKey)
    ),
  })).sort((left, right) => left.directory.localeCompare(right.directory));
}

function LanePathsPopover({
  profile,
  episodeIndexByRatingKey,
}: {
  profile: SeasonVersionProfile;
  episodeIndexByRatingKey: ReadonlyMap<string, number>;
}) {
  const entries = profile.members.map((member) => ({
    episodeRatingKey: member.episodeRatingKey,
    episodeIndex: episodeIndexByRatingKey.get(member.episodeRatingKey) ?? null,
    filePath: member.filePath ?? null,
  }));
  const groups = groupSeasonLanePaths(entries);
  const pathCount = groups.reduce((total, group) => total + group.files.length, 0);
  const missing = entries.filter((entry) => entry.filePath === null);
  const label = pathCount === entries.length
    ? `${pathCount} path${pathCount === 1 ? "" : "s"}`
    : `${pathCount} / ${entries.length} paths`;

  return (
    <HoverPopover
      openOnClick
      interactive
      anchorClassName="inline-flex shrink-0"
      popoverAriaLabel="Season version paths"
      popoverClassName="season-profile-path-popover"
      content={
        <div>
          <div className="season-profile-path-popover-header">
            <strong>{pathCount} file{pathCount === 1 ? "" : "s"}</strong>
            <span>{groups.length} folder{groups.length === 1 ? "" : "s"}</span>
          </div>
          <div className="season-profile-path-groups">
            {groups.map((group) => (
              <section key={group.directory}>
                <code title={group.directory}>{group.directory}</code>
                <ul>
                  {group.files.map((file) => (
                    <li key={`${file.episodeRatingKey}:${file.filename}`}>
                      <b>
                        {file.episodeIndex === null
                          ? "Episode"
                          : `E${String(file.episodeIndex).padStart(2, "0")}`}
                      </b>
                      <span title={file.filePath ?? undefined}>{file.filename}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {missing.length > 0 && (
              <section className="season-profile-path-missing">
                <strong>Path unavailable</strong>
                <p>
                  {missing.map((entry) =>
                    entry.episodeIndex === null
                      ? entry.episodeRatingKey
                      : `E${String(entry.episodeIndex).padStart(2, "0")}`
                  ).join(", ")}
                </p>
              </section>
            )}
          </div>
        </div>
      }
    >
      <button
        type="button"
        className={`season-profile-tag season-profile-path-tag ${
          missing.length > 0 || groups.length > 1 ? "has-warning" : ""
        }`}
        aria-label={`Inspect ${label} across ${groups.length} folder${
          groups.length === 1 ? "" : "s"
        }`}
      >
        {label}
      </button>
    </HoverPopover>
  );
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
    previewFingerprint: string;
    sonarrMode: "none" | "adopt_retained" | "remove_and_unmonitor";
    cleanupDownloads: boolean;
  }) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
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
  const comparisonSummary = analysis.data
    ? summarizeDuplicateComparisons(plans.map((plan) => plan.comparison))
    : season?.comparisonSummary;
  const episodeIndexByRatingKey = useMemo(
    () =>
      new Map(
        analyzedEpisodes.map((episode) => [episode.episodeRatingKey, episode.episodeIndex]),
      ),
    [analyzedEpisodes, seasonKey],
  );
  const profilePathByMember = useMemo(
    () =>
      new Map(
        (analysis.data?.profiles ?? []).flatMap((profile) =>
          profile.members.map((member) =>
            [
              `${member.episodeRatingKey}:${member.mediaId}`,
              member.filePath,
            ] as const
          )
        ),
      ),
    [analysis.data?.profiles, seasonKey],
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
  const [confirmationRefreshing, setConfirmationRefreshing] = useState(false);
  const [destinationChoice, setDestinationChoice] = useState<{
    key: string;
    sonarrMode: "none" | "adopt_retained" | "remove_and_unmonitor";
    cleanupDownloads: boolean;
  }>({
    key: "",
    sonarrMode: "none",
    cleanupDownloads: false,
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
    setDestinationChoice({ key: "", sonarrMode: "none", cleanupDownloads: false });
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
  const { sonarrMode, cleanupDownloads } = seasonDestinationChoice(
    authorizationKey,
    destinationChoice,
  );
  const [destinationAvailability, setDestinationAvailability] = useState({
    key: authorizationKey,
    sonarr: false,
  });
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
  const deletionPreviewKey = useMemo(() =>
    [
      "duplicates",
      "season-deletion-preview",
      season?.seasonRatingKey ?? "none",
      selections,
      sonarrMode,
      cleanupDownloads,
    ] as const, [
    season?.seasonRatingKey,
    authorizationKey,
    sonarrMode,
    cleanupDownloads,
  ]);
  const deletionPreview = useQuery({
    queryKey: deletionPreviewKey,
    queryFn: () =>
      api.duplicates.seasonDeletionPreview(
        season!.seasonRatingKey,
        selections.map((selection) => ({
          episodeRatingKey: selection.ratingKey,
          mediaIds: selection.deleteMediaIds,
        })),
        { sonarrMode, cleanupDownloads },
      ),
    enabled: season !== null && selections.length > 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const submissionKey = JSON.stringify({
    seasonKey,
    authorizationKey,
    sonarrMode,
    cleanupDownloads,
  });
  const submissionKeyRef = useRef(submissionKey);
  submissionKeyRef.current = submissionKey;
  const submittedPreviewKeyRef = useRef(deletionPreviewKey);
  useEffect(() => {
    if (
      error instanceof ApiError && error.code === "PREVIEW_CHANGED" && error.preview
    ) {
      queryClient.setQueryData(submittedPreviewKeyRef.current, error.preview);
    }
  }, [error, queryClient]);
  useEffect(() => {
    if (!deletionPreview.data) return;
    setDestinationAvailability({
      key: authorizationKey,
      sonarr: deletionPreview.data.sonarrAvailable,
    });
    if (!deletionPreview.data.sonarrAvailable) {
      setDestinationChoice((current) => seasonChoiceWithoutSonarr(authorizationKey, current));
    }
  }, [authorizationKey, deletionPreview.data]);
  useEffect(() => {
    if (!deletionPreview.isError || deletionPreview.isFetching) return;
    setDestinationAvailability({ key: authorizationKey, sonarr: false });
    setDestinationChoice((current) => seasonChoiceWithoutSonarr(authorizationKey, current));
  }, [authorizationKey, deletionPreview.isError, deletionPreview.isFetching]);
  const cleanupEligibleVersionCount = deletionPreview.data?.cleanupEligibleVersionCount ?? 0;
  const breakGlassVisible = seasonBreakGlassVisible(deletionPreview.data, sonarrMode);
  useEffect(() => {
    if (deletionPreview.data && cleanupEligibleVersionCount === 0) {
      setDestinationChoice((current) => ({
        key: authorizationKey,
        sonarrMode: current.key === authorizationKey ? current.sonarrMode : "none",
        cleanupDownloads: false,
      }));
    }
  }, [authorizationKey, cleanupEligibleVersionCount, deletionPreview.data]);
  if (!season) return <dialog ref={dialogRef} className="modal" onClose={onClose} />;
  const conflictOperationId = seasonDeletionConflictOperationId(error);

  async function confirmWithFreshPreview() {
    const acceptedSubmissionKey = submissionKey;
    setConfirmationRefreshing(true);
    try {
      const preview = await refreshAuthorizedSeasonDeletionPreview(
        deletionPreview.data,
        deletionPreview.refetch,
        acceptedSubmissionKey,
        () => submissionKeyRef.current,
      );
      if (!preview) return;
      submittedPreviewKeyRef.current = deletionPreviewKey;
      onConfirm({
        selections,
        previewFingerprint: preview.fingerprint,
        sonarrMode,
        cleanupDownloads,
      });
    } finally {
      setConfirmationRefreshing(false);
    }
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
    (deletionPreview.isLoading ||
      (deletionPreview.data?.automaticAdoptionCount ?? 0) > 0 ||
      breakGlassVisible) &&
    (
      <div className="season-profile-note" aria-live="polite">
        {deletionPreview.isLoading && "Verifying Plex and Sonarr destinations…"}
        {sonarrMode !== "none" && deletionPreview.data &&
          deletionPreview.data.automaticAdoptionCount > 0 && (
          <div className="space-y-1">
            <span className="badge badge-info">
              Sonarr adopts {deletionPreview.data.automaticAdoptionCount}
            </span>
            {(deletionPreview.data.sonarrAdoptionTargets?.length ?? 0) > 0 && (
              <details open={deletionPreview.data.sonarrAdoptionTargets?.length === 1}>
                <summary className="cursor-pointer text-xs text-base-content/70">
                  Review exact import{" "}
                  {deletionPreview.data.sonarrAdoptionTargets?.length === 1 ? "target" : "targets"}
                </summary>
                <ul className="mt-1 space-y-1 text-xs text-base-content/65">
                  {deletionPreview.data.sonarrAdoptionTargets?.map((target) => (
                    <li key={target.episodeRatingKey} className="break-all">
                      <span className="font-medium">{target.episodeTitle}:</span> {target.path}
                      {target.fallbackCandidateCount > 0
                        ? ` · ${target.fallbackCandidateCount} other verified retained ${
                          target.fallbackCandidateCount === 1 ? "copy" : "copies"
                        } available to the guarded rescan fallback`
                        : " · guarded rescan remains available if exact import fails"}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {sonarrMode === "remove_and_unmonitor" && deletionPreview.data &&
          (deletionPreview.data.removedAndUnmonitoredCount ?? 0) > 0 && (
          <span className="badge badge-warning">
            Sonarr removes and unmonitors {deletionPreview.data.removedAndUnmonitoredCount}
          </span>
        )}
        {sonarrMode === "none" && deletionPreview.data?.breakGlassAvailable &&
          deletionPreview.data.adoptionUnavailableReason && (
          <span className="text-warning">
            {deletionPreview.data.adoptionUnavailableReason}
          </span>
        )}
      </div>
    );

  const destinationOptions = (
    <DestinationOptions
      options={[
        ...(seasonSonarrVisible(authorizationKey, destinationAvailability) &&
            deletionPreview.data?.breakGlassAvailable !== true
          ? [{
            id: "arr" as const,
            service: "sonarr" as const,
            label: "Sonarr",
            info:
              "For a Sonarr-managed episode file, Sonarr protects monitoring, removes only the old EpisodeFile, and first imports the exact retained path. A whole-series rescan is used only as a guarded fallback and may adopt another verified retained copy. Versions Sonarr does not manage are removed through Plex; the series itself is never removed.",
            checked: sonarrMode === "adopt_retained",
            disabled: pending || deletionPreview.isFetching,
            warning: false,
            onChange: (checked: boolean) => {
              setDestinationChoice({
                key: authorizationKey,
                sonarrMode: checked ? "adopt_retained" : "none",
                cleanupDownloads,
              });
            },
          }]
          : []),
        ...(seasonDownloadCleanupVisible(deletionPreview.data)
          ? [{
            id: "cleanup" as const,
            service: "qbittorrent" as const,
            label: "Delete from qBittorrent",
            info:
              `Deletes verified qBittorrent jobs and their downloaded files for ${cleanupEligibleVersionCount} selected ${
                cleanupEligibleVersionCount === 1 ? "version" : "versions"
              }. Unmatched downloads are left untouched.`,
            checked: cleanupDownloads,
            disabled: pending || deletionPreview.isFetching,
            warning: false,
            onChange: (checked: boolean) =>
              setDestinationChoice({
                key: authorizationKey,
                sonarrMode,
                cleanupDownloads: checked,
              }),
          }]
          : []),
        ...(breakGlassVisible
          ? [{
            id: "arr-break-glass" as const,
            service: "sonarr" as const,
            label: "Remove from Sonarr and unmonitor",
            info:
              "Break glass: episodes without an eligible retained path have only their exact managed EpisodeFile removed and remain permanently unmonitored. Eligible episodes still adopt a verified retained copy. The series is never removed.",
            checked: sonarrMode === "remove_and_unmonitor",
            disabled: pending || deletionPreview.isFetching,
            warning: true,
            onChange: (checked: boolean) => {
              if (
                checked && !globalThis.confirm(
                  "Permanently unmonitor each affected Sonarr episode that has no eligible retained path after removing its managed file? Eligible episodes will still adopt a verified retained copy.",
                )
              ) return;
              setDestinationChoice({
                key: authorizationKey,
                sonarrMode: checked ? "remove_and_unmonitor" : "none",
                cleanupDownloads,
              });
            },
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
        {(analysis.isError || deletionPreview.isError ||
          (deletionPreview.data?.blockers.length ?? 0) > 0 ||
          (error !== null && error !== undefined)) && (
          <div className="season-batch-alerts" aria-live="polite">
            {analysis.isError && (
              <ErrorAlert
                message={analysis.error instanceof Error
                  ? analysis.error.message
                  : "Season versions could not be analyzed"}
                onRetry={() => analysis.refetch()}
              />
            )}
            {deletionPreview.isError && (
              <ErrorAlert
                message={deletionPreview.error instanceof Error
                  ? deletionPreview.error.message
                  : "Authoritative preview failed"}
                onRetry={() => deletionPreview.refetch()}
              />
            )}
            {deletionPreview.data?.blockers.map((blocker, index) => (
              <div key={`${index}:${blocker}`} className="alert alert-warning text-sm" role="alert">
                {blocker}
              </div>
            ))}
            {deletionPreview.data?.sonarrInspectionWarning && (
              <div className="alert alert-warning text-sm" role="alert">
                {deletionPreview.data.sonarrInspectionWarning}
              </div>
            )}
            {error !== null && error !== undefined && (
              <div className="space-y-2">
                <ErrorAlert
                  message={error instanceof Error
                    ? error.message
                    : "Season cleanup could not be queued"}
                  onRetry={confirmWithFreshPreview}
                />
                {conflictOperationId && (
                  <Link
                    className="btn btn-sm btn-outline"
                    to="/deletion-operations/$id"
                    params={{ id: conflictOperationId }}
                  >
                    View conflicting deletion
                  </Link>
                )}
              </div>
            )}
          </div>
        )}

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
              {analysis.data?.analyzedEpisodeCount ?? season.duplicateGroupCount} duplicate{" "}
              {(analysis.data?.analyzedEpisodeCount ?? season.duplicateGroupCount) === 1
                ? "episode"
                : "episodes"}
              {season.totalEpisodeCount !== null && ` · ${season.totalEpisodeCount} total`}
            </p>
            {comparisonSummary &&
              (comparisonSummary.sameProfileEpisodeCount > 0 ||
                comparisonSummary.needsReviewEpisodeCount > 0) &&
              (
                <p className="season-batch-header-summary">
                  {comparisonSummary.sameProfileEpisodeCount > 0 && (
                    <span>{comparisonSummary.sameProfileEpisodeCount} matching profiles</span>
                  )}
                  {comparisonSummary.needsReviewEpisodeCount > 0 && (
                    <span>{comparisonSummary.needsReviewEpisodeCount} need review</span>
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

          {mode === "profiles"
            ? (
              <div className="season-profile-panel">
                {analysis.isLoading && (
                  <div className="season-profile-loading" role="status">
                    <span className="loading loading-spinner loading-sm" />
                    Analyzing season versions…
                  </div>
                )}
                {analysis.data && analysis.data.profiles.length === 0 && (
                  <div className="season-profile-empty">
                    No repeating season-wide versions could be identified safely. Use Individual
                    episodes to review these files.
                  </div>
                )}
                {analysis.data && (
                  <div className="season-profile-lanes">
                    {analysis.data.profiles.map((profile) => {
                      const active = selectedProfileIds.has(profile.id);
                      const subtitleLabels = countedLabels(profile.subtitleSummary);
                      const sourceLabel = profile.sourceHints.length === 1
                        ? profile.sourceHints[0]!
                        : profile.sourceHints.length > 1
                        ? `${profile.sourceHints.length} source folders`
                        : "Season version";
                      const coverageDenominator = Math.max(
                        season.totalEpisodeCount ?? 0,
                        plans.length,
                      );
                      const coveragePercent = coverageDenominator === 0
                        ? 0
                        : Math.min(100, (profile.coverageCount / coverageDenominator) * 100);
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
                        <div
                          key={profile.id}
                          className={`season-profile-card ${active ? "is-selected" : ""}`}
                        >
                          <button
                            type="button"
                            className="season-profile-toggle"
                            aria-pressed={active}
                            aria-label={`${active ? "Do not delete" : "Delete"} ${sourceLabel}`}
                            disabled={unsafe}
                            title={unsafe
                              ? "Selecting this lane would remove every version from at least one episode"
                              : undefined}
                            onClick={() => toggleProfile(profile)}
                          >
                            <span className="season-profile-radio" aria-hidden="true">
                              {active ? "✓" : ""}
                            </span>
                          </button>
                          <div
                            className="season-profile-select"
                            title={unsafe
                              ? "Selecting this lane would remove every version from at least one episode"
                              : coverage.truncated
                              ? `Episodes ${coverage.full}`
                              : undefined}
                          >
                            <span className="season-profile-copy">
                              <span className="season-profile-heading">
                                <strong title={profile.sourceHints.join(" · ")}>
                                  {sourceLabel}
                                </strong>
                                <span className="badge badge-ghost badge-xs">
                                  {seasonLaneMatchBasisLabel(profile.matchBasis)}
                                </span>
                              </span>
                              <small className="season-profile-technical" title={profile.label}>
                                {profile.label}
                              </small>
                              <small>
                                {profile.audioSummary.length > 0
                                  ? profile.audioSummary.join(", ")
                                  : "Audio details unavailable"}
                                {profile.subtitleSummary.length > 0 && (
                                  <>
                                    {" · "}
                                    <HoverPopover
                                      openOnClick
                                      anchorTabIndex={0}
                                      anchorClassName="inline-flex"
                                      content={
                                        <div className="space-y-1.5">
                                          <strong className="block">
                                            {profile.subtitleSummary.length}{" "}
                                            subtitle track{profile.subtitleSummary.length === 1
                                              ? ""
                                              : "s"}
                                          </strong>
                                          <ul className="space-y-0.5 text-base-content/70">
                                            {subtitleLabels.map(({ label, count }) => (
                                              <li key={label}>
                                                {label}
                                                {count > 1 ? ` ×${count}` : ""}
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      }
                                    >
                                      <span className="season-profile-subtitle-count">
                                        {profile.subtitleSummary.length}{" "}
                                        subtitle track{profile.subtitleSummary.length === 1
                                          ? ""
                                          : "s"}
                                      </span>
                                    </HoverPopover>
                                  </>
                                )}
                              </small>
                              <span className="season-profile-coverage">
                                <span
                                  className="season-profile-coverage-range"
                                  title={coverage.full}
                                >
                                  {coverage.compact}
                                </span>
                                <span className="season-profile-coverage-meter" aria-hidden="true">
                                  <span style={{ width: `${coveragePercent}%` }} />
                                </span>
                                <span className="season-profile-coverage-count">
                                  {profile.coverageCount} / {coverageDenominator} episodes
                                </span>
                                <span className="season-profile-size">
                                  Total: {profile.totalFileSize === null
                                    ? "Unknown size"
                                    : formatKilobytes(profile.totalFileSize)}
                                </span>
                              </span>
                            </span>
                          </div>
                          <span className="season-profile-actions">
                            <LaneDestinationMark
                              service="sonarr"
                              count={profile.sonarrManagedCount ?? 0}
                              total={profile.coverageCount}
                            />
                            <LaneDestinationMark
                              service="qbittorrent"
                              count={profile.qbittorrentSeededCount ?? 0}
                              total={profile.coverageCount}
                            />
                            <LanePathsPopover
                              profile={profile}
                              episodeIndexByRatingKey={episodeIndexByRatingKey}
                            />
                            <HoverPopover
                              openOnClick
                              anchorClassName="inline-flex shrink-0"
                              content={
                                <div className="space-y-1.5">
                                  <strong className="block">
                                    {profile.technicalVariantCount}{" "}
                                    technical signature{profile.technicalVariantCount === 1
                                      ? ""
                                      : "s"}
                                  </strong>
                                  <p className="text-base-content/70">
                                    {profile.technicalVariantCount === 1
                                      ? `All ${profile.coverageCount} files share one exact Plex technical signature.`
                                      : `These ${profile.coverageCount} files contain ${profile.technicalVariantCount} exact Plex technical signatures.`}
                                  </p>
                                  <p className="text-base-content/55">
                                    {profile.matchBasis === "release-root"
                                      ? "Recurring source folders establish this season version."
                                      : profile.matchBasis === "mixed"
                                      ? "Recurring source folders and fixed technical evidence establish this season version."
                                      : profile.matchBasis === "filename-family"
                                      ? "A recurring filename family establishes this season version."
                                      : "Fixed technical evidence establishes this season version."}
                                    {" "}
                                    Each episode contributes at most one file.
                                  </p>
                                </div>
                              }
                            >
                              <button
                                type="button"
                                className={`season-profile-tag season-profile-signature-tag ${
                                  profile.technicalVariantCount > 1 ? "has-warning" : ""
                                }`}
                              >
                                {profile.technicalVariantCount}{" "}
                                signature{profile.technicalVariantCount === 1 ? "" : "s"}
                              </button>
                            </HoverPopover>
                            {unsafe && (
                              <span className="badge badge-ghost badge-sm">Must keep one</span>
                            )}
                          </span>
                        </div>
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
                            const pathsFor = (items: typeof plan.episode.versions) =>
                              items.map((version) =>
                                profilePathByMember.get(
                                  `${plan.episode.episodeRatingKey}:${version.mediaId}`,
                                ) ?? "Path unavailable"
                              );
                            const selectedPaths = pathsFor(versions);
                            return (
                              <div key={planKey(plan)} className="season-version-preview-row">
                                <div className="season-version-preview-episode">
                                  <span>
                                    E{String(plan.episode.episodeIndex).padStart(2, "0")} —{" "}
                                    {plan.episode.episodeTitle}
                                  </span>
                                  <small>
                                    {versions.length > 0
                                      ? versions.map(versionLabel).join(" + ")
                                      : "Version unavailable"}
                                  </small>
                                </div>
                                <div className="season-version-preview-paths">
                                  <span title={selectedPaths.join(" · ")}>
                                    {selectedPaths.join(" · ")}
                                  </span>
                                </div>
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
                      {comparisonSummary?.differences.map((difference) => (
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
              pending: pending || confirmationRefreshing || deletionPreview.isFetching,
              selectionCount: selections.length,
              mode,
              profileReady: !analysis.isLoading && selectedProfileIds.size > 0 &&
                profilePlan.safe,
              previewLoading: deletionPreview.isLoading,
              previewError: deletionPreview.isError,
              previewAvailable: deletionPreview.data !== undefined,
              blockerCount: deletionPreview.data?.blockers.length ?? 0,
            })}
            onClick={confirmWithFreshPreview}
          >
            {pending || confirmationRefreshing || deletionPreview.isFetching
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
