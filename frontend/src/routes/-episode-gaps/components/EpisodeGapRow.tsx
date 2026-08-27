import { useState } from "react";
import type { CSSProperties } from "react";
import { ExternalLink } from "lucide-react";
import type { EpisodeGapSeason } from "@shared/types";
import { PosterThumb } from "../../../components/PosterThumb.tsx";
import { ServiceIcon } from "../../../components/ServiceIcons.tsx";
import { usePosterPalette } from "../hooks/usePosterPalette.ts";
import type { EpisodeGapSonarrTarget } from "../types/index.ts";
import { episodeGapReasonLabel } from "../utils/formatters.ts";

export function EpisodeGapRow(
  { row, sonarrTargets }: {
    row: EpisodeGapSeason;
    sonarrTargets: EpisodeGapSonarrTarget[];
  },
) {
  const irregular = row.status === "irregular";
  const [highlightedRange, setHighlightedRange] = useState<
    { start: number; end: number } | null
  >(null);
  const ambientPoster = row.showThumb
    ? `/api/proxy/thumb?path=${encodeURIComponent(row.showThumb)}&width=96&height=144`
    : null;
  const { palette, rowRef } = usePosterPalette(ambientPoster);
  const paletteStyle = palette
    ? {
      "--episode-palette-tl": palette.topLeft,
      "--episode-palette-tr": palette.topRight,
      "--episode-palette-br": palette.bottomRight,
      "--episode-palette-bl": palette.bottomLeft,
    } as CSSProperties
    : undefined;

  return (
    <article
      ref={rowRef}
      className={`episode-gap-row ${irregular ? "is-irregular" : ""}`}
      style={paletteStyle}
    >
      {palette && <span className="episode-gap-row-ambient" aria-hidden="true" />}
      <div className="episode-gap-show">
        <PosterThumb
          thumb={row.showThumb}
          width={96}
          height={144}
          className="episode-gap-poster"
        />
        <div>
          <span className="episode-gap-library">{row.libraryTitle}</span>
          <h3>{row.showTitle}</h3>
          <p>{row.seasonTitle || `Season ${row.seasonIndex}`}</p>
        </div>
      </div>
      <div className="episode-gap-finding">
        <div className="episode-gap-finding-title">
          {irregular ? "Numbering needs review" : (
            <>
              <strong>{row.missingCount}</strong> episode{row.missingCount === 1 ? "" : "s"} missing
            </>
          )}
        </div>
        <p>
          {irregular
            ? episodeGapReasonLabel(row.reason)
            : `${row.presentCount} of ${
              row.presentCount + row.missingCount
            } episodes present · inspected E${row.firstEpisodeIndex}–E${row.lastEpisodeIndex}`}
        </p>
        {!irregular && <EpisodeStrip row={row} highlightedRange={highlightedRange} />}
        <div className="episode-gap-tokens" aria-label={irregular ? undefined : "Missing episodes"}>
          {irregular
            ? <span className="episode-gap-token">Irregular metadata</span>
            : row.missingRanges.map((range) => (
              <span
                className="episode-gap-token"
                key={`${range.start}-${range.end}`}
                onPointerEnter={(event) => {
                  if (event.pointerType !== "touch") setHighlightedRange(range);
                }}
                onPointerLeave={() => setHighlightedRange(null)}
              >
                {range.start === range.end ? `E${range.start}` : `E${range.start}–E${range.end}`}
              </span>
            ))}
        </div>
      </div>
      <nav className="episode-gap-actions" aria-label={`Open ${row.showTitle}`}>
        <a
          className="episode-gap-service-action is-plex"
          href={`/api/tools/episode-gaps/open/plex/${encodeURIComponent(row.showRatingKey)}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in Plex"
          aria-label={`Open ${row.showTitle} in Plex`}
        >
          <span>Plex</span> <ExternalLink aria-hidden />
        </a>
        {sonarrTargets.map((target) => (
          <a
            key={target.id}
            className="episode-gap-service-action is-sonarr"
            href={`/api/tools/episode-gaps/open/sonarr/${target.id}/${
              encodeURIComponent(row.showRatingKey)
            }`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open in ${target.name}`}
            aria-label={`Open ${row.showTitle} in ${target.name}`}
          >
            <ServiceIcon service="sonarr" />
            <span>{sonarrTargets.length > 1 ? target.name : "Sonarr"}</span>
          </a>
        ))}
      </nav>
    </article>
  );
}

function EpisodeStrip({
  row,
  highlightedRange,
}: {
  row: EpisodeGapSeason;
  highlightedRange: { start: number; end: number } | null;
}) {
  const first = row.firstEpisodeIndex!;
  const last = row.lastEpisodeIndex!;
  const width = last - first + 1;
  const [hoveredEpisode, setHoveredEpisode] = useState<number | null>(null);
  const missing = (index: number) =>
    row.missingRanges.some((range) => index >= range.start && index <= range.end);
  const highlighted = (index: number) =>
    highlightedRange !== null &&
    index >= highlightedRange.start &&
    index <= highlightedRange.end;
  const tooltipRange = hoveredEpisode !== null
    ? { start: hoveredEpisode, end: hoveredEpisode }
    : highlightedRange;
  const tooltipMissing = hoveredEpisode !== null
    ? missing(hoveredEpisode)
    : highlightedRange !== null;
  const label = `Episodes ${first} through ${last}; missing ${
    row.missingRanges.map((range) =>
      range.start === range.end
        ? `episode ${range.start}`
        : `episodes ${range.start} through ${range.end}`
    ).join(", ")
  }`;

  if (width <= 32) {
    return (
      <div className="episode-strip is-cells" role="img" aria-label={label}>
        <div className="episode-strip-visual">
          {Array.from({ length: width }, (_, index) => first + index).map((index) => (
            <span
              className={`${missing(index) ? "is-gap" : ""} ${
                hoveredEpisode === index ? "is-hovered" : ""
              } ${highlighted(index) ? "is-related" : ""}`}
              key={index}
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") setHoveredEpisode(index);
              }}
              onPointerLeave={() => setHoveredEpisode(null)}
            >
              <i>{index}</i>
            </span>
          ))}
        </div>
        <EpisodeStripTooltip
          range={tooltipRange}
          first={first}
          width={width}
          missing={tooltipMissing}
        />
        <small>E{first}</small>
        <small>E{last}</small>
      </div>
    );
  }

  return (
    <div className="episode-strip is-track" role="img" aria-label={label}>
      <div
        className="episode-strip-visual"
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const position = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width - 1);
          setHoveredEpisode(first + Math.floor((position / bounds.width) * width));
        }}
        onPointerLeave={() => setHoveredEpisode(null)}
      >
        {row.missingRanges.map((range) => (
          <span
            className={`episode-strip-gap ${
              highlightedRange?.start === range.start && highlightedRange.end === range.end
                ? "is-related"
                : ""
            }`}
            key={range.start}
            style={{
              left: `${((range.start - first) / width) * 100}%`,
              width: `${((range.end - range.start + 1) / width) * 100}%`,
            }}
          />
        ))}
        {hoveredEpisode !== null && (
          <span
            className={`episode-strip-hover-marker ${missing(hoveredEpisode) ? "is-gap" : ""}`}
            style={{
              left: `${((hoveredEpisode - first) / width) * 100}%`,
              width: `${(1 / width) * 100}%`,
            }}
          />
        )}
      </div>
      <EpisodeStripTooltip
        range={tooltipRange}
        first={first}
        width={width}
        missing={tooltipMissing}
      />
      <small>E{first}</small>
      <small>E{last}</small>
    </div>
  );
}

function EpisodeStripTooltip({
  range,
  first,
  width,
  missing,
}: {
  range: { start: number; end: number } | null;
  first: number;
  width: number;
  missing: boolean;
}) {
  if (range === null) return null;
  const position = (((range.start + range.end) / 2 - first + 0.5) / width) * 100;
  const episodeLabel = range.start === range.end
    ? `E${range.start}`
    : `E${range.start}–E${range.end}`;
  return (
    <span
      aria-hidden="true"
      className={`episode-strip-tooltip ${missing ? "is-gap" : ""}`}
      style={{ left: `${Math.min(Math.max(position, 7), 93)}%` }}
    >
      {episodeLabel} <i aria-hidden /> {missing ? "Missing" : "Present"}
    </span>
  );
}
