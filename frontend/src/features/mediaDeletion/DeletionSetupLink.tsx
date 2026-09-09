/** Open setup separately so the current media selection and dialog remain intact. */
export function DeletionSetupLink({ reason }: { reason?: string }) {
  if (
    !reason ||
    !/mapping|namespace|mount|cannot access|not visible|storage root|storage relationship/i.test(
      reason,
    )
  ) {
    return null;
  }
  return (
    <p className="mt-2 text-sm text-base-content/70">
      Review the affected connection in{" "}
      <a
        className="link"
        href="/settings/sonarr-radarr"
        target="_blank"
        rel="noopener noreferrer"
      >
        Settings → Media connections
      </a>{" "}
      (opens a new tab), then return here and refresh the preview. Your selection stays here.
    </p>
  );
}
