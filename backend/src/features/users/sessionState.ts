import type { PlexActiveSession } from '../../integrations/plex/index.ts';

export interface SessionLifecycleEvent {
  event: 'media.play' | 'media.pause' | 'media.resume' | 'media.stop';
  session: PlexActiveSession;
}

export function sessionEventsForSnapshot(
  previous: ReadonlyMap<string, PlexActiveSession>,
  currentSessions: PlexActiveSession[],
): { next: Map<string, PlexActiveSession>; events: SessionLifecycleEvent[] } {
  const next = new Map(currentSessions.map((session) => [session.sessionKey, session]));
  const events: SessionLifecycleEvent[] = [];

  for (const session of currentSessions) {
    const prior = previous.get(session.sessionKey);
    if (!prior) {
      events.push({ event: 'media.play', session });
      if (session.state === 'paused') events.push({ event: 'media.pause', session });
      continue;
    }

    if (prior.state !== 'paused' && session.state === 'paused') {
      events.push({ event: 'media.pause', session });
    } else if (prior.state === 'paused' && session.state !== 'paused') {
      events.push({ event: 'media.resume', session });
    }
  }

  for (const [sessionKey, session] of previous) {
    if (!next.has(sessionKey)) events.push({ event: 'media.stop', session });
  }

  return { next, events };
}
