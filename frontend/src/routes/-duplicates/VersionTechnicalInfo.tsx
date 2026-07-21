import { Info } from "lucide-react";
import type { MediaStreamSummary, MediaVersion } from "@shared/types";
import { HoverPopover } from "../../components/HoverPopover";
import { formatDuration, formatKilobytes } from "../../lib/format";

function text(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function streamLabel(
  stream: MediaStreamSummary,
  includeChannels: boolean,
): string {
  return [
    text(stream.language)?.toUpperCase(),
    text(stream.codec)?.toUpperCase(),
    includeChannels && stream.channels != null ? `${stream.channels}ch` : null,
    includeChannels ? text(stream.channelLayout) : null,
    text(stream.title),
    stream.forced ? "Forced" : null,
    stream.default ? "Default" : null,
  ].filter(Boolean).join(" / ") || "Unknown track";
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 leading-5">
      <dt className="text-base-content/45">{label}</dt>
      <dd className="min-w-0 break-words text-base-content/85">{value}</dd>
    </div>
  );
}

export function VersionTechnicalInfo({ version }: { version: MediaVersion }) {
  const dimensions = version.width != null && version.height != null
    ? `${version.width}x${version.height}`
    : text(version.videoResolution) ?? "Not reported";
  const video = [
    text(version.videoCodec)?.toUpperCase(),
    text(version.videoProfile),
    version.videoBitDepth != null ? `${version.videoBitDepth}-bit` : null,
    text(version.videoDynamicRange),
    text(version.videoFrameRate),
    text(version.videoScanType),
  ].filter(Boolean).join(" / ") || "Not reported";
  const audio = version.audioStreams.length > 0
    ? version.audioStreams.map((stream) => streamLabel(stream, true))
    : [
      [
        text(version.audioCodec)?.toUpperCase(),
        version.audioChannels != null ? `${version.audioChannels}ch` : null,
        text(version.audioProfile),
      ].filter(Boolean).join(" / ") || "Not reported",
    ];
  const subtitles = version.streamDetailsAvailable
    ? version.subtitleStreams.length > 0
      ? version.subtitleStreams.map((stream) => streamLabel(stream, false))
      : ["None"]
    : ["Not reported by Plex"];
  const file = [
    text(version.container)?.toUpperCase(),
    version.bitrate != null ? `${(version.bitrate / 1000).toFixed(1)} Mbps` : null,
    version.fileSize != null ? formatKilobytes(version.fileSize) : null,
    version.duration != null ? formatDuration(Math.round(version.duration / 1000)) : null,
  ].filter(Boolean).join(" / ") || "Not reported";

  return (
    <HoverPopover
      content={
        <div className="w-64 max-w-full">
          <div className="mb-1 font-semibold">Version details</div>
          <dl className="space-y-0.5">
            <DetailRow label="Resolution" value={dimensions} />
            <DetailRow label="Video" value={video} />
            <DetailRow label="File" value={file} />
            <DetailRow label="Audio" value={audio.join("; ")} />
            <DetailRow label="Subtitles" value={subtitles.join("; ")} />
          </dl>
        </div>
      }
    >
      <button
        type="button"
        className="inline-flex cursor-help text-base-content/40 transition-colors hover:text-base-content/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        aria-label="Show technical details for this version"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Info className="size-3.5" />
      </button>
    </HoverPopover>
  );
}
