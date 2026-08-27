import type {
  IntegrationCompatibilityCheck,
  IntegrationCompatibilityKind,
} from '@plex-librarian/shared/types.ts';
import {
  RADARR_PATH_ADOPTION_MIN_VERSION,
  SONARR_SEASON_COORDINATION_MIN_VERSION,
  supportedRadarrPathAdoptionVersion,
  supportedSonarrSeasonMutationVersion,
} from '../../integrations/arr/client.ts';

interface Identity {
  key: string;
  instanceId: number | null;
  kind: IntegrationCompatibilityKind;
  name: string;
}

function versionMajor(version: string | null): number | null {
  if (!version) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

function unverifiedArr(
  identity: Identity,
  version: string | null,
  feature: string,
): IntegrationCompatibilityCheck {
  const product = identity.kind === 'sonarr' ? 'Sonarr' : 'Radarr';
  return {
    ...identity,
    version,
    apiVersion: 'v3',
    status: 'unverified',
    message: version
      ? `${product} ${version} is outside the versions reviewed by Plex Librarian. ${feature} remains unavailable until compatibility is verified.`
      : `The ${product} version could not be verified. ${feature} remains unavailable until compatibility is verified.`,
  };
}

function numericVersionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => value.replace(/^v/i, '').split('.').map(Number);
  const left = parse(actual);
  const right = parse(minimum);
  if (left.some((part) => !Number.isSafeInteger(part) || part < 0)) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function assessArr(
  identity: Identity,
  version: string | null,
): IntegrationCompatibilityCheck {
  const major = versionMajor(version);
  if (identity.kind === 'sonarr' && (major === null || major > 4)) {
    return unverifiedArr(identity, version, 'Coordinated season cleanup');
  }
  if (identity.kind === 'sonarr' && !supportedSonarrSeasonMutationVersion(version!)) {
    return {
      ...identity,
      version,
      apiVersion: 'v3',
      status: 'limited',
      message: version
        ? `Sonarr ${SONARR_SEASON_COORDINATION_MIN_VERSION} or newer within major version 4 is required for coordinated season cleanup; this instance reports ${version}.`
        : `The Sonarr version could not be verified. Coordinated season cleanup requires ${SONARR_SEASON_COORDINATION_MIN_VERSION} or newer within major version 4.`,
    };
  }
  if (identity.kind === 'radarr' && (major === null || major > 6)) {
    return unverifiedArr(identity, version, 'Retained-version path adoption');
  }
  if (identity.kind === 'radarr' && !supportedRadarrPathAdoptionVersion(version!)) {
    return {
      ...identity,
      version,
      apiVersion: 'v3',
      status: 'limited',
      message: version
        ? `Radarr ${RADARR_PATH_ADOPTION_MIN_VERSION} or newer is required for retained-version path adoption; this instance reports ${version}.`
        : `The Radarr version could not be verified. Retained-version path adoption requires ${RADARR_PATH_ADOPTION_MIN_VERSION} or newer.`,
    };
  }
  return { ...identity, version, apiVersion: 'v3', status: 'compatible', message: null };
}

export function assessQbittorrent(
  identity: Identity,
  version: string,
  apiVersion: string,
): IntegrationCompatibilityCheck {
  if (!numericVersionAtLeast(apiVersion, '2.0')) {
    return {
      ...identity,
      version,
      apiVersion,
      status: 'incompatible',
      message: `qBittorrent Web API 2.0 or newer is required; this instance reports ${
        apiVersion || 'an unknown API version'
      }.`,
    };
  }
  return { ...identity, version, apiVersion, status: 'compatible', message: null };
}

export function compatibleSeerr(
  identity: Identity,
  version: string | null,
): IntegrationCompatibilityCheck {
  return { ...identity, version, apiVersion: 'v1', status: 'compatible', message: null };
}

export function unreachable(
  identity: Identity,
  error: unknown,
): IntegrationCompatibilityCheck {
  return {
    ...identity,
    version: null,
    apiVersion: null,
    status: 'unreachable',
    message: error instanceof Error ? error.message : 'Connection check failed',
  };
}
