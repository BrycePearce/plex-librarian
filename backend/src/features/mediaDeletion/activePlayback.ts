import type { PlexActiveSession } from '../../integrations/plex/types.ts';

export function activeWholeItemRatingKeys(
  selectedRatingKeys: ReadonlySet<string>,
  sessions: readonly PlexActiveSession[],
): Set<string> {
  const active = new Set<string>();
  for (const session of sessions) {
    if (selectedRatingKeys.has(session.ratingKey)) active.add(session.ratingKey);
    if (
      session.grandparentRatingKey && selectedRatingKeys.has(session.grandparentRatingKey)
    ) active.add(session.grandparentRatingKey);
  }
  return active;
}

export function mediaRatingKeyIsPlaying(
  ratingKey: string,
  sessions: readonly PlexActiveSession[],
): boolean {
  return sessions.some((session) => session.ratingKey === ratingKey);
}
