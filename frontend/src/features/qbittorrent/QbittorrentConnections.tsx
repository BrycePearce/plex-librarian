import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CircleHelp, Download, Plus, Trash2, TriangleAlert } from "lucide-react";
import { api } from "../../lib/api.ts";
import type { QbittorrentInstance } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { AnimatedSuccessCheck } from "../arr/AnimatedSuccessCheck.tsx";
import { IntegrationCompatibilityIndicator } from "../integrationCompatibility/IntegrationCompatibilityIndicator.tsx";

export function QbittorrentConnections({
  onConfigure,
  onRemove,
}: {
  onConfigure: (instance?: QbittorrentInstance) => void;
  onRemove: (instance: QbittorrentInstance) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.qbittorrentIntegrations.all,
    queryFn: api.qbittorrent.get,
  });
  const queryClient = useQueryClient();
  const { data: compatibilityData } = useQuery({
    queryKey: queryKeys.integrationCompatibility.all,
    queryFn: api.integrationCompatibility.get,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const test = useMutation({
    mutationFn: api.qbittorrent.testInstance,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.integrationCompatibility.all }),
  });
  const [mapping, setMapping] = useState({
    instanceKey: "",
    qbittorrentPath: "",
    localPath: "",
    validationQbittorrentPath: "",
    validationLocalPath: "",
    validationSize: "",
    caseSensitive: true,
  });
  const saveMapping = useMutation({
    mutationFn: () =>
      api.qbittorrent.createPathMapping({
        ...mapping,
        validationSize: Number(mapping.validationSize),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.qbittorrentIntegrations.all });
      setMapping((current) => ({
        ...current,
        qbittorrentPath: "",
        localPath: "",
        validationQbittorrentPath: "",
        validationLocalPath: "",
        validationSize: "",
      }));
    },
  });
  const removeMapping = useMutation({
    mutationFn: api.qbittorrent.deletePathMapping,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.qbittorrentIntegrations.all }),
  });

  useEffect(() => {
    if (!test.isSuccess) return;
    const timeout = globalThis.setTimeout(() => test.reset(), 2_000);
    return () => globalThis.clearTimeout(timeout);
  }, [test.isSuccess]);

  const isEmpty = !isLoading && !error && data && !data.envConfigured &&
    data.instances.length === 0;

  return (
    <section className="border-t border-base-content/10 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-semibold">Download client</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-base-content/50">
            Connect qBittorrent to inspect and optionally remove verified torrent payloads during
            deletion.
          </p>
        </div>
        {!data?.envConfigured && !isEmpty && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onConfigure()}
          >
            <Plus className="size-4" /> Add qBittorrent
          </button>
        )}
      </div>

      {isLoading &&
        <span className="mt-3 loading loading-spinner loading-sm" />}
      {error && <p className="mt-2 text-xs text-error">{error.message}</p>}
      {isEmpty && (
        <div className="mt-3 flex flex-wrap items-center gap-4 rounded-2xl border border-dashed border-base-content/15 bg-base-200/30 p-4 transition-colors hover:border-primary/25 hover:bg-base-200/45">
          <span className="grid size-11 place-items-center rounded-xl border border-primary/10 bg-primary/10 text-primary">
            <Download className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <strong className="block text-sm">
              No download client connected
            </strong>
            <span className="mt-1 block text-xs leading-relaxed text-base-content/50">
              Add qBittorrent when you want verified torrent cleanup during deletion.
            </span>
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onConfigure()}
          >
            <Plus className="size-4" /> Add qBittorrent
          </button>
        </div>
      )}
      {data?.envConfigured && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3">
          <Download className="size-4 text-primary" />
          <span className="text-sm font-medium">qBittorrent (environment)</span>
          <IntegrationCompatibilityIndicator
            check={compatibilityData?.checks.find((check) =>
              check.kind === "qbittorrent" && check.instanceId === null
            )}
          />
          <span className="badge badge-sm badge-outline">
            Managed by environment variables
          </span>
        </div>
      )}
      {data?.instances.map((instance) => (
        <div
          key={instance.id}
          className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3"
        >
          <Download className="size-4 text-primary" />
          <span className="font-medium">{instance.name}</span>
          <IntegrationCompatibilityIndicator
            check={test.isSuccess && test.variables === instance.id
              ? test.data
              : compatibilityData?.checks.find((check) =>
                check.kind === "qbittorrent" && check.instanceId === instance.id
              )}
          />
          <span className="min-w-0 flex-1 truncate text-xs text-base-content/50">
            {instance.url}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => onConfigure(instance)}
            disabled={test.isPending || data.envConfigured}
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
              ? test.data.status === "compatible"
                ? <AnimatedSuccessCheck />
                : test.data.status === "unverified"
                ? <CircleHelp className="size-4 text-info" />
                : <TriangleAlert className="size-4 text-warning" />
              : (
                "Test"
              )}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs text-error"
            aria-label={`Remove ${instance.name}`}
            onClick={() => onRemove(instance)}
            disabled={test.isPending}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      ))}
      {data && data.targets.length > 0 && (
        <div className="mt-4 rounded-xl border border-base-300 bg-base-200/25 p-4">
          <h4 className="text-sm font-semibold">Direct-discovery path mappings</h4>
          <p className="mt-1 text-xs text-base-content/55">
            Map qBittorrent container paths to this container using one exact existing file. This
            enables verified cleanup without Sonarr history; connection credentials remain
            unchanged.
          </p>
          {data.pathMappings.map((item) => (
            <div key={item.id} className="mt-2 flex items-center gap-2 text-xs">
              <code>{item.qbittorrentPath}</code>
              <span>→</span>
              <code>{item.localPath}</code>
              <span className="badge badge-xs badge-outline">rev {item.revision}</span>
              <button
                type="button"
                className="btn btn-ghost btn-xs ml-auto text-error"
                onClick={() =>
                  removeMapping.mutate(item.id)}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <select
              className="select select-bordered select-sm sm:col-span-2"
              value={mapping.instanceKey}
              onChange={(event) => setMapping({ ...mapping, instanceKey: event.target.value })}
            >
              <option value="">Choose qBittorrent target</option>
              {data.targets.map((target) => (
                <option key={target.instanceKey} value={target.instanceKey}>{target.name}</option>
              ))}
            </select>
            {([
              ["qbittorrentPath", "qBittorrent root, e.g. /downloads"],
              ["localPath", "Local root, e.g. /downloads"],
              ["validationQbittorrentPath", "Exact qBittorrent validation file"],
              ["validationLocalPath", "Exact local validation file"],
            ] as const).map(([key, placeholder]) => (
              <input
                key={key}
                className="input input-bordered input-sm"
                placeholder={placeholder}
                value={mapping[key]}
                onChange={(event) => setMapping({ ...mapping, [key]: event.target.value })}
              />
            ))}
            <input
              className="input input-bordered input-sm"
              inputMode="numeric"
              placeholder="Exact validation size in bytes"
              value={mapping.validationSize}
              onChange={(event) => setMapping({ ...mapping, validationSize: event.target.value })}
            />
            <label className="label cursor-pointer justify-start gap-2 text-xs">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={mapping.caseSensitive}
                onChange={(event) =>
                  setMapping({ ...mapping, caseSensitive: event.target.checked })}
              />
              qBittorrent paths are case-sensitive
            </label>
          </div>
          {saveMapping.isError && (
            <p className="mt-2 text-xs text-error">{saveMapping.error.message}</p>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm mt-3"
            disabled={saveMapping.isPending || !mapping.instanceKey || !mapping.qbittorrentPath ||
              !mapping.localPath || !mapping.validationQbittorrentPath ||
              !mapping.validationLocalPath || Number(mapping.validationSize) <= 0}
            onClick={() => saveMapping.mutate()}
          >
            {saveMapping.isPending && <span className="loading loading-spinner loading-xs" />}
            Add validated mapping
          </button>
        </div>
      )}
      <div className="min-h-5">
        {test.isError && <p className="mt-1 text-xs text-error">{test.error.message}</p>}
      </div>
    </section>
  );
}
