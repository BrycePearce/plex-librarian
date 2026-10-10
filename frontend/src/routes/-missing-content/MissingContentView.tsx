import { useEffect, useId, useRef, useState } from "react";
import "../../components/dataSurfaces.css";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  EyeOff,
  Film,
  FolderOpen,
  ScanLine,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  type MissingContentResponse,
  missingFindingLabels,
} from "../../../../shared/missingContent.ts";

type Row = MissingContentResponse["rows"][number];
type Kind = Row["type"];
export type MissingFilters = {
  type: string;
  library: string;
  instance: string;
  dismissed: boolean;
  offset: number;
};
const kinds: Record<Kind, { label: string; hint: string }> = {
  missing: { label: "Missing", hint: "No match in the expected Plex library." },
  metadata: { label: "Metadata", hint: "The file is present, but its metadata needs review." },
  version: { label: "Copy unverified", hint: "Movie found. File comparison is inconclusive." },
  unable: { label: "Unverified", hint: "More evidence is needed before calling this missing." },
};
const date = (value: number | null) =>
  value
    ? new Date(value * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "Not audited";
const timestamp = (value: number | null) =>
  value ? new Date(value * 1000).toLocaleString() : "Unknown";
function versionExplanation(row: Row): string {
  const samePath = row.evidence.movie.path &&
    row.evidence.matches.some((match) => match.paths.includes(row.evidence.movie.path!));
  if (!row.evidence.comparablePath) {
    return samePath
      ? "Plex has this movie, and both services report the same path. Librarian cannot yet verify that they refer to the same stored file."
      : "Plex has this movie. Librarian cannot compare its file location with Radarr until a trusted path mapping is available.";
  }
  return "Plex has this movie, but its file path was not matched to the Radarr-managed file through the configured mappings.";
}
function nextStep(row: Row): string {
  if (row.type === "version" && !row.evidence.comparablePath) {
    return "No movie repair is indicated by this result. File verification needs connection-level path setup, which is not available in this build’s UI. A sync alone will not resolve it.";
  }
  if (row.type === "version") {
    return "Compare the paths below and check the mappings. If Plex has not indexed the expected file, scan the movie library in Plex, then sync Librarian.";
  }
  if (row.type === "metadata") {
    return "Compare the IDs below. Correct the movie match in the service with the wrong metadata, then sync Librarian.";
  }
  if (row.type === "missing") {
    return "Check that Radarr’s file is in the intended Plex library. If it is available, scan that library in Plex, then sync Librarian.";
  }
  if (row.evidence.pending || row.evidence.reason.includes("grace")) {
    return "Let the import finish and allow the 24-hour grace period, then sync Librarian again.";
  }
  return "Review the audit coverage and evidence below. Resolve incomplete provider reads or mapping issues, then sync Librarian.";
}
function summary(row: Row): string {
  if (row.type === "version" && !row.evidence.comparablePath) {
    return "Movie found. Path mapping needs review.";
  }
  if (row.type === "metadata") {
    if (!row.evidence.matches.some((match) => match.exact)) {
      return "Identity matches; metadata and managed copy need review.";
    }
    return row.evidence.reason.includes("lacks")
      ? "Exact file found. Plex is missing a provider ID."
      : "Exact file found. Provider IDs disagree.";
  }
  if (row.type === "unable" && row.evidence.pending) {
    return "An import is still in the Radarr queue.";
  }
  if (row.type === "unable" && row.evidence.reason.includes("grace")) {
    return "Recent import. Waiting for the 24-hour grace period.";
  }
  return kinds[row.type].hint;
}

export function MissingContentView(
  { data, filters, busy, update, dismiss, dismissing, dismissalError }: {
    data: MissingContentResponse;
    filters: MissingFilters;
    busy: boolean;
    update: (next: Partial<MissingFilters>) => void;
    dismiss: (row: Row) => void;
    dismissing: boolean;
    dismissalError: boolean;
  },
) {
  const [selected, setSelected] = useState<Row | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogTitle = useId();
  useEffect(() => {
    if (selected) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [selected]);
  const instanceName = (id: number) =>
    data.instances.find((i) => i.id === id)?.name ?? `Radarr ${id}`;
  const libraryName = (key: string) =>
    data.libraries.find((l) => l.key === key)?.title ?? (key || "Unmapped");
  const incomplete = data.scopes.filter((s) => s.status !== "complete").length;
  const lastAudit = data.scopes.reduce(
    (latest, scope) => Math.max(latest, scope.completedAt ?? 0),
    0,
  );
  const needsConnection = !data.setup.plexConnected || !data.instances.length ||
    data.setup.unmappedInstances.length > 0;
  const limitedComparison = data.setup.fileComparisonUnavailable.length > 0;
  const setupTitle = !data.setup.plexConnected
    ? "Connect Plex to get started"
    : !data.instances.length
    ? "Connect Radarr to check for missing movies"
    : "Choose which libraries to compare";
  const setupAction = !data.setup.plexConnected
    ? "Connect Plex"
    : !data.instances.length
    ? "Connect Radarr"
    : "Map libraries";
  const filtered = !!(filters.type || filters.library || filters.instance || filters.dismissed);
  return (
    <>
      {needsConnection && (
        <section className="missing-setup" aria-label="Audit setup">
          <div className="missing-setup-heading">
            <div>
              <h2>{setupTitle}</h2>
              <p>Finish connection setup to enable these checks.</p>
            </div>
            {needsConnection && (
              <a
                className="missing-service-link"
                href={!data.setup.plexConnected ? "/setup" : "/settings/sonarr-radarr"}
              >
                {setupAction}
                <ArrowUpRight />
              </a>
            )}
          </div>
          <details>
            <summary>
              What’s needed<ChevronDown />
            </summary>
            <div className="missing-setup-requirements">
              {!data.setup.plexConnected && (
                <p>
                  <strong>Plex:</strong>{" "}
                  sign in and select the server that holds your movie libraries.
                </p>
              )}
              {data.setup.plexConnected && !data.instances.length && (
                <p>
                  <strong>Radarr:</strong>{" "}
                  have its server URL and API key ready. Connect it, then select the matching Plex
                  movie libraries.
                </p>
              )}
              {!!data.setup.unmappedInstances.length && (
                <p>
                  <strong>Library selection:</strong> edit{" "}
                  {data.setup.unmappedInstances.map((i) => i.name).join(", ")}{" "}
                  in Connections and select the Plex movie libraries it manages.
                </p>
              )}
              {needsConnection && (
                <p>After saving, run a sync from the dashboard to populate the audit.</p>
              )}
            </div>
          </details>
        </section>
      )}
      <div className="missing-disclosures">
        <details className="missing-coverage">
          <summary>
            <span className={`missing-status-dot ${incomplete ? "is-stale" : ""}`} />Audit
            coverage<span className="missing-count">
              {data.scopes.length - incomplete}/{data.scopes.length} complete
            </span>
            <ChevronDown />
          </summary>
          <div className="missing-coverage-body">
            {!data.instances.length && (
              <p>
                Connect Radarr in{" "}
                <a href="/settings/sonarr-radarr">Settings</a>, map a library, then run a sync.
              </p>
            )}
            {data.scopes.map((scope) => (
              <div className="missing-scope" key={`${scope.instanceId}/${scope.libraryKey}`}>
                <Server />
                <div>
                  <strong>
                    {instanceName(scope.instanceId)}
                    <span>/ {libraryName(scope.libraryKey)}</span>
                  </strong>
                  <small>
                    {scope.status === "complete"
                      ? `Audited ${timestamp(scope.completedAt)}`
                      : scope.reason ?? "Waiting for a complete sync."}
                  </small>
                  {scope.status !== "complete" && (
                    <small>
                      Last complete: {scope.completedAt ? timestamp(scope.completedAt) : "Never"}
                      {" "}
                      · Attempt: {timestamp(scope.attemptedAt)}
                    </small>
                  )}
                </div>
                <span className={`missing-state ${scope.status === "complete" ? "" : "is-stale"}`}>
                  {scope.status === "complete" ? "Current" : "Incomplete"}
                </span>
              </div>
            ))}
            {limitedComparison && (
              <div className="missing-comparison-note">
                <p>
                  <strong>Movie matching is available.</strong>{" "}
                  Exact-copy comparison is not available for every library.
                </p>
                <p>
                  It requires trusted file-path mappings, which this build cannot configure in the
                  UI. This does not indicate a missing movie or require a repair.
                </p>
                <p className="missing-footnote">
                  Applies to: {data.setup.fileComparisonUnavailable.map((scope) =>
                    `${instanceName(scope.instanceId)} / ${libraryName(scope.libraryKey)}`
                  ).join(" · ")}
                </p>
              </div>
            )}
            <p className="missing-footnote">
              Updated by normal syncs. Failed reads retain previous findings as stale.
            </p>
          </div>
        </details>
        <details className="missing-about">
          <summary>
            <CircleHelp />About these findings<ChevronDown />
          </summary>
          <div>
            <p>
              Only “Missing” indicates catalog absence. Metadata and version findings need review.
            </p>
            <p>
              Recent imports get 24 hours. This audit checks catalog records, not physical files.
            </p>
          </div>
        </details>
        <div className="missing-overview-meta">
          <span>
            <Clock3 />Last audit <strong title={timestamp(lastAudit)}>{date(lastAudit)}</strong>
          </span>
          <span className={incomplete ? "missing-warning" : ""}>
            {incomplete ? <CircleHelp /> : <ShieldCheck />}
            {!data.scopes.length
              ? "Awaiting first sync"
              : incomplete
              ? `${incomplete} ${incomplete === 1 ? "scope needs" : "scopes need"} a refresh`
              : "All mapped libraries audited"}
          </span>
        </div>
      </div>

      <section className="missing-results" aria-label="Saved findings">
        <div className="missing-filter-tabs" role="group" aria-label="Finding type">
          {[
            { value: "", label: "All findings" },
            ...Object.entries(kinds).map(([value, kind]) => ({ value, label: kind.label })),
          ].map(({ value, label }) => (
            <button
              type="button"
              key={value}
              aria-pressed={filters.type === value}
              className={filters.type === value ? "is-active" : ""}
              onClick={() => update({ type: value })}
            >
              {value && <span className={`missing-kind-dot is-${value}`} />}
              {label}
            </button>
          ))}
        </div>
        <div className="missing-filter-bar">
          <label className="missing-select">
            <FolderOpen />
            <span className="sr-only">Library</span>
            <select
              aria-label="Library"
              value={filters.library}
              onChange={(event) => update({ library: event.target.value })}
            >
              <option value="">All libraries</option>
              {data.libraries.map((library) => (
                <option key={library.key} value={library.key}>{library.title}</option>
              ))}
            </select>
            <ChevronDown />
          </label>
          <label className="missing-select">
            <Server />
            <span className="sr-only">Radarr instance</span>
            <select
              aria-label="Radarr instance"
              value={filters.instance}
              onChange={(event) => update({ instance: event.target.value })}
            >
              <option value="">All Radarr instances</option>
              {data.instances.map((instance) => (
                <option key={instance.id} value={instance.id}>{instance.name}</option>
              ))}
            </select>
            <ChevronDown />
          </label>
          <label className="missing-hidden">
            <input
              type="checkbox"
              checked={filters.dismissed}
              onChange={(event) => update({ dismissed: event.target.checked })}
            />
            <EyeOff />
            <span>Include hidden</span>
          </label>
          {filtered && (
            <button
              type="button"
              className="missing-clear"
              onClick={() => update({ type: "", library: "", instance: "", dismissed: false })}
            >
              Reset
            </button>
          )}
        </div>
        <div className="missing-results-status" role="status" aria-live="polite">
          {busy ? "Updating results…" : (
            <>
              <strong>{data.total.toLocaleString()}</strong>
              <span>{filtered ? "matching " : ""}{data.total === 1 ? "finding" : "findings"}</span>
            </>
          )}
        </div>
        {dismissalError && (
          <p role="alert" className="missing-error">Couldn’t save that change. Please try again.</p>
        )}
        <div aria-busy={busy} className={busy ? "missing-list is-updating" : "missing-list"}>
          {!!data.rows.length && (
            <div className="missing-list-heading">
              <span>Movie</span>
              <span>Finding</span>
              <span>Checked</span>
              <span />
            </div>
          )}
          {data.rows.map((row) => (
            <FindingRow
              key={`${row.instanceId}/${row.libraryKey}/${row.movieId}`}
              row={row}
              instance={instanceName(row.instanceId)}
              library={libraryName(row.libraryKey)}
              onOpen={() => setSelected(row)}
            />
          ))}
          {!data.rows.length && (
            <div className="missing-empty">
              <span>{incomplete || !data.scopes.length ? <ScanLine /> : <Check />}</span>
              <h2>
                {filtered
                  ? "No matches"
                  : needsConnection
                  ? "No findings from available checks"
                  : incomplete || !data.scopes.length
                  ? "Your audit is still incomplete"
                  : "Nothing to review"}
              </h2>
              <p>
                {filtered
                  ? "Try another filter or include hidden findings."
                  : needsConnection
                  ? "See the setup notice above for checks that aren’t available yet."
                  : incomplete || !data.scopes.length
                  ? "Run a sync to get a complete picture."
                  : "No visible discrepancies in the last complete audit."}
              </p>
              {filtered && (
                <button
                  type="button"
                  onClick={() => update({ type: "", library: "", instance: "", dismissed: false })}
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
        <footer className="missing-pagination">
          <span>
            {data.total
              ? `${filters.offset + 1}–${
                Math.min(filters.offset + 50, data.total)
              } of ${data.total.toLocaleString()}`
              : "0 results"}
          </span>
          <nav aria-label="Results pages">
            <button
              type="button"
              aria-label="Previous page"
              disabled={!filters.offset || busy}
              onClick={() => update({ offset: Math.max(0, filters.offset - 50) })}
            >
              <ChevronLeft />
            </button>
            <button
              type="button"
              aria-label="Next page"
              disabled={filters.offset + 50 >= data.total || busy}
              onClick={() => update({ offset: filters.offset + 50 })}
            >
              <ChevronRight />
            </button>
          </nav>
        </footer>
      </section>
      <dialog
        ref={dialogRef}
        className="modal missing-dialog"
        aria-labelledby={dialogTitle}
        onClose={() => setSelected(null)}
      >
        <div className="modal-box polished-modal missing-dialog-box">
          <header className="missing-dialog-header">
            <div>
              <span className="missing-eyebrow">Finding details</span>
              <h2 id={dialogTitle}>
                {selected?.title} <span>{selected?.evidence.movie.year}</span>
              </h2>
              {selected && (
                <p>
                  {libraryName(selected.libraryKey)} · {instanceName(selected.instanceId)}
                  {selected.stale ? " · Stale audit" : ""}
                </p>
              )}
            </div>
            <button
              type="button"
              className="btn btn-sm btn-circle btn-ghost"
              aria-label="Close finding details"
              onClick={() => dialogRef.current?.close()}
            >
              <X />
            </button>
          </header>
          {selected && (
            <FindingEvidence
              row={selected}
              disabled={dismissing || busy}
              dismiss={(row) => {
                dismiss(row);
                dialogRef.current?.close();
              }}
            />
          )}
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="submit">Close finding details</button>
        </form>
      </dialog>
    </>
  );
}

function FindingRow(
  { row, instance, library, onOpen }: {
    row: Row;
    instance: string;
    library: string;
    onOpen: () => void;
  },
) {
  return (
    <div className={`missing-row is-${row.type}`}>
      <button type="button" className="missing-row-summary" aria-haspopup="dialog" onClick={onOpen}>
        <div className="missing-movie">
          <span className="missing-movie-icon">
            <Film />
          </span>
          <div>
            <div className="missing-movie-title">
              <strong>{row.title}</strong>
              <span>{row.evidence.movie.year}</span>
              {row.stale && <span className="missing-stale-tag">Stale</span>}
              {row.dismissed && <EyeOff aria-label="Dismissed" />}
            </div>
            <span className="missing-movie-source">
              {library}
              <i />
              {instance}
            </span>
          </div>
        </div>
        <div className="missing-finding">
          <span className={`missing-kind is-${row.type}`}>
            <span />
            {kinds[row.type].label}
          </span>
          <small>{summary(row)}</small>
        </div>
        <time
          className="missing-checked"
          dateTime={new Date(row.lastSeen * 1000).toISOString()}
          title={timestamp(row.lastSeen)}
        >
          {date(row.lastSeen)}
        </time>
        <ChevronRight className="missing-row-chevron" />
      </button>
    </div>
  );
}

function FindingEvidence(
  { row, dismiss, disabled }: { row: Row; dismiss: (row: Row) => void; disabled: boolean },
) {
  return (
    <div className="missing-evidence">
      <div className="missing-evidence-intro">
        <div>
          <h3 className="missing-problem-title">
            {row.type === "version"
              ? (!row.evidence.comparablePath
                ? "File verification unavailable"
                : "File match unconfirmed")
              : missingFindingLabels[row.type]}
          </h3>
          <p>{row.type === "version" ? versionExplanation(row) : row.evidence.reason}</p>
        </div>
      </div>
      <div className="missing-next-step">
        <h3>
          {row.type === "version" && !row.evidence.comparablePath
            ? "What this means for you"
            : "Next step"}
        </h3>
        <p>{nextStep(row)}</p>
      </div>
      <details className="missing-technical">
        <summary>
          Compare paths and IDs <ChevronDown />
        </summary>
        <a
          className="missing-service-link"
          target="_blank"
          rel="noreferrer"
          href={`/api/tools/missing-content/open/${row.instanceId}/${
            encodeURIComponent(row.libraryKey)
          }/${row.movieId}`}
        >
          Open Radarr<ArrowUpRight />
        </a>
        <div className="missing-evidence-grid">
          <section>
            <h3>
              <ArrowDownToLine />Expected copy
            </h3>
            <dl>
              <div>
                <dt>TMDB / IMDb</dt>
                <dd>{row.evidence.movie.tmdb ?? "—"} / {row.evidence.movie.imdb ?? "—"}</dd>
              </div>
              <div>
                <dt>Movie / file ID</dt>
                <dd>{row.movieId} / {row.evidence.movie.fileId ?? "—"}</dd>
              </div>
              <div>
                <dt>Imported</dt>
                <dd>{timestamp(row.evidence.movie.importedAt)}</dd>
              </div>
              <div>
                <dt>Queue</dt>
                <dd>{row.evidence.pending ? "Pending" : "No pending entry"}</dd>
              </div>
            </dl>
            <code>{row.evidence.movie.path ?? "No managed path"}</code>
            <details className="missing-path-detail">
              <summary>Comparison path</summary>
              <code>
                {row.evidence.comparablePath ?? "Trusted mapping unavailable or ambiguous"}
              </code>
            </details>
          </section>
          <section>
            <h3>
              <Film />Plex evidence
            </h3>
            {!row.evidence.matches.length && (
              <p className="missing-no-match">No verified match in this library.</p>
            )}
            {row.evidence.matches.map((match) => (
              <div className="missing-plex-match" key={match.ratingKey}>
                <a
                  target="_blank"
                  rel="noreferrer"
                  href={`/api/tools/missing-content/plex/${encodeURIComponent(match.ratingKey)}`}
                >
                  {match.title}
                  <ArrowUpRight />
                </a>
                <dl>
                  <div>
                    <dt>TMDB / IMDb</dt>
                    <dd>{match.tmdb.join(", ") || "—"} / {match.imdb.join(", ") || "—"}</dd>
                  </div>
                  <div>
                    <dt>Managed path</dt>
                    <dd>{match.exact ? "Exact match" : "Unverified"}</dd>
                  </div>
                </dl>
                {match.paths.map((path) => <code key={path}>{path}</code>)}
              </div>
            ))}
          </section>
        </div>
      </details>
      <div className="missing-evidence-footer">
        <span>First seen {timestamp(row.firstSeen)} · Checked {timestamp(row.lastSeen)}</span>
        <button type="button" disabled={disabled} onClick={() => dismiss(row)}>
          <EyeOff />
          {row.dismissed ? "Restore finding" : "Hide finding"}
        </button>
      </div>
    </div>
  );
}
