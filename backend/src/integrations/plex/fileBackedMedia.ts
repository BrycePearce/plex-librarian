import type { PlexRawMetadata } from './types.ts';

export type PlexRawMedia = NonNullable<PlexRawMetadata['Media']>[number];
export type PlexRawPart = NonNullable<PlexRawMedia['Part']>[number];
export type ExistingFilePart = PlexRawPart & { file: string };
export type FileBackedMedia = PlexRawMedia & { id: number };

/** The one backend predicate for a Plex Media entry that still owns a file-backed Part. */
export function isExistingFilePart(part: PlexRawPart): part is ExistingFilePart {
  return typeof part.file === 'string' && part.file.length > 0 &&
    part.exists !== false && part.exists !== 0;
}

export function existingFileParts(media: PlexRawMedia): ExistingFilePart[] {
  return (media.Part ?? []).filter(isExistingFilePart);
}

export function isFileBackedMedia(media: PlexRawMedia): media is FileBackedMedia {
  return Number.isSafeInteger(media.id) && existingFileParts(media).length > 0;
}
