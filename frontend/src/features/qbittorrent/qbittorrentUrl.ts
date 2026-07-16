interface ArrUrlSource {
  type: "radarr" | "sonarr";
  url: string;
}

export function suggestedQbittorrentUrl(
  instances: readonly ArrUrlSource[],
): string {
  if (instances.length === 0) return "";

  const candidates: string[] = [];
  for (const instance of instances) {
    try {
      const parsed = new URL(instance.url);
      if (
        parsed.username ||
        parsed.password ||
        (parsed.pathname !== "/" && parsed.pathname !== "")
      ) return "";

      // Docker Compose commonly uses service names. If Arr is reachable that way,
      // qBittorrent probably is too; LAN-address installations keep their shared host.
      if (parsed.hostname.toLowerCase() === instance.type) {
        parsed.hostname = "qbittorrent";
      }
      parsed.port = "8080";
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
