/** Plex owns edition identity; this badge never guesses from filenames or codecs. */
export function EditionBadge({ editionTitle }: { editionTitle?: string | null }) {
  return editionTitle
    ? <span className="badge badge-outline badge-sm" title="Plex edition">{editionTitle}</span>
    : null;
}
