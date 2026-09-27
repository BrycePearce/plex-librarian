import type { SeasonVersionProfile } from "../../lib/api.ts";
import { HoverPopover } from "../../components/HoverPopover.tsx";
import { groupSeasonLanePaths } from "./seasonVersionPresentation.ts";
export function LanePathsPopover({
  profile,
  episodeIndexByRatingKey,
}: {
  profile: SeasonVersionProfile;
  episodeIndexByRatingKey: ReadonlyMap<string, number>;
}) {
  const entries = profile.members.map((member) => ({
    episodeRatingKey: member.episodeRatingKey,
    episodeIndex: episodeIndexByRatingKey.get(member.episodeRatingKey) ?? null,
    filePath: member.filePath ?? null,
  }));
  const groups = groupSeasonLanePaths(entries);
  const pathCount = groups.reduce((total, group) => total + group.files.length, 0);
  const missing = entries.filter((entry) => entry.filePath === null);
  const label = pathCount === entries.length
    ? `${pathCount} path${pathCount === 1 ? "" : "s"}`
    : `${pathCount} / ${entries.length} paths`;

  return (
    <HoverPopover
      openOnClick
      interactive
      anchorClassName="inline-flex shrink-0"
      popoverAriaLabel="Season version paths"
      popoverClassName="season-profile-path-popover"
      content={
        <div>
          <div className="season-profile-path-popover-header">
            <strong>{pathCount} file{pathCount === 1 ? "" : "s"}</strong>
            <span>{groups.length} folder{groups.length === 1 ? "" : "s"}</span>
          </div>
          <div className="season-profile-path-groups">
            {groups.map((group) => (
              <section key={group.directory}>
                <code title={group.directory}>{group.directory}</code>
                <ul>
                  {group.files.map((file) => (
                    <li key={`${file.episodeRatingKey}:${file.filename}`}>
                      <b>
                        {file.episodeIndex === null
                          ? "Episode"
                          : `E${String(file.episodeIndex).padStart(2, "0")}`}
                      </b>
                      <span title={file.filePath ?? undefined}>{file.filename}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {missing.length > 0 && (
              <section className="season-profile-path-missing">
                <strong>Path unavailable</strong>
                <p>
                  {missing.map((entry) =>
                    entry.episodeIndex === null
                      ? entry.episodeRatingKey
                      : `E${String(entry.episodeIndex).padStart(2, "0")}`
                  ).join(", ")}
                </p>
              </section>
            )}
          </div>
        </div>
      }
    >
      <button
        type="button"
        className={`season-profile-tag season-profile-path-tag ${
          missing.length > 0 || groups.length > 1 ? "has-warning" : ""
        }`}
        aria-label={`Inspect ${label} across ${groups.length} folder${
          groups.length === 1 ? "" : "s"
        }`}
      >
        {label}
      </button>
    </HoverPopover>
  );
}
