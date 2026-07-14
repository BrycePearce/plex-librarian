// Plex account avatars (auth status, users page) are plex.tv URLs. Rendering them
// directly makes the browser send a credentialed third-party request — plex.tv sets
// a cookie on it — so route them through the backend proxy instead. Anything that
// isn't a plex.tv URL is passed through untouched (the proxy would reject it anyway).
export function avatarUrl(thumb: string): string {
  try {
    const host = new URL(thumb).hostname;
    if (host === "plex.tv" || host.endsWith(".plex.tv")) {
      return `/api/proxy/avatar?url=${encodeURIComponent(thumb)}`;
    }
  } catch {
    // Relative or malformed URL — nothing third-party about it, render as-is.
  }
  return thumb;
}
