import { useMutation } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { PlugZap } from "lucide-react";
import { api } from "../../lib/api.ts";
import type {
  ArrInstance,
  ArrIntegrationSettings,
  ArrRootFoldersRequest,
  ArrRootFoldersResponse,
  LibrariesResponse,
} from "../../lib/api.ts";
import { ArrLibrarySelectionStep } from "./ArrLibrarySelectionStep.tsx";
import { ArrUrlHelp } from "./ArrUrlHelp.tsx";
import { companionUrl } from "./companionUrl.ts";

export type ArrType = "radarr" | "sonarr";
export const ARR_SETUP_STEPS = ["Connection", "Libraries", "Storage cleanup"] as const;

export interface ArrDraft {
  instanceId: number | null;
  name: string;
  url: string;
  apiKey: string;
  urlWasSuggested: boolean;
  libraryKeys: Set<string>;
  addImportExclusion: boolean;
  libraryArrPath: string;
  libraryLocalPath: string;
  downloadArrPath: string;
  downloadLocalPath: string;
}

export type RootFolderDiscoveryStatus =
  | "idle"
  | "loading"
  | "suggested"
  | "empty"
  | "error"
  | "manual";

export interface RootFolderDiscoveryState {
  revision: number;
  attemptedRevision: number | null;
  status: RootFolderDiscoveryStatus;
  roots: string[];
}

export type RootFolderDiscoveryEvent =
  | { type: "credentials-changed" }
  | { type: "started"; revision: number }
  | { type: "succeeded"; revision: number; roots: string[] }
  | { type: "failed"; revision: number }
  | { type: "manual"; revision: number };

export function initialRootFolderDiscoveryState(): RootFolderDiscoveryState {
  return { revision: 0, attemptedRevision: null, status: "idle", roots: [] };
}

export function rootFolderDiscoveryTransition(
  state: RootFolderDiscoveryState,
  event: RootFolderDiscoveryEvent,
): RootFolderDiscoveryState {
  if (event.type === "credentials-changed") {
    return {
      revision: state.revision + 1,
      attemptedRevision: null,
      status: "idle",
      roots: [],
    };
  }
  if (event.revision !== state.revision) return state;
  if (event.type === "started") {
    return { ...state, attemptedRevision: event.revision, status: "loading", roots: [] };
  }
  if (event.type === "succeeded") {
    return {
      ...state,
      status: event.roots.length === 0 ? "empty" : "suggested",
      roots: [...event.roots],
    };
  }
  if (event.type === "manual") {
    return { ...state, attemptedRevision: event.revision, status: "manual", roots: [] };
  }
  return { ...state, status: "error", roots: [] };
}

function normalizeDiscoveryUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/$/, "").replace(/\/api\/v3$/i, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export type RootFolderDiscoveryPlan =
  | { kind: "request"; request: ArrRootFoldersRequest }
  | { kind: "manual" }
  | { kind: "ineligible" };

export function rootFolderDiscoveryPlan(
  type: ArrType,
  draft: ArrDraft,
  instances: readonly ArrInstance[],
): RootFolderDiscoveryPlan {
  if (!arrConnectionComplete(draft)) return { kind: "ineligible" };
  const url = normalizeDiscoveryUrl(draft.url);
  if (!url) return { kind: "ineligible" };
  if (draft.instanceId === null) {
    const apiKey = draft.apiKey.trim();
    return apiKey ? { kind: "request", request: { type, url, apiKey } } : { kind: "ineligible" };
  }
  const instance = instances.find((candidate) =>
    candidate.id === draft.instanceId && candidate.type === type
  );
  if (!instance) return { kind: "ineligible" };
  const replacementApiKey = draft.apiKey.trim();
  if (url !== normalizeDiscoveryUrl(instance.url) && !replacementApiKey) {
    return { kind: "manual" };
  }
  return {
    kind: "request",
    request: {
      instanceId: draft.instanceId,
      url,
      ...(replacementApiKey ? { apiKey: replacementApiKey } : {}),
    },
  };
}

export function rootFolderSuggestionListId(type: ArrType): string {
  return `arr-${type}-library-root-suggestions`;
}

export function automaticRootFolderDiscoveryTypes(
  drafts: Readonly<Record<ArrType, ArrDraft>>,
  instances: readonly ArrInstance[],
  discoveries: Readonly<Record<ArrType, RootFolderDiscoveryState>>,
): ArrType[] {
  return (["radarr", "sonarr"] as const).filter((candidate) => {
    const state = discoveries[candidate];
    return state.attemptedRevision !== state.revision &&
      rootFolderDiscoveryPlan(candidate, drafts[candidate], instances).kind !== "ineligible";
  });
}

export function selectSuggestedRoot(root: string): Pick<ArrDraft, "libraryArrPath"> {
  return { libraryArrPath: root };
}

export function startRootFolderDiscovery(
  type: ArrType,
  draft: ArrDraft,
  instances: readonly ArrInstance[],
  state: RootFolderDiscoveryState,
  load: (request: ArrRootFoldersRequest) => Promise<ArrRootFoldersResponse>,
  dispatch: (event: RootFolderDiscoveryEvent) => void,
  retry = false,
): boolean {
  if (!retry && state.attemptedRevision === state.revision) return false;
  const plan = rootFolderDiscoveryPlan(type, draft, instances);
  if (plan.kind === "ineligible") return false;
  if (plan.kind === "manual") {
    dispatch({ type: "manual", revision: state.revision });
    return true;
  }
  const revision = state.revision;
  dispatch({ type: "started", revision });
  void load(plan.request).then(
    ({ roots }) => dispatch({ type: "succeeded", revision, roots }),
    () => dispatch({ type: "failed", revision }),
  );
  return true;
}

function draftFor(
  type: ArrType,
  data: ArrIntegrationSettings,
  libraries: LibrariesResponse | undefined,
  editingInstanceId: number | null,
): ArrDraft {
  const editingInstance = editingInstanceId === null
    ? undefined
    : data.instances.find((candidate) => candidate.id === editingInstanceId);
  const instance = editingInstance?.type === type
    ? editingInstance
    : editingInstance
    ? data.instances.find((candidate) => candidate.type === type)
    : undefined;
  const mappings = instance
    ? data.mappings.filter((mapping) => mapping.instanceId === instance.id)
    : [];
  const suggestedUrl = instance ? "" : companionUrl(data.instances, type);
  return {
    instanceId: instance?.id ?? null,
    name: instance?.name ?? (type === "radarr" ? "Radarr" : "Sonarr"),
    url: instance?.url ?? suggestedUrl,
    apiKey: "",
    urlWasSuggested: Boolean(suggestedUrl),
    libraryKeys: new Set(
      instance ? mappings.map((mapping) => mapping.libraryKey) : (libraries?.libraries ?? [])
        .filter(
          (library) => library.type === (type === "radarr" ? "movie" : "show"),
        )
        .map((library) => library.key),
    ),
    addImportExclusion: mappings[0]?.addImportExclusion ?? true,
    libraryArrPath: instance?.pathMappings.find((mapping) => mapping.kind === "library")
      ?.arrPath ?? "",
    libraryLocalPath: instance?.pathMappings.find((mapping) => mapping.kind === "library")
      ?.localPath ?? "/media",
    downloadArrPath: instance?.pathMappings.find((mapping) => mapping.kind === "download")
      ?.arrPath ?? "",
    downloadLocalPath: instance?.pathMappings.find((mapping) => mapping.kind === "download")
      ?.localPath ?? "/downloads",
  };
}

function pathMappings(type: ArrType, draft: ArrDraft) {
  void type;
  return [
    draft.libraryArrPath.trim() && draft.libraryLocalPath.trim()
      ? {
        kind: "library" as const,
        arrPath: draft.libraryArrPath.trim(),
        localPath: draft.libraryLocalPath.trim(),
      }
      : null,
    draft.downloadArrPath.trim() && draft.downloadLocalPath.trim()
      ? {
        kind: "download" as const,
        arrPath: draft.downloadArrPath.trim(),
        localPath: draft.downloadLocalPath.trim(),
      }
      : null,
  ].filter((mapping) => mapping !== null);
}

export function arrConnectionComplete(draft: ArrDraft): boolean {
  return Boolean(
    draft.name.trim() &&
      draft.url.trim() &&
      (draft.instanceId !== null || draft.apiKey.trim()),
  );
}

export type StorageCleanupState = "configured" | "incomplete";

function normalizedLocalRoot(value: string): string | null {
  const raw = value.trim();
  if (!raw.startsWith("/") || raw.includes("\\")) return null;
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return `/${segments.join("/")}`;
}

function validArrRoot(value: string): boolean {
  const raw = value.trim();
  const windows = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(raw);
  if (!windows && (!raw.startsWith("/") || raw === "/")) return false;
  return !raw.split(windows ? /[\\/]+/ : /\/+/).includes("..");
}

export function storageCleanupProblem(
  draft: Pick<
    ArrDraft,
    "libraryArrPath" | "libraryLocalPath" | "downloadArrPath" | "downloadLocalPath"
  >,
): string | null {
  if (
    !draft.libraryArrPath.trim() || !draft.libraryLocalPath.trim() ||
    !draft.downloadArrPath.trim() || !draft.downloadLocalPath.trim()
  ) return "Both path-mapping pairs must be complete.";
  if (!validArrRoot(draft.libraryArrPath) || !validArrRoot(draft.downloadArrPath)) {
    return "Arr roots must be absolute POSIX, Windows drive, or UNC paths without parent traversal.";
  }
  const libraryLocal = normalizedLocalRoot(draft.libraryLocalPath);
  const downloadLocal = normalizedLocalRoot(draft.downloadLocalPath);
  if (!libraryLocal || !downloadLocal) {
    return "Plex Librarian roots must be absolute Linux paths without parent traversal.";
  }
  if (
    libraryLocal === downloadLocal || libraryLocal.startsWith(`${downloadLocal}/`) ||
    downloadLocal.startsWith(`${libraryLocal}/`)
  ) return "The Plex Librarian library and download roots must not overlap.";
  return null;
}

export function storageCleanupState(
  draft: Pick<
    ArrDraft,
    "libraryArrPath" | "libraryLocalPath" | "downloadArrPath" | "downloadLocalPath"
  >,
): StorageCleanupState {
  return storageCleanupProblem(draft) === null ? "configured" : "incomplete";
}

export function storageCleanupCanSave(
  draft: Pick<
    ArrDraft,
    "libraryArrPath" | "libraryLocalPath" | "downloadArrPath" | "downloadLocalPath"
  >,
): boolean {
  const arrRootEntered = Boolean(draft.libraryArrPath.trim() || draft.downloadArrPath.trim());
  return !arrRootEntered || storageCleanupProblem(draft) === null;
}

export function ArrConnectionWizard({
  data,
  libraryData,
  librariesLoading,
  librariesError,
  initialType,
  editingInstanceId,
  onCancel,
  onSaved,
}: {
  data: ArrIntegrationSettings;
  libraryData: LibrariesResponse | undefined;
  librariesLoading: boolean;
  librariesError: Error | null;
  initialType: ArrType;
  editingInstanceId: number | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<ArrType>(initialType);
  const [step, setStep] = useState<"connection" | "libraries" | "storage">("connection");
  const [drafts, setDrafts] = useState<Record<ArrType, ArrDraft>>(() => ({
    radarr: draftFor("radarr", data, libraryData, editingInstanceId),
    sonarr: draftFor("sonarr", data, libraryData, editingInstanceId),
  }));
  const [discoveries, setDiscoveries] = useState<Record<ArrType, RootFolderDiscoveryState>>(() => ({
    radarr: initialRootFolderDiscoveryState(),
    sonarr: initialRootFolderDiscoveryState(),
  }));
  const discoveriesRef = useRef(discoveries);
  const draft = drafts[type];
  const completeTypes = useMemo(
    () =>
      (["radarr", "sonarr"] as const).filter((candidate) =>
        arrConnectionComplete(drafts[candidate]) && storageCleanupCanSave(drafts[candidate])
      ),
    [drafts],
  );

  function updateDraft(update: Partial<ArrDraft>) {
    const credentialChanged =
      (update.instanceId !== undefined && update.instanceId !== draft.instanceId) ||
      (update.url !== undefined && update.url !== draft.url) ||
      (update.apiKey !== undefined && update.apiKey !== draft.apiKey);
    setDrafts((current) => ({
      ...current,
      [type]: { ...current[type], ...update },
    }));
    if (credentialChanged) {
      updateDiscovery(type, { type: "credentials-changed" });
    }
  }

  function updateDiscovery(candidate: ArrType, event: RootFolderDiscoveryEvent) {
    const next = {
      ...discoveriesRef.current,
      [candidate]: rootFolderDiscoveryTransition(discoveriesRef.current[candidate], event),
    };
    discoveriesRef.current = next;
    setDiscoveries(next);
  }

  function discoverRootFolders(candidate: ArrType, retry = false) {
    startRootFolderDiscovery(
      candidate,
      drafts[candidate],
      data.instances,
      discoveriesRef.current[candidate],
      api.arr.rootFolders,
      (event) => updateDiscovery(candidate, event),
      retry,
    );
  }

  const save = useMutation({
    mutationFn: async () => {
      await Promise.all(
        completeTypes.map((candidate) => {
          const value = drafts[candidate];
          return value.instanceId === null
            ? api.arr.createInstance({
              type: candidate,
              name: value.name,
              url: value.url,
              apiKey: value.apiKey,
              libraryKeys: [...value.libraryKeys],
              addImportExclusion: value.addImportExclusion,
              pathMappings: pathMappings(candidate, value),
            })
            : api.arr.updateInstance(value.instanceId, {
              name: value.name,
              url: value.url,
              libraryKeys: [...value.libraryKeys],
              addImportExclusion: value.addImportExclusion,
              pathMappings: pathMappings(candidate, value),
              ...(value.apiKey.trim() ? { apiKey: value.apiKey } : {}),
            });
        }),
      );
    },
    onSuccess: onSaved,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step === "connection") {
      if (!arrConnectionComplete(draft)) return;
      save.reset();
      for (
        const candidate of automaticRootFolderDiscoveryTypes(
          drafts,
          data.instances,
          discoveriesRef.current,
        )
      ) {
        discoverRootFolders(candidate);
      }
      setStep("libraries");
      return;
    }
    if (step === "libraries") {
      setStep("storage");
      return;
    }
    save.mutate();
  }

  const appName = type === "radarr" ? "Radarr" : "Sonarr";

  return (
    <div className="modal-box polished-modal max-w-2xl">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <PlugZap className="size-5" />
        </span>
        <div>
          <h3 className="text-lg font-bold">Connect Sonarr and Radarr</h3>
          <p className="mt-1 text-sm text-base-content/60">
            Configure either app or both. Every completed connection will be tested and saved
            together.
          </p>
        </div>
      </div>

      <ol className="mt-4 grid grid-cols-3 gap-2 text-xs">
        {ARR_SETUP_STEPS.map((label, index) => {
          const key = (["connection", "libraries", "storage"] as const)[index];
          return (
            <li
              key={key}
              className={`rounded-lg px-3 py-2 font-medium ${
                step === key ? "bg-primary/15 text-primary" : "bg-base-200 text-base-content/45"
              }`}
            >
              {index + 1}. {label}
            </li>
          );
        })}
      </ol>

      {save.isError && (
        <div role="alert" className="alert alert-error mt-4 text-sm">
          {save.error.message}
        </div>
      )}

      <form onSubmit={submit} className="mt-5 space-y-4" autoComplete="off">
        <fieldset>
          <legend className="mb-2 text-xs font-medium">Application</legend>
          <div className="grid grid-cols-2 gap-2">
            {(["radarr", "sonarr"] as const).map((application) => {
              const value = drafts[application];
              const complete = arrConnectionComplete(value);
              return (
                <button
                  key={application}
                  type="button"
                  className={`rounded-xl border p-3 text-left transition ${
                    type === application
                      ? "border-primary bg-primary/10 text-base-content"
                      : "border-base-300 bg-base-200/35 text-base-content/65 hover:border-base-content/25"
                  }`}
                  onClick={() => setType(application)}
                  aria-pressed={type === application}
                >
                  <span className="flex items-center justify-between gap-2">
                    <strong className="block text-sm capitalize">
                      {application}
                    </strong>
                    {complete && (
                      <span className="badge badge-success badge-xs">
                        Connection ready
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs opacity-65">
                    {application === "radarr" ? "Movie libraries" : "TV libraries"}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {step === "connection"
          ? (
            <>
              <label className="form-control flex flex-col">
                <span className="label-text mb-1 text-xs font-medium">
                  Connection name
                </span>
                <input
                  className="input input-bordered w-full"
                  value={draft.name}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                  required
                />
              </label>
              <div className="form-control flex flex-col">
                <div className="label-text mb-1 flex items-center gap-1 text-xs font-medium">
                  <label htmlFor={`arr-url-${type}`}>URL</label>
                  <ArrUrlHelp type={type} />
                </div>
                <input
                  id={`arr-url-${type}`}
                  className="input input-bordered w-full font-mono text-sm"
                  type="url"
                  value={draft.url}
                  placeholder={type === "radarr" ? "http://radarr:7878" : "http://sonarr:8989"}
                  onChange={(event) =>
                    updateDraft({
                      url: event.target.value,
                      urlWasSuggested: false,
                    })}
                  required
                />
                <span className="mt-1 text-xs text-base-content/45">
                  {draft.urlWasSuggested
                    ? "Suggested from your other Arr connection. Verify it before continuing."
                    : "Use an address reachable from the Plex Librarian container, not localhost."}
                </span>
              </div>
              <label className="form-control flex flex-col">
                <span className="label-text mb-1 text-xs font-medium">
                  API key
                </span>
                <input
                  className="input input-bordered w-full font-mono text-sm [-webkit-text-security:disc]"
                  type="text"
                  value={draft.apiKey}
                  onChange={(event) => updateDraft({ apiKey: event.target.value })}
                  placeholder={draft.instanceId !== null
                    ? "Stored API key — leave blank to keep it"
                    : undefined}
                  required={draft.instanceId === null}
                  autoComplete="off"
                />
                <span className="mt-1 text-xs text-base-content/45">
                  {draft.instanceId !== null
                    ? "Leave blank to keep the stored API key."
                    : `Find it under Settings → General → Security in ${appName}.`}
                </span>
              </label>
            </>
          )
          : step === "libraries"
          ? (
            <ArrLibrarySelectionStep
              type={type}
              libraryData={libraryData}
              isLoading={librariesLoading}
              error={librariesError}
              selectedKeys={draft.libraryKeys}
              setSelectedKeys={(libraryKeys) => updateDraft({ libraryKeys })}
              addImportExclusion={draft.addImportExclusion}
              setAddImportExclusion={(addImportExclusion) => updateDraft({ addImportExclusion })}
            />
          )
          : (
            <StorageCleanupStep
              type={type}
              draft={draft}
              discovery={discoveries[type]}
              onRetry={() => discoverRootFolders(type, true)}
              onUpdate={updateDraft}
            />
          )}

        <div className="modal-action">
          {step !== "connection" && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setStep(step === "storage" ? "libraries" : "connection")}
              disabled={save.isPending}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={onCancel}
            disabled={save.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={save.isPending || librariesLoading ||
              (step === "connection" && !arrConnectionComplete(draft)) ||
              (step === "storage" && !storageCleanupCanSave(draft))}
          >
            {step !== "storage" ? "Next" : (
              <>
                {save.isPending && <span className="loading loading-spinner loading-xs" />}
                Test and save {completeTypes.length === 2 ? "both" : appName}
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

export function StorageCleanupStep({
  type,
  draft,
  discovery = initialRootFolderDiscoveryState(),
  onRetry,
  onUpdate,
}: {
  type: ArrType;
  draft: ArrDraft;
  discovery?: RootFolderDiscoveryState;
  onRetry?: () => void;
  onUpdate: (update: Partial<ArrDraft>) => void;
}) {
  const appName = type === "radarr" ? "Radarr" : "Sonarr";
  const problem = storageCleanupProblem(draft);
  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-base-300 bg-base-200/30 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">Historical hardlink cleanup</h4>
            <p className="mt-1 text-xs leading-relaxed text-base-content/60">
              Optional. These Plex Librarian path translations let deletion previews verify and
              remove historical import hardlinks after a download job is gone. Ordinary
              {` ${appName} `}managed deletion works when this capability is skipped.
            </p>
          </div>
          <span
            className={`badge badge-sm ${
              storageCleanupState(draft) === "configured" ? "badge-success" : "badge-warning"
            }`}
          >
            {storageCleanupState(draft) === "configured" ? "Configured" : "Incomplete"}
          </span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-base-content/55">
          Enter the roots exactly as {appName}{" "}
          reports them. A suggested root still needs the matching path mounted inside Plex
          Librarian—for example, <code>/data/TV</code> may correspond to{" "}
          <code>/media/TV</code>, depending on your bind mount. These are not {appName}{" "}
          Remote Path Mappings, which neither mount files nor grant Plex Librarian filesystem
          access.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <PathInput
            label={`${appName} library root`}
            value={draft.libraryArrPath}
            placeholder="/data/media or D:\\Media"
            suggestions={discovery.roots}
            suggestionListId={rootFolderSuggestionListId(type)}
            onChange={(libraryArrPath) => onUpdate({ libraryArrPath })}
          />
          <PathInput
            label="Plex Librarian library root"
            value={draft.libraryLocalPath}
            placeholder="/media"
            onChange={(libraryLocalPath) => onUpdate({ libraryLocalPath })}
          />
          <PathInput
            label={`${appName} download root`}
            value={draft.downloadArrPath}
            placeholder="/data/torrents or D:\\Downloads"
            onChange={(downloadArrPath) => onUpdate({ downloadArrPath })}
          />
          <PathInput
            label="Plex Librarian download root"
            value={draft.downloadLocalPath}
            placeholder="/downloads"
            onChange={(downloadLocalPath) => onUpdate({ downloadLocalPath })}
          />
        </div>
        <RootFolderSuggestionStatus
          appName={appName}
          discovery={discovery}
          onUse={(libraryArrPath) => onUpdate(selectSuggestedRoot(libraryArrPath))}
          onRetry={onRetry}
        />
        <p className="mt-3 text-xs leading-relaxed text-warning/85">
          Docker or Unraid must expose the library root read-only and the narrow completed-download
          root read/write when the container is created. Plex Librarian cannot create or change
          these mounts. Both mapping pairs must be complete, and the local roots must not overlap.
        </p>
        {!storageCleanupCanSave(draft) && (
          <p role="alert" className="mt-2 text-xs font-medium text-error">
            {problem} Enter both {appName} roots and both Plex Librarian roots, or clear the
            {` ${appName} `}roots to skip this optional capability.
          </p>
        )}
      </div>
    </section>
  );
}

function PathInput({
  label,
  value,
  placeholder,
  suggestions = [],
  suggestionListId,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  suggestions?: readonly string[];
  suggestionListId?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="form-control flex flex-col">
      <span className="label-text mb-1 text-xs font-medium">{label}</span>
      <input
        className="input input-bordered input-sm w-full font-mono text-xs"
        value={value}
        placeholder={placeholder}
        list={suggestions.length > 1 ? suggestionListId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {suggestions.length > 1 && suggestionListId && (
        <datalist id={suggestionListId}>
          {suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
        </datalist>
      )}
    </label>
  );
}

export function RootFolderSuggestionStatus({
  appName,
  discovery,
  onUse,
  onRetry,
}: {
  appName: "Radarr" | "Sonarr";
  discovery: RootFolderDiscoveryState;
  onUse: (root: string) => void;
  onRetry?: () => void;
}) {
  if (discovery.status === "idle") return null;
  if (discovery.status === "loading") {
    return <p className="mt-2 text-xs text-base-content/50">Loading {appName} suggestions…</p>;
  }
  if (discovery.status === "manual") {
    return (
      <p className="mt-2 text-xs text-base-content/55">
        Enter the path manually. A replacement API key is required to refresh suggestions for an
        edited URL.
      </p>
    );
  }
  if (discovery.status === "empty") {
    return <p className="mt-2 text-xs text-base-content/55">No configured roots found.</p>;
  }
  if (discovery.status === "error") {
    return (
      <p className="mt-2 text-xs text-base-content/55">
        Couldn’t load suggestions—enter the path manually.{" "}
        <button type="button" className="link" onClick={onRetry}>Retry</button>
      </p>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-base-content/55">
      <span>Suggested from {appName}.</span>
      {discovery.roots.length === 1 && (
        <button
          type="button"
          className="btn btn-ghost btn-xs font-mono"
          onClick={() => onUse(discovery.roots[0]!)}
        >
          Use {discovery.roots[0]}
        </button>
      )}
    </div>
  );
}
