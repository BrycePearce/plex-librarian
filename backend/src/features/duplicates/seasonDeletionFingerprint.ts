import type { episodeMediaVersions } from '../../db/schema.ts';

const PREVIEW_TTL_SECONDS = 5 * 60;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return '{' +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(',') +
      '}';
  }
  return JSON.stringify(value);
}

export async function seasonDeletionFingerprint(
  serverId: number,
  rows: readonly (typeof episodeMediaVersions.$inferSelect)[],
): Promise<string> {
  const evidence = rows.map((row) => ({
    serverId,
    libraryKey: row.libraryKey,
    showRatingKey: row.showRatingKey,
    seasonRatingKey: row.seasonRatingKey,
    episodeRatingKey: row.episodeRatingKey,
    mediaId: row.mediaId,
    fileSize: row.fileSize,
    updatedAt: row.updatedAt,
    seasonIndex: row.seasonIndex,
    episodeIndex: row.episodeIndex,
  })).sort((left, right) =>
    `${left.episodeRatingKey}\0${left.mediaId}`.localeCompare(
      `${right.episodeRatingKey}\0${right.mediaId}`,
    )
  );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(evidence)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function seasonDeletionPreviewExpiry(now = Math.floor(Date.now() / 1000)): number {
  return now + PREVIEW_TTL_SECONDS;
}

export function seasonDeletionPreviewIsFresh(expiresAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return Number.isSafeInteger(expiresAt) && expiresAt > now &&
    expiresAt <= now + PREVIEW_TTL_SECONDS;
}
