import type { MediaVersion } from "./api";

export function versionLabel(v: MediaVersion): string {
  const parts: string[] = [];
  if (v.videoResolution) parts.push(v.videoResolution);
  if (v.videoCodec) parts.push(v.videoCodec.toUpperCase());
  if (v.container) parts.push(v.container.toUpperCase());
  if (v.bitrate != null) parts.push(`${(v.bitrate / 1000).toFixed(1)} Mbps`);
  return parts.length > 0 ? parts.join(" · ") : "Unknown version";
}
