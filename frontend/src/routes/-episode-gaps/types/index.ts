import type { EpisodeGapsParams } from "@shared/types";

export type EpisodeGapsSearch =
  & Required<Pick<EpisodeGapsParams, "status" | "sort" | "order">>
  & Pick<EpisodeGapsParams, "libraryKey" | "search">
  & {
    offset: number;
    fixture?:
      | "gaps"
      | "clean"
      | "no-tv"
      | "unaudited"
      | "loading"
      | "syncing"
      | "error"
      | "large";
  };

export interface EpisodeGapSonarrTarget {
  id: number;
  name: string;
}
