export interface SharingPlaybackObservation {
  accountId: number;
  observedAt: number;
  event: string;
  ip: string | null;
  networkKey: string | null;
  playerUuid: string | null;
  isLocal: boolean | null;
}

export interface SharingPlaybackPatterns {
  concurrentRemotePlaybackDays: number;
  maxRemoteNetworksPerHour: number;
}

// A missing pause/stop webhook must not leave a player "active" indefinitely. Six
// hours covers unusually long movies and sports while bounding false overlap from a
// client that disappeared without sending its closing event.
const SESSION_TIMEOUT_SECONDS = 6 * 60 * 60;
const RAPID_SWITCH_WINDOW_SECONDS = 60 * 60;
const START_EVENTS = new Set(['media.play', 'media.resume']);
const END_EVENTS = new Set(['media.pause', 'media.stop', 'media.scrobble']);

type ActiveRemotePlayback = {
  network: string;
  startedAt: number;
};

function networkFor(observation: SharingPlaybackObservation): string | null {
  return observation.networkKey ?? observation.ip;
}

export function sharingPlaybackPatterns(
  observations: SharingPlaybackObservation[],
): Map<number, SharingPlaybackPatterns> {
  const byAccount = new Map<number, SharingPlaybackObservation[]>();
  for (const observation of observations) {
    const account = byAccount.get(observation.accountId) ?? [];
    account.push(observation);
    byAccount.set(observation.accountId, account);
  }

  const result = new Map<number, SharingPlaybackPatterns>();
  for (const [accountId, accountObservations] of byAccount) {
    accountObservations.sort((a, b) => a.observedAt - b.observedAt);

    const active = new Map<string, ActiveRemotePlayback>();
    const concurrentDays = new Set<number>();
    const recentRemoteStarts: Array<{ observedAt: number; network: string }> = [];
    const networksInWindow = new Map<string, number>();
    let windowStart = 0;
    let maxRemoteNetworksPerHour = 0;

    for (const observation of accountObservations) {
      for (const [playerUuid, session] of active) {
        if (observation.observedAt - session.startedAt > SESSION_TIMEOUT_SECONDS) {
          active.delete(playerUuid);
        }
      }

      if (observation.event === 'media.play' && observation.isLocal === false) {
        const network = networkFor(observation);
        if (network) {
          recentRemoteStarts.push({ observedAt: observation.observedAt, network });
          networksInWindow.set(network, (networksInWindow.get(network) ?? 0) + 1);
          while (
            recentRemoteStarts[windowStart] &&
            observation.observedAt - recentRemoteStarts[windowStart].observedAt >
              RAPID_SWITCH_WINDOW_SECONDS
          ) {
            const expiredNetwork = recentRemoteStarts[windowStart].network;
            const remaining = (networksInWindow.get(expiredNetwork) ?? 1) - 1;
            if (remaining === 0) networksInWindow.delete(expiredNetwork);
            else networksInWindow.set(expiredNetwork, remaining);
            windowStart++;
          }
          maxRemoteNetworksPerHour = Math.max(
            maxRemoteNetworksPerHour,
            networksInWindow.size,
          );
        }
      }

      const playerUuid = observation.playerUuid;
      if (!playerUuid) continue;
      if (END_EVENTS.has(observation.event)) {
        active.delete(playerUuid);
        continue;
      }
      if (!START_EVENTS.has(observation.event)) continue;

      // A new local or incomplete start replaces any older remote session for this
      // player, but cannot itself contribute to remote concurrency.
      const network = networkFor(observation);
      active.delete(playerUuid);
      if (observation.isLocal !== false || !network) continue;

      for (const [otherPlayerUuid, session] of active) {
        if (otherPlayerUuid !== playerUuid && session.network !== network) {
          // UTC is intentional and deterministic; this is only a recurrence bucket,
          // not a claim about the user's local calendar day.
          concurrentDays.add(Math.floor(observation.observedAt / 86400));
          break;
        }
      }
      active.set(playerUuid, { network, startedAt: observation.observedAt });
    }

    result.set(accountId, {
      concurrentRemotePlaybackDays: concurrentDays.size,
      maxRemoteNetworksPerHour,
    });
  }
  return result;
}
