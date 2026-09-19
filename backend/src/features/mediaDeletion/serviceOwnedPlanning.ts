import { createHash } from 'node:crypto';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { PlexMetadataIdentity } from '../../integrations/plex/types.ts';
import type { ArrTorrentAssociation } from '../../integrations/arr/client.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { OrdinarySelection } from './ordinaryPlanning.ts';
import type { DownloadClientTarget, DownloadJob, DownloadJobSummary } from './downloadClient.ts';
import type { ServiceStorageEndpoint } from '../../../../shared/serviceStorage.ts';
import {
  planServiceOwnedRetention,
  type ServiceOwnedAction,
  type ServiceOwnedDecision,
  type ServiceOwnedEntry,
  type ServiceOwnedRetentionPlan,
} from './serviceOwnedRetention.ts';

export interface ServiceOwnedPlannedAction extends ServiceOwnedAction {
  /** Verified import connection, distinct from a QB job read only for overlap protection. */
  matchedToSelection?: boolean;
  serviceKey: string;
  instanceId?: number;
  instanceKey?: string;
  recordId?: number;
  fileId?: number;
  hash?: string;
  ratingKey?: string;
  mediaId?: number;
  episodeIds?: number[];
  episodes?: Array<{ id: number; monitored: boolean; seasonNumber: number; episodeNumber: number }>;
  files: Array<{ path: string; size: number | null }>;
  /** Preserve native ownership even when several Plex entries name the same file. */
  plexParts?: Array<{
    path: string;
    size: number;
    ratingKey: string;
    mediaId: number;
    season?: number;
    episode?: number;
  }>;
  job?: DownloadJob;
  /** Binds imported-file lineage independently of global evidence changed by earlier deletions. */
  provenanceFingerprint?: string;
  /** Only after every file action for this record succeeds; never delete its directory. */
  recordCleanup?: { deleteFiles: false; addImportExclusion: boolean };
  unavailableReason?: string;
  /** Native file-ID boundary includes linked extras even when Sonarr cannot enumerate them. */
  associatedExtras?: { policy: 'sonarr_file_id'; managedRoot: string };
}

export interface ServiceOwnedPlan {
  policyVersion: 4;
  confidencePolicy?: 'service-owned-reasonable-v1';
  serverId: number;
  libraryKey: string;
  selection: OrdinarySelection & { mediaId?: number; episodeIndex?: number };
  arrSelected: boolean;
  qbSelected: boolean;
  connections: Array<{ key: string; configurationIdentity: string }>;
  actions: ServiceOwnedPlannedAction[];
  retention: ServiceOwnedRetentionPlan;
  fingerprint: string;
  plexFiles: Array<{ path: string; size: number }>;
  evidenceRevision: string;
}

export interface ServiceOwnedPlanningInput {
  serverId: number;
  libraryKey: string;
  selection: ServiceOwnedPlan['selection'];
  arrSelected: boolean;
  qbSelected: boolean;
  plex: PlexClient;
  arrTargets: readonly ArrDeleteTarget[];
  downloadTargets: readonly DownloadClientTarget[];
  connections?: readonly ServiceStorageEndpoint[];
  /** Synced identity hints only; candidate ownership/files are read live below. */
  relatedPlexItems?: () => Promise<
    Array<{ ratingKey: string; libraryKey: string; type: 'movie' | 'show' }>
  >;
  /** Accepted job IDs remain read candidates after earlier service effects remove import lineage. */
  knownJobIds?: readonly string[];
  /** Confirmed same-operation removals remain conservative retained evidence for siblings. */
  completedSiblingRetainedEntries?: readonly { serviceKey: string; path: string }[];
  /** Execution-only: refresh this native file's owners; other owners still come from
   * two fresh complete snapshots. Unchanged unrelated Plex parts use accepted
   * coordinates only as matching hints, never to authorize their mutation. */
  focus?: {
    action: ServiceOwnedPlannedAction;
    acceptedPlexParts: NonNullable<ServiceOwnedPlannedAction['plexParts']>;
  };
}

// Operation evidence is bounded separately from library sync. Never silently truncate a deletion.
const MAX_ENTRIES = 100_000;
const MAX_JOBS = 10_000;
const MAX_REQUESTS = 25_000;
const MAX_FILES = 50_000;

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') +
      '}';
  }
  return JSON.stringify(value);
}
export function serviceOwnedFingerprint(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
export function serviceOwnedPlanFingerprint(plan: Omit<ServiceOwnedPlan, 'fingerprint'>): string {
  return serviceOwnedFingerprint({
    ...plan,
    actions: plan.actions.map(serviceOwnedActionEvidence),
  });
}
function basename(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1)!;
}
function canonicalPath(path: string): string {
  return path.includes('\\') ? path.replaceAll('\\', '/').toLowerCase() : path;
}
function directory(path: string): string {
  const value = canonicalPath(path);
  return value.slice(0, value.lastIndexOf('/'));
}
/** A risk signal for known retained sidecars, not an exhaustive inventory of Sonarr's extras. */
function possibleSonarrSidecar(action: ServiceOwnedPlannedAction, path: string): boolean {
  if (!action.associatedExtras || !inManagedRoot(path, action.associatedExtras.managedRoot)) {
    return false;
  }
  const name = basename(canonicalPath(path));
  // Another video version is a separate media entry, not a filename-only sidecar signal.
  if (/\.(mkv|mp4|avi|mov|wmv|m4v|ts|m2ts|webm|mpg|mpeg)$/i.test(name)) return false;
  if (
    action.files.some((file) => {
      const main = basename(canonicalPath(file.path));
      const stem = main.slice(0, main.lastIndexOf('.'));
      return directory(file.path) === directory(path) && name.startsWith(stem + '.');
    })
  ) return true;
  const coordinates = [...name.matchAll(/s(\d+)e(\d+)/gi), ...name.matchAll(/\b(\d+)x(\d+)\b/gi)];
  return coordinates.some((match) =>
    action.episodes?.some((episode) =>
      episode.seasonNumber === Number(match[1]) && episode.episodeNumber === Number(match[2])
    )
  ) && /\.(srt|ass|ssa|sub|idx|vtt|nfo|xml|txt|jpg|jpeg|png|webp)$/i.test(name);
}
function inManagedRoot(path: string, root: string): boolean {
  const canonical = (value: string) =>
    value.includes('\\') ? value.replaceAll('\\', '/').toLowerCase() : value;
  return canonical(path).startsWith(canonical(root).replace(/\/+$/, '') + '/');
}
function remoteJoin(root: string, relative: string): string {
  if (
    !relative || relative.startsWith('/') || relative.includes('\\') ||
    relative.split('/').some((p) => !p || p === '.' || p === '..') || /^[A-Za-z]:/.test(relative)
  ) {
    throw new Error('Invalid relative service payload');
  }
  const separator = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + separator + relative.replaceAll('/', separator);
}
function jobEvidence(job: DownloadJob) {
  return {
    id: job.id,
    size: job.size,
    savePath: job.savePath,
    contentPath: job.contentPath,
    fileCount: job.fileCount,
    manifestFiles: [...job.manifestFiles].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
/** Stable destructive identity, excluding volatile playback/seeding counters and client objects. */
export function serviceOwnedActionEvidence(action: ServiceOwnedPlannedAction) {
  const evidence = { ...action, ...(action.job ? { job: jobEvidence(action.job) } : {}) };
  // Display applicability can change after Arr removes import records. Existing
  // provenance and effect checks own execution safety across those transitions.
  delete evidence.matchedToSelection;
  return evidence;
}
export function serviceOwnedDecisionExplanation(
  action: ServiceOwnedPlannedAction | undefined,
  decision: ServiceOwnedDecision,
): string {
  if (action?.unavailableReason) return action.unavailableReason;
  if (decision.state === 'delete_candidate' && action?.associatedExtras) {
    return 'Sonarr will delete this episode file and extras linked to its file ID. Linked extras are managed by Sonarr and cannot be listed separately.';
  }
  return {
    eligible: 'Current service target is eligible for deletion',
    not_selected: 'This optional service target was not selected',
    target_absent: 'No applicable current service target',
    target_unknown: 'The current service target could not be verified',
    effects_incomplete: 'The required deletion scope could not be verified',
    qb_inventory_unavailable: 'Required qBittorrent ownership evidence could not be read',
    retained_entry: 'Kept because the action overlaps a retained file',
    relationship_unknown: 'A relevant file relationship remains unresolved',
  }[decision.reason];
}
function endpoint(raw: string): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Read-only API collector. It never reads host storage, user mappings or historical orphan paths. */
export async function buildServiceOwnedPlan(
  input: ServiceOwnedPlanningInput,
): Promise<ServiceOwnedPlan> {
  const selection = { ...input.selection };
  if (!['movie', 'show', 'season', 'episode'].includes(selection.type)) {
    throw new Error('Unsupported service deletion type');
  }
  if (
    selection.mediaId !== undefined &&
    (!Number.isSafeInteger(selection.mediaId) || selection.mediaId <= 0 ||
      !['movie', 'episode'].includes(selection.type))
  ) throw new Error('Invalid media-version selection');
  let requests = 0, entries = 0;
  const read = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (++requests > MAX_REQUESTS) throw new Error('Service evidence request budget exceeded');
    return await fn();
  };
  const charge = (count: number) => {
    entries += count;
    if (entries > MAX_ENTRIES) throw new Error('Service evidence entry budget exceeded');
  };
  const actions: ServiceOwnedPlannedAction[] = [];
  const retainedEntries = new Map<string, ServiceOwnedEntry>();
  const retain = (key: string, path: string) => {
    const id = `${key}:${path}`;
    retainedEntries.set(id, { id, path });
    charge(1);
  };
  const base = (
    id: string,
    service: ServiceOwnedAction['service'],
    serviceKey: string,
    selected?: boolean,
  ): ServiceOwnedPlannedAction => ({
    id,
    service,
    serviceKey,
    targetId: id,
    selected,
    presence: 'unknown',
    effectsComplete: false,
    files: [],
    entries: [],
  });
  const setFiles = (
    action: ServiceOwnedPlannedAction,
    files: ServiceOwnedPlannedAction['files'],
  ) => {
    charge(files.length);
    action.files = [...files].sort((a, b) => a.path.localeCompare(b.path));
    action.entries = action.files.map((file) => ({
      id: `${action.serviceKey}:${file.path}`,
      path: file.path,
    }));
  };
  const plexKey = `plex:${input.libraryKey}`;
  const plexAction = base(
    `${plexKey}:${selection.ratingKey}${
      selection.mediaId === undefined ? '' : `:media:${selection.mediaId}`
    }`,
    'plex',
    plexKey,
    true,
  );
  plexAction.ratingKey = selection.ratingKey;
  plexAction.mediaId = selection.mediaId;
  actions.push(plexAction);
  let identity: PlexMetadataIdentity | null = null;
  let externalId: number | null = null;
  const selectedParts: Array<
    {
      path: string;
      size: number;
      ratingKey: string;
      mediaId: number;
      season?: number;
      episode?: number;
    }
  > = [];
  const unselectedVersionPaths: string[] = [];
  const unselectedParts: typeof selectedParts = [];
  try {
    identity = await read(() => input.plex.metadataIdentity(selection.ratingKey));
    if (!identity) {
      plexAction.presence = 'absent';
      plexAction.effectsComplete = true;
    } else {
      if (
        identity.ratingKey !== selection.ratingKey || identity.type !== selection.type ||
        identity.librarySectionId !== input.libraryKey
      ) throw new Error('Plex identity changed');
      let owner = identity;
      if (selection.type === 'season' || selection.type === 'episode') {
        const key = selection.type === 'season'
          ? identity.parentRatingKey
          : identity.grandparentRatingKey;
        if (!key || selection.showRatingKey && selection.showRatingKey !== key) {
          throw new Error('Plex ancestry changed');
        }
        const show = await read(() => input.plex.metadataIdentity(key));
        if (!show || show.type !== 'show' || show.librarySectionId !== input.libraryKey) {
          throw new Error('Plex show identity changed');
        }
        owner = show;
        if (
          selection.type === 'episode' &&
          (selection.seasonIndex !== undefined && selection.seasonIndex !== identity.seasonIndex ||
            selection.episodeIndex !== undefined && selection.episodeIndex !== identity.index)
        ) throw new Error('Plex episode coordinates changed');
      }
      externalId = selection.type === 'movie' ? owner.tmdbId : owner.tvdbId;
      const acceptedId = selection.type === 'movie' ? selection.tmdbId : selection.tvdbId;
      if (acceptedId !== null && acceptedId !== externalId) {
        throw new Error('Plex external identity changed');
      }
      if (selection.type === 'season') {
        if (identity.index !== selection.seasonIndex) throw new Error('Plex season changed');
        const episodes = await read(() =>
          input.plex.seasonDeletionEpisodes(selection.ratingKey, MAX_FILES)
        );
        charge(episodes.length);
        for (const episode of episodes) {
          if (episode.showRatingKey !== owner.ratingKey || episode.seasonIndex !== identity.index) {
            throw new Error('Plex episode changed');
          }
          for (const media of episode.media) {
            for (const file of media.paths) {
              selectedParts.push({
                path: file.path,
                size: file.byteSize,
                ratingKey: episode.ratingKey,
                mediaId: media.mediaId,
                season: episode.seasonIndex,
                episode: episode.episodeIndex,
              });
            }
          }
        }
        if (
          stable(episodes) !== stable(
            await read(() => input.plex.seasonDeletionEpisodes(selection.ratingKey, MAX_FILES)),
          )
        ) {
          throw new Error('Plex season changed during collection');
        }
      } else {
        const paths = await read(() =>
          input.plex.mediaPathPreview(
            selection.ratingKey,
            selection.type,
            MAX_FILES,
            undefined,
            true,
            true,
          )
        );
        if (paths.truncated || !paths.versionFiles) {
          throw new Error('Incomplete Plex atomic effects');
        }
        const all = paths.versionFiles;
        if (selection.mediaId !== undefined) {
          unselectedParts.push(
            ...all.filter((p) => p.mediaId !== selection.mediaId).map((p) => ({
              ...p,
              season: identity!.seasonIndex ?? undefined,
              episode: identity!.index ?? undefined,
            })),
          );
          unselectedVersionPaths.push(
            ...all.filter((p) => p.mediaId !== selection.mediaId).map((p) => p.path),
          );
        }
        if (selection.mediaId !== undefined && new Set(all.map((p) => p.mediaId)).size < 2) {
          throw new Error('A remaining Plex version is required');
        }
        for (
          const file of all.filter((p) =>
            selection.mediaId === undefined || p.mediaId === selection.mediaId
          )
        ) {
          let season = identity.seasonIndex ?? undefined, episode = identity.index ?? undefined;
          if (selection.type === 'show') {
            const accepted = input.focus?.acceptedPlexParts.find((part) =>
              part.ratingKey === file.ratingKey && part.mediaId === file.mediaId &&
              part.path === file.path && part.size === file.size
            );
            const focused = !accepted ||
              input.focus!.action.episodes?.some((entry) =>
                entry.seasonNumber === accepted.season && entry.episodeNumber === accepted.episode
              );
            if (accepted && !focused) {
              selectedParts.push({ ...file, season: accepted.season, episode: accepted.episode });
              continue;
            }
            const child = await read(() => input.plex.metadataIdentity(file.ratingKey));
            if (
              !child || child.type !== 'episode' ||
              child.grandparentRatingKey !== identity.ratingKey ||
              child.librarySectionId !== input.libraryKey
            ) throw new Error('Plex child changed');
            season = child.seasonIndex ?? undefined;
            episode = child.index ?? undefined;
          }
          selectedParts.push({ ...file, season, episode });
        }
        if (
          stable(paths) !== stable(
            await read(() =>
              input.plex.mediaPathPreview(
                selection.ratingKey,
                selection.type,
                MAX_FILES,
                undefined,
                true,
                true,
              )
            ),
          )
        ) {
          throw new Error('Plex effects changed during collection');
        }
      }
      if (
        (!selectedParts.length && selection.type !== 'season' && selection.type !== 'show') ||
        selectedParts.some((p) => !Number.isSafeInteger(p.size) || p.size <= 0)
      ) throw new Error('Incomplete Plex file evidence');
      if (
        stable(identity) !== stable(
          await read(() => input.plex.metadataIdentity(selection.ratingKey)),
        )
      ) throw new Error('Plex identity changed during collection');
      setFiles(plexAction, [
        ...new Map(selectedParts.map((p) => [p.path, { path: p.path, size: p.size }])).values(),
      ]);
      plexAction.plexParts = [...selectedParts].sort((a, b) => stable(a).localeCompare(stable(b)));
      plexAction.presence = 'current';
      plexAction.effectsComplete = true;
    }
  } catch {
    selectedParts.length = 0;
    externalId = null;
    plexAction.presence = 'unknown';
    plexAction.effectsComplete = false;
    plexAction.unavailableReason =
      'Current Plex identity or complete file effects are unavailable or changed';
  }
  const histories: Array<
    {
      target: ArrDeleteTarget;
      recordId: number;
      fileId: number;
      path: string;
      size: number;
      episodeIds: number[];
      imports: ArrTorrentAssociation[];
    }
  > = [];
  let provenanceUnavailable = false;
  const unverifiedImportHashes = new Set<string>();
  const targets = input.arrTargets.filter((t) =>
    t.instanceType === (selection.type === 'movie' ? 'radarr' : 'sonarr')
  );
  for (const target of targets) {
    const serviceKey = `arr:${target.instanceId}`;
    const placeholder = base(
      `${serviceKey}:selection:${selection.ratingKey}`,
      target.instanceType,
      serviceKey,
      input.arrSelected,
    );
    placeholder.instanceId = target.instanceId;
    try {
      if (!externalId || !plexAction.effectsComplete) {
        throw new Error('No trustworthy Plex identity');
      }
      const record = await read(() => target.client.lookup(externalId!));
      if (!record) {
        if (await read(() => target.client.lookup(externalId!))) {
          throw new Error('Arr record appeared during collection');
        }
        placeholder.presence = 'absent';
        placeholder.effectsComplete = true;
        actions.push(placeholder);
        continue;
      }
      if (!record.path) throw new Error('Missing managed folder');
      let files: Array<{ id: number; path: string; size: number; episodeIds: number[] }> = [];
      let episodes: Array<
        {
          id: number;
          monitored: boolean;
          seasonNumber: number;
          episodeNumber: number;
          episodeFileId: number;
        }
      > = [];
      let extras: Array<{ relativePath: string; fileId: number | null }> = [];
      let extrasComplete = false;
      let ownedFileCount = 0;
      if (target.instanceType === 'sonarr') {
        const snapshot = await read(() => target.client.sonarrSeriesSnapshot(record.id));
        charge(snapshot.files.length + snapshot.episodes.length);
        ownedFileCount = snapshot.files.length;
        episodes = snapshot.episodes;
        const coordinate = (e: { seasonNumber: number; episodeNumber: number }) =>
          selectedParts.some((p) => p.season === e.seasonNumber && p.episode === e.episodeNumber);
        const ids = new Set(episodes.filter(coordinate).map((e) => e.id));
        files = snapshot.files.filter((f) => f.episodeIds.some((id) => ids.has(id)));
        for (
          const file of snapshot.files.filter((f) => !files.some((chosen) => chosen.id === f.id))
        ) retain(serviceKey, file.path);
        // Preserve every snapshot-known out-of-scope owner before a live owner
        // check can fail. A conflict in the first file must not hide later ones.
        for (const file of files) {
          if (file.episodeIds.some((id) => !ids.has(id))) retain(serviceKey, file.path);
        }
        for (const file of files) {
          if (
            input.focus &&
            (input.focus.action.instanceId !== target.instanceId ||
              input.focus.action.fileId !== file.id)
          ) continue;
          const owners = await read(() =>
            target.client.sonarrEpisodeFileOwnerIds(file.id, record.id)
          );
          if (
            !owners.length || stable([...owners].sort((a, b) =>
                a - b
              )) !== stable([...file.episodeIds].sort((a, b) => a - b)) ||
            owners.some((id) => !ids.has(id))
          ) {
            // A failed selection check must not discard a known shared file. Plex or
            // another service could otherwise still delete this same retained entry.
            retain(serviceKey, file.path);
            throw new Error('File includes an unselected owner');
          }
        }
        if (
          stable(snapshot) !==
            stable(await read(() => target.client.sonarrSeriesSnapshot(record.id)))
        ) throw new Error('Sonarr inventory changed');
        // Accept the native EpisodeFile ID boundary, including Sonarr-owned linked extras.
        // This is not an empty sidecar inventory; known retained sidecar risks veto below.
        extrasComplete = true;
      } else {
        // lookup verifies a unique external identity; the native file read verifies record ownership.
        const file = await read(() => target.client.radarrManagedFile(record.id));
        ownedFileCount = file ? 1 : 0;
        if (file) {
          if (!file.path || !Number.isSafeInteger(file.size) || file.size! <= 0) {
            throw new Error('Incomplete Radarr file');
          }
          files = [{ id: file.id, path: file.path, size: file.size!, episodeIds: [] }];
        }
        const observedExtras = await read(() => target.client.extraFiles(record.id));
        charge(observedExtras.length);
        extras = observedExtras.map((e) => ({
          relativePath: e.relativePath,
          fileId: e.movieFileId,
        }));
        // Null/other file ownership is not an effect of this file-ID deletion.
        // Keep those known entries as conflict evidence without inventing a directory delete.
        for (
          const extra of extras.filter((e) =>
            e.fileId === null || !files.some((f) => f.id === e.fileId)
          )
        ) {
          retain(serviceKey, remoteJoin(record.path, extra.relativePath));
        }
        extrasComplete = true;
        if (
          stable(file) !== stable(await read(() => target.client.radarrManagedFile(record.id))) ||
          stable(observedExtras) !== stable(await read(() => target.client.extraFiles(record.id)))
        ) throw new Error('Radarr inventory changed');
      }
      let imports: ArrTorrentAssociation[] = [];
      if (files.length) {
        try {
          imports = await read(() => target.client.torrentAssociations(record.id));
          charge(imports.length);
          if (
            stable(imports) !==
              stable(await read(() => target.client.torrentAssociations(record.id)))
          ) {
            for (const item of imports) unverifiedImportHashes.add(item.hash.toLowerCase());
            imports = [];
            provenanceUnavailable = true;
          }
        } catch {
          for (const item of imports) unverifiedImportHashes.add(item.hash.toLowerCase());
          imports = [];
          provenanceUnavailable = true;
        }
      }
      if (stable(record) !== stable(await read(() => target.client.lookup(externalId!)))) {
        throw new Error('Arr record changed');
      }
      if (!files.length) {
        if (
          ownedFileCount === 0 && selection.mediaId === undefined &&
          (selection.type === 'movie' || selection.type === 'show')
        ) {
          const catalog = base(
            `${serviceKey}:record:${record.id}`,
            target.instanceType,
            serviceKey,
            input.arrSelected,
          );
          Object.assign(catalog, {
            catalogOnly: true,
            presence: 'current',
            effectsComplete: true,
            instanceId: target.instanceId,
            recordId: record.id,
            recordCleanup: { deleteFiles: false, addImportExclusion: target.addImportExclusion },
          });
          actions.push(catalog);
          continue;
        }
        placeholder.presence = 'absent';
        placeholder.effectsComplete = true;
        actions.push(placeholder);
        continue;
      }
      for (const file of files) {
        if (!inManagedRoot(file.path, record.path)) {
          throw new Error('Current managed file lies outside its record folder');
        }
        const matches = selectedParts.filter((p) =>
          basename(p.path) === basename(file.path) && p.size === file.size
        );
        // IDs/coordinates establish media identity; current filename+size corroborate the exact version.
        const matched = matches.length > 0 && new Set(matches.map((p) => p.path)).size === 1 &&
          file.episodeIds.every((id) => {
            const owner = episodes.find((e) => e.id === id);
            return owner &&
              matches.some((p) =>
                p.season === owner.seasonNumber && p.episode === owner.episodeNumber
              );
          });
        // A complete, stable remaining version can positively identify the managed
        // file as retained. A mere failure to match the selected version cannot.
        const retainedMatches = unselectedParts.filter((p) =>
          p.ratingKey === selection.ratingKey && Number.isSafeInteger(p.size) && p.size > 0 &&
          basename(p.path) === basename(file.path) && p.size === file.size
        );
        const matchedRetained = target.instanceType === 'sonarr' &&
          selection.type === 'episode' && selection.mediaId !== undefined && matches.length === 0 &&
          retainedMatches.length > 0 &&
          new Set(retainedMatches.map((p) => `${p.mediaId}:${p.path}`)).size === 1 &&
          file.episodeIds.length > 0 && file.episodeIds.every((id) => {
            const owner = episodes.find((e) => e.id === id);
            return owner &&
              retainedMatches.some((p) =>
                p.season === owner.seasonNumber && p.episode === owner.episodeNumber
              );
          });
        const current = base(
          `${serviceKey}:file:${file.id}`,
          target.instanceType,
          serviceKey,
          input.arrSelected,
        );
        Object.assign(current, {
          instanceId: target.instanceId,
          recordId: record.id,
          fileId: file.id,
          episodeIds: file.episodeIds,
          episodes: episodes.filter((e) => file.episodeIds.includes(e.id)).map((
            { id, monitored, seasonNumber, episodeNumber },
          ) => ({ id, monitored, seasonNumber, episodeNumber })),
        });
        if (target.instanceType === 'sonarr') {
          current.associatedExtras = { policy: 'sonarr_file_id', managedRoot: record.path };
        }
        setFiles(current, [
          { path: file.path, size: file.size },
          ...extras.filter((e) => e.fileId === file.id).map((e) => ({
            path: remoteJoin(record.path!, e.relativePath),
            size: null,
          })),
        ]);
        current.presence = 'current';
        current.effectsComplete = (matched || matchedRetained) && extrasComplete;
        if (matchedRetained) {
          current.retainedOwnership = true;
          retain(serviceKey, file.path);
        }
        if (!current.effectsComplete) {
          current.unavailableReason = !matched
            ? 'Exact current file version is ambiguous or unmatched'
            : 'Complete associated extra-file effects are unavailable';
        }
        if (
          selection.mediaId === undefined &&
          (selection.type === 'movie' || selection.type === 'show')
        ) {
          current.recordCleanup = {
            deleteFiles: false,
            addImportExclusion: target.addImportExclusion,
          };
        }
        actions.push(current);
        if (matched) {
          histories.push({
            target,
            recordId: record.id,
            fileId: file.id,
            path: file.path,
            size: file.size,
            episodeIds: file.episodeIds,
            imports,
          });
        }
      }
    } catch {
      placeholder.unavailableReason =
        'Current Arr identity, ownership or stable inventory is unavailable';
      actions.push(placeholder);
    }
  }
  // More than one current manager is ambiguous. Never choose the first endpoint or delete both.
  const currentInstances = new Set(
    actions.filter((a) => a.recordId !== undefined && a.presence === 'current').map((a) =>
      a.serviceKey
    ),
  );
  if (currentInstances.size > 1) {
    for (const a of actions.filter((a) => a.recordId !== undefined)) {
      a.effectsComplete = false;
      a.unavailableReason = 'Multiple service instances own this media identity';
    }
  }
  let qbInventory: 'unconfigured' | 'complete' | 'failed' = input.downloadTargets.length
    ? 'complete'
    : 'unconfigured';
  const inventories: Array<{ serviceKey: string; fingerprint: string }> = [];
  const historyHashes = new Set([
    ...histories.flatMap((h) => h.imports.map((i) => i.hash.toLowerCase())),
    ...(input.knownJobIds ?? []).map((id) => id.toLowerCase()),
    ...unverifiedImportHashes,
  ]);
  let indexedActions = -1;
  let scopePaths: string[] = [];
  let scopeSet = new Set<string>();
  const relevantSummary = (summary: DownloadJobSummary) => {
    if (historyHashes.has(summary.id.toLowerCase())) return true;
    if (indexedActions !== actions.length) {
      scopeSet = new Set(
        actions.flatMap((a) => [
          ...a.files.map((f) => canonicalPath(f.path)),
          ...(a.associatedExtras ? [canonicalPath(a.associatedExtras.managedRoot)] : []),
        ]).map((path) => path.replace(/\/+$/, '')),
      );
      scopePaths = [...scopeSet].sort();
      indexedActions = actions.length;
    }
    const path = canonicalPath(summary.contentPath || summary.savePath).replace(/\/+$/, '');
    for (let ancestor = path; ancestor; ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'))) {
      if (scopeSet.has(ancestor)) return true;
      if (!ancestor.includes('/')) break;
    }
    // A summary may be a containing payload directory. Search only its descendants.
    const prefix = path + '/';
    let low = 0, high = scopePaths.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (scopePaths[middle] < prefix) low = middle + 1;
      else high = middle;
    }
    return scopePaths[low]?.startsWith(prefix) ?? false;
  };
  const qbContexts: Array<{
    target: DownloadClientTarget;
    serviceKey: string;
    all: DownloadJobSummary[];
    summaries: DownloadJobSummary[];
    loaded: Set<string>;
    failed: boolean;
    collect: (summary: DownloadJobSummary) => Promise<void>;
  }> = [];
  const failQb = (target: DownloadClientTarget, serviceKey: string) => {
    qbInventory = 'failed';
    const unknown = base(`${serviceKey}:inventory`, 'qb', serviceKey, input.qbSelected);
    unknown.instanceKey = target.instanceKey;
    unknown.unavailableReason = 'Configured QB ownership inventory failed or changed';
    actions.push(unknown);
  };
  for (const target of input.downloadTargets) {
    const serviceKey = `qb:${target.instanceKey}`;
    try {
      if (!target.client.scanJobSummaries) throw new Error('Complete QB inventory unavailable');
      const seen = new Set<string>();
      const summaries: DownloadJobSummary[] = [];
      const all: DownloadJobSummary[] = [];
      await read(() =>
        target.client.scanJobSummaries!((summary: DownloadJobSummary) => {
          if (seen.has(summary.id) || seen.size >= MAX_ENTRIES) {
            throw new Error('Invalid or excessive QB inventory');
          }
          seen.add(summary.id);
          all.push({
            id: summary.id,
            size: summary.size,
            contentPath: summary.contentPath,
            savePath: summary.savePath,
          });
          return Promise.resolve();
        })
      );
      const collect = async (summary: DownloadJobSummary) => {
        if (summaries.length >= MAX_JOBS) throw new Error('Relevant QB inventory budget exceeded');
        summaries.push(summary);
        const job = await read(() => target.client.findJob(summary.id));
        if (
          !job || job.id !== summary.id || job.size !== summary.size ||
          job.savePath !== summary.savePath || job.contentPath !== summary.contentPath ||
          !job.fileCount || job.fileCount !== job.manifestFiles.length ||
          job.manifestFiles.some((f) =>
            f.size === null || !Number.isSafeInteger(f.size) || f.size < 0
          )
        ) throw new Error('Incomplete QB manifest');
        const current = base(`${serviceKey}:job:${job.id}`, 'qb', serviceKey, false);
        Object.assign(current, {
          instanceId: target.instanceId ?? undefined,
          instanceKey: target.instanceKey,
          hash: job.id,
          job,
        });
        setFiles(
          current,
          job.manifestFiles.map((f) => ({
            path: remoteJoin(job.savePath, f.path),
            size: f.size,
          })),
        );
        current.presence = 'current';
        current.effectsComplete = true;
        const sources = histories.flatMap((h) =>
          h.imports.filter((i) =>
            i.hash.toLowerCase() === job.id.toLowerCase() &&
            i.importedPath === h.path && i.sourcePath &&
            (h.target.instanceType === 'radarr' && 'movieFileId' in i &&
                i.movieFileId === h.fileId ||
              h.target.instanceType === 'sonarr' && i.episodeFileId === h.fileId &&
                i.episodeId !== undefined && h.episodeIds.includes(i.episodeId))
          ).map((i) => ({ h, i }))
        );
        current.provenanceFingerprint = serviceOwnedFingerprint(sources.map(({ h, i }) => ({
          serviceKey: `arr:${h.target.instanceId}`,
          recordId: h.recordId,
          fileId: h.fileId,
          path: h.path,
          size: h.size,
          episodeIds: h.episodeIds,
          import: i,
        })));
        current.matchedToSelection = sources.length > 0;
        if (sources.length) {
          const allOwned = job.manifestFiles.every((f) =>
            sources.some(({ h, i }) =>
              h.size === f.size &&
              i.sourcePath!.replaceAll('\\', '/').endsWith('/' + f.path)
            )
          );
          let exclusive = allOwned && currentInstances.size <= 1;
          if (exclusive) {
            for (
              const h of [
                ...new Map(sources.map(({ h }) => [`${h.target.instanceId}:${h.recordId}`, h]))
                  .values(),
              ]
            ) {
              exclusive &&= await read(() =>
                h.target.client.downloadIdIsExclusiveTo(h.recordId, job.id)
              );
            }
          }
          current.selected = input.qbSelected;
          current.retainedOwnership = exclusive ? undefined : true;
          if (!exclusive) {
            current.unavailableReason = 'Whole QB payload includes unproved or retained owners';
          }
        }
        const after = await read(() => target.client.findJob(summary.id));
        if (!after || stable(jobEvidence(job)) !== stable(jobEvidence(after))) {
          throw new Error('QB manifest changed');
        }
        actions.push(current);
      };
      qbContexts.push({
        target,
        serviceKey,
        all,
        summaries,
        loaded: new Set(),
        failed: false,
        collect,
      });
    } catch {
      failQb(target, serviceKey);
    }
  }
  // Discover overlap with newly observed payloads across every connected QB instance,
  // independent of summary ordering, without loading unrelated manifests.
  let expanded: boolean;
  do {
    expanded = false;
    for (const context of qbContexts) {
      if (context.failed) continue;
      try {
        for (const summary of context.all) {
          if (context.loaded.has(summary.id) || !relevantSummary(summary)) continue;
          context.loaded.add(summary.id);
          await context.collect(summary);
          expanded = true;
        }
      } catch {
        context.failed = true;
        failQb(context.target, context.serviceKey);
      }
    }
  } while (expanded);
  for (const { target, serviceKey, summaries, failed, all } of qbContexts) {
    if (failed) continue;
    try {
      if (input.qbSelected && provenanceUnavailable && all.length) {
        const unknownAssociation = base(`${serviceKey}:association`, 'qb', serviceKey, true);
        unknownAssociation.instanceKey = target.instanceKey;
        unknownAssociation.associationUnavailable = true;
        unknownAssociation.unavailableReason =
          'Current import provenance could not be verified; no QB deletion is authorized';
        actions.push(unknownAssociation);
      }
      const repeated: DownloadJobSummary[] = [];
      const repeatedIds = new Set<string>();
      await read(() =>
        target.client.scanJobSummaries!((summary) => {
          if (repeatedIds.has(summary.id) || repeatedIds.size >= MAX_ENTRIES) {
            throw new Error('Invalid QB inventory');
          }
          repeatedIds.add(summary.id);
          if (relevantSummary(summary)) repeated.push(summary);
          if (repeated.length > MAX_JOBS) throw new Error('Relevant QB inventory budget exceeded');
          return Promise.resolve();
        })
      );
      const summaryEvidence = (list: DownloadJobSummary[]) =>
        serviceOwnedFingerprint(
          list.map(({ id, size, contentPath, savePath }) => ({ id, size, contentPath, savePath }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        );
      const fingerprint = summaryEvidence(summaries);
      if (fingerprint !== summaryEvidence(repeated)) {
        throw new Error('Relevant QB inventory changed');
      }
      inventories.push({ serviceKey, fingerprint });
      if (!summaries.length) {
        const absent = base(`${serviceKey}:inventory`, 'qb', serviceKey, input.qbSelected);
        absent.presence = 'absent';
        absent.effectsComplete = true;
        absent.instanceKey = target.instanceKey;
        actions.push(absent);
      }
    } catch {
      failQb(target, serviceKey);
    }
  }
  // Scope retained Plex reads to this title and synced same-identity candidates.
  // The sync index is a discovery hint, not proof of global absence. Hidden aliases
  // without a concrete signal are outside the practical service-owned confidence policy.
  let retainedInventory = '';
  try {
    for (const entry of input.completedSiblingRetainedEntries ?? []) {
      retain(entry.serviceKey, entry.path);
    }
    for (const path of unselectedVersionPaths) retain(plexKey, path);
    const related = input.relatedPlexItems ? await read(input.relatedPlexItems) : [];
    if (related.length > 200) throw new Error('Related Plex title budget exceeded');
    if ((selection.type === 'season' || selection.type === 'episode') && selection.showRatingKey) {
      related.push({
        ratingKey: selection.showRatingKey,
        libraryKey: input.libraryKey,
        type: 'show',
      });
    }
    for (const candidate of new Map(related.map((item) => [item.ratingKey, item])).values()) {
      if (candidate.ratingKey === selection.ratingKey) continue;
      const owner = await read(() => input.plex.metadataIdentity(candidate.ratingKey));
      if (!owner) continue; // A successful scoped read, not a failed catalog scan.
      if (owner.librarySectionId !== candidate.libraryKey || owner.type !== candidate.type) {
        throw new Error('Related Plex identity changed');
      }
      const files = await read(() =>
        input.plex.mediaPathPreview(
          candidate.ratingKey,
          candidate.type,
          MAX_FILES,
          undefined,
          true,
          true,
        )
      );
      if (files.truncated || !files.versionFiles) throw new Error('Incomplete related Plex scope');
      charge(files.versionFiles.length);
      for (const file of files.versionFiles) {
        if (
          candidate.libraryKey === input.libraryKey &&
          selectedParts.some((part) =>
            part.ratingKey === file.ratingKey && part.mediaId === file.mediaId &&
            part.path === file.path
          )
        ) continue;
        retain(`plex:${candidate.libraryKey}`, file.path);
      }
    }
    retainedInventory = serviceOwnedFingerprint(
      [...retainedEntries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    );
  } catch {
    retainedInventory = 'unavailable';
    for (const action of actions) {
      if (
        !action.catalogOnly && action.presence === 'current' &&
        (action.service === 'plex' || action.selected)
      ) {
        action.effectsComplete = false;
        action.unavailableReason = 'Relevant retained Plex ownership could not be read';
      }
    }
  }
  // Known retained sidecars can be among Sonarr's linked extras even without a
  // sidecar-list endpoint. Include those risk paths in the atomic retention veto.
  const observedFiles = [...retainedEntries.values(), ...actions.flatMap((a) => [...a.entries])];
  for (const action of actions.filter((a) => a.associatedExtras)) {
    const sidecars = observedFiles.filter((entry) =>
      possibleSonarrSidecar(action, entry.path) &&
      !action.files.some((file) => file.path === entry.path)
    );
    if (sidecars.length) {
      setFiles(
        action,
        [...action.files, ...new Set(sidecars.map((entry) => entry.path))].map((file) =>
          typeof file === 'string' ? { path: file, size: null } : file
        ),
      );
    }
  }
  const connections = (input.connections ?? []).map(({ key, configurationIdentity }) => ({
    key,
    configurationIdentity,
  }));
  for (const target of targets) {
    if (!connections.some((c) => c.key === `arr:${target.instanceId}`)) {
      connections.push({
        key: `arr:${target.instanceId}`,
        configurationIdentity: await serviceOwnedFingerprint({
          url: endpoint(target.instanceUrl),
          updatedAt: target.configurationUpdatedAt,
        }),
      });
    }
  }
  for (const target of input.downloadTargets) {
    if (!connections.some((c) => c.key === `qb:${target.instanceKey}`)) {
      connections.push({
        key: `qb:${target.instanceKey}`,
        configurationIdentity: target.configurationIdentity,
      });
    }
  }
  connections.sort((a, b) => a.key.localeCompare(b.key));
  actions.sort((a, b) => a.id.localeCompare(b.id));
  const evidenceRevision = await serviceOwnedFingerprint({
    serverId: input.serverId,
    libraryKey: input.libraryKey,
    selection,
    connections,
    actions: actions.map(serviceOwnedActionEvidence),
    inventories,
    qbInventory,
    retainedInventory,
    retainedEntries: [...retainedEntries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    provenance: histories.map(({ target, ...history }) => ({
      ...history,
      serviceKey: `arr:${target.instanceId}`,
    })),
  });
  const retention = planServiceOwnedRetention({
    evidenceRevision,
    actions,
    retainedEntries: [...retainedEntries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    qbInventory,
  });
  const plan: Omit<ServiceOwnedPlan, 'fingerprint'> = {
    policyVersion: 4,
    confidencePolicy: 'service-owned-reasonable-v1',
    serverId: input.serverId,
    libraryKey: input.libraryKey,
    selection,
    arrSelected: input.arrSelected,
    qbSelected: input.qbSelected,
    connections,
    actions,
    retention,
    evidenceRevision,
    plexFiles: plexAction.files.filter((f): f is { path: string; size: number } => f.size !== null),
  };
  return { ...plan, fingerprint: serviceOwnedPlanFingerprint(plan) };
}
