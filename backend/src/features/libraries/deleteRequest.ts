export type DeletionMode = 'coordinated' | 'plex-only';

export function isDeletionMode(value: unknown): value is DeletionMode {
  return value === 'coordinated' || value === 'plex-only';
}
