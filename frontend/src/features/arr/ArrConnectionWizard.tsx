import { useMutation } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import type { ArrStorageVerificationResponse } from "@plex-librarian/shared/types.ts";
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
export const ARR_SETUP_STEPS = ["Connection", "Libraries"] as const;

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

export type StoragePathDiscoveryStatus = "idle" | "loading" | "suggested" | "empty" | "error";

export interface StoragePathDiscoveryState {
  status: StoragePathDiscoveryStatus;
  paths: string[];
}

export type StorageCleanupSuggestion = Pick<
  ArrDraft,
  "libraryArrPath" | "libraryLocalPath" | "downloadArrPath" | "downloadLocalPath"
>;

function normalizedPosixRoot(value: string): string | null {
  const raw = value.trim();
  if (!raw.startsWith("/") || raw.includes("\\")) return null;
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return `/${segments.join("/")}`;
}

export function commonPosixRoot(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const normalized = paths.map(normalizedPosixRoot);
  if (normalized.some((path) => path === null)) return null;
  const segments = normalized.map((path) => path!.slice(1).split("/"));
  const shared = [...segments[0]!];
  for (const parts of segments.slice(1)) {
    while (shared.length > 0 && shared.some((part, index) => parts[index] !== part)) shared.pop();
  }
  return shared.length > 0 ? `/${shared.join("/")}` : null;
}

export function storageCleanupSuggestion(
  roots: readonly string[],
  downloadPaths: readonly string[],
): StorageCleanupSuggestion | null {
  const libraryArrPath = commonPosixRoot([...new Set(roots)]);
  const normalizedDownloads = downloadPaths.map(normalizedPosixRoot);
  if (!libraryArrPath || normalizedDownloads.length === 0 || normalizedDownloads.includes(null)) {
    return null;
  }
  const downloadArrPath = normalizedDownloads[0]!;
  if (
    !normalizedDownloads.every((path) =>
      path === downloadArrPath || path!.startsWith(`${downloadArrPath}/`)
    )
  ) return null;
  return {
    libraryArrPath,
    libraryLocalPath: "/media",
    downloadArrPath,
    downloadLocalPath: "/downloads",
  };
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
  // Prefilled local defaults do not opt users into a mapping.
  const pairs = [
    {
      remote: draft.libraryArrPath.trim(),
      local: draft.libraryLocalPath.trim(),
      defaultLocal: "/media",
    },
    {
      remote: draft.downloadArrPath.trim(),
      local: draft.downloadLocalPath.trim(),
      defaultLocal: "/downloads",
    },
  ].filter((pair) => pair.remote || (pair.local && pair.local !== pair.defaultLocal));
  if (pairs.some((pair) => !pair.remote || !pair.local)) {
    return "Each configured mapping needs both an Arr root and a Plex Librarian root.";
  }
  if (pairs.some((pair) => !validArrRoot(pair.remote))) {
    return "Arr roots must be absolute POSIX, Windows drive, or UNC paths without parent traversal.";
  }
  const localRoots = pairs.map((pair) => normalizedLocalRoot(pair.local));
  if (localRoots.some((root) => !root)) {
    return "Plex Librarian roots must be absolute Linux paths without parent traversal.";
  }
  const [libraryLocal, downloadLocal] = localRoots;
  if (
    libraryLocal && downloadLocal && (
      libraryLocal === downloadLocal || libraryLocal.startsWith(`${downloadLocal}/`) ||
      downloadLocal.startsWith(`${libraryLocal}/`)
    )
  ) return "The Plex Librarian library and download roots must not overlap.";
  return null;
}

export function storageCleanupState(
  draft: Pick<
    ArrDraft,
    "libraryArrPath" | "libraryLocalPath" | "downloadArrPath" | "downloadLocalPath"
  >,
): StorageCleanupState {
  return (draft.libraryArrPath.trim() || draft.downloadArrPath.trim()) &&
      storageCleanupProblem(draft) === null
    ? "configured"
    : "incomplete";
}

export function storageCleanupCanSave(
  draft: Pick<
    ArrDraft,
    "libraryArrPath" | "libraryLocalPath" | "downloadArrPath" | "downloadLocalPath"
  >,
): boolean {
  return storageCleanupProblem(draft) === null;
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
  const [step, setStep] = useState<"connection" | "libraries">("connection");
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
        arrConnectionComplete(drafts[candidate])
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
              pathMappings: [],
            })
            : api.arr.updateInstance(value.instanceId, {
              name: value.name,
              url: value.url,
              libraryKeys: [...value.libraryKeys],
              addImportExclusion: value.addImportExclusion,
              pathMappings: data.instances.find((instance) =>
                instance.id === value.instanceId
              )?.pathMappings ?? [],
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

      <ol className="mt-4 grid grid-cols-2 gap-2 text-xs">
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
                  className={`min-w-0 rounded-xl border p-3 text-left transition ${
                    type === application
                      ? "border-primary bg-primary/10 text-base-content"
                      : "border-base-300 bg-base-200/35 text-base-content/65 hover:border-base-content/25"
                  }`}
                  onClick={() => setType(application)}
                  aria-pressed={type === application}
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="block text-sm capitalize">
                      {application}
                    </strong>
                    {complete && (
                      <span className="badge badge-ghost badge-xs shrink-0 whitespace-nowrap">
                        {connectionTestLabel(discoveries[application])}
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
          : (
            <>
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
              <p className="text-sm text-base-content/60">
                Host discovery identifies paths after you save. Enable it in Media connections once
                the host helper is installed.
              </p>
            </>
          )}

        <div className="modal-action">
          {step !== "connection" && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setStep("connection")}
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
              (step === "connection" && !arrConnectionComplete(draft))}
          >
            {step === "connection" ? "Test connection and continue" : (
              <>
                {save.isPending && <span className="loading loading-spinner loading-xs" />}
                {`Test and save ${completeTypes.length === 2 ? "both" : appName}`}
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
  storagePaths = { status: "idle", paths: [] },
  onRetry,
  onStorageRetry,
  verification,
  onVerificationRetry,
  onUpdate,
}: {
  type: ArrType;
  draft: ArrDraft;
  discovery?: RootFolderDiscoveryState;
  storagePaths?: StoragePathDiscoveryState;
  onRetry?: () => void;
  onStorageRetry?: () => void;
  verification?: { loading?: boolean; result?: ArrStorageVerificationResponse };
  onVerificationRetry?: () => void;
  onUpdate: (update: Partial<ArrDraft>) => void;
}) {
  const appName = type === "radarr" ? "Radarr" : "Sonarr";
  const problem = storageCleanupProblem(draft);
  const suggestion = storageCleanupSuggestion(discovery.roots, storagePaths.paths);
  const discoveryLoading = discovery.status === "loading" || storagePaths.status === "loading";
  const mappingEntered = Boolean(
    draft.libraryArrPath.trim() || draft.downloadArrPath.trim() ||
      draft.libraryLocalPath.trim() !== "/media" || draft.downloadLocalPath.trim() !== "/downloads",
  );
  const canConfirmSuggestion = suggestion !== null && !mappingEntered;
  const libraryDetected = discovery.status === "suggested" &&
    draft.libraryArrPath === commonPosixRoot(discovery.roots);
  const downloadDetected = storagePaths.status === "suggested" &&
    Boolean(draft.downloadArrPath) &&
    draft.downloadArrPath ===
      storageCleanupSuggestion(["/library"], storagePaths.paths)?.downloadArrPath;
  const sampleVerified = verification?.result?.status === "verified";
  const libraryVerified = verification?.result?.library?.status === "verified" || sampleVerified;
  const unavailableRoots =
    verification?.result?.roots?.filter((root) => root.status !== "accessible") ?? [];
  return (
    <section className="min-w-0 space-y-4" aria-label="Optional path access">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold">Optional path access</h4>
          <p className="mt-1 text-xs leading-relaxed text-base-content/60">
            Match the folders {appName}{" "}
            sees to their locations in Plex Librarian when a deletion needs file identity checks. No
            mapping is required to connect.
          </p>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-md bg-base-200 px-2 py-1 text-[10px] font-medium text-base-content/55">
          Optional
        </span>
      </div>

      {canConfirmSuggestion && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
          <div className="min-w-0 text-xs">
            <p className="font-medium">Paths found in {appName} and qBittorrent</p>
            <p className="mt-0.5 text-base-content/55">
              Check the local mounts and confirm QB uses the path {appName} sees.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm shrink-0"
            onClick={() => onUpdate(suggestion)}
          >
            Use detected paths
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-base-300">
        <div className="space-y-3 bg-base-200/25 p-4">
          <div>
            <h5 className="text-xs font-semibold">Library files</h5>
            <p className="mt-0.5 text-xs text-base-content/45">
              Your organized movies or TV shows.
            </p>
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <PathInput
              label={`${appName} library root`}
              value={draft.libraryArrPath}
              placeholder={suggestion?.libraryArrPath ?? "/data/media"}
              suggestions={discovery.roots}
              suggestionListId={rootFolderSuggestionListId(type)}
              tag={libraryDetected ? "Auto-detected" : undefined}
              tagHelp={`Found in ${appName}'s configured library folders.`}
              onChange={(libraryArrPath) => onUpdate({ libraryArrPath })}
            />
            <PathInput
              label="Plex Librarian library root"
              value={draft.libraryLocalPath}
              placeholder="/media"
              tag={libraryVerified
                ? "Verified"
                : draft.libraryLocalPath === "/media"
                ? "Suggested"
                : undefined}
              onChange={(libraryLocalPath) => onUpdate({ libraryLocalPath })}
            />
          </div>
          {(!suggestion || (draft.libraryArrPath && !libraryDetected)) && (
            <RootFolderSuggestionStatus
              appName={appName}
              discovery={discovery}
              onUse={(libraryArrPath) => onUpdate(selectSuggestedRoot(libraryArrPath))}
              onRetry={onRetry}
            />
          )}
        </div>
        <div className="space-y-3 border-t border-base-300 bg-base-200/25 p-4">
          <div>
            <h5 className="text-xs font-semibold">Completed downloads</h5>
            <p className="mt-0.5 text-xs text-base-content/45">
              Optional. Map current download folders only when file identity verification needs
              access.
            </p>
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <PathInput
              label={`${appName} download root`}
              value={draft.downloadArrPath}
              placeholder={suggestion?.downloadArrPath ?? "/data/torrents"}
              suggestions={storagePaths.paths}
              suggestionListId={`${type}-download-path-suggestions`}
              tag={downloadDetected ? "From QB" : undefined}
              tagHelp={`Reported by qBittorrent. Confirm this is also the path ${appName} sees.`}
              onChange={(downloadArrPath) => onUpdate({ downloadArrPath })}
            />
            <PathInput
              label="Plex Librarian download root"
              value={draft.downloadLocalPath}
              placeholder="/downloads"
              tag={sampleVerified
                ? "Verified"
                : draft.downloadLocalPath === "/downloads"
                ? "Suggested"
                : undefined}
              onChange={(downloadLocalPath) => onUpdate({ downloadLocalPath })}
            />
          </div>
          {downloadDetected && (
            <p className="text-xs text-base-content/55">
              Confirm the QB path is also the path {appName} sees.
            </p>
          )}
          {storagePaths.status === "empty" && (
            <p className="text-xs text-base-content/55">
              Enter the completed-download folder manually. qBittorrent is optional.
            </p>
          )}
          {!suggestion && storagePaths.status === "suggested" && storagePaths.paths.length > 1 && (
            <p className="break-all text-xs text-base-content/55">
              Choose a download folder from the input suggestions. Detected:{" "}
              {storagePaths.paths.join(", ")}
            </p>
          )}
          {storagePaths.status === "error" && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-base-content/55">
              <span>Could not detect qBittorrent paths. You can enter them manually.</span>
              {onStorageRetry && (
                <button type="button" className="btn btn-ghost btn-xs" onClick={onStorageRetry}>
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {unavailableRoots.length > 0 && (
        <div
          className="space-y-3 rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs"
          role="status"
        >
          <div>
            <p className="font-semibold">Storage access needs setup</p>
            <p className="mt-1 leading-relaxed text-base-content/65">
              {unavailableRoots.some((root) => root.status === "missing")
                ? "A configured folder is missing inside Plex Librarian. Add its Docker mount or correct the local path below."
                : "A configured folder is not accessible. Check its Docker mount, folder permissions, and local path."}
              {" "}
              Connecting to {appName} does not give this container access to its files.
            </p>
          </div>
          {unavailableRoots.map((root) => (
            <div
              key={`${root.kind}:${root.localPath}`}
              className="rounded border border-base-300 p-2.5 leading-relaxed"
            >
              <p className="font-medium">
                {root.kind === "library"
                  ? "Library files · read-only"
                  : "Completed downloads · read-only"}
              </p>
              <p className="mt-1 break-all text-base-content/65">
                Container path: <code>{root.localPath}</code>
              </p>
              <p className="break-words text-base-content/65">
                Host path: the actual host folder that {appName} sees as{" "}
                <code className="break-all">{root.arrPath}</code>.
              </p>
            </div>
          ))}
          <details open>
            <summary className="cursor-pointer font-medium">Set up in Unraid or Docker</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-4 leading-relaxed text-base-content/65">
              <li>
                Edit the Plex Librarian container in Unraid. Set the optional Library Inspection
                Path and Download Inspection Path, or add a Path entry for the container paths
                above.
              </li>
              <li>
                Choose the matching host folders. With Docker Compose, add these as volume mappings
                with the access modes shown. Keep the existing app-data mount unchanged.
              </li>
              <li>
                Apply the changes and reopen this connection. The wizard checks automatically; use
                Check again if this page is still open.
              </li>
            </ol>
            <p className="mt-2 leading-relaxed text-base-content/65">
              Host paths cannot be determined from inside this container. Use your host's actual
              paths, not a Windows mapped drive letter. Plex Librarian cannot create mounts itself.
            </p>
          </details>
        </div>
      )}

      {discoveryLoading && (
        <p role="status" className="flex items-center gap-2 text-xs text-base-content/55">
          <span className="loading loading-spinner loading-xs" />{" "}
          Checking connected services for storage paths…
        </p>
      )}

      {verification && (
        <div
          role="status"
          className="space-y-2 rounded-lg border border-base-300 bg-base-200/25 px-3 py-2.5 text-xs"
        >
          {verification.loading
            ? (
              <p className="flex items-center gap-2">
                <span className="loading loading-spinner loading-xs" />Checking current library
                access...
              </p>
            )
            : verification.result?.library
            ? (
              <>
                <p className={libraryVerified ? "font-medium text-success" : "font-medium"}>
                  {libraryVerified
                    ? "Library path verified"
                    : verification.result.library.status === "no_sample"
                    ? "Library access: no sample available"
                    : "Library path needs a check"}
                </p>
                <p className="break-words text-base-content/60">
                  {verification.result.library.reason}
                </p>
                {!libraryVerified && verification.result.library.arrPath && (
                  <p className="break-all font-mono text-base-content/70">
                    {verification.result.library.arrPath} &rarr;{" "}
                    {verification.result.library.localPath ?? "No matching local root"}
                  </p>
                )}
                {!libraryVerified && (
                  <p className="text-base-content/60">
                    You can save this connection and correct its storage settings later.
                  </p>
                )}
              </>
            )
            : (
              <p className="break-words leading-relaxed text-base-content/60">
                {verification.result?.reason}
              </p>
            )}
          {!verification.loading && onVerificationRetry && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={onVerificationRetry}>
              Check again
            </button>
          )}
        </div>
      )}

      {!storageCleanupCanSave(draft) && (
        <p role="alert" className="text-xs leading-relaxed text-error">
          {problem} Complete the paths or clear the optional mappings.
        </p>
      )}

      <details className="group text-xs">
        <summary className="cursor-pointer font-medium text-base-content/65 hover:text-base-content">
          How to match your folders
        </summary>
        <div className="mt-3 space-y-2 border-l-2 border-base-300 pl-3 leading-relaxed text-base-content/55">
          <p>
            The local paths must already exist inside the Plex Librarian container. Entering a path
            here does not create a Docker mount. If your files are mounted elsewhere, use that
            existing container path; the wizard checks a current file before marking it verified.
          </p>
          <p>
            Each row must point to the same host folder. For example, <code>/data/TV</code>{" "}
            may correspond to <code>/media/TV</code> in Plex Librarian.
          </p>
          <p>
            Local mount paths are suggestions, not verified mappings. Docker or Unraid must mount
            your library read-only and completed downloads read-only. Plex Librarian cannot create
            or change these mounts. Keep the two local roots separate.
          </p>
          <p>
            The {appName}{" "}
            library root must cover all its configured folders. These settings do not change{" "}
            {appName} Remote Path Mappings.
          </p>
          <p>
            If you use qBittorrent, verify its own path mappings in Media connections. Saving these
            Arr paths does not verify qBittorrent ownership.
          </p>
        </div>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-base-300 pt-3 text-xs text-base-content/45">
        <span>You can set this up later in Media connections.</span>
        {mappingEntered && (
          <button
            type="button"
            className="btn btn-ghost btn-xs shrink-0"
            onClick={() =>
              onUpdate({
                libraryArrPath: "",
                downloadArrPath: "",
                libraryLocalPath: "/media",
                downloadLocalPath: "/downloads",
              })}
          >
            Clear optional mappings
          </button>
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
  tag,
  tagHelp,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  suggestions?: readonly string[];
  suggestionListId?: string;
  tag?: "Auto-detected" | "From QB" | "Suggested" | "Verified";
  tagHelp?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] font-medium text-base-content/65">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 rounded-lg border border-base-content/20 bg-base-100 px-2.5 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
        <input
          className="h-10 w-0 min-w-0 flex-1 bg-transparent font-mono text-xs text-base-content outline-none placeholder:text-base-content/30"
          aria-label={label}
          value={value}
          placeholder={placeholder}
          list={suggestions.length > 1 ? suggestionListId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {tag && (
          <span
            title={tagHelp ?? (tag === "Verified"
              ? "A sample file was verified through this mapping. Each deletion is checked again."
              : "Default container path. Check that the matching host folder is mounted here.")}
            className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ${
              tag === "Verified"
                ? "bg-success/10 text-success"
                : tag === "Suggested"
                ? "bg-base-200 text-base-content/45"
                : "bg-primary/10 text-primary"
            }`}
          >
            {tag}
          </span>
        )}
      </span>
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

export function connectionTestLabel(state: RootFolderDiscoveryState): string {
  return state.status === "suggested" || state.status === "empty"
    ? "Connected"
    : state.status === "loading"
    ? "Testing…"
    : state.status === "error"
    ? "Connection failed"
    : "Not tested";
}
