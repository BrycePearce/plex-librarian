import { Link } from "@tanstack/react-router";
import type { api } from "../../lib/api";

export function ArrLibrarySelectionStep({
  type,
  libraryData,
  isLoading,
  error,
  selectedKeys,
  setSelectedKeys,
  addImportExclusion,
  setAddImportExclusion,
}: {
  type: "radarr" | "sonarr";
  libraryData: Awaited<ReturnType<typeof api.libraries.listAll>> | undefined;
  isLoading: boolean;
  error: Error | null;
  selectedKeys: Set<string>;
  setSelectedKeys: (keys: Set<string>) => void;
  addImportExclusion: boolean;
  setAddImportExclusion: (value: boolean) => void;
}) {
  const appName = type === "radarr" ? "Radarr" : "Sonarr";
  const expectedType = type === "radarr" ? "movie" : "show";
  const libraries = (libraryData?.libraries ?? []).filter(
    (library) => library.type === expectedType,
  );

  function toggleLibrary(key: string) {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedKeys(next);
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="font-semibold">Select Plex libraries</h4>
        <p className="mt-1 text-sm text-base-content/60">
          Choose the libraries managed by{" "}
          {appName}. Compatible libraries are selected automatically for new connections.
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-6 text-sm text-base-content/60">
          <span className="loading loading-spinner loading-sm" />
          Loading Plex libraries…
        </div>
      )}

      {error && (
        <div role="alert" className="alert alert-error text-sm">
          <span>Could not load Plex libraries: {error.message}</span>
        </div>
      )}

      {!isLoading && !error && libraries.length === 0 && (
        <div className="rounded-xl border border-base-300 bg-base-200/35 p-4">
          <strong className="block text-sm">
            {libraryData?.total === 0
              ? "Sync Plex before selecting libraries"
              : `No compatible ${expectedType === "movie" ? "movie" : "TV"} libraries found`}
          </strong>
          <p className="mt-1 text-xs text-base-content/55">
            {libraryData?.total === 0
              ? "Run a Plex sync to discover your libraries, then return to finish this connection."
              : `${appName} can only be mapped to ${
                expectedType === "movie" ? "movie" : "TV show"
              } libraries.`}
          </p>
          {libraryData?.total === 0 && (
            <Link to="/dashboard" className="btn btn-sm mt-3">
              Go to dashboard
            </Link>
          )}
        </div>
      )}

      {libraries.length > 0 && (
        <div className="space-y-2">
          {libraries.map((library) => (
            <label
              key={library.key}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${
                selectedKeys.has(library.key)
                  ? "border-primary bg-primary/10"
                  : "border-base-300 bg-base-200/25 hover:border-base-content/25"
              }`}
            >
              <input
                type="checkbox"
                className="checkbox checkbox-primary checkbox-sm"
                checked={selectedKeys.has(library.key)}
                onChange={() => toggleLibrary(library.key)}
              />
              <span>
                <strong className="block text-sm">{library.title}</strong>
                <span className="text-xs capitalize text-base-content/50">
                  {library.type === "show" ? "TV shows" : library.type}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-sm text-base-content/70">
        <input
          type="checkbox"
          className="checkbox checkbox-sm"
          checked={addImportExclusion}
          onChange={(event) => setAddImportExclusion(event.target.checked)}
          disabled={selectedKeys.size === 0}
        />
        Add an import-list exclusion when deleting
      </label>
    </div>
  );
}
