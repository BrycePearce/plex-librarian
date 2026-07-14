import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PlugZap, Plus, Server, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import type { ArrInstance } from "../../lib/api";
import { AnimatedSuccessCheck } from "./AnimatedSuccessCheck";
import { ArrConnectionWizard } from "./ArrConnectionWizard";

// Rendered only while /settings/sonarr-radarr is active (see that route and the
// <Outlet/> in settings.tsx) — mounting/unmounting doubles as opening/closing, so
// "close" is just navigating back to /settings rather than any imperative dialog state.
export function ArrIntegrationDialog() {
  const qc = useQueryClient();
  const navigate = useNavigate();
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<"manager" | "connection" | "remove">("manager");
  const [initialType, setInitialType] = useState<"radarr" | "sonarr">("radarr");
  const [editingInstanceId, setEditingInstanceId] = useState<number | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<ArrInstance | null>(null);
  const [wizardKey, setWizardKey] = useState(0);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  // Jumps straight to the connection wizard when there's nothing to manage yet, mirroring
  // the trigger's old click-time check. A one-shot ref rather than reacting to every `data`
  // change, so removing the last instance while the dialog is already open still lands on
  // the (now empty) manager view instead of yanking the user into the wizard mid-session.
  const skippedEmptyManager = useRef(false);
  useEffect(() => {
    if (skippedEmptyManager.current || !data) return;
    skippedEmptyManager.current = true;
    if (data.instances.length === 0) setView("connection");
  }, [data]);

  const remove = useMutation({
    mutationFn: api.arr.deleteInstance,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["arr-integrations"] });
      setPendingRemoval(null);
      setView("manager");
    },
  });
  const test = useMutation({ mutationFn: api.arr.testInstance });

  useEffect(() => {
    if (!test.isSuccess) return;
    const timeout = globalThis.setTimeout(() => test.reset(), 2_000);
    return () => globalThis.clearTimeout(timeout);
  }, [test.isSuccess]);

  function openWizard(instance?: ArrInstance) {
    test.reset();
    setInitialType(instance?.type ?? "radarr");
    setEditingInstanceId(instance?.id ?? null);
    setWizardKey((key) => key + 1);
    setView("connection");
  }

  const removalMappingCount = data?.mappings.filter(
    (mapping) => mapping.instanceId === pendingRemoval?.id,
  ).length ?? 0;

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onCancel={(event) => {
        if (remove.isPending) event.preventDefault();
        else if (view === "remove") {
          event.preventDefault();
          setView("manager");
        }
      }}
      onClose={() => void navigate({ to: "/settings" })}
    >
      {view === "manager" && (
        <div className="modal-box polished-modal max-w-3xl">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Server className="size-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold">Media managers</h2>
              <p className="mt-1 text-sm text-base-content/60">Connect Sonarr and Radarr, then choose which Plex libraries each instance manages.</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => dialogRef.current?.close()}>Close</button>
          </div>

          <div className="mt-5 space-y-4">
            {isLoading && <span className="loading loading-spinner loading-sm" />}
            {error && <p className="text-sm text-error">{error.message}</p>}
            {data?.instances.length === 0 && (
              <div className="flex flex-wrap items-center gap-4 rounded-xl border border-dashed border-base-300 bg-base-200/25 p-4">
                <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><PlugZap className="size-5" /></span>
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm">No media managers connected</strong>
                  <span className="mt-0.5 block text-xs text-base-content/55">Configure Sonarr, Radarr, or both in one pass.</span>
                </span>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => openWizard()}><Plus className="size-4" /> Add connections</button>
              </div>
            )}
            {!!data?.instances.length && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 className="font-medium">Connections</h3>
                    <p className="text-xs text-base-content/55">API keys stay server-side and are never returned to the browser.</p>
                  </div>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => openWizard()}><Plus className="size-4" /> Configure connections</button>
                </div>
                {data.instances.map((instance) => (
                  <div key={instance.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3">
                    <span className={`badge badge-sm ${instance.type === "radarr" ? "badge-primary" : "badge-secondary"}`}>{instance.type === "radarr" ? "Radarr" : "Sonarr"}</span>
                    <span className="font-medium">{instance.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-base-content/50">{instance.url}</span>
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => openWizard(instance)} disabled={test.isPending}>Edit</button>
                    <button
                      type="button"
                      className={`btn btn-xs w-14 ${test.isSuccess && test.variables === instance.id ? "btn-ghost text-success" : "btn-ghost"}`}
                      onClick={() => test.mutate(instance.id)}
                      disabled={test.isPending}
                    >
                      {test.isPending && test.variables === instance.id ? <span className="loading loading-spinner loading-xs" /> : test.isSuccess && test.variables === instance.id ? <AnimatedSuccessCheck /> : "Test"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs text-error"
                      aria-label={`Remove ${instance.name}`}
                      onClick={() => {
                        remove.reset();
                        setPendingRemoval(instance);
                        setView("remove");
                      }}
                      disabled={remove.isPending || test.isPending}
                    ><Trash2 className="size-4" /></button>
                  </div>
                ))}
                <div className="min-h-5">{test.isError && <p className="text-xs text-error">{test.error.message}</p>}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {view === "connection" && data && (
        <ArrConnectionWizard
          key={wizardKey}
          data={data}
          libraryData={libraryData}
          librariesLoading={librariesLoading}
          librariesError={librariesError}
          initialType={initialType}
          editingInstanceId={editingInstanceId}
          onCancel={() => dialogRef.current?.close()}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["arr-integrations"] });
            dialogRef.current?.close();
          }}
        />
      )}

      {view === "remove" && (
        <div className="modal-box polished-modal">
          <h3 className="flex items-center gap-2 text-lg font-bold"><Trash2 className="size-5 text-error" /> Remove connection?</h3>
          <p className="py-3 text-sm text-base-content/70">
            Remove <strong>{pendingRemoval?.name}</strong> from Plex Librarian? This also removes {removalMappingCount === 1 ? "1 library mapping" : `${removalMappingCount} library mappings`}. It does not delete anything from Sonarr, Radarr, Plex, or disk.
          </p>
          {remove.isError && <p className="text-sm text-error">{remove.error.message}</p>}
          <div className="modal-action">
            <button type="button" className="btn btn-sm" onClick={() => setView("manager")} disabled={remove.isPending}>Cancel</button>
            <button type="button" className="btn btn-error btn-sm" onClick={() => pendingRemoval && remove.mutate(pendingRemoval.id)} disabled={!pendingRemoval || remove.isPending}>
              {remove.isPending ? <span className="loading loading-spinner loading-xs" /> : <Trash2 className="size-4" />} Remove connection
            </button>
          </div>
        </div>
      )}

      <form className="modal-backdrop" onSubmit={(event) => {
        event.preventDefault();
        if (remove.isPending) return;
        if (view === "remove") setView("manager");
        else dialogRef.current?.close();
      }}><button type="submit" disabled={remove.isPending}>close</button></form>
    </dialog>
  );
}
