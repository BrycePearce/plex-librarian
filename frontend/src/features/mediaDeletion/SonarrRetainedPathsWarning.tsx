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
    heading: `${summary.count} known historical Sonarr ${
      summary.count === 1 ? "path" : "paths"
    } will be retained`,
    detail: `${
      reasons.join(" ")
    } Full logical-media-byte reclamation is not expected, so physical disk space may remain occupied.`,
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
    <div role="alert" className="alert alert-warning mt-2 items-start gap-2.5 py-2 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-semibold">
          {copy.heading}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed">
          {copy.detail} You can continue with managed-only deletion or review{" "}
          <Link to="/settings/sonarr-radarr" className="link font-medium">
            Historical hardlink cleanup
          </Link>{" "}
          in Media connections.
        </p>
      </div>
    </div>
  );
}
