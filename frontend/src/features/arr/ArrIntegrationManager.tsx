import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { PlugZap, Plus, Server, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import type { ArrInstance } from "../../lib/api";
import { AnimatedSuccessCheck } from "./AnimatedSuccessCheck";
import { ArrLibrarySelectionStep } from "./ArrLibrarySelectionStep";
import { ArrUrlHelp } from "./ArrUrlHelp";
import { companionUrl } from "./companionUrl";

export function ArrIntegrationManager() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["arr-integrations"],
    queryFn: api.arr.get,
  });
  const {
    data: libraryData,
    isLoading: librariesLoading,
    error: librariesError,
  } = useQuery({
    queryKey: ["libraries", "arr-settings"],
    queryFn: api.libraries.listAll,
  });
  const managerDialogRef = useRef<HTMLDialogElement>(null);
  const handledHashRef = useRef(false);
  const [modalView, setModalView] = useState<
    "manager" | "connection" | "remove"
  >("manager");
  const [pendingRemoval, setPendingRemoval] = useState<ArrInstance | null>(
    null,
  );
  const [editingInstance, setEditingInstance] = useState<ArrInstance | null>(
    null,
  );
  const [type, setType] = useState<"radarr" | "sonarr">("radarr");
  const [name, setName] = useState("Radarr");
  const [url, setUrl] = useState("");
  const [urlWasSuggested, setUrlWasSuggested] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [connectionStep, setConnectionStep] = useState<
    "connection" | "libraries"
  >("connection");
  const [selectedLibraryKeys, setSelectedLibraryKeys] = useState<Set<string>>(
    new Set(),
  );
  const [addImportExclusion, setAddImportExclusion] = useState(true);

  const save = useMutation({
    mutationFn: ({
      instanceId,
      type,
      name,
      url,
      apiKey,
      libraryKeys,
      addImportExclusion,
    }: {
      instanceId: number | null;
      type: "radarr" | "sonarr";
      name: string;
      url: string;
      apiKey: string;
      libraryKeys: string[];
      addImportExclusion: boolean;
    }) =>
      instanceId === null
        ? api.arr.createInstance({
            type,
            name,
            url,
            apiKey,
            libraryKeys,
            addImportExclusion,
          })
        : api.arr.updateInstance(instanceId, {
            name,
            url,
            libraryKeys,
            addImportExclusion,
            ...(apiKey ? { apiKey } : {}),
          }),
    onSuccess: () => {
      managerDialogRef.current?.close();
      setName("Radarr");
      setUrl("");
      setUrlWasSuggested(false);
      setApiKey("");
      void qc.invalidateQueries({ queryKey: ["arr-integrations"] });
    },
  });
  const remove = useMutation({
    mutationFn: api.arr.deleteInstance,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["arr-integrations"] });
      setPendingRemoval(null);
      setModalView("manager");
    },
  });
  const test = useMutation({ mutationFn: api.arr.testInstance });

  useEffect(() => {
    if (!test.isSuccess) return;
    const timeout = globalThis.setTimeout(() => test.reset(), 2_000);
    return () => globalThis.clearTimeout(timeout);
  }, [test.isSuccess]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (connectionStep === "connection") {
      const compatibleKeys = videoLibraries
        .filter((library) =>
          type === "radarr"
            ? library.type === "movie"
            : library.type === "show",
        )
        .map((library) => library.key);
      const existingMappings = editingInstance
        ? (data?.mappings.filter(
            (mapping) => mapping.instanceId === editingInstance.id,
          ) ?? [])
        : [];
      setSelectedLibraryKeys(
        new Set(
          editingInstance
            ? existingMappings.map((mapping) => mapping.libraryKey)
            : compatibleKeys,
        ),
      );
      setAddImportExclusion(existingMappings[0]?.addImportExclusion ?? true);
      save.reset();
      setConnectionStep("libraries");
      return;
    }

    save.mutate({
      instanceId: editingInstance?.id ?? null,
      type,
      name,
      url,
      apiKey,
      libraryKeys: [...selectedLibraryKeys],
      addImportExclusion,
    });
  }

  function openManager() {
    if (data?.instances.length === 0) {
      openAddDialog();
      return;
    }
    setModalView("manager");
    managerDialogRef.current?.showModal();
  }

  function openAddDialog() {
    test.reset();
    save.reset();
    setEditingInstance(null);
    setConnectionStep("connection");
    setSelectedLibraryKeys(new Set());
    setAddImportExclusion(true);
    setType("radarr");
    setName("Radarr");
    const suggestedUrl = companionUrl(data?.instances ?? [], "radarr");
    setUrl(suggestedUrl);
    setUrlWasSuggested(Boolean(suggestedUrl));
    setApiKey("");
    setModalView("connection");
    if (!managerDialogRef.current?.open) {
      managerDialogRef.current?.showModal();
    }
  }

  function openEditDialog(instance: ArrInstance) {
    test.reset();
    save.reset();
    setEditingInstance(instance);
    setConnectionStep("connection");
    setSelectedLibraryKeys(new Set());
    setType(instance.type);
    setName(instance.name);
    setUrl(instance.url);
    setUrlWasSuggested(false);
    setApiKey("");
    setModalView("connection");
  }

  useEffect(() => {
    if (
      handledHashRef.current ||
      globalThis.location?.hash !== "#sonarr-radarr" ||
      !data
    ) {
      return;
    }
    handledHashRef.current = true;
    openManager();
  }, [data]);

  function openRemoveDialog(instance: ArrInstance) {
    remove.reset();
    setPendingRemoval(instance);
    setModalView("remove");
  }

  function closeRemoveDialog() {
    setPendingRemoval(null);
    setModalView("manager");
  }

  const videoLibraries = (libraryData?.libraries ?? []).filter(
    (library) => library.type === "movie" || library.type === "show",
  );
  const pendingRemovalMappingCount =
    data?.mappings.filter(
      (mapping) => mapping.instanceId === pendingRemoval?.id,
    ).length ?? 0;

  return (
    <>
      <button
        type="button"
        className={`btn btn-sm ${
          data && data.instances.length > 0 ? "btn-ghost" : "btn-primary"
        }`}
        onClick={openManager}
        disabled={isLoading}
      >
        <Server className="size-4" />
        Sonarr &amp; Radarr
        {data && data.instances.length > 0 && (
          <span className="badge badge-sm">{data.instances.length}</span>
        )}
      </button>

      <dialog
        ref={managerDialogRef}
        className="modal"
        onCancel={(event) => {
          if (save.isPending || remove.isPending) {
            event.preventDefault();
            return;
          }
          if (modalView === "remove") {
            event.preventDefault();
            closeRemoveDialog();
          }
        }}
        onClose={() => {
          setModalView("manager");
          setEditingInstance(null);
          setPendingRemoval(null);
          setConnectionStep("connection");
          setSelectedLibraryKeys(new Set());
          setAddImportExclusion(true);
          setName("Radarr");
          setUrl("");
          setUrlWasSuggested(false);
          setApiKey("");
        }}
      >
        {modalView === "manager" && (
          <div className="modal-box polished-modal max-w-3xl">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <Server className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold">Media managers</h2>
                <p className="mt-1 text-sm text-base-content/60">
                  Connect Sonarr and Radarr, then choose which Plex libraries
                  each instance manages.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => managerDialogRef.current?.close()}
              >
                Close
              </button>
            </div>

            <div className="mt-5 space-y-4">
              {isLoading && (
                <span className="loading loading-spinner loading-sm" />
              )}
              {error && <p className="text-sm text-error">{error.message}</p>}
              {data && data.instances.length === 0 && (
                <div className="flex flex-wrap items-center gap-4 rounded-xl border border-dashed border-base-300 bg-base-200/25 p-4">
                  <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
                    <PlugZap className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-sm">
                      No media managers connected
                    </strong>
                    <span className="mt-0.5 block text-xs text-base-content/55">
                      Add Sonarr or Radarr, test the connection, then map it to
                      your Plex libraries.
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => openAddDialog()}
                  >
                    <Plus className="size-4" /> Add connection
                  </button>
                </div>
              )}
              {(data?.instances.length ?? 0) > 0 && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h3 className="font-medium">Connections</h3>
                      <p className="text-xs text-base-content/55">
                        API keys stay server-side and are never returned to the
                        browser.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => openAddDialog()}
                    >
                      <Plus className="size-4" /> Add connection
                    </button>
                  </div>
                  {data!.instances.map((instance) => (
                    <div
                      key={instance.id}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3"
                    >
                      <span
                        className={`badge badge-sm ${
                          instance.type === "radarr"
                            ? "badge-primary"
                            : "badge-secondary"
                        }`}
                      >
                        {instance.type === "radarr" ? "Radarr" : "Sonarr"}
                      </span>
                      <span className="font-medium">{instance.name}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-base-content/50">
                        {instance.url}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => openEditDialog(instance)}
                        disabled={test.isPending}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={`btn btn-xs w-14 ${
                          test.isSuccess && test.variables === instance.id
                            ? "btn-ghost text-success"
                            : "btn-ghost"
                        }`}
                        onClick={() => test.mutate(instance.id)}
                        disabled={test.isPending}
                        aria-label={
                          test.isSuccess && test.variables === instance.id
                            ? `${instance.name} connection successful`
                            : `Test ${instance.name} connection`
                        }
                      >
                        {test.isPending && test.variables === instance.id ? (
                          <span className="loading loading-spinner loading-xs" />
                        ) : test.isSuccess && test.variables === instance.id ? (
                          <AnimatedSuccessCheck />
                        ) : (
                          "Test"
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs text-error"
                        aria-label={`Remove ${instance.name}`}
                        onClick={() => openRemoveDialog(instance)}
                        disabled={remove.isPending || test.isPending}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  ))}
                  <div className="min-h-5">
                    {test.isError && (
                      <p className="text-xs text-error">{test.error.message}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {modalView === "connection" && (
          <div className="modal-box polished-modal max-w-2xl">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <PlugZap className="size-5" />
              </span>
              <div>
                <h3 className="text-lg font-bold">
                  {editingInstance
                    ? `Edit ${editingInstance.name}`
                    : "Connect Sonarr or Radarr"}
                </h3>
                <p className="mt-1 text-sm text-base-content/60">
                  Plex Librarian will test the connection before saving your
                  changes.
                </p>
              </div>
            </div>

            <ol className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <li className="rounded-lg bg-primary/15 px-3 py-2 font-medium text-primary">
                1. Connection
              </li>
              <li
                className={`rounded-lg px-3 py-2 font-medium ${
                  connectionStep === "libraries"
                    ? "bg-primary/15 text-primary"
                    : "bg-base-200 text-base-content/45"
                }`}
              >
                2. Libraries
              </li>
            </ol>

            <div
              role={save.isError ? "alert" : undefined}
              aria-live="polite"
              aria-hidden={!save.isError}
              className={`alert mt-4 min-h-12 text-sm transition-opacity duration-150 ${
                save.isError ? "alert-error opacity-100" : "invisible opacity-0"
              }`}
            >
              <span>
                {save.isError ? save.error.message : "Connection error"}
              </span>
            </div>

            <form
              onSubmit={submit}
              className="mt-5 space-y-4"
              autoComplete="off"
            >
              {connectionStep === "connection" ? (
                <>
                  <fieldset disabled={editingInstance !== null}>
                    <legend className="mb-2 text-xs font-medium">
                      Application
                    </legend>
                    <div className="grid grid-cols-2 gap-2">
                      {(["radarr", "sonarr"] as const).map((application) => (
                        <button
                          key={application}
                          type="button"
                          className={`rounded-xl border p-3 text-left transition ${
                            type === application
                              ? "border-primary bg-primary/10 text-base-content"
                              : "border-base-300 bg-base-200/35 text-base-content/65 hover:border-base-content/25"
                          }`}
                          onClick={() => {
                            setType(application);
                            setName(
                              application === "radarr" ? "Radarr" : "Sonarr",
                            );
                            if (!url || urlWasSuggested) {
                              const suggestedUrl = companionUrl(
                                data?.instances ?? [],
                                application,
                              );
                              setUrl(suggestedUrl);
                              setUrlWasSuggested(Boolean(suggestedUrl));
                            }
                          }}
                          aria-pressed={type === application}
                        >
                          <strong className="block text-sm capitalize">
                            {application}
                          </strong>
                          <span className="mt-0.5 block text-xs opacity-65">
                            {application === "radarr"
                              ? "Movie libraries"
                              : "TV libraries"}
                          </span>
                        </button>
                      ))}
                    </div>
                  </fieldset>

                  <label className="form-control flex flex-col">
                    <span className="label-text mb-1 text-xs font-medium">
                      Connection name
                    </span>
                    <input
                      className="input input-bordered w-full"
                      placeholder={type === "radarr" ? "Movies" : "TV"}
                      name="arr-connection-name"
                      autoComplete="off"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                    />
                    <span className="mt-1 text-xs text-base-content/45">
                      A label used only inside Plex Librarian.
                    </span>
                  </label>

                  <div className="form-control flex flex-col">
                    <div className="label-text mb-1 flex items-center gap-1 text-xs font-medium">
                      <label htmlFor="arr-url">URL</label>
                      <ArrUrlHelp type={type} />
                    </div>
                    <input
                      id="arr-url"
                      className="input input-bordered w-full font-mono text-sm"
                      type="url"
                      name="arr-url"
                      autoComplete="url"
                      spellCheck={false}
                      placeholder={
                        type === "radarr"
                          ? "http://radarr:7878"
                          : "http://sonarr:8989"
                      }
                      value={url}
                      onChange={(event) => {
                        setUrl(event.target.value);
                        setUrlWasSuggested(false);
                      }}
                      required
                    />
                    <span className="mt-1 text-xs text-base-content/45">
                      {urlWasSuggested
                        ? "Suggested from your existing Arr connection. Verify it before continuing."
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
                      name="arr-api-key"
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      data-1p-ignore="true"
                      data-lpignore="true"
                      placeholder={
                        editingInstance
                          ? "Stored API key — leave blank to keep it"
                          : undefined
                      }
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      required={!editingInstance}
                    />
                    <span className="mt-1 text-xs text-base-content/45">
                      {editingInstance
                        ? "Leave blank to keep the stored API key. Enter a new one to replace it."
                        : `Find it under Settings → General → Security in ${
                            type === "radarr" ? "Radarr" : "Sonarr"
                          }.`}
                    </span>
                  </label>
                </>
              ) : (
                <ArrLibrarySelectionStep
                  type={type}
                  libraryData={libraryData}
                  isLoading={librariesLoading}
                  error={librariesError}
                  selectedKeys={selectedLibraryKeys}
                  setSelectedKeys={setSelectedLibraryKeys}
                  addImportExclusion={addImportExclusion}
                  setAddImportExclusion={setAddImportExclusion}
                />
              )}

              <div className="modal-action">
                {connectionStep === "libraries" && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      save.reset();
                      setConnectionStep("connection");
                    }}
                    disabled={save.isPending}
                  >
                    Back
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => managerDialogRef.current?.close()}
                  disabled={save.isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={
                    save.isPending ||
                    (connectionStep === "connection" && librariesLoading)
                  }
                >
                  {connectionStep === "connection" ? (
                    "Next"
                  ) : (
                    <>
                      {save.isPending ? (
                        <span className="loading loading-spinner loading-xs" />
                      ) : (
                        <PlugZap className="size-4" />
                      )}
                      {editingInstance ? "Test and save" : "Test and add"}
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        )}

        {modalView === "remove" && (
          <div className="modal-box polished-modal">
            <h3 className="flex items-center gap-2 text-lg font-bold">
              <Trash2 className="size-5 text-error" /> Remove connection?
            </h3>
            <p className="py-3 text-sm text-base-content/70">
              Remove <strong>{pendingRemoval?.name}</strong> from Plex
              Librarian? This also removes{" "}
              {pendingRemovalMappingCount === 1
                ? "1 library mapping"
                : `${pendingRemovalMappingCount} library mappings`}
              . It does not delete anything from Sonarr, Radarr, Plex, or disk.
            </p>
            {remove.isError && (
              <p className="text-sm text-error">{remove.error.message}</p>
            )}
            <div className="modal-action">
              <button
                type="button"
                className="btn btn-sm"
                onClick={closeRemoveDialog}
                disabled={remove.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-error btn-sm"
                onClick={() => {
                  if (pendingRemoval) remove.mutate(pendingRemoval.id);
                }}
                disabled={!pendingRemoval || remove.isPending}
              >
                {remove.isPending ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                Remove connection
              </button>
            </div>
          </div>
        )}

        <form
          className="modal-backdrop"
          onSubmit={(event) => {
            event.preventDefault();
            if (save.isPending || remove.isPending) return;
            if (modalView === "remove") closeRemoveDialog();
            else managerDialogRef.current?.close();
          }}
        >
          <button type="submit" disabled={save.isPending || remove.isPending}>
            close
          </button>
        </form>
      </dialog>
    </>
  );
}
