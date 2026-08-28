import { useState } from "react";
import type { CSSProperties } from "react";
import { ExternalLink } from "lucide-react";
import type { SeasonGapShow } from "@shared/types";
import { PosterThumb } from "../../../components/PosterThumb.tsx";
import { ServiceIcon } from "../../../components/ServiceIcons.tsx";
import { usePosterPalette } from "../hooks/usePosterPalette.ts";
import type { EpisodeGapSonarrTarget } from "../types/index.ts";
import { episodeGapReasonLabel } from "../utils/formatters.ts";
import { NumberedRangeStrip } from "./EpisodeGapRow.tsx";

export function SeasonGapRow(
  { row, sonarrTargets }: { row: SeasonGapShow; sonarrTargets: EpisodeGapSonarrTarget[] },
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
        <PosterThumb thumb={row.showThumb} width={96} height={144} className="episode-gap-poster" />
        <div>
          <span className="episode-gap-library">{row.libraryTitle}</span>
          <h3>{row.showTitle}</h3>
          <p>Internal season range</p>
        </div>
      </div>
      <div className="episode-gap-finding">
        <div className="episode-gap-finding-title">
          {irregular ? "Season numbering needs review" : (
            <>
              <strong>{row.missingCount}</strong> season{row.missingCount === 1 ? "" : "s"} missing
            </>
          )}
        </div>
        <p>
          {irregular
            ? episodeGapReasonLabel(row.reason)
            : `${row.presentCount} of ${
              row.presentCount + row.missingCount
            } seasons present · inspected S${row.firstSeasonIndex}–S${row.lastSeasonIndex}`}
        </p>
        {!irregular && (
          <NumberedRangeStrip
            first={row.firstSeasonIndex!}
            last={row.lastSeasonIndex!}
            missingRanges={row.missingRanges}
            highlightedRange={highlightedRange}
            prefix="S"
            noun="season"
          />
        )}
        <div className="episode-gap-tokens" aria-label={irregular ? undefined : "Missing seasons"}>
          {irregular
            ? <span className="episode-gap-token">Irregular show metadata</span>
            : row.missingRanges.map((range) => (
              <span
                className="episode-gap-token"
                key={`${range.start}-${range.end}`}
                onPointerEnter={(event) => {
                  if (event.pointerType !== "touch") setHighlightedRange(range);
                }}
                onPointerLeave={() => setHighlightedRange(null)}
              >
                {range.start === range.end ? `S${range.start}` : `S${range.start}–S${range.end}`}
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
