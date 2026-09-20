import { sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { mediaRemovals } from '../../db/schema.ts';

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
