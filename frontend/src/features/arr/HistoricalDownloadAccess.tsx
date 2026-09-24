/// <reference lib="dom" />
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowLeft, CircleCheck, FolderClock, Info, Plus, TriangleAlert, X } from "lucide-react";
import { HoverPopover } from "../../components/HoverPopover.tsx";
import type { HistoricalAccessStatus } from "../../../../shared/historicalDownloads.ts";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import {
  historicalAccessMessage,
  historicalAccessNotification,
  historicalCheckMessage,
  type HistoricalNoticeSnapshot,
} from "./historicalAccessNotifications.ts";

const accessKey = queryKeys.historicalDownloadAccess.all;
function FolderPathHelp({ service }: { service?: string }) {
  const title = service ? `Find the folder in ${service}` : "Find the folder in Librarian";
  return (
    <HoverPopover
      openOnClick
      content={
        <div className="max-w-72 space-y-2 text-xs font-normal leading-relaxed">
          <strong className="block text-base-content">{title}</strong>
          {service
            ? (
              <>
                <p>
                  Use the completed-downloads path inside{" "}
                  {service}, before files are imported into your library.
                </p>
                <p>
                  <strong>Unraid:</strong> Docker → {service} → Edit. Check the download volume’s
                  {" "}
                  <strong>Container Path</strong>, including any completed-downloads subfolder.
                </p>
                <p>
                  Example:{" "}
                  <code>/data/.torrents/complete</code>. Use the parent download folder, not a movie
                  or season folder.
                </p>
              </>
            )
            : (
              <>
                <p>
                  <strong>Unraid:</strong>{" "}
                  Docker → Plex Librarian → Edit → Completed downloads. Copy its{" "}
                  <strong>Container Path</strong>.
                </p>
                <p>
                  <strong>Docker Compose:</strong> use the volume’s <strong>target</strong> path.
                </p>
                <p>
                  Example:{" "}
                  <code>/downloads</code>. Both apps must point to the same files; their container
                  paths can differ.
                </p>
              </>
            )}
        </div>
      }
    >
      <button
        type="button"
        aria-label={title}
        className="inline-flex text-base-content/45 hover:text-base-content/75 focus-visible:outline-2 focus-visible:outline-primary"
        onClick={(event) => event.preventDefault()}
      >
        <Info className="size-3.5" />
      </button>
    </HoverPopover>
  );
}
const accessLabels: Record<HistoricalAccessStatus["status"], string> = {
  ready_to_enable: "Ready to enable",
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

export type HistoricalDownloadAccessHandle = { open: (instanceId?: number) => void };

export function HistoricalCleanupShortcut({ instanceId, onOpen }: {
  instanceId: number;
  onOpen: () => void;
}) {
  const query = useQuery({ queryKey: accessKey, queryFn: api.historicalAccess.get });
  const folders = query.data?.statuses.filter((s) => s.instanceId === instanceId) ?? [];
  const qc = useQueryClient();
  const proposal = folders.length === 1 && folders[0].status === "ready_to_enable"
    ? folders[0]
    : null;
  const enable = useMutation({
    mutationFn: () => api.historicalAccess.enable(proposal!.id, proposal!.revision),
    onSettled: () => void qc.invalidateQueries({ queryKey: accessKey }),
  });
  const ready = folders.length > 0 &&
    folders.every((s) => s.configuration.enabled && s.status === "available");
  const status = query.isError
    ? "Status unavailable"
    : query.isPending
    ? "Loading…"
    : ready
    ? "Ready"
    : proposal
    ? "Ready to enable"
    : !folders.some((s) => s.configuration.localRoot)
    ? "Not configured"
    : folders.every((s) => !s.configuration.enabled)
    ? "Disabled"
    : folders.some((s) =>
        s.configuration.enabled && (s.status === "access_lost" || s.status === "setup_needed")
      )
    ? "Needs attention"
    : "Not ready";
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-base-300/50 pt-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${
            query.isError
              ? "bg-warning"
              : ready
              ? "bg-success"
              : status === "Needs attention"
              ? "bg-warning"
              : "bg-base-content/35"
          }`}
        />
        <span className="text-base-content/60">Download cleanup</span>
        <span className={ready ? "text-success" : "text-base-content/70"}>{status}</span>
      </div>
      <button
        type="button"
        className="btn btn-soft btn-xs min-w-20 px-4"
        onClick={() => proposal && !enable.isError ? enable.mutate() : onOpen()}
        title={proposal
          ? "Include eligible leftover downloads when deleting from Sonarr/Radarr. No files are deleted now."
          : undefined}
        aria-label={`${
          proposal && !enable.isError ? "Enable" : status === "Not configured" ? "Set up" : "Manage"
        } download cleanup`}
        disabled={query.isPending || enable.isPending}
      >
        {enable.isPending
          ? "Enabling…"
          : proposal && !enable.isError
          ? "Enable"
          : status === "Not configured"
          ? "Set up"
          : "Manage"}
      </button>
      {enable.isError && (
        <p role="status" className="w-full text-warning">
          Access changed. Open Manage to review setup.
        </p>
      )}
    </div>
  );
}

export function HistoricalDownloadAccess(
  { instances, ref, onConnect }: {
    instances: Array<{ id: number; name: string; type: string }>;
    ref?: Ref<HistoricalDownloadAccessHandle>;
    onConnect?: (type: "sonarr" | "radarr") => void;
  },
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
  const [feedback, setFeedback] = useState<
    {
      text: string;
      title: string;
      tone: "info" | "success" | "warning";
    } | null
  >(null);
  function setMessage(
    text: string,
    title = "Folder access",
    tone: "info" | "success" | "warning" = "info",
  ) {
    setFeedback(text ? { text, title, tone } : null);
  }
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
          setMessage(
            e instanceof Error ? e.message : String(e),
            "Folder access request failed",
            "warning",
          );
        }
        throw e;
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: accessKey }),
  });
  const services = instances.filter((i) => i.type === "sonarr" || i.type === "radarr");
  const statuses = query.data?.statuses ?? [];
  function edit(status?: HistoricalAccessStatus, serviceId?: number) {
    const existingFolders = [
      ...new Set(
        statuses.filter((s) => s.configuration.enabled)
          .map((s) => s.configuration.localRoot).filter(Boolean),
      ),
    ];
    const suggestions = existingFolders.length
      ? existingFolders
      : query.data?.suggestedLocalFolders ?? [];
    const suggestedFolder = suggestions.length === 1
      ? suggestions[0]
      : suggestions.length
      ? ""
      : "/cleanup-downloads";
    setInstanceId(
      status
        ? String(status.instanceId)
        : serviceId !== undefined
        ? String(serviceId)
        : services.length === 1
        ? String(services[0].id)
        : "",
    );
    setRemoteRoot(status?.configuration.remoteRoot ?? "");
    setLocalRoot(status?.configuration.localRoot || suggestedFolder);
    setNoRemainingClient(status?.configuration.noRemainingClient ?? false);
    setEditing(status?.id);
    setSetupOpen(true);
    setMessage("");
  }
  useImperativeHandle(ref, () => ({
    open(serviceId) {
      setOpen(true);
      setMessage("");
      const folders = statuses.filter((s) => s.instanceId === serviceId);
      if (serviceId !== undefined && !query.isError && folders.length <= 1) {
        edit(folders[0], serviceId);
      } else setSetupOpen(false);
    },
  }));
  return (
    <>
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
                    ? "One download folder, as seen by each app."
                    : "Allow access to exact download files recorded in Sonarr/Radarr history."}
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
            <p className="mt-4 text-xs leading-relaxed text-base-content/60">
              Include eligible leftover downloads when deleting from Sonarr/Radarr. Saving won’t
              delete files.
            </p>
            {query.isError && (
              <p role="alert" className="mt-4 text-sm text-error">
                Folder status could not be loaded.{" "}
                <button type="button" className="link" onClick={() => void query.refetch()}>
                  Try again
                </button>
              </p>
            )}
            {feedback && (
              <div
                role="status"
                aria-live="polite"
                className={`mt-4 flex items-start gap-3 rounded-lg border p-4 text-sm ${
                  feedback.tone === "success"
                    ? "border-success/30 bg-success/10"
                    : feedback.tone === "warning"
                    ? "border-warning/30 bg-warning/10"
                    : "border-info/30 bg-info/10"
                }`}
              >
                {feedback.tone === "success"
                  ? <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" />
                  : feedback.tone === "warning"
                  ? <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" />
                  : <Info className="mt-0.5 size-5 shrink-0 text-info" />}
                <div className="min-w-0 flex-1 break-words">
                  <p className="font-semibold">{feedback.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-base-content/75">
                    {feedback.text}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-square"
                  aria-label="Dismiss access result"
                  onClick={() => setMessage("")}
                >
                  <X className="size-4" />
                </button>
              </div>
            )}
            {!setupOpen
              ? (
                <>
                  <div className="mt-5 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">Download cleanup by service</h3>
                  </div>
                  <div className="mt-2 space-y-3">
                    {(["sonarr", "radarr"] as const).flatMap((type) => {
                      const connections = services.filter((s) => s.type === type);
                      if (!connections.length) {
                        return [
                          <div key={type} className="rounded-xl border border-base-300 p-4">
                            <div className="flex items-center justify-between gap-3">
                              <h4 className="text-sm font-semibold">
                                {type === "sonarr" ? "Sonarr" : "Radarr"}
                              </h4>
                              <span className="badge badge-sm badge-ghost">Not connected</span>
                            </div>
                            <p className="mt-3 text-xs text-base-content/55">
                              Connect this service to set up leftover download cleanup.
                            </p>
                            {onConnect && (
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost mt-3"
                                onClick={() => {
                                  setOpen(false);
                                  onConnect(type);
                                }}
                              >
                                Connect {type === "sonarr" ? "Sonarr" : "Radarr"}
                              </button>
                            )}
                          </div>,
                        ];
                      }
                      return connections.map((service) => {
                        const folders = statuses.filter((s) => s.instanceId === service.id);
                        return (
                          <div
                            key={service.id}
                            className="min-w-0 rounded-xl border border-base-300 p-4"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <h4 className="text-sm font-semibold">{service.name}</h4>
                              {!folders.length && (
                                <span className="badge badge-sm badge-ghost">
                                  {query.isError
                                    ? "Status unavailable"
                                    : query.isPending
                                    ? "Loading…"
                                    : "Not configured"}
                                </span>
                              )}
                            </div>
                            {!folders.length && (
                              <>
                                <p className="mt-3 text-xs text-base-content/55">
                                  Downloaded copies may remain after deleting from{" "}
                                  {service.name}. Set up folder access to include eligible
                                  leftovers.
                                </p>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-primary mt-3"
                                  disabled={query.isPending || query.isError || mutation.isPending}
                                  onClick={() => edit(undefined, service.id)}
                                >
                                  Set up download cleanup
                                </button>
                              </>
                            )}
                            {folders.map((s) => (
                              <div key={s.id} className="mt-3 border-t border-base-300 pt-3">
                                <div className="flex items-center justify-between gap-3">
                                  <h4 className="text-sm font-semibold">
                                    Download folder
                                  </h4>
                                  <AccessBadge status={s.status} />
                                </div>
                                <dl className="mt-3 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                                  <dt className="text-base-content/45">Sonarr/Radarr</dt>
                                  <dd
                                    className="truncate font-mono"
                                    title={s.configuration.remoteRoot}
                                  >
                                    {s.configuration.remoteRoot}
                                  </dd>
                                  <dt className="text-base-content/45">Librarian</dt>
                                  <dd
                                    className="truncate font-mono"
                                    title={s.configuration.localRoot}
                                  >
                                    {s.configuration.localRoot || "Not configured"}
                                  </dd>
                                </dl>
                                <p className="mt-3 text-xs text-base-content/55 break-words [overflow-wrap:anywhere]">
                                  {historicalAccessMessage(s)}
                                </p>
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-primary"
                                    disabled={mutation.isPending}
                                    onClick={() =>
                                      edit(s)}
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
                                        setMessage(
                                          "Checking the configured folder. No files will be deleted.",
                                          `${service.name}: checking access`,
                                        );
                                        const result = await api.historicalAccess.check(s.id);
                                        if (currentServer.current === server) {
                                          const checked = result.statuses.filter((r) =>
                                            r.id === s.id
                                          );
                                          const ready = checked.length > 0 && checked.every((r) =>
                                            r.status === "available"
                                          );
                                          const waiting = checked.length > 0 && checked.every((r) =>
                                            r.status === "checking" ||
                                            r.status === "waiting_for_sample"
                                          );
                                          setMessage(
                                            historicalCheckMessage(checked),
                                            `${service.name}: ${
                                              ready
                                                ? "access check passed"
                                                : waiting
                                                ? "access check pending"
                                                : "access check needs attention"
                                            }`,
                                            ready ? "success" : waiting ? "info" : "warning",
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
                                          s.status === "ready_to_enable"
                                            ? api.historicalAccess.enable(s.id, s.revision)
                                            : api.historicalAccess.save(s.instanceId, {
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
                                    <p>Sonarr/Radarr: {s.configuration.remoteRoot}</p>
                                    {s.sample && <p>Example file: {s.sample}</p>}
                                    {s.reason && <p>{s.reason}</p>}
                                    {s.diagnostic?.details && <p>{s.diagnostic.details}</p>}
                                    <p>
                                      {s.checkedAt
                                        ? `Last checked: ${new Date(s.checkedAt).toLocaleString()}`
                                        : "Not checked yet."}
                                    </p>
                                    {s.succeededAt && (
                                      <p>
                                        Last successful check:{" "}
                                        {new Date(s.succeededAt).toLocaleString()}
                                      </p>
                                    )}
                                  </div>
                                </details>
                              </div>
                            ))}
                            {!!folders.length && (
                              <details className="mt-3 text-xs text-base-content/55">
                                <summary className="cursor-pointer">More folders</summary>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-ghost mt-2"
                                  disabled={mutation.isPending || query.isError}
                                  onClick={() => edit(undefined, service.id)}
                                >
                                  <Plus className="size-3.5" /> Add another folder
                                </button>
                              </details>
                            )}
                          </div>
                        );
                      });
                    })}
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
                      <span className="text-xs font-medium">Media service</span>
                      <select
                        className="select select-bordered select-sm w-full"
                        value={instanceId}
                        required
                        disabled={!!editing}
                        onChange={(e) => setInstanceId(e.target.value)}
                      >
                        <option value="">Choose Sonarr/Radarr</option>
                        {services.map((i) => <option value={i.id} key={i.id}>{i.name}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        Download folder in{" "}
                        {services.find((s) => String(s.id) === instanceId)?.name ?? "Sonarr/Radarr"}
                        <FolderPathHelp
                          service={services.find((s) => String(s.id) === instanceId)?.name ??
                            "Sonarr/Radarr"}
                        />
                      </span>
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
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        Download folder in Librarian <FolderPathHelp />
                      </span>
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
                      Use the completed-downloads folder, not an individual movie or season folder.
                    </p>
                    <details
                      className="rounded-lg border border-base-300 p-3 text-xs"
                      open={noRemainingClient}
                    >
                      <summary className="cursor-pointer font-medium">
                        Advanced{noRemainingClient ? " · No client declared" : ""}
                      </summary>
                      {(!editing ||
                        statuses.some((s) => s.id === editing && !s.configuration.localRoot)) && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs mt-3"
                          disabled={!instanceId || mutation.isPending}
                          onClick={() =>
                            mutation.mutate(async () => {
                              const server = currentServer.current;
                              await api.historicalAccess.discover(Number(instanceId));
                              if (currentServer.current === server) {
                                setSetupOpen(false);
                                setMessage(
                                  "Detection finished. Verified folders show Ready to enable; otherwise use manual setup.",
                                );
                              }
                            })}
                        >
                          Retry folder detection
                        </button>
                      )}
                      <label className="mt-3 flex items-start gap-3">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm mt-0.5"
                          checked={noRemainingClient}
                          onChange={(e) => setNoRemainingClient(e.target.checked)}
                        />
                        <span className="text-xs leading-relaxed">
                          I no longer use a download client for these files.
                          <span className="mt-1 block text-base-content/50">
                            For leftover files whose client is no longer in use. This enables
                            cleanup without a client; it does not turn cleanup off or bypass an
                            unreachable connected client.
                          </span>
                        </span>
                      </label>
                      <details className="mt-4 border-t border-base-300 pt-3 text-xs">
                        <summary className="cursor-pointer font-medium">
                          Need to mount a folder?
                        </summary>
                        <div className="mt-3 space-y-3 leading-relaxed text-base-content/65">
                          <p>Folder cleanup requires Linux, Docker or Unraid.</p>
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
                            <code>docker compose up -d</code>. Librarian cannot mount a folder
                            itself.
                          </p>
                        </div>
                      </details>
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
          <span className="break-words [overflow-wrap:anywhere]">
            {historicalCheckMessage(issues)} Ordinary service deletion remains available.
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
