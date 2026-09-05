import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import type { SonarrHistoricalPathPreview } from "@shared/types";

export interface SonarrRetainedPathsSummary {
  count: number;
  unverifiedCount: number;
  firstUnverifiedReason: string | null;
  liveOwnerCount: number;
  firstLiveOwnerReason: string | null;
}

export function sonarrRetainedPathsWarningCopy(summary: SonarrRetainedPathsSummary): {
  heading: string;
  detail: string;
} {
  const reasons = [
    summary.unverifiedCount > 0
      ? `${
        summary.unverifiedCount === 1 ? "Path" : `${summary.unverifiedCount} paths`
      } could not be verified: ${summary.firstUnverifiedReason}.`
      : null,
    summary.liveOwnerCount > 0
      ? `${
        summary.liveOwnerCount === 1
          ? "Live qBittorrent owner retained a path"
          : `Live qBittorrent owners retained ${summary.liveOwnerCount} paths`
      }: ${summary.firstLiveOwnerReason}.`
      : null,
  ].filter((reason): reason is string => reason !== null);
  return {
    heading: summary.unverifiedCount > 0
      ? `${summary.unverifiedCount} historical ${
        summary.unverifiedCount === 1 ? "location" : "locations"
      } could not be checked`
      : `${summary.liveOwnerCount} download ${
        summary.liveOwnerCount === 1 ? "path is" : "paths are"
      } protected`,
    detail: reasons.join(" "),
  };
}

export function sonarrRetainedPathsSummary(
  paths: readonly SonarrHistoricalPathPreview[],
): SonarrRetainedPathsSummary | null {
  const retained = paths.filter((entry) => entry.disposition !== "delete");
  if (retained.length === 0) return null;
  const unverified = retained.filter((entry) => entry.disposition === "unverified");
  const liveOwner = retained.filter((entry) => entry.disposition === "retain_live_qbittorrent");
  return {
    count: retained.length,
    unverifiedCount: unverified.length,
    firstUnverifiedReason: unverified[0]?.reason ?? null,
    liveOwnerCount: liveOwner.length,
    firstLiveOwnerReason: liveOwner[0]?.reason ?? null,
  };
}

export function SonarrRetainedPathsWarning({
  paths,
}: {
  paths: readonly SonarrHistoricalPathPreview[];
}) {
  const summary = sonarrRetainedPathsSummary(paths);
  if (!summary) return null;
  const copy = sonarrRetainedPathsWarningCopy(summary);

  return (
    <div
      role="status"
      className="mt-3 flex min-w-0 items-start gap-2.5 rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-base-content/85">
          {copy.heading}
        </p>
        <p className="mt-1 leading-relaxed text-base-content/60">
          {summary.unverifiedCount > 0
            ? "These files may already be gone or their folders may be unavailable. Current Plex/Sonarr files can still be deleted if their checks pass."
            : "These paths belong to qBittorrent jobs that are being kept."}
          {summary.unverifiedCount > 0 && summary.liveOwnerCount > 0 &&
            ` ${summary.liveOwnerCount} qBittorrent-owned ${
              summary.liveOwnerCount === 1 ? "path will" : "paths will"
            } also be kept.`}
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer text-base-content/65">
            Details and path settings
          </summary>
          <p className="mt-2 break-words leading-relaxed text-base-content/55">{copy.detail}</p>
          <Link
            to="/settings/sonarr-radarr"
            className="mt-2 inline-block link text-base-content/70"
          >
            Review storage paths
          </Link>
        </details>
      </div>
    </div>
  );
}
