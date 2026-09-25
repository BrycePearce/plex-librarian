import { discoverHistoricalSetup } from './historicalSetup.ts';
import {
  discoverHistoricalAccess,
  invalidateHistoricalAccessConfiguration,
} from './historicalDownloadAccess.ts';

export type HistoricalSetupMutation = { serverId: number; instanceIds: number[] };

/** Run after the successful write has finished, never from inside its handler.
 * Discovery snapshots must be taken after invalidation, and legacy sample
 * discovery must not race the verified setup proposal for this same mutation. */
export async function completeHistoricalConfigurationChange(
  serverId: number,
  setup?: HistoricalSetupMutation,
  dependencies = {
    invalidate: invalidateHistoricalAccessConfiguration,
    setup: discoverHistoricalSetup,
    legacy: discoverHistoricalAccess,
  },
): Promise<void> {
  dependencies.invalidate(serverId);
  if (setup?.serverId === serverId) {
    for (const instanceId of [...new Set(setup.instanceIds)].slice(0, 20)) {
      await dependencies.setup(serverId, instanceId);
    }
  } else {
    await dependencies.legacy(serverId);
  }
}
