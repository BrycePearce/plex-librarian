import { AlertTriangle, CheckCircle2, Library, ScanLine } from "lucide-react";
import type { EpisodeGapsResponse } from "@shared/types";
import { DataSurface } from "../../../components/Workspace.tsx";
import { episodeGapsSummaryPresentation } from "../utils/summaryPresentation.ts";

export function EpisodeGapsSummary(
  { data, loading, scope }: {
    data: EpisodeGapsResponse | undefined;
    loading: boolean;
    scope: "episode" | "season";
  },
) {
  const presentation = episodeGapsSummaryPresentation(data, scope);
  const { irregularCount, missingCount, gapContainerCount } = presentation;
  const auditClean = !loading && irregularCount === 0;
  return (
    <section className="episode-gaps-summary" aria-label="Gap audit summary">
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
                : <strong>{missingCount?.toLocaleString() ?? "—"}</strong>}
              <span>{presentation.missingNoun} missing</span>
            </div>
            <p>
              Across {loading ? "—" : gapContainerCount?.toLocaleString() ?? "—"}{" "}
              {presentation.containerNoun} with internal gaps
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
              <small>
                {auditClean
                  ? `No irregular ${presentation.irregularNoun}`
                  : `Irregular ${presentation.irregularNoun}`}
              </small>
            </div>
          </div>
        </div>
      </DataSurface>
    </section>
  );
}
