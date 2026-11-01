/** Display only: keep the underlying Plex title and identity unchanged. */
export function titleWithEdition(title: string, editionTitle?: string | null): string {
  return editionTitle ? `${title} (${editionTitle})` : title;
}
