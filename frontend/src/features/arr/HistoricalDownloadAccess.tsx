/// <reference lib="dom" />
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, FolderClock, Plus, X } from "lucide-react";
import type { HistoricalAccessStatus } from "../../../../shared/historicalDownloads.ts";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import {
  historicalAccessNotification,
  historicalCheckMessage,
  type HistoricalNoticeSnapshot,
} from "./historicalAccessNotifications.ts";

const accessKey = queryKeys.historicalDownloadAccess.all;
const accessLabels: Record<HistoricalAccessStatus["status"], string> = {
  available: "Ready",
  checking: "Checking…",
  waiting_for_sample: "Waiting for history",
  setup_needed: "Setup needed",
  access_lost: "Needs attention",
  not_enabled: "Disabled",
};
function AccessBadge({ status }: { status: HistoricalAccessStatus["status"] }) {
  const tone = status === "available"
    ? "badge-success"
    : status === "access_lost" || status === "setup_needed"
    ? "badge-warning"
    : "badge-ghost";
  return (
    <span className={`badge badge-sm badge-soft whitespace-nowrap ${tone}`}>
      {accessLabels[status]}
    </span>
  );
}

export function HistoricalDownloadAccess(
  { instances }: { instances: Array<{ id: number; name: string; type: string }> },
) {
  const query = useQuery({
    queryKey: accessKey,
    queryFn: api.historicalAccess.get,
    refetchInterval: 5000,
  });
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [instanceId, setInstanceId] = useState("");
  const [remoteRoot, setRemoteRoot] = useState("");
  const [localRoot, setLocalRoot] = useState("/cleanup-downloads");
  const [noRemainingClient, setNoRemainingClient] = useState(false);
  const [host, setHost] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [setupOpen, setSetupOpen] = useState(false);
  const currentServer = useRef(query.data?.serverId);
  currentServer.current = query.data?.serverId;
  useEffect(() => {
    if (open) dialogRef.current?.showModal();
  }, [open]);
  useEffect(() => {
    setMessage("");
    setInstanceId("");
    setRemoteRoot("");
    setLocalRoot("/cleanup-downloads");
    setNoRemainingClient(false);
    setEditing(undefined);
    setSetupOpen(false);
    setOpen(false);
    setHost("");
  }, [query.data?.serverId]);
  const mutation = useMutation({
    mutationFn: async (task: () => Promise<unknown>) => {
      const server = currentServer.current;
      try {
        return await task();
      } catch (e) {
        if (currentServer.current === server) {
          setMessage(e instanceof Error ? e.message : String(e));
        }
        throw e;
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: accessKey }),
  });
  const sonarr = instances.filter((i) => i.type === "sonarr");
  const statuses = query.data?.statuses ?? [];
  const ready = statuses.filter((s) => s.configuration.enabled && s.status === "available").length;
  const needsSetup = statuses.some((s) =>
    s.status === "setup_needed" || s.status === "access_lost"
  );
  function edit(status?: HistoricalAccessStatus) {
    setInstanceId(
      status ? String(status.instanceId) : sonarr.length === 1 ? String(sonarr[0].id) : "",
    );
    setRemoteRoot(status?.configuration.remoteRoot ?? "");
    setLocalRoot(status?.configuration.localRoot || "/cleanup-downloads");
    setNoRemainingClient(status?.configuration.noRemainingClient ?? false);
    setEditing(status?.id);
    setSetupOpen(true);
    setMessage("");
  }
  if (!sonarr.length) return null;
  return (
    <>
      <section className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-base-300 bg-base-200/30 p-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <FolderClock className="size-5" />
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Historical download cleanup</h3>
            <span className="badge badge-ghost badge-xs">Optional</span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-base-content/60">
            Clean up download files left behind after a Sonarr import.
          </p>
          <p className="mt-1 text-xs text-base-content/50">
            {query.isError
              ? "Folder status unavailable"
              : query.isPending
              ? "Loading folder status…"
              : needsSetup
              ? "Folder access needs setup"
              : ready
              ? `${ready} ${ready === 1 ? "folder" : "folders"} ready`
              : statuses.some((s) => s.status === "checking")
              ? "Checking folder access…"
              : statuses.some((s) => s.status === "waiting_for_sample")
              ? "Waiting for Sonarr import history"
              : statuses.length
              ? "Folder cleanup is disabled"
              : "Set up folder access to get started"}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost gap-1"
          onClick={() => {
            setMessage("");
            setSetupOpen(false);
            setOpen(true);
          }}
        >
          Manage access <ChevronRight className="size-4" />
        </button>
      </section>
      {open && (
        <dialog
          ref={dialogRef}
          className="modal"
          aria-labelledby="historical-access-title"
          onCancel={(event) => event.stopPropagation()}
          onClose={(event) => {
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <div className="modal-box polished-modal max-w-2xl p-6">
            <div className="flex items-start gap-3.5">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
                <FolderClock className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="historical-access-title" className="text-lg font-bold tracking-tight">
                  {setupOpen
                    ? editing ? "Edit folder access" : "Add folder access"
                    : "Historical download cleanup"}
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-base-content/55">
                  {setupOpen
                    ? "Match the same completed-downloads folder in Sonarr and Librarian."
                    : "Allow access to exact download files recorded in Sonarr history."}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close folder access"
                className="btn btn-ghost btn-sm btn-square -mr-1 -mt-1 text-base-content/55"
                onClick={() => dialogRef.current?.close()}
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-5 rounded-lg border border-base-300 bg-base-200/40 px-3 py-2.5 text-xs leading-relaxed text-base-content/65">
              Native Linux / Docker / Unraid required. Folder access never deletes files on its own.
              You choose whether to include cleanup in each deletion review.
            </div>
            {query.isError && (
              <p role="alert" className="mt-4 text-sm text-error">
                Folder status could not be loaded.{" "}
                <button type="button" className="link" onClick={() => void query.refetch()}>
                  Try again
                </button>
              </p>
            )}
            {message && (
              <div
                role="status"
                className="mt-4 rounded-lg border border-base-300 p-3 text-sm break-words"
              >
                {message}
              </div>
            )}
            {!setupOpen
              ? (
                <>
                  <div className="mt-5 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">Download folders</h3>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm gap-1"
                      disabled={mutation.isPending}
                      onClick={() => edit()}
                    >
                      <Plus className="size-3.5" /> Add folder
                    </button>
                  </div>
                  <div className="mt-2 space-y-3">
                    {!statuses.length && (
                      <div className="rounded-xl border border-dashed border-base-300 p-6 text-center text-sm text-base-content/55">
                        No folders configured. Add the completed-downloads folder used by Sonarr.
                      </div>
                    )}
                    {statuses.map((s) => (
                      <div key={s.id} className="min-w-0 rounded-xl border border-base-300 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <h4 className="text-sm font-semibold">
                            {sonarr.find((i) =>
                              i.id === s.instanceId
                            )?.name ?? "Sonarr"}
                          </h4>
                          <AccessBadge status={s.status} />
                        </div>
                        <dl className="mt-3 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                          <dt className="text-base-content/45">Sonarr</dt>
                          <dd className="truncate font-mono" title={s.configuration.remoteRoot}>
                            {s.configuration.remoteRoot}
                          </dd>
                          <dt className="text-base-content/45">Librarian</dt>
                          <dd className="truncate font-mono" title={s.configuration.localRoot}>
                            {s.configuration.localRoot || "Not configured"}
                          </dd>
                        </dl>
                        {s.status === "setup_needed" && (
                          <p className="mt-3 text-xs text-base-content/55">
                            Choose the matching folder inside Librarian to finish setup.
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={mutation.isPending}
                            onClick={() => edit(s)}
                          >
                            Edit access
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            disabled={mutation.isPending || !s.configuration.localRoot}
                            onClick={() =>
                              mutation.mutate(async () => {
                                const server = currentServer.current;
                                const result = await api.historicalAccess.check(s.id);
                                if (currentServer.current === server) {
                                  setMessage(
                                    historicalCheckMessage(result.statuses.filter((r) =>
                                      r.id === s.id
                                    )),
                                  );
                                }
                              })}
                          >
                            Check access
                          </button>
                          {!!s.configuration.localRoot && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost text-base-content/55"
                              disabled={mutation.isPending}
                              onClick={() =>
                                mutation.mutate(() =>
                                  api.historicalAccess.save(s.instanceId, {
                                    ...s.configuration,
                                    enabled: !s.configuration.enabled,
                                  }, s.id)
                                )}
                            >
                              {s.configuration.enabled ? "Disable" : "Enable"}
                            </button>
                          )}
                        </div>
                        <details className="mt-3 text-xs text-base-content/55">
                          <summary className="cursor-pointer hover:text-base-content">
                            Access details
                          </summary>
                          <div className="mt-2 space-y-2 break-words [overflow-wrap:anywhere]">
                            <p>Sonarr: {s.configuration.remoteRoot}</p>
                            {s.sample && <p>Example file: {s.sample}</p>}
                            {s.reason && <p>{s.reason}</p>}
                            <p>
                              {s.checkedAt
                                ? `Last checked: ${new Date(s.checkedAt).toLocaleString()}`
                                : "Not checked yet."}
                            </p>
                            {s.succeededAt && (
                              <p>
                                Last successful check: {new Date(s.succeededAt).toLocaleString()}
                              </p>
                            )}
                          </div>
                        </details>
                      </div>
                    ))}
                  </div>
                  <div className="modal-action">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => dialogRef.current?.close()}
                    >
                      Done
                    </button>
                  </div>
                </>
              )
              : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    mutation.mutate(async () => {
                      const server = currentServer.current;
                      await api.historicalAccess.save(Number(instanceId), {
                        enabled: true,
                        remoteRoot,
                        localRoot,
                        noRemainingClient,
                      }, editing);
                      if (currentServer.current === server) {
                        setSetupOpen(false);
                        setMessage("Folder saved. See its access status below.");
                      }
                    });
                  }}
                >
                  <fieldset disabled={mutation.isPending} className="mt-5 space-y-4">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium">Sonarr connection</span>
                      <select
                        className="select select-bordered select-sm w-full"
                        value={instanceId}
                        required
                        disabled={!!editing}
                        onChange={(e) => setInstanceId(e.target.value)}
                      >
                        <option value="">Choose Sonarr</option>
                        {sonarr.map((i) => <option value={i.id} key={i.id}>{i.name}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium">Sonarr download folder</span>
                      <input
                        className="input input-bordered input-sm w-full font-mono"
                        value={remoteRoot}
                        required
                        onChange={(e) => {
                          setRemoteRoot(e.target.value);
                          setNoRemainingClient(false);
                        }}
                        placeholder="/data/.torrents/complete"
                      />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium">Librarian folder</span>
                      <input
                        className="input input-bordered input-sm w-full font-mono"
                        value={localRoot}
                        required
                        onChange={(e) => {
                          setLocalRoot(e.target.value);
                          setNoRemainingClient(false);
                        }}
                      />
                    </label>
                    <p className="text-xs leading-relaxed text-base-content/55">
                      Both paths must point to the same folder. If Sonarr suggested a single release
                      folder, change it to match the completed-downloads folder you mounted.
                    </p>
                    <label className="flex items-start gap-3 rounded-lg border border-base-300 p-3">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm mt-0.5"
                        checked={noRemainingClient}
                        onChange={(e) => setNoRemainingClient(e.target.checked)}
                      />
                      <span className="text-xs leading-relaxed">
                        No download client manages this folder
                        anymore.<span className="mt-1 block text-base-content/50">
                          Only confirm if true. This cannot bypass an unavailable connected client.
                        </span>
                      </span>
                    </label>
                    <details className="rounded-lg border border-base-300 p-3 text-xs">
                      <summary className="cursor-pointer font-medium">
                        Need to mount a folder?
                      </summary>
                      <div className="mt-3 space-y-3 leading-relaxed text-base-content/65">
                        <p>
                          Add one writable completed-downloads mount. Keep the existing{" "}
                          <code>/data</code> app-data volume.
                        </p>
                        <p>
                          <strong>Unraid:</strong>{" "}
                          Docker → Plex Librarian → Edit → Completed downloads folder. Choose the
                          host folder and apply. If missing, add a Read/Write Path with container
                          path <code>/cleanup-downloads</code>.
                        </p>
                        <label className="flex flex-col gap-1.5">
                          Compose host folder<input
                            className="input input-bordered input-sm w-full font-mono"
                            value={host}
                            placeholder="/mnt/user/downloads/complete"
                            onChange={(e) => setHost(e.target.value)}
                          />
                        </label>
                        <pre className="overflow-x-auto rounded-lg bg-base-300/50 p-3 text-xs">{`- type: bind\n  source: ${JSON.stringify(host || '/choose/your/completed-downloads')}\n  target: /cleanup-downloads\n  read_only: false\n  bind:\n    create_host_path: false`}</pre>
                        <p>
                          Add under service volumes, then recreate with{" "}
                          <code>docker compose up -d</code>. Librarian cannot mount a folder itself.
                        </p>
                      </div>
                    </details>
                  </fieldset>
                  <div className="modal-action justify-between gap-3">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setSetupOpen(false);
                        setMessage("");
                      }}
                    >
                      <ArrowLeft className="size-4" /> Back
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm"
                      disabled={!instanceId || !remoteRoot || !localRoot || mutation.isPending}
                    >
                      {mutation.isPending && (
                        <span className="loading loading-spinner loading-xs" />
                      )}Save and check access
                    </button>
                  </div>
                </form>
              )}
          </div>
          <form method="dialog" className="modal-backdrop">
            <button type="submit" aria-label="Close folder access backdrop">close</button>
          </form>
        </dialog>
      )}
    </>
  );
}

export function HistoricalDownloadAccessBanner() {
  const [notice, setNotice] = useState<string | null>(null);
  const previous = useRef<HistoricalNoticeSnapshot | undefined>(undefined);
  const qc = useQueryClient();
  const mutationServer = useRef<number | null | undefined>(undefined);
  const query = useQuery({
    queryKey: accessKey,
    queryFn: api.historicalAccess.get,
    refetchInterval: 15000,
    retry: false,
  });
  const issues =
    query.data?.statuses.filter((s) =>
      s.configuration.enabled && s.problemRevision && s.problemRevision !== s.dismissedRevision
    ) ?? [];
  useEffect(() => {
    if (!query.data) return;
    if (previous.current?.serverId !== query.data.serverId) setNotice(null);
    const result = historicalAccessNotification(
      previous.current,
      query.data.serverId,
      query.data.statuses,
    );
    previous.current = result.snapshot;
    if (result.message) setNotice(result.message);
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: async (check: boolean) => {
      const serverId = query.data?.serverId;
      mutationServer.current = serverId;
      if (check) {
        const results = [];
        for (const s of issues) {
          if (previous.current?.serverId !== serverId) return;
          const result = await api.historicalAccess.check(s.id);
          results.push(...result.statuses.filter((r) => r.id === s.id));
        }
        if (previous.current?.serverId === serverId) {
          setNotice(
            historicalCheckMessage(results),
          );
        }
      } else await api.historicalAccess.dismiss();
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: accessKey }),
    onError: () => {
      if (mutationServer.current === previous.current?.serverId) {
        setNotice(
          "The access request failed. Review folder status in Media connections and try again.",
        );
      }
    },
  });
  return (
    <>
      {!!issues.length && (
        <div className="alert alert-warning mb-4">
          <span>
            Leftover download cleanup needs folder access. Plex/Sonarr deletion remains available.
          </span>
          <a className="link" href="/settings/sonarr-radarr">Review access</a>
          <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>
            Check access
          </button>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(false)}
          >
            Dismiss
          </button>
        </div>
      )}
      {notice && (
        <div className="toast toast-end z-50">
          <div role="status" className="alert">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </>
  );
}
