import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { PersistedArrMappingIdentity } from './arrReassignmentPlanning/types.ts';

export interface InspectedSonarrSeasonTarget {
  target: ArrDeleteTarget;
  seriesId: number;
  seriesPath: string;
  version: string;
  snapshot: Awaited<ReturnType<ArrDeleteTarget['client']['sonarrSeriesSnapshot']>>;
}

export interface SonarrSeasonInspection {
  inspectedTargets: ArrDeleteTarget[];
  successfulTargets: ArrDeleteTarget[];
  missingRecordTargets: ArrDeleteTarget[];
  targetPlans: InspectedSonarrSeasonTarget[];
  mappingIdentities: PersistedArrMappingIdentity[];
  warnings: string[];
}

export function sonarrActivityConflictMessage(names: readonly string[]): string {
  const refreshing = names.length > 0 &&
    names.every((name) => /^(refresh|rescan)/i.test(name));
  const activity = refreshing
    ? 'refreshing this series'
    : 'updating or importing files for this series';
  return `Sonarr is currently ${activity}. Plex Librarian waits for it to finish so the file list cannot change during removal. Try again in a moment.`;
}

/**
 * Collects the stable Sonarr evidence shared by redundant-version cleanup and whole-season
 * deletion. It performs all reads before callers interpret ownership or choose a mutation.
 */
export async function inspectSonarrSeason(input: {
  targets: readonly ArrDeleteTarget[];
  tvdbId: number | null;
  inspect: boolean;
  mutationRequested: boolean;
  fallbackWarning: string;
}): Promise<SonarrSeasonInspection> {
  const inspectedTargets = input.inspect || input.mutationRequested ? [...input.targets] : [];
  const warnings: string[] = [];
  const targetPlans: InspectedSonarrSeasonTarget[] = [];
  const successfulTargets: ArrDeleteTarget[] = [];
  const missingRecordTargets: ArrDeleteTarget[] = [];

  if (inspectedTargets.length > 0 && (!Number.isSafeInteger(input.tvdbId) || input.tvdbId! <= 0)) {
    if (input.mutationRequested) {
      throw new Error('the Plex show has no exact TVDB identity for Sonarr inspection');
    }
    warnings.push(
      `Sonarr ownership could not be inspected because the Plex show has no exact TVDB identity. ${input.fallbackWarning}`,
    );
  } else if (Number.isSafeInteger(input.tvdbId) && input.tvdbId! > 0) {
    for (const target of inspectedTargets) {
      try {
        const capabilities = await target.client.sonarrSeasonCoordinationCapabilities();
        if (input.mutationRequested && (!capabilities.available || !capabilities.version)) {
          throw new Error(capabilities.reason ?? 'Sonarr v4 coordination is unavailable');
        }
        if (!input.mutationRequested && !capabilities.available) {
          warnings.push(
            `${target.instanceName}: ${
              capabilities.reason ?? 'automatic Sonarr coordination is unavailable'
            }. Read-only ownership was still inspected; ${input.fallbackWarning}`,
          );
        }
        const series = await target.client.lookup(input.tvdbId!);
        if (!series) {
          successfulTargets.push(target);
          missingRecordTargets.push(target);
          continue;
        }
        if (!series.path) throw new Error('Sonarr series path is unavailable');
        const [snapshot, activity] = await Promise.all([
          target.client.sonarrSeriesSnapshot(series.id),
          target.client.sonarrSeriesActivity(series.id),
        ]);
        if (!activity.quiet) {
          throw new Error(sonarrActivityConflictMessage(
            activity.blocking.map((entry) => entry.name),
          ));
        }
        targetPlans.push({
          target,
          seriesId: series.id,
          seriesPath: series.path,
          version: capabilities.version ?? 'unverified',
          snapshot,
        });
        successfulTargets.push(target);
      } catch (error) {
        if (input.mutationRequested) throw error;
        warnings.push(
          `${target.instanceName}: ${
            error instanceof Error ? error.message : 'Sonarr inspection failed'
          }. ${input.fallbackWarning}`,
        );
      }
    }
  }

  const mappingIdentities = inspectedTargets.map((target) => ({
    instanceId: target.instanceId,
    instanceType: target.instanceType,
    instanceUrl: target.instanceUrl,
    configurationUpdatedAt: target.configurationUpdatedAt,
    mappingIdentity: target.mappingIdentity,
  } satisfies PersistedArrMappingIdentity)).sort((left, right) =>
    left.instanceId - right.instanceId
  );

  return {
    inspectedTargets,
    successfulTargets,
    missingRecordTargets,
    targetPlans,
    mappingIdentities,
    warnings,
  };
}
