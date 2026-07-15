import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Download, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import type { QbittorrentInstance } from "../../lib/api";
import { AnimatedSuccessCheck } from "./AnimatedSuccessCheck";

export function QbittorrentConnections({
  onConfigure,
  onRemove,
}: {
  onConfigure: (instance?: QbittorrentInstance) => void;
  onRemove: (instance: QbittorrentInstance) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["qbittorrent-integrations"],
    queryFn: api.qbittorrent.get,
  });
  const test = useMutation({ mutationFn: api.qbittorrent.testInstance });

  useEffect(() => {
    if (!test.isSuccess) return;
    const timeout = globalThis.setTimeout(() => test.reset(), 2_000);
    return () => globalThis.clearTimeout(timeout);
  }, [test.isSuccess]);

  return (
    <section className="border-t border-base-300 pt-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-medium">Download client</h3>
          <p className="text-xs text-base-content/55">
            Connect qBittorrent to inspect and optionally remove verified
            torrent payloads during deletion.
          </p>
        </div>
        {!data?.envConfigured && (
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
      {data?.envConfigured && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3">
          <Download className="size-4 text-primary" />
          <span className="text-sm font-medium">qBittorrent (environment)</span>
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
              ? <AnimatedSuccessCheck />
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
      <div className="min-h-5">
        {test.isError && (
          <p className="mt-1 text-xs text-error">{test.error.message}</p>
        )}
      </div>
    </section>
  );
}
