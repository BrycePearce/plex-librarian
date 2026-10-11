import type { MissingContentResponse } from "../../../../shared/missingContent.ts";

type Row = MissingContentResponse["rows"][number];
export interface FindingPresentation {
  label: string;
  headline: string;
  summary: string;
  explanation: string;
  nextStep: string;
  radarrSummary: string;
  plexSummary: string;
}

/** Saved findings predate structured diagnoses; preserve their classification precedence. */
function diagnosisCode(row: Row): string {
  if (row.evidence.diagnosis) return row.evidence.diagnosis.code;
  const { reason, movie, matches, pending } = row.evidence;
  if (row.type === "missing") return "missing_from_plex";
  if (row.type === "metadata") {
    return reason.startsWith("Plex lacks") ? "metadata_ids_missing" : "metadata_conflict";
  }
  if (row.type === "version") return "copy_unverified";
  if (!movie.fileId) return "radarr_file_incomplete";
  if (matches.length > 30 || reason.startsWith("Too many catalog matches")) {
    return "too_many_matches";
  }
  const exact = matches.filter((match) => match.exact);
  if ((exact.length || matches.length) > 1 || reason.startsWith("Multiple Plex entries")) {
    return "multiple_matches";
  }
  if (pending) return "import_pending";
  if (reason.includes("24-hour import grace period")) return "import_recent";
  if (reason.startsWith("Import time is unknown")) return "import_time_unknown";
  return "evidence_incomplete";
}

/** Describe only the single matched entry; never combine IDs from different movies. */
function identityComparison(row: Row): { conflict: string; missing: string; matched: string } {
  const { movie, matches } = row.evidence;
  const match = matches.length === 1 ? matches[0] : null;
  const groups = { matched: [] as string[], different: [] as string[], missing: [] as string[] };
  if (match) {
    for (const kind of ["tmdb", "imdb"] as const) {
      const expected = movie[kind];
      if (!expected) continue;
      const group = match[kind].includes(expected)
        ? "matched"
        : match[kind].length
        ? "different"
        : "missing";
      groups[group].push(kind === "tmdb" ? "TMDB" : "IMDb");
    }
  }
  const subject = (names: string[], plural = false) =>
    `${names.join(" and ")} ${plural || names.length > 1 ? "IDs" : "ID"}`;
  const matched = groups.matched.length
    ? `The ${subject(groups.matched)} ${groups.matched.length > 1 ? "match" : "matches"}`
    : "";
  return {
    conflict: groups.different.length
      ? matched
        ? `${matched}, but the ${subject(groups.different, true)} differ.`
        : `The ${subject(groups.different, true)} differ between Plex and Radarr.`
      : "Plex and Radarr disagree on the movie’s identity.",
    missing: groups.missing.length
      ? `Plex is missing the ${subject(groups.missing)} supplied by Radarr.`
      : "Plex is missing a TMDB or IMDb ID supplied by Radarr.",
    matched: matched ? `${matched} between Plex and Radarr.` : "Plex and Radarr share a movie ID.",
  };
}

export function findingPresentation(row: Row): FindingPresentation {
  const { movie, matches, comparablePath, diagnosis } = row.evidence;
  const exact = matches.some((match) => match.exact);
  const identity = identityComparison(row);
  const base = {
    radarrSummary: movie.fileId ? "Managed file reported" : "File details incomplete",
    plexSummary: exact
      ? "Managed path matched"
      : matches.length
      ? `${matches.length === 1 ? "Movie identity matched" : `${matches.length} possible matches`}`
      : "No identity match found",
  };
  const result = (
    label: string,
    headline: string,
    summary: string,
    explanation: string,
    nextStep: string,
  ): FindingPresentation => ({ ...base, label, headline, summary, explanation, nextStep });
  switch (diagnosisCode(row)) {
    case "missing_from_plex":
      return result(
        "Missing from Plex",
        "Imported movie not found in Plex",
        "No movie ID or managed path matched in the selected library.",
        "A complete audit found no matching movie ID or managed path in this Plex library. This does not prove the file is missing from disk.",
        "Check Plex can access Radarr’s file. If it belongs in this library, scan it in Plex, then sync Librarian.",
      );
    case "metadata_conflict":
      return result(
        "IDs disagree",
        "Radarr and Plex disagree on the movie",
        "Plex and Radarr disagree on the movie’s identity.",
        `${identity.conflict} ${
          exact
            ? "The managed file path matches."
            : "The exact Radarr-managed copy is also unverified."
        }`,
        "Correct the match in the service with the wrong movie, then sync Librarian.",
      );
    case "metadata_ids_missing":
      return result(
        "Plex IDs incomplete",
        "Movie found with incomplete Plex metadata",
        identity.missing,
        `${identity.missing} The managed file path matches.`,
        "Check the match in Plex, refresh or correct its metadata, then sync Librarian.",
      );
    case "copy_unverified":
      return result(
        "Copy unverified",
        "Movie found; exact copy unverified",
        "Plex has this movie. Its Radarr-managed copy is not confirmed.",
        comparablePath
          ? `${identity.matched} Plex’s file path does not match Radarr’s through the configured mappings.`
          : `${identity.matched} Without file comparison, Librarian cannot confirm the exact Radarr-managed copy.`,
        comparablePath
          ? "Compare file locations in Radarr and Plex to check whether Plex has the intended version."
          : "No movie repair is indicated. Open the movie in Plex if you want to check its version manually.",
      );
    case "radarr_file_incomplete":
      return result(
        "File details unavailable",
        "Radarr’s file details are incomplete",
        "Radarr reports a file without a valid managed-file identity.",
        "Radarr reports a file, but its file record could not be validated.",
        "Check the file details in Radarr. If missing, refresh the movie, then sync Librarian.",
      );
    case "too_many_matches":
    case "multiple_matches":
      return result(
        "Multiple Plex matches",
        "More than one Plex entry matches",
        "The evidence does not identify one unambiguous Plex entry.",
        "Several Plex entries match Radarr’s movie IDs or managed path; no single match could be confirmed.",
        "Correct any wrong matches in Plex. Intentional separate entries may need no change.",
      );
    case "import_pending":
      return result(
        "In Radarr’s queue",
        "Radarr has a pending queue entry",
        "A download or import may change the managed copy.",
        "No Plex match was found. A pending Radarr queue entry may still change the imported copy.",
        "Check Radarr’s queue for progress or errors. Once imported, allow 24 hours before syncing Librarian.",
      );
    case "import_recent":
      return result(
        "Recently imported",
        "This import is less than 24 hours old",
        "No Plex match yet. The import grace period is still active.",
        "Librarian allows 24 hours after import before classifying an unmatched movie as missing.",
        "Sync Librarian after the grace period. No repair is indicated yet.",
      );
    case "import_time_unknown":
      return result(
        "Import date unknown",
        "Radarr did not provide an import date",
        "No Plex match found; the import’s age is unknown.",
        "Without an import date, Librarian cannot establish whether the 24-hour grace period has passed.",
        "Check the movie’s file and import history in Radarr. If the movie plays in Plex, no movie repair is needed.",
      );
    default: {
      const limitations = diagnosis?.limitations ?? [];
      const noIds = limitations.includes("movie_ids_missing") || !(movie.tmdb || movie.imdb);
      const noPaths = limitations.includes("path_comparison_unavailable") || !comparablePath;
      const incompletePaths = limitations.includes("plex_paths_incomplete");
      return result(
        noIds ? "Movie IDs unavailable" : "No identity match",
        "Couldn’t confirm this movie in Plex",
        noIds
          ? "Radarr supplied no usable movie IDs for comparison."
          : noPaths
          ? "No Plex movie ID matched Radarr’s. File comparison is unavailable."
          : "No Plex movie ID matched Radarr’s. File evidence is incomplete.",
        noIds
          ? "Radarr supplied no usable TMDB or IMDb ID, so this movie’s presence could not be confirmed."
          : noPaths
          ? "No Plex movie ID matched Radarr’s in this library. File comparison is unavailable, so this is not a confirmed missing movie."
          : incompletePaths
          ? "No Plex movie ID matched Radarr’s, and Plex file paths could not all be compared. This is not a confirmed missing movie."
          : "The saved audit lacks enough file or movie-identity evidence to confirm this movie is missing.",
        noIds
          ? "Check the movie match and IDs in Radarr, then sync Librarian."
          : "Find the title in Plex and compare its movie IDs with Radarr. If it is absent, check Plex’s file access before scanning.",
      );
    }
  }
}
