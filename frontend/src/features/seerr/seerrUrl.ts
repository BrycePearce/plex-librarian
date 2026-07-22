interface ConnectionUrlSource {
  url: string;
}

export function suggestedSeerrUrl(
  sources: readonly ConnectionUrlSource[],
): string {
  // One connection says nothing about where Seerr runs. Require corroboration
  // from at least two configured services before suggesting a shared host.
  if (sources.length < 2) return "";

  const candidates: string[] = [];
  for (const source of sources) {
    try {
      const parsed = new URL(source.url);
      if (
        parsed.username ||
        parsed.password ||
        (parsed.pathname !== "/" && parsed.pathname !== "")
      ) return "";

      // Preserve the host exactly. A hostname such as `seerr` is valid only when
      // that specific Docker alias exists on a shared network; other service names
      // are not evidence that Plex Librarian can resolve an invented alias.
      parsed.port = "5055";
      parsed.pathname = "/";
      parsed.search = "";
      parsed.hash = "";
      candidates.push(parsed.toString().replace(/\/$/, ""));
    } catch {
      return "";
    }
  }

  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : "";
}
