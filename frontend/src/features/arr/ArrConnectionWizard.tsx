import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { PlugZap } from "lucide-react";
import { api } from "../../lib/api";
import type { ArrIntegrationSettings, LibrariesResponse } from "../../lib/api";
import { ArrLibrarySelectionStep } from "./ArrLibrarySelectionStep";
import { ArrUrlHelp } from "./ArrUrlHelp";
import { companionUrl } from "./companionUrl";

type ArrType = "radarr" | "sonarr";

interface ArrDraft {
  instanceId: number | null;
  name: string;
  url: string;
  apiKey: string;
  urlWasSuggested: boolean;
  libraryKeys: Set<string>;
  addImportExclusion: boolean;
}

function draftFor(
  type: ArrType,
  data: ArrIntegrationSettings,
  libraries: LibrariesResponse | undefined,
  editingInstanceId: number | null,
): ArrDraft {
  const editingInstance =
    editingInstanceId === null
      ? undefined
      : data.instances.find((candidate) => candidate.id === editingInstanceId);
  const instance =
    editingInstance?.type === type
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
      instance
        ? mappings.map((mapping) => mapping.libraryKey)
        : (libraries?.libraries ?? [])
            .filter(
              (library) =>
                library.type === (type === "radarr" ? "movie" : "show"),
            )
            .map((library) => library.key),
    ),
    addImportExclusion: mappings[0]?.addImportExclusion ?? true,
  };
}

function isComplete(draft: ArrDraft): boolean {
  return Boolean(
    draft.name.trim() &&
    draft.url.trim() &&
    (draft.instanceId !== null || draft.apiKey.trim()),
  );
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
  const draft = drafts[type];
  const completeTypes = useMemo(
    () =>
      (["radarr", "sonarr"] as const).filter((candidate) =>
        isComplete(drafts[candidate]),
      ),
    [drafts],
  );

  function updateDraft(update: Partial<ArrDraft>) {
    setDrafts((current) => ({
      ...current,
      [type]: { ...current[type], ...update },
    }));
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
              })
            : api.arr.updateInstance(value.instanceId, {
                name: value.name,
                url: value.url,
                libraryKeys: [...value.libraryKeys],
                addImportExclusion: value.addImportExclusion,
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
      if (!isComplete(draft)) return;
      save.reset();
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
            Configure either app or both. Every completed connection will be
            tested and saved together.
          </p>
        </div>
      </div>

      <ol className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <li className="rounded-lg bg-primary/15 px-3 py-2 font-medium text-primary">
          1. Connection
        </li>
        <li
          className={`rounded-lg px-3 py-2 font-medium ${step === "libraries" ? "bg-primary/15 text-primary" : "bg-base-200 text-base-content/45"}`}
        >
          2. Libraries
        </li>
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
              const complete = isComplete(value);
              return (
                <button
                  key={application}
                  type="button"
                  className={`rounded-xl border p-3 text-left transition ${type === application ? "border-primary bg-primary/10 text-base-content" : "border-base-300 bg-base-200/35 text-base-content/65 hover:border-base-content/25"}`}
                  onClick={() => setType(application)}
                  aria-pressed={type === application}
                >
                  <span className="flex items-center justify-between gap-2">
                    <strong className="block text-sm capitalize">
                      {application}
                    </strong>
                    {complete && (
                      <span className="badge badge-success badge-xs">
                        Ready
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs opacity-65">
                    {application === "radarr"
                      ? "Movie libraries"
                      : "TV libraries"}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {step === "connection" ? (
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
                placeholder={
                  type === "radarr"
                    ? "http://radarr:7878"
                    : "http://sonarr:8989"
                }
                onChange={(event) =>
                  updateDraft({
                    url: event.target.value,
                    urlWasSuggested: false,
                  })
                }
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
                onChange={(event) =>
                  updateDraft({ apiKey: event.target.value })
                }
                placeholder={
                  draft.instanceId !== null
                    ? "Stored API key — leave blank to keep it"
                    : undefined
                }
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
        ) : (
          <ArrLibrarySelectionStep
            type={type}
            libraryData={libraryData}
            isLoading={librariesLoading}
            error={librariesError}
            selectedKeys={draft.libraryKeys}
            setSelectedKeys={(libraryKeys) => updateDraft({ libraryKeys })}
            addImportExclusion={draft.addImportExclusion}
            setAddImportExclusion={(addImportExclusion) =>
              updateDraft({ addImportExclusion })
            }
          />
        )}

        <div className="modal-action">
          {step === "libraries" && (
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
            disabled={save.isPending || librariesLoading || !isComplete(draft)}
          >
            {step === "connection" ? (
              "Next"
            ) : (
              <>
                {save.isPending && (
                  <span className="loading loading-spinner loading-xs" />
                )}
                Test and save {completeTypes.length === 2 ? "both" : appName}
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
