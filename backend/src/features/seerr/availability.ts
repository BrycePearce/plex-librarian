import {
  SEERR_MEDIA_STATUS_AVAILABLE,
  SEERR_REQUEST_STATUS_COMPLETED,
  type SeerrRequestRecord,
  type SeerrRequestSeason,
} from '../../integrations/seerr/client.ts';

function epoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = nonNegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function mediaType(record: SeerrRequestRecord): 'movie' | 'tv' | null {
  const value = record.media?.mediaType;
  return value === 'movie' || value === 'tv' ? value : null;
}

function seasons(value: unknown): SeerrRequestSeason[] {
  return Array.isArray(value)
    ? value.filter((season): season is SeerrRequestSeason =>
      season !== null && typeof season === 'object'
    )
    : [];
}

// Seerr's top-level media status describes the whole show, not the scope of one
// partial-season request. An explicitly scoped TV request therefore requires a matching
// media-season row for every requested season; missing scope-specific evidence must not
// fall back to a potentially unrelated show-wide status.
export function requestAvailability(record: SeerrRequestRecord): {
  available: boolean;
  updatedAt: number | null;
  estimated: boolean;
} {
  const is4k = record.is4k === true;
  const requestedSeasons = requestSeasonNumbers(record);
  const mediaSeasons = seasons(record.media?.seasons);

  if (mediaType(record) === 'tv' && requestedSeasons.length > 0) {
    const byNumber = new Map(
      mediaSeasons.map((season) => [nonNegativeInteger(season.seasonNumber), season]),
    );
    const matched = requestedSeasons.map((seasonNumber) => byNumber.get(seasonNumber));
    if (!matched.every((season): season is SeerrRequestSeason => season !== undefined)) {
      // A partially populated season collection is evidence that the requested scope
      // is incomplete, not an older response shape. Falling back to the show-wide
      // status here could start the grace period before every requested season exists.
      return { available: false, updatedAt: null, estimated: true };
    }
    const available = matched.every((season) =>
      positiveInteger(is4k ? season.status4k : season.status) === SEERR_MEDIA_STATUS_AVAILABLE
    );
    const updated = matched.map((season) => epoch(season.updatedAt));
    return {
      available,
      // If even one season lacks a usable timestamp, use the current sync time in
      // resolveAvailabilityObservation. Reusing another season's older timestamp could
      // expire the grace period before the undated season was actually observed.
      updatedAt: updated.every((value): value is number => value !== null)
        ? Math.max(...updated)
        : null,
      // Seerr exposes only a generic UpdateDateColumn for seasons. It can move
      // after the availability transition, so it is useful ordering evidence but
      // never an exact availability timestamp.
      estimated: true,
    };
  }

  // Seerr has no separate mediaAddedAt4k field, so the standard timestamp is exact
  // evidence only for a non-4K request.
  const mediaAddedAt = is4k ? null : epoch(record.media?.mediaAddedAt);
  const currentStatusAvailable = positiveInteger(
    is4k ? record.media?.status4k : record.media?.status,
  ) === SEERR_MEDIA_STATUS_AVAILABLE;
  // COMPLETED is retained after Seerr later marks the media DELETED. When the dedicated
  // movie library-addition timestamp is still present, it remains exact historical
  // availability evidence and must not disappear merely because the current copy did.
  const completedMovieWithExactHistory = mediaType(record) === 'movie' &&
    positiveInteger(record.status) === SEERR_REQUEST_STATUS_COMPLETED &&
    mediaAddedAt !== null;
  return {
    available: currentStatusAvailable || completedMovieWithExactHistory,
    updatedAt: mediaAddedAt ?? epoch(record.media?.updatedAt),
    // mediaAddedAt is Seerr's dedicated library-addition timestamp. updatedAt is
    // only a generic row-update fallback and must remain marked as estimated.
    estimated: mediaAddedAt === null,
  };
}

export function requestSeasonNumbers(record: SeerrRequestRecord): number[] {
  return [
    ...new Set(
      seasons(record.seasons)
        .map((season) => nonNegativeInteger(season.seasonNumber))
        .filter((seasonNumber): seasonNumber is number => seasonNumber !== null),
    ),
  ].sort((a, b) => a - b);
}

export function resolveAvailabilityObservation(
  prior: {
    availableAt: number | null;
    observedAt: number | null;
    observedSyncAt: number | null;
    observationFromSuccessfulSync: boolean;
    estimated: boolean;
  },
  availability: { available: boolean; updatedAt: number | null; estimated: boolean },
  requestedAt: number,
  syncedAt: number,
  confirmImmediately: boolean,
  evidenceChanged = false,
): {
  availableAt: number | null;
  observedAt: number | null;
  observedSyncAt: number | null;
  estimated: boolean;
} {
  if (!evidenceChanged && prior.availableAt !== null) {
    // Upgrade an older estimated import when Seerr now supplies its dedicated
    // mediaAddedAt timestamp. Historical availability otherwise survives a later
    // deletion/unavailable state by design.
    if (availability.available && !availability.estimated && availability.updatedAt !== null) {
      const exactAt = Math.max(requestedAt, availability.updatedAt);
      // A later exact timestamp can describe a reappearance, not the original event.
      // Never move confirmed historical evidence forward. An equal/earlier dedicated
      // timestamp can safely improve an older estimate.
      if (exactAt > prior.availableAt) {
        return {
          availableAt: prior.availableAt,
          observedAt: null,
          observedSyncAt: null,
          estimated: prior.estimated,
        };
      }
      return {
        availableAt: exactAt,
        observedAt: null,
        observedSyncAt: null,
        estimated: false,
      };
    }
    return {
      availableAt: prior.availableAt,
      observedAt: null,
      observedSyncAt: null,
      estimated: prior.estimated,
    };
  }
  if (!availability.available) {
    return { availableAt: null, observedAt: null, observedSyncAt: null, estimated: false };
  }

  const estimatedAt = Math.max(requestedAt, availability.updatedAt ?? syncedAt);
  // A dedicated mediaAddedAt value identifies a specific availability event. If it
  // differs from the pending observation (or replaces a generic estimate), do not let
  // publication promote the superseded evidence as a consecutive observation.
  const pendingExactEvidenceChanged = prior.observedAt !== null &&
    !availability.estimated && availability.updatedAt !== null &&
    (prior.estimated || prior.observedAt !== estimatedAt);
  if (confirmImmediately) {
    return {
      availableAt: evidenceChanged || pendingExactEvidenceChanged
        ? estimatedAt
        : prior.observedAt ?? estimatedAt,
      observedAt: null,
      observedSyncAt: null,
      estimated: availability.estimated,
    };
  }
  if (
    !evidenceChanged && !pendingExactEvidenceChanged && prior.observedAt !== null &&
    prior.observationFromSuccessfulSync
  ) {
    return {
      availableAt: null,
      observedAt: prior.observedAt,
      observedSyncAt: prior.observedSyncAt,
      estimated: prior.estimated,
    };
  }
  return {
    availableAt: null,
    observedAt: estimatedAt,
    observedSyncAt: syncedAt,
    estimated: availability.estimated,
  };
}

export function requestEvidenceChanged(
  prior: {
    mediaType: 'movie' | 'tv' | null;
    seasonNumbers: number[];
  } | null,
  current: {
    mediaType: 'movie' | 'tv' | null;
    seasonNumbers: number[];
  },
): boolean {
  if (prior === null) return false;
  // Plex matching is current attribution evidence, not Seerr availability evidence.
  // A temporarily missing/remapped Plex item must pause attribution without erasing a
  // confirmed historical availability event.
  return prior.mediaType !== current.mediaType ||
    prior.seasonNumbers.length !== current.seasonNumbers.length ||
    prior.seasonNumbers.some((seasonNumber, index) =>
      seasonNumber !== current.seasonNumbers[index]
    );
}
