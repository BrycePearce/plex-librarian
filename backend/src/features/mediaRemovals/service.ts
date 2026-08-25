import { sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { mediaRemovals } from '../../db/schema.ts';

export type MediaRemovalTargetKind = 'item' | 'movie_version' | 'episode_version';

export interface RecordMediaRemovalInput {
  serverId: number;
  operationId: string;
  targetKind: MediaRemovalTargetKind;
  targetKey: string;
  mediaSize: number | null;
}

// A deletion request may be retried by its caller or replay its successful local
// bookkeeping after an ambiguous response. The composite unique key makes recording
// the same target within the same operation idempotent.
export async function recordMediaRemovals(inputs: RecordMediaRemovalInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const createdAt = Math.floor(Date.now() / 1000);
  await db.insert(mediaRemovals).values(
    inputs.map((input) => ({ ...input, createdAt })),
  ).onConflictDoNothing({
    target: [
      mediaRemovals.serverId,
      mediaRemovals.operationId,
      mediaRemovals.targetKind,
      mediaRemovals.targetKey,
    ],
  });
}

export async function getMediaRemovalSummary(serverId: number): Promise<{
  mediaSizeRemoved: number;
  verifiedHardlinkDataRemoved: number;
  removalCount: number;
  unknownSizeCount: number;
}> {
  const [summary] = await db.select({
    // Cast the potentially large aggregate to text because @db/sqlite's integer read
    // path truncates values outside the signed 32-bit range.
    mediaSizeRemoved: sql<
      string
    >`cast(coalesce(sum(case when ${mediaRemovals.logicalAttributable} then ${mediaRemovals.mediaSize} else 0 end), 0) as text)`,
    verifiedHardlinkDataRemoved: sql<
      string
    >`cast(coalesce(sum(${mediaRemovals.verifiedHardlinkDataSize}), 0) as text)`,
    removalCount: sql<number>`count(*) filter (where ${mediaRemovals.logicalAttributable})`,
    unknownSizeCount: sql<
      number
    >`count(*) filter (where ${mediaRemovals.logicalAttributable} and ${mediaRemovals.mediaSize} is null)`,
  }).from(mediaRemovals).where(sql`${mediaRemovals.serverId} = ${serverId}`);

  return {
    mediaSizeRemoved: Number(summary?.mediaSizeRemoved ?? 0),
    verifiedHardlinkDataRemoved: Number(summary?.verifiedHardlinkDataRemoved ?? 0),
    removalCount: summary?.removalCount ?? 0,
    unknownSizeCount: summary?.unknownSizeCount ?? 0,
  };
}
