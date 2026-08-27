import { AlertTriangle, CheckCircle2, Library, ScanLine } from "lucide-react";
import type { EpisodeGapsResponse } from "@shared/types";
import { DataSurface } from "../../../components/Workspace.tsx";

export function EpisodeGapsSummary(
  { data, loading }: { data: EpisodeGapsResponse | undefined; loading: boolean },
) {
  const irregularCount = data?.summary.irregularSeasonCount;
  const auditClean = !loading && irregularCount === 0;
  return (
    <section className="episode-gaps-summary" aria-label="Episode audit summary">
      <DataSurface className="episode-gaps-overview">
        <div className="episode-gaps-overview-main">
          <span className="episode-gaps-overview-icon">
            <ScanLine />
          </span>
          <div>
            <span className="episode-gaps-overview-kicker">Audit findings</span>
            <div className="episode-gaps-overview-value">
              {loading
                ? <span className="skeleton h-9 w-20" />
                : <strong>{data?.summary.missingEpisodeCount.toLocaleString() ?? "—"}</strong>}
              <span>episodes missing</span>
            </div>
            <p>
              Across {loading ? "—" : data?.summary.gapSeasonCount.toLocaleString() ?? "—"}{" "}
              seasons with internal gaps
            </p>
          </div>
        </div>
        <div className="episode-gaps-overview-details">
          <div className="episode-gap-stat is-coverage">
            <Library />
            <div>
              <span>Coverage</span>
              {loading
                ? <span className="skeleton h-6 w-10" />
                : <strong>{data?.summary.checkedLibraryCount.toLocaleString() ?? "—"}</strong>}
              <small>TV libraries checked</small>
            </div>
          </div>
          <div className={`episode-gap-stat is-irregular ${auditClean ? "is-clear" : ""}`}>
            {auditClean ? <CheckCircle2 /> : <AlertTriangle />}
            <div>
              <span>{auditClean ? "Audit clean" : "Needs review"}</span>
              {loading
                ? <span className="skeleton h-6 w-10" />
                : <strong>{irregularCount?.toLocaleString() ?? "—"}</strong>}
              <small>{auditClean ? "No irregular seasons" : "Irregular seasons"}</small>
            </div>
          </div>
        </div>
      </DataSurface>
    </section>
  );
}
