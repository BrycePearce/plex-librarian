import type {
  DuplicateEpisodeGroup,
  MediaStreamSummary,
  MediaVersion,
  SeasonLaneMatchBasis,
  SeasonVersionProfile,
} from '../types.ts';
import {
  normalized,
  type SeasonEpisodeLiveEvidence,
  seasonVersionFingerprint,
  seasonVersionLaneKey,
  sortedLaneStreamKeys,
} from './technicalEvidence.ts';
import {
  seasonFilenameFamilyKey,
  type SeasonPathEvidence,
  seasonPathEvidence,
} from './pathEvidence.ts';

export const MAX_SEASON_LANES = 11;
export const MIN_TECHNICAL_ONLY_LEAD = 60;

function profileId(evidence: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < evidence.length; index++) {
    const code = evidence.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `profile-${(left >>> 0).toString(36)}-${(right >>> 0).toString(36)}`;
}

function display(value: string | null): string {
  return value?.trim() || 'Unknown';
}

function streamLabel(stream: MediaStreamSummary, audio: boolean): string {
  const parts = [display(stream.language)];
  if (stream.codec) parts.push(stream.codec.toUpperCase());
  if (audio && stream.channels != null) parts.push(`${stream.channels}ch`);
  if (!audio && stream.forced) parts.push('forced');
  return parts.join(' · ');
}

function sumKnown(values: Array<number | null>): number | null {
  return values.every((value) => value !== null)
    ? values.reduce((total, value) => total + (value ?? 0), 0)
    : null;
}

function bitrateSummary(values: Array<number | null>): string | null {
  if (values.some((value) => value === null)) return null;
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  const minimum = Math.min(...known) / 1_000;
  const maximum = Math.max(...known) / 1_000;
  return minimum === maximum
    ? `${minimum.toFixed(1)} Mbps`
    : `${minimum.toFixed(1)}–${maximum.toFixed(1)} Mbps`;
}

export interface SeasonVersionProfileAnalysis {
  profiles: SeasonVersionProfile[];
  recommendedProfileId: string | null;
  uncertainEpisodeRatingKeys: string[];
}

interface VersionOccurrence {
  episode: DuplicateEpisodeGroup;
  version: MediaVersion;
  path: SeasonPathEvidence;
  fingerprint: string;
  qualifiedRootKey: string | null;
  qualifiedFilenameFamilyKey: string | null;
}

interface SemanticScore {
  root: number;
  filenameFamily: number;
  technical: number;
  proximity: number;
}

interface AssignmentCandidate {
  score: SemanticScore;
  assignment: number[];
}

interface Lane {
  rootKey: string | null;
  rootLabel: string | null;
  filenameFamilyKey: string | null;
  representative: VersionOccurrence | null;
  members: Array<{ occurrence: VersionOccurrence; basis: 'root' | 'filename' | 'technical' }>;
}

function relativeSimilarity(left: number | null, right: number | null): number {
  if (left === null || right === null || left <= 0 || right <= 0) return 0;
  return Math.max(0, 1 - Math.abs(Math.log(left / right)) / Math.log(4));
}

function same(left: string | null, right: string | null): boolean {
  const a = normalized(left);
  const b = normalized(right);
  return a !== null && a === b;
}

function technicalSimilarity(left: VersionOccurrence, right: VersionOccurrence): number {
  const a = left.version;
  const b = right.version;
  let score = 0;
  const leftDimensions = a.width && a.height ? `${a.width}x${a.height}` : a.videoResolution;
  const rightDimensions = b.width && b.height ? `${b.width}x${b.height}` : b.videoResolution;
  score += same(leftDimensions, rightDimensions) ? 180 : -180;
  score += same(a.videoCodec, b.videoCodec) ? 120 : -120;
  score += a.videoBitDepth !== null && a.videoBitDepth === b.videoBitDepth ? 50 : 0;
  score += same(a.videoDynamicRange, b.videoDynamicRange)
    ? 70
    : a.videoDynamicRange || b.videoDynamicRange
    ? -60
    : 0;
  score += same(a.videoScanType, b.videoScanType) ? 20 : 0;
  score += same(a.container, b.container) ? 30 : -20;
  score += JSON.stringify(sortedLaneStreamKeys(a.audioStreams, true)) ===
      JSON.stringify(sortedLaneStreamKeys(b.audioStreams, true))
    ? 160
    : -80;
  score += JSON.stringify(sortedLaneStreamKeys(a.subtitleStreams, false)) ===
      JSON.stringify(sortedLaneStreamKeys(b.subtitleStreams, false))
    ? 80
    : -30;
  return score;
}

function proximitySimilarity(left: VersionOccurrence, right: VersionOccurrence): number {
  return Math.round(
    relativeSimilarity(left.version.bitrate, right.version.bitrate) * 100 +
      relativeSimilarity(left.version.fileSize, right.version.fileSize) * 50 +
      relativeSimilarity(left.version.duration, right.version.duration) * 30,
  );
}

function occurrenceSortKey(occurrence: VersionOccurrence): string {
  const version = occurrence.version;
  return JSON.stringify([
    occurrence.qualifiedRootKey,
    seasonVersionLaneKey(version),
    version.bitrate,
    version.fileSize,
    occurrence.path.normalizedPath,
    version.mediaId,
  ]);
}

function compareScore(left: SemanticScore, right: SemanticScore): number {
  return left.root - right.root ||
    left.filenameFamily - right.filenameFamily ||
    left.technical - right.technical ||
    left.proximity - right.proximity;
}

function addScore(left: SemanticScore, right: SemanticScore): SemanticScore {
  return {
    root: left.root + right.root,
    filenameFamily: left.filenameFamily + right.filenameFamily,
    technical: left.technical + right.technical,
    proximity: left.proximity + right.proximity,
  };
}

function assignmentSort(left: AssignmentCandidate, right: AssignmentCandidate): number {
  return compareScore(right.score, left.score) ||
    left.assignment.join(',').localeCompare(right.assignment.join(','));
}

/** Exact best and runner-up distinct one-to-one assignments; lanes are capped at eleven. */
function bestAssignments(
  occurrences: readonly VersionOccurrence[],
  lanes: readonly Lane[],
  unavailableMask: number,
  allowEmptyLanes = false,
): AssignmentCandidate[] {
  const memo = new Map<string, AssignmentCandidate[]>();
  const zero: SemanticScore = { root: 0, filenameFamily: 0, technical: 0, proximity: 0 };
  const edges = occurrences.map((occurrence) =>
    lanes.map((lane): SemanticScore | null =>
      lane.representative
        ? {
          root: 0,
          filenameFamily: 0,
          technical: technicalSimilarity(occurrence, lane.representative),
          proximity: proximitySimilarity(occurrence, lane.representative),
        }
        : allowEmptyLanes && lane.rootKey === null && lane.filenameFamilyKey === null
        ? zero
        : null
    )
  );
  function visit(index: number, mask: number): AssignmentCandidate[] {
    if (index === occurrences.length) return [{ score: zero, assignment: [] }];
    const key = `${index}:${mask}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const candidates: AssignmentCandidate[] = [];
    const firstAvailableEmptyLane = lanes.findIndex((lane, laneIndex) =>
      lane.representative === null && lane.rootKey === null && lane.filenameFamilyKey === null &&
      (mask & (1 << laneIndex)) === 0
    );
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
      if ((mask & (1 << laneIndex)) !== 0) continue;
      if (
        allowEmptyLanes && lanes[laneIndex]!.representative === null &&
        lanes[laneIndex]!.rootKey === null && lanes[laneIndex]!.filenameFamilyKey === null &&
        laneIndex !== firstAvailableEmptyLane
      ) continue;
      const edge = edges[index]![laneIndex];
      if (!edge) continue;
      for (const remainder of visit(index + 1, mask | (1 << laneIndex))) {
        candidates.push({
          score: addScore(edge, remainder.score),
          assignment: [laneIndex, ...remainder.assignment],
        });
      }
    }
    candidates.sort(assignmentSort);
    const best = candidates.slice(0, 2);
    memo.set(key, best);
    return best;
  }
  return visit(0, unavailableMask);
}

function representativeOf(members: readonly VersionOccurrence[]): VersionOccurrence | null {
  if (members.length === 0) return null;
  const familyCounts = new Map<string, number>();
  for (const member of members) {
    const key = seasonVersionLaneKey(member.version) ?? member.fingerprint;
    familyCounts.set(key, (familyCounts.get(key) ?? 0) + 1);
  }
  const representativeFamily =
    [...familyCounts].sort((left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0])
    )[0]![0];
  const candidates = members.filter((member) =>
    (seasonVersionLaneKey(member.version) ?? member.fingerprint) === representativeFamily
  ).sort((left, right) => occurrenceSortKey(left).localeCompare(occurrenceSortKey(right)));
  return candidates[Math.floor((candidates.length - 1) / 2)]!;
}

function technicalSeparation(occurrences: readonly VersionOccurrence[]): number {
  let score = 0;
  for (let left = 0; left < occurrences.length; left++) {
    for (let right = left + 1; right < occurrences.length; right++) {
      score -= technicalSimilarity(occurrences[left]!, occurrences[right]!);
    }
  }
  return score;
}

function profileBasis(members: Lane['members']): SeasonLaneMatchBasis {
  const root = members.some((member) => member.basis === 'root');
  const filename = members.some((member) => member.basis === 'filename');
  const technical = members.some((member) => member.basis === 'technical');
  const basisCount = Number(root) + Number(filename) + Number(technical);
  if (basisCount > 1) return 'mixed';
  return root ? 'release-root' : filename ? 'filename-family' : 'technical-only';
}

export function analyzeSeasonVersionProfiles(
  episodes: readonly DuplicateEpisodeGroup[],
  liveEvidence?: ReadonlyMap<string, SeasonEpisodeLiveEvidence>,
): SeasonVersionProfileAnalysis {
  const uncertain = new Set<string>();
  const completeEpisodes: VersionOccurrence[][] = [];
  const canonicalEpisodes = [...episodes].sort((left, right) =>
    left.episodeIndex - right.episodeIndex ||
    left.episodeRatingKey.localeCompare(right.episodeRatingKey)
  );
  for (const episode of canonicalEpisodes) {
    const evidence = liveEvidence?.get(episode.episodeRatingKey);
    if (liveEvidence && (!evidence || evidence.status !== 'complete')) {
      uncertain.add(episode.episodeRatingKey);
      continue;
    }
    const occurrences: VersionOccurrence[] = [];
    for (const version of episode.versions) {
      const filePath = evidence?.versions.get(version.mediaId)?.filePath ?? null;
      const path = {
        ...seasonPathEvidence(filePath),
        filenameFamilyKey: seasonFilenameFamilyKey(filePath, episode),
      };
      const fingerprint = seasonVersionFingerprint(version);
      if (!fingerprint && !path.releaseRootKey && !path.filenameFamilyKey) {
        uncertain.add(episode.episodeRatingKey);
        break;
      }
      occurrences.push({
        episode,
        version,
        path,
        fingerprint: fingerprint ??
          (path.releaseRootKey
            ? `root:${path.releaseRootKey}`
            : `filename:${path.filenameFamilyKey}`),
        qualifiedRootKey: null,
        qualifiedFilenameFamilyKey: null,
      });
    }
    if (!uncertain.has(episode.episodeRatingKey) && occurrences.length >= 2) {
      completeEpisodes.push(
        occurrences.sort((left, right) =>
          occurrenceSortKey(left).localeCompare(occurrenceSortKey(right))
        ),
      );
    }
  }

  const roots = new Map<string, VersionOccurrence[]>();
  for (const occurrences of completeEpisodes) {
    for (const occurrence of occurrences) {
      if (!occurrence.path.releaseRootKey) continue;
      const members = roots.get(occurrence.path.releaseRootKey) ?? [];
      members.push(occurrence);
      roots.set(occurrence.path.releaseRootKey, members);
    }
  }
  const qualifiedRoots = new Map<string, VersionOccurrence[]>();
  for (const [rootKey, members] of roots) {
    const counts = new Map<string, number>();
    for (const member of members) {
      counts.set(
        member.episode.episodeRatingKey,
        (counts.get(member.episode.episodeRatingKey) ?? 0) + 1,
      );
    }
    if (counts.size < 2) continue;
    if ([...counts.values()].some((count) => count > 1)) continue;
    qualifiedRoots.set(rootKey, members);
    members.forEach((member) => member.qualifiedRootKey = rootKey);
  }
  const families = new Map<string, VersionOccurrence[]>();
  for (const occurrences of completeEpisodes) {
    for (const occurrence of occurrences) {
      if (!occurrence.path.filenameFamilyKey) continue;
      const members = families.get(occurrence.path.filenameFamilyKey) ?? [];
      members.push(occurrence);
      families.set(occurrence.path.filenameFamilyKey, members);
    }
  }
  const qualifiedFamilies = new Map<
    string,
    { members: VersionOccurrence[]; attachedRootKey: string | null }
  >();
  for (const [familyKey, members] of families) {
    const counts = new Map<string, number>();
    for (const member of members) {
      counts.set(
        member.episode.episodeRatingKey,
        (counts.get(member.episode.episodeRatingKey) ?? 0) + 1,
      );
    }
    if (counts.size < 2 || [...counts.values()].some((count) => count > 1)) continue;
    const rootKeys = new Set(
      members.flatMap((member) => member.qualifiedRootKey ? [member.qualifiedRootKey] : []),
    );
    if (rootKeys.size > 1) continue;
    qualifiedFamilies.set(familyKey, {
      members,
      attachedRootKey: rootKeys.values().next().value ?? null,
    });
    members.forEach((member) => member.qualifiedFilenameFamilyKey = familyKey);
  }

  const eligibleEpisodes = completeEpisodes;
  const widest = eligibleEpisodes.reduce(
    (maximum, occurrences) => Math.max(maximum, occurrences.length),
    0,
  );
  const standaloneFamilyKeys = [...qualifiedFamilies]
    .filter(([, family]) => family.attachedRootKey === null)
    .map(([key]) => key)
    .sort();
  const laneCount = Math.max(qualifiedRoots.size + standaloneFamilyKeys.length, widest);
  if (laneCount === 0 || laneCount > MAX_SEASON_LANES) {
    eligibleEpisodes.forEach((occurrences) =>
      uncertain.add(occurrences[0]!.episode.episodeRatingKey)
    );
    return {
      profiles: [],
      recommendedProfileId: null,
      uncertainEpisodeRatingKeys: [...uncertain].sort(),
    };
  }

  const rootKeys = [...qualifiedRoots.keys()].sort();
  const lanes: Lane[] = rootKeys.map((rootKey) => ({
    rootKey,
    rootLabel: qualifiedRoots.get(rootKey)![0]!.path.releaseRootLabel,
    filenameFamilyKey: null,
    representative: null,
    members: [],
  }));
  lanes.push(...standaloneFamilyKeys.map((filenameFamilyKey): Lane => ({
    rootKey: null,
    rootLabel: null,
    filenameFamilyKey,
    representative: null,
    members: [],
  })));
  while (lanes.length < laneCount) {
    lanes.push({
      rootKey: null,
      rootLabel: null,
      filenameFamilyKey: null,
      representative: null,
      members: [],
    });
  }
  const rootLaneIndex = new Map(rootKeys.map((key, index) => [key, index]));
  const familyLaneIndex = new Map<string, number>();
  for (const [familyKey, family] of qualifiedFamilies) {
    const laneIndex = family.attachedRootKey === null
      ? rootKeys.length + standaloneFamilyKeys.indexOf(familyKey)
      : rootLaneIndex.get(family.attachedRootKey)!;
    familyLaneIndex.set(familyKey, laneIndex);
  }

  function anchoredLaneIndex(occurrence: VersionOccurrence): number | null | 'conflict' {
    const rootIndex = occurrence.qualifiedRootKey
      ? rootLaneIndex.get(occurrence.qualifiedRootKey) ?? null
      : null;
    const familyIndex = occurrence.qualifiedFilenameFamilyKey
      ? familyLaneIndex.get(occurrence.qualifiedFilenameFamilyKey) ?? null
      : null;
    if (rootIndex !== null && familyIndex !== null && rootIndex !== familyIndex) return 'conflict';
    return rootIndex ?? familyIndex;
  }

  function partitionEpisode(occurrences: readonly VersionOccurrence[]): {
    fixed: Array<{ occurrence: VersionOccurrence; laneIndex: number }>;
    remaining: VersionOccurrence[];
    usedMask: number;
    conflict: boolean;
  } {
    const fixed: Array<{ occurrence: VersionOccurrence; laneIndex: number }> = [];
    const remaining: VersionOccurrence[] = [];
    let usedMask = 0;
    let conflict = false;
    for (const occurrence of occurrences) {
      const laneIndex = anchoredLaneIndex(occurrence);
      if (laneIndex === null) {
        remaining.push(occurrence);
        continue;
      }
      if (laneIndex === 'conflict' || (usedMask & (1 << laneIndex)) !== 0) {
        conflict = true;
        break;
      }
      usedMask |= 1 << laneIndex;
      fixed.push({ occurrence, laneIndex });
    }
    return { fixed, remaining, usedMask, conflict };
  }

  function anchoredBasis(occurrence: VersionOccurrence): 'root' | 'filename' {
    return occurrence.qualifiedRootKey ? 'root' : 'filename';
  }

  // An anchored lane is reserved capacity even when no episode is fully anchored. Build its
  // immutable representative from every non-conflicting qualified member before the seed pass;
  // otherwise the first unanchored seed occurrence can occupy a named root/family lane with zero
  // evidence and incorrectly become that anchor's representative.
  const safeAnchoredMembers = eligibleEpisodes.flatMap((occurrences) => {
    const partition = partitionEpisode(occurrences);
    return partition.conflict ? [] : partition.fixed;
  });
  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
    const safeMembers = safeAnchoredMembers
      .filter((member) => member.laneIndex === laneIndex)
      .map((member) => member.occurrence);
    lanes[laneIndex]!.representative = representativeOf(safeMembers);
  }

  const seedCandidates = [...eligibleEpisodes].sort((left, right) =>
    right.length - left.length ||
    right.filter((member) => anchoredLaneIndex(member) !== null).length -
      left.filter((member) => anchoredLaneIndex(member) !== null).length ||
    technicalSeparation(right) - technicalSeparation(left) ||
    left[0]!.episode.episodeIndex - right[0]!.episode.episodeIndex ||
    left[0]!.episode.episodeRatingKey.localeCompare(right[0]!.episode.episodeRatingKey)
  );
  let seed: VersionOccurrence[] | null = null;
  for (const candidate of seedCandidates) {
    const partition = partitionEpisode(candidate);
    if (partition.conflict) continue;
    const assignments = bestAssignments(partition.remaining, lanes, partition.usedMask, true);
    const best = assignments[0];
    const runnerUp = assignments[1];
    if (!best) continue;
    const emptyMembers = partition.remaining.filter((_, index) =>
      lanes[best.assignment[index]!]!.representative === null
    );
    const emptyFamilies = emptyMembers.map((occurrence) =>
      seasonVersionLaneKey(occurrence.version)
    );
    const ambiguousEmptySeeds = emptyMembers.length > 1 &&
      (emptyFamilies.some((family) => family === null) ||
        new Set(emptyFamilies).size !== emptyFamilies.length);
    const tied = runnerUp !== undefined && compareScore(best.score, runnerUp.score) === 0;
    const weak = runnerUp !== undefined &&
      best.score.technical - runnerUp.score.technical < MIN_TECHNICAL_ONLY_LEAD;
    if (ambiguousEmptySeeds || tied || weak) continue;

    for (const member of partition.fixed) {
      const lane = lanes[member.laneIndex]!;
      lane.members.push({
        occurrence: member.occurrence,
        basis: anchoredBasis(member.occurrence),
      });
      lane.representative ??= member.occurrence;
    }
    partition.remaining.forEach((occurrence, index) => {
      const lane = lanes[best.assignment[index]!]!;
      lane.representative ??= occurrence;
      lane.members.push({ occurrence, basis: 'technical' });
    });
    seed = candidate;
    break;
  }

  for (const occurrences of eligibleEpisodes) {
    if (occurrences === seed) continue;
    const partition = partitionEpisode(occurrences);
    const candidates = partition.conflict
      ? []
      : bestAssignments(partition.remaining, lanes, partition.usedMask);
    const best = candidates[0];
    const runnerUp = candidates[1];
    const noEvidence = partition.remaining.length > 0 && best !== undefined &&
      best.score.technical === 0 && best.score.proximity === 0;
    const tied = best !== undefined && runnerUp !== undefined &&
      compareScore(best.score, runnerUp.score) === 0;
    const weak = best !== undefined && runnerUp !== undefined &&
      best.score.technical - runnerUp.score.technical < MIN_TECHNICAL_ONLY_LEAD;
    if (!best || noEvidence || tied || weak) {
      uncertain.add(occurrences[0]!.episode.episodeRatingKey);
      continue;
    }
    for (const member of partition.fixed) {
      lanes[member.laneIndex]!.members.push({
        occurrence: member.occurrence,
        basis: anchoredBasis(member.occurrence),
      });
    }
    partition.remaining.forEach((occurrence, index) => {
      lanes[best.assignment[index]!]!.members.push({ occurrence, basis: 'technical' });
    });
  }

  const profiles = lanes.flatMap((lane): SeasonVersionProfile[] => {
    if (lane.members.length === 0) return [];
    const members = [...lane.members].sort((left, right) =>
      left.occurrence.episode.episodeIndex - right.occurrence.episode.episodeIndex ||
      left.occurrence.episode.episodeRatingKey.localeCompare(
        right.occurrence.episode.episodeRatingKey,
      )
    );
    const representative = lane.representative ?? members[0]!.occurrence;
    const versions = members.map((member) => member.occurrence.version);
    const laneBitrateSummary = bitrateSummary(versions.map((version) => version.bitrate));
    const videoSummary = [
      representative.version.height
        ? `${representative.version.height}p`
        : representative.version.videoResolution,
      representative.version.videoCodec?.toUpperCase(),
      representative.version.videoBitDepth ? `${representative.version.videoBitDepth}-bit` : null,
      representative.version.videoDynamicRange,
      representative.version.videoScanType,
      representative.version.container?.toUpperCase(),
    ].filter(Boolean).join(' · ');
    const memberIdentity = members.map(({ occurrence }) =>
      `${occurrence.episode.episodeRatingKey}:${occurrence.version.mediaId}`
    ).sort().join('|');
    const hints = [
      ...(lane.rootLabel ? [lane.rootLabel] : []),
      ...(lane.filenameFamilyKey ? [lane.filenameFamilyKey] : []),
      ...members.flatMap(({ occurrence }) =>
        occurrence.path.releaseRootLabel ? [occurrence.path.releaseRootLabel] : []
      ),
    ];
    return [{
      id: profileId(memberIdentity),
      label: [laneBitrateSummary, videoSummary].filter(Boolean).join(' · ') || 'Technical profile',
      coverageCount: members.length,
      technicalVariantCount: new Set(members.map(({ occurrence }) => occurrence.fingerprint)).size,
      totalFileSize: sumKnown(versions.map((version) => version.fileSize)),
      bitrateSummary: laneBitrateSummary,
      videoSummary,
      audioSummary: representative.version.audioStreams.map((stream) => streamLabel(stream, true))
        .sort(),
      subtitleSummary: representative.version.subtitleStreams.map((stream) =>
        streamLabel(stream, false)
      ).sort(),
      sourceHints: [...new Set(hints)],
      matchBasis: profileBasis(members),
      members: members.map(({ occurrence }) => ({
        episodeRatingKey: occurrence.episode.episodeRatingKey,
        mediaId: occurrence.version.mediaId,
        filePath: occurrence.path.originalPath,
      })),
    }];
  });
  profiles.sort((left, right) =>
    right.coverageCount - left.coverageCount || left.id.localeCompare(right.id)
  );
  return {
    profiles,
    recommendedProfileId: null,
    uncertainEpisodeRatingKeys: [...uncertain].sort(),
  };
}
