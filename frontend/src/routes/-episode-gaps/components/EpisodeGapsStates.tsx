import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { DataSurface } from "../../../components/Workspace.tsx";

export function EpisodeGapsSkeleton() {
  return (
    <div className="episode-gaps-results" aria-label="Loading episode gap findings">
      {[1, 2, 3].map((key) => (
        <div className="episode-gap-row episode-gap-skeleton" key={key}>
          <span className="skeleton episode-gap-poster" />
          <div className="space-y-3 flex-1">
            <span className="skeleton h-4 w-1/3" />
            <span className="skeleton h-7 w-1/2" />
            <span className="skeleton h-4 w-4/5" />
            <span className="skeleton h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EpisodeGapsEmpty(
  { icon: Icon, title, description, action, celebrate = false }: {
    icon: LucideIcon;
    title: string;
    description: string;
    action?: ReactNode;
    celebrate?: boolean;
  },
) {
  return (
    <DataSurface className={`episode-gaps-empty ${celebrate ? "is-clean" : ""}`}>
      <span>
        <Icon />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </DataSurface>
  );
}
