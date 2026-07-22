import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PlugZap, Plus, Server, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import type { ArrInstance, QbittorrentInstance, SeerrInstance } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { AnimatedSuccessCheck } from "./AnimatedSuccessCheck";
import { ArrConnectionWizard } from "./ArrConnectionWizard";
import { QbittorrentConnections } from "../qbittorrent/QbittorrentConnections";
import { QbittorrentConnectionWizard } from "../qbittorrent/QbittorrentConnectionWizard";
import { SeerrConnections } from "../seerr/SeerrConnections";
import { SeerrConnectionWizard } from "../seerr/SeerrConnectionWizard";

// Rendered only while /settings/sonarr-radarr is active (see that route and the
// <Outlet/> in settings.tsx) — mounting/unmounting doubles as opening/closing, so
// "close" is just navigating back to /settings rather than any imperative dialog state.
export function ArrIntegrationDialog() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.arrIntegrations.all,
    queryFn: api.arr.get,
  });
  const {
    data: libraryData,
    isLoading: librariesLoading,
    error: librariesError,
  } = useQuery({
    queryKey: queryKeys.libraries.arrSettings,
    queryFn: api.libraries.listAll,
  });
  const { data: qbittorrentData } = useQuery({
    queryKey: queryKeys.qbittorrentIntegrations.all,
    queryFn: api.qbittorrent.get,
  });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<
    | "manager"
    | "connection"
    | "qbittorrent"
    | "seerr"
    | "remove"
    | "remove-qbittorrent"
    | "remove-seerr"
  >("manager");
  const [initialType, setInitialType] = useState<"radarr" | "sonarr">("radarr");
  const [editingInstanceId, setEditingInstanceId] = useState<number | null>(
    null,
  );
  const [pendingRemoval, setPendingRemoval] = useState<ArrInstance | null>(
    null,
  );
  const [editingQbittorrent, setEditingQbittorrent] = useState<
    QbittorrentInstance | null
  >(null);
  const [pendingQbittorrentRemoval, setPendingQbittorrentRemoval] = useState<
    QbittorrentInstance | null
  >(null);
  const [editingSeerr, setEditingSeerr] = useState<SeerrInstance | null>(null);
  const [pendingSeerrRemoval, setPendingSeerrRemoval] = useState<SeerrInstance | null>(null);
  const [wizardKey, setWizardKey] = useState(0);
  const [qbittorrentWizardKey, setQbittorrentWizardKey] = useState(0);
  const [seerrWizardKey, setSeerrWizardKey] = useState(0);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const remove = useMutation({
    mutationFn: api.arr.deleteInstance,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.arrIntegrations.all });
      setPendingRemoval(null);
      setView("manager");
    },
  });
  const test = useMutation({ mutationFn: api.arr.testInstance });
  const removeQbittorrent = useMutation({
    mutationFn: api.qbittorrent.deleteInstance,
    onSuccess: async () => {
      await qc.invalidateQueries({
        queryKey: queryKeys.qbittorrentIntegrations.all,
      });
      setPendingQbittorrentRemoval(null);
      setView("manager");
    },
  });
  const removeSeerr = useMutation({
    mutationFn: api.seerr.deleteInstance,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.seerrIntegrations.all });
      setPendingSeerrRemoval(null);
      setView("manager");
    },
  });

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

  function openQbittorrentWizard(instance?: QbittorrentInstance) {
    setEditingQbittorrent(instance ?? null);
    setQbittorrentWizardKey((key) => key + 1);
    setView("qbittorrent");
  }

  function openSeerrWizard(instance?: SeerrInstance) {
    setEditingSeerr(instance ?? null);
    setSeerrWizardKey((key) => key + 1);
    setView("seerr");
  }

  const removalMappingCount = data?.mappings.filter(
    (mapping) => mapping.instanceId === pendingRemoval?.id,
  ).length ?? 0;

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onCancel={(event) => {
        if (remove.isPending || removeQbittorrent.isPending || removeSeerr.isPending) {
          event.preventDefault();
        } else if (
          view === "remove" || view === "remove-qbittorrent" || view === "remove-seerr"
        ) {
          event.preventDefault();
          setView("manager");
        }
      }}
      onClose={() => void navigate({ to: "/settings" })}
    >
      {view === "manager" && (
        <div
          className="modal-box polished-modal max-w-3xl p-6 outline-none"
          tabIndex={-1}
          autoFocus
        >
          <div className="flex items-start gap-3.5">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/10 text-primary shadow-sm">
              <Server className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold tracking-tight">
                Media connections
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-base-content/55">
                Connect Sonarr and Radarr for managed deletion, qBittorrent for optional torrent
                cleanup, and Seerr for request insights.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square -mr-1 -mt-1 text-base-content/55 hover:text-base-content"
              onClick={() => dialogRef.current?.close()}
              aria-label="Close media connections"
              title="Close"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="mt-6 space-y-5">
            {isLoading && <span className="loading loading-spinner loading-sm" />}
            {error && <p className="text-sm text-error">{error.message}</p>}
            {data?.instances.length === 0 && (
              <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-dashed border-base-content/15 bg-base-200/30 p-4 transition-colors hover:border-primary/25 hover:bg-base-200/45">
                <span className="grid size-11 place-items-center rounded-xl border border-primary/10 bg-primary/10 text-primary">
                  <PlugZap className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm">
                    No media managers connected
                  </strong>
                  <span className="mt-1 block text-xs leading-relaxed text-base-content/50">
                    Configure Sonarr, Radarr, or both in one pass.
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => openWizard()}
                >
                  <Plus className="size-4" /> Add connections
                </button>
              </div>
            )}
            {!!data?.instances.length && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 className="font-medium">Connections</h3>
                    <p className="text-xs text-base-content/55">
                      API keys stay server-side and are never returned to the browser.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => openWizard()}
                  >
                    <Plus className="size-4" /> Configure connections
                  </button>
                </div>
                {data.instances.map((instance) => (
                  <div
                    key={instance.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3"
                  >
                    <span
                      className={`badge badge-sm ${
                        instance.type === "radarr" ? "badge-primary" : "badge-secondary"
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
                      onClick={() => openWizard(instance)}
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
                    >
                      {test.isPending && test.variables === instance.id
                        ? <span className="loading loading-spinner loading-xs" />
                        : test.isSuccess && test.variables === instance.id
                        ? <AnimatedSuccessCheck />
                        : "Test"}
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
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
                <div className="min-h-5">
                  {test.isError && <p className="text-xs text-error">{test.error.message}</p>}
                </div>
              </div>
            )}
            <QbittorrentConnections
              onConfigure={openQbittorrentWizard}
              onRemove={(instance) => {
                removeQbittorrent.reset();
                setPendingQbittorrentRemoval(instance);
                setView("remove-qbittorrent");
              }}
            />
            <SeerrConnections
              onConfigure={openSeerrWizard}
              onRemove={(instance) => {
                removeSeerr.reset();
                setPendingSeerrRemoval(instance);
                setView("remove-seerr");
              }}
            />
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
            void qc.invalidateQueries({
              queryKey: queryKeys.arrIntegrations.all,
            });
            dialogRef.current?.close();
          }}
        />
      )}

      {view === "qbittorrent" && data && (
        <QbittorrentConnectionWizard
          key={qbittorrentWizardKey}
          instance={editingQbittorrent}
          arrInstances={data.instances}
          onCancel={() => dialogRef.current?.close()}
          onSaved={() => {
            void qc.invalidateQueries({
              queryKey: queryKeys.qbittorrentIntegrations.all,
            });
            dialogRef.current?.close();
          }}
        />
      )}

      {view === "seerr" && (
        <SeerrConnectionWizard
          key={seerrWizardKey}
          instance={editingSeerr}
          arrInstances={data?.instances ?? []}
          qbittorrentInstances={qbittorrentData?.instances ?? []}
          onCancel={() => dialogRef.current?.close()}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: queryKeys.seerrIntegrations.all });
            dialogRef.current?.close();
          }}
        />
      )}

      {view === "remove" && (
        <div className="modal-box polished-modal">
          <h3 className="flex items-center gap-2 text-lg font-bold">
            <Trash2 className="size-5 text-error" /> Remove connection?
          </h3>
          <p className="py-3 text-sm text-base-content/70">
            Remove <strong>{pendingRemoval?.name}</strong> from Plex Librarian? This also removes
            {" "}
            {removalMappingCount === 1
              ? "1 library mapping"
              : `${removalMappingCount} library mappings`}. It does not delete anything from Sonarr,
            Radarr, Plex, or disk.
          </p>
          {remove.isError && <p className="text-sm text-error">{remove.error.message}</p>}
          <div className="modal-action">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setView("manager")}
              disabled={remove.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-error btn-sm"
              onClick={() => pendingRemoval && remove.mutate(pendingRemoval.id)}
              disabled={!pendingRemoval || remove.isPending}
            >
              {remove.isPending
                ? <span className="loading loading-spinner loading-xs" />
                : <Trash2 className="size-4" />} Remove connection
            </button>
          </div>
        </div>
      )}

      {view === "remove-qbittorrent" && (
        <div className="modal-box polished-modal">
          <h3 className="flex items-center gap-2 text-lg font-bold">
            <Trash2 className="size-5 text-error" /> Remove connection?
          </h3>
          <p className="py-3 text-sm text-base-content/70">
            Remove <strong>{pendingQbittorrentRemoval?.name}</strong>{" "}
            from Plex Librarian? It does not remove torrents, downloaded payloads, or anything from
            qBittorrent.
          </p>
          {removeQbittorrent.isError && (
            <p className="text-sm text-error">
              {removeQbittorrent.error.message}
            </p>
          )}
          <div className="modal-action">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setView("manager")}
              disabled={removeQbittorrent.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-error btn-sm"
              onClick={() =>
                pendingQbittorrentRemoval &&
                removeQbittorrent.mutate(pendingQbittorrentRemoval.id)}
              disabled={!pendingQbittorrentRemoval ||
                removeQbittorrent.isPending}
            >
              {removeQbittorrent.isPending
                ? <span className="loading loading-spinner loading-xs" />
                : <Trash2 className="size-4" />} Remove connection
            </button>
          </div>
        </div>
      )}

      {view === "remove-seerr" && (
        <div className="modal-box polished-modal">
          <h3 className="flex items-center gap-2 text-lg font-bold">
            <Trash2 className="size-5 text-error" /> Remove connection?
          </h3>
          <p className="py-3 text-sm text-base-content/70">
            Remove <strong>{pendingSeerrRemoval?.name}</strong>{" "}
            from Plex Librarian? It does not change requests, users, or settings in Seerr.
          </p>
          {removeSeerr.isError && <p className="text-sm text-error">{removeSeerr.error.message}</p>}
          <div className="modal-action">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setView("manager")}
              disabled={removeSeerr.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-error btn-sm"
              onClick={() => pendingSeerrRemoval && removeSeerr.mutate(pendingSeerrRemoval.id)}
              disabled={!pendingSeerrRemoval || removeSeerr.isPending}
            >
              {removeSeerr.isPending
                ? <span className="loading loading-spinner loading-xs" />
                : <Trash2 className="size-4" />} Remove connection
            </button>
          </div>
        </div>
      )}

      <form
        className="modal-backdrop"
        onSubmit={(event) => {
          event.preventDefault();
          if (remove.isPending || removeQbittorrent.isPending || removeSeerr.isPending) return;
          if (
            view === "remove" || view === "remove-qbittorrent" || view === "remove-seerr"
          ) {
            setView("manager");
          } else dialogRef.current?.close();
        }}
      >
        <button
          type="submit"
          disabled={remove.isPending || removeQbittorrent.isPending || removeSeerr.isPending}
        >
          close
        </button>
      </form>
    </dialog>
  );
}
