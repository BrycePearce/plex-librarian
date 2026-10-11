import { PosterThumb } from "../../components/PosterThumb.tsx";
import { useEffect, useId, useRef, useState } from "react";
import "../../components/dataSurfaces.css";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  EyeOff,
  FolderOpen,
  ScanLine,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import type { MissingContentResponse } from "../../../../shared/missingContent.ts";
import { findingPresentation } from "./findingPresentation.ts";
import { FindingDetails } from "./FindingDetails.tsx";

type Row = MissingContentResponse["rows"][number];
export type MissingFilters = {
  type: string;
  library: string;
  instance: string;
  dismissed: boolean;
  offset: number;
};
const date = (value: number | null) =>
  value
    ? new Date(value * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "Not audited";
const timestamp = (value: number | null) =>
  value ? new Date(value * 1000).toLocaleString() : "Unknown";
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
  const inconclusive = filters.type === "inconclusive";
  const overview = data.overviewCounts ?? data.counts;
  const unverifiedCount = overview.version + overview.unable;
  const filtered =
    !!((filters.type && filters.type !== "review") || filters.library || filters.instance ||
      filters.dismissed);
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
        {(unverifiedCount > 0 || inconclusive) && (
          <button
            type="button"
            className="missing-unverified-link"
            aria-pressed={inconclusive}
            onClick={() => update({ type: inconclusive ? "review" : "inconclusive" })}
          >
            {unverifiedCount.toLocaleString()} couldn’t be verified<ChevronRight />
          </button>
        )}
        <details className="missing-about">
          <summary>
            <CircleHelp />About these findings<ChevronDown />
          </summary>
          <div>
            <p>
              Checks movies that Radarr reports as imported against their mapped Plex libraries.
              Episode Gaps checks missing TV episodes; this tool does not check movie collections.
            </p>
            <p>
              Unverified checks are separate from findings to review. Recent imports get 24 hours.
              These checks use catalog records, not physical files.
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
            { value: "review", label: "To review" },
            { value: "missing", label: "Missing" },
            { value: "metadata", label: "Metadata" },
          ].map(({ value, label }) => (
            <button
              type="button"
              key={value}
              aria-pressed={filters.type === value}
              className={filters.type === value ? "is-active" : ""}
              onClick={() => update({ type: value })}
            >
              {value !== "review" && <span className={`missing-kind-dot is-${value}`} />}
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
              onClick={() =>
                update({ type: "review", library: "", instance: "", dismissed: false })}
            >
              Reset
            </button>
          )}
        </div>
        {inconclusive && (
          <p className="missing-view-note">
            Unverified checks · These do not confirm a missing movie. Review is optional.
          </p>
        )}
        {!inconclusive && !busy && !needsConnection && !incomplete && !!data.scopes.length &&
          overview.missing === 0 && data.rows.length > 0 && (
          <p className="missing-view-note">
            No confirmed missing movies{filters.dismissed ? "" : " among visible findings"}.
            Metadata findings are listed below.
          </p>
        )}
        <div className="missing-results-status" role="status" aria-live="polite">
          {busy ? "Updating results…" : (
            <>
              <strong>{data.total.toLocaleString()}</strong>
              <span>
                {filtered ? "matching " : ""}
                {inconclusive
                  ? (data.total === 1 ? "unverified check" : "unverified checks")
                  : (data.total === 1 ? "finding to review" : "findings to review")}
              </span>
              {data.counts && (
                <span className="missing-result-breakdown">
                  {[
                    data.counts.missing ? `${data.counts.missing.toLocaleString()} missing` : "",
                    data.counts.metadata ? `${data.counts.metadata.toLocaleString()} metadata` : "",
                    data.counts.version
                      ? `${data.counts.version.toLocaleString()} copy checks`
                      : "",
                    data.counts.unable
                      ? `${data.counts.unable.toLocaleString()} need checking`
                      : "",
                  ].filter(Boolean).join(" · ")}
                </span>
              )}
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
                {filters.type === "missing" && !needsConnection && !incomplete &&
                    !!data.scopes.length
                  ? "No confirmed missing movies"
                  : filtered
                  ? "No matches"
                  : needsConnection
                  ? "No findings from available checks"
                  : incomplete || !data.scopes.length
                  ? "Your audit is still incomplete"
                  : "No confirmed missing movies"}
              </h2>
              <p>
                {filtered
                  ? "Try another filter or include hidden findings."
                  : needsConnection
                  ? "See the setup notice above for checks that aren’t available yet."
                  : incomplete || !data.scopes.length
                  ? "Run a sync to get a complete picture."
                  : unverifiedCount > 0
                  ? "No visible missing-movie or metadata findings. Some checks remain unverified; see Audit coverage above."
                  : "No visible missing-movie or metadata findings in the last complete audit."}
              </p>
              {filtered && (
                <button
                  type="button"
                  onClick={() =>
                    update({ type: "review", library: "", instance: "", dismissed: false })}
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
            <FindingDetails
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
          <PosterThumb
            thumb={null}
            src={row.posterUrl}
            mediaType="movie"
            width={75}
            height={90}
            loading="lazy"
            className="missing-movie-icon"
          />
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
            {findingPresentation(row).label}
          </span>
          <small>{findingPresentation(row).summary}</small>
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
