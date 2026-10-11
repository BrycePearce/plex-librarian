import { ArrowUpRight, ChevronDown, Clock3, EyeOff } from "lucide-react";
import type { MissingContentResponse } from "../../../../shared/missingContent.ts";
import { findingPresentation } from "./findingPresentation.ts";

type Row = MissingContentResponse["rows"][number];
const timestamp = (value: number | null) =>
  value ? new Date(value * 1000).toLocaleString() : "Unknown";
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
function Identity({ tmdb, imdb }: { tmdb: string[]; imdb: string[] }) {
  return (
    <dl>
      {(["tmdb", "imdb"] as const).map((kind) => (
        <div key={kind}>
          <dt>{kind === "tmdb" ? "TMDB" : "IMDb"}</dt>
          <dd>{(kind === "tmdb" ? tmdb : imdb).join(", ") || "Not provided"}</dd>
        </div>
      ))}
    </dl>
  );
}
function ServiceLink({ row, ratingKey }: { row: Row; ratingKey?: string }) {
  const service = ratingKey === undefined ? "Radarr" : "Plex";
  const href = ratingKey === undefined
    ? `/api/tools/missing-content/open/${row.instanceId}/${
      encodeURIComponent(row.libraryKey)
    }/${row.movieId}`
    : `/api/tools/missing-content/plex/${encodeURIComponent(ratingKey)}`;
  return (
    <a
      className="missing-evidence-action"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${service}`}
    >
      {service}
      <ArrowUpRight />
    </a>
  );
}
function KeyEvidence({ row }: { row: Row }) {
  const { movie, matches } = row.evidence;
  const match = matches.length === 1 ? matches[0] : null;
  if (row.type === "metadata" && match) {
    const differences = (["tmdb", "imdb"] as const).filter((kind) =>
      movie[kind] && !match[kind].includes(movie[kind]!)
    );
    return (
      <div className="missing-key-evidence">
        <table className="missing-id-table">
          <caption className="sr-only">Movie identification differences</caption>
          <thead>
            <tr>
              <th scope="col">Movie ID</th>
              <th scope="col">Radarr</th>
              <th scope="col">Plex</th>
            </tr>
          </thead>
          <tbody>
            {differences.map((kind) => (
              <tr key={kind}>
                <th scope="row">{kind === "tmdb" ? "TMDB" : "IMDb"}</th>
                <td>{movie[kind]}</td>
                <td className="missing-id-conflict">{match[kind].join(", ") || "Not provided"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">
                <span className="sr-only">Open service</span>
              </th>
              <td>
                <ServiceLink row={row} />
              </td>
              <td>
                <ServiceLink row={row} ratingKey={match.ratingKey} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  }
  if (matches.length > 1) {
    return (
      <div className="missing-key-evidence missing-candidate-list">
        <div className="missing-evidence-heading">
          <span className="missing-evidence-label">Radarr</span>
          <ServiceLink row={row} />
        </div>
        <span className="missing-evidence-label">Plex matches</span>
        {matches.slice(0, 3).map((candidate) => (
          <a
            key={candidate.ratingKey}
            className="missing-match-link"
            target="_blank"
            rel="noreferrer"
            href={`/api/tools/missing-content/plex/${encodeURIComponent(candidate.ratingKey)}`}
          >
            {candidate.title}
            <ArrowUpRight />
          </a>
        ))}
        {matches.length > 3 && (
          <p className="missing-service-title">
            Showing 3 of {matches.length} matches. See Technical details for the rest.
          </p>
        )}
      </div>
    );
  }
  return (
    <dl className="missing-key-evidence missing-key-facts">
      <div>
        <dt>Radarr file</dt>
        <dd className="missing-fact-action">
          <span>{movie.path ? fileName(movie.path) : "File details unavailable"}</span>
          <ServiceLink row={row} />
        </dd>
      </div>
      {row.type === "version" && match
        ? (
          <div>
            <dt>Plex file</dt>
            <dd className="missing-fact-action">
              <span>
                {match.paths.length ? match.paths.map(fileName).join(" · ") : "Path not provided"}
              </span>
              <ServiceLink row={row} ratingKey={match.ratingKey} />
            </dd>
          </div>
        )
        : (
          <div>
            <dt>Plex match</dt>
            <dd className="missing-fact-action">
              <span>{match ? match.title : "No matching movie ID found"}</span>
              {match && <ServiceLink row={row} ratingKey={match.ratingKey} />}
            </dd>
          </div>
        )}
    </dl>
  );
}
export function FindingDetails(
  { row, dismiss, disabled }: { row: Row; dismiss: (row: Row) => void; disabled: boolean },
) {
  const view = findingPresentation(row);
  const { movie, matches } = row.evidence;
  return (
    <div className={`missing-evidence missing-detail is-${row.type}`}>
      {row.stale && (
        <p className="missing-stale-notice">
          <Clock3 />Saved evidence from an earlier audit. Sync Librarian before acting on it.
        </p>
      )}
      <div className="missing-evidence-intro">
        <div>
          <h3 className="missing-problem-title">{view.headline}</h3>
          <p>{view.explanation}</p>
        </div>
      </div>
      <KeyEvidence row={row} />
      <div className="missing-next-step">
        <h3>Next step</h3>
        <p>{view.nextStep}</p>
      </div>
      <div className="missing-detail-footer">
        <details className="missing-technical">
          <summary>
            Technical details<ChevronDown />
          </summary>
          <div className="missing-evidence-grid">
            <section>
              <h3>Radarr file</h3>
              <code>{movie.path ?? "Path not provided"}</code>
              <Identity
                tmdb={movie.tmdb ? [movie.tmdb] : []}
                imdb={movie.imdb ? [movie.imdb] : []}
              />
              <dl>
                <div>
                  <dt>Movie / file ID</dt>
                  <dd>{row.movieId} / {movie.fileId ?? "Unknown"}</dd>
                </div>
                <div>
                  <dt>Imported</dt>
                  <dd>{timestamp(movie.importedAt)}</dd>
                </div>
                <div>
                  <dt>Queue</dt>
                  <dd>{row.evidence.pending ? "Pending" : "No pending entry"}</dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>Plex files</h3>
              {!matches.length && <p className="missing-no-match">No matching entries.</p>}
              {matches.map((match) => (
                <div key={match.ratingKey}>
                  <a
                    className="missing-match-link"
                    target="_blank"
                    rel="noreferrer"
                    href={`/api/tools/missing-content/plex/${encodeURIComponent(match.ratingKey)}`}
                  >
                    {match.title}
                    <ArrowUpRight />
                  </a>
                  <Identity tmdb={match.tmdb} imdb={match.imdb} />
                  <p className="missing-service-title">Plex ID: {match.ratingKey}</p>
                  {match.paths.map((path) => <code key={path}>{path}</code>)}
                </div>
              ))}
            </section>
          </div>
          <p className="missing-technical-label">Comparison path</p>
          <code>{row.evidence.comparablePath ?? "Trusted file comparison unavailable"}</code>
          <p className="missing-audit-reason">Recorded reason: {row.evidence.reason}</p>
          <p className="missing-audit-reason">
            First seen {timestamp(row.firstSeen)} · Checked {timestamp(row.lastSeen)}
          </p>
        </details>
        <button
          className="missing-hide-finding"
          type="button"
          disabled={disabled}
          onClick={() => dismiss(row)}
        >
          <EyeOff />
          {row.dismissed ? "Restore finding" : "Hide finding"}
        </button>
      </div>
    </div>
  );
}
