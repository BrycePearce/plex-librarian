import type { MediaVersion } from "./api";

export function versionLabel(v: MediaVersion): string {
  const parts: string[] = [];
  if (v.videoResolution) parts.push(v.videoResolution);
  if (v.videoFrameRate) parts.push(v.videoFrameRate);
  if (v.videoDynamicRange) parts.push(v.videoDynamicRange);
  if (v.videoCodec) parts.push(v.videoCodec.toUpperCase());
  // Progressive is the common case and not worth the label space; interlaced is the
  // one scan-type value that actually changes a keep/delete decision.
  if (v.videoScanType?.trim().toLowerCase() === "interlaced") {
    parts.push("Interlaced");
  }
  if (v.container) parts.push(v.container.toUpperCase());
  if (v.bitrate != null) parts.push(`${(v.bitrate / 1000).toFixed(1)} Mbps`);
  if (v.audioCodec) {
    const channels = v.audioChannels != null ? ` ${v.audioChannels}ch` : "";
    parts.push(`${v.audioCodec.toUpperCase()}${channels}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Unknown version";
}
