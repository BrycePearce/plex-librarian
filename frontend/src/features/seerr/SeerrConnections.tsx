import { useMutation, useQuery } from "@tanstack/react-query";
import { ListPlus, Plus, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { AnimatedSuccessCheck } from "../arr/AnimatedSuccessCheck";
import { api } from "../../lib/api";
import type { SeerrInstance } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function SeerrConnections({
  onConfigure,
  onRemove,
}: {
  onConfigure: (instance?: SeerrInstance) => void;
  onRemove: (instance: SeerrInstance) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.seerrIntegrations.all,
    queryFn: api.seerr.get,
  });
  const test = useMutation({ mutationFn: api.seerr.testInstance });

  useEffect(() => {
    if (!test.isSuccess) return;
    const timeout = globalThis.setTimeout(() => test.reset(), 2_000);
    return () => globalThis.clearTimeout(timeout);
  }, [test.isSuccess]);

  const isEmpty = !isLoading && !error && data?.instances.length === 0;
  return (
    <section className="border-t border-base-content/10 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            Request manager
            <span className="badge badge-warning badge-outline badge-xs">Beta</span>
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-base-content/50">
            Seerr connection setup is available now; request syncing and insights are not active
            yet.
          </p>
        </div>
        {!isEmpty && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onConfigure()}
          >
            <Plus className="size-4" /> Add Seerr
          </button>
        )}
      </div>

      {isLoading && <span className="mt-3 loading loading-spinner loading-sm" />}
      {error && <p className="mt-2 text-xs text-error">{error.message}</p>}
      {isEmpty && (
        <div className="mt-3 flex flex-wrap items-center gap-4 rounded-2xl border border-dashed border-base-content/15 bg-base-200/30 p-4 transition-colors hover:border-primary/25 hover:bg-base-200/45">
          <span className="grid size-11 place-items-center rounded-xl border border-primary/10 bg-primary/10 text-primary">
            <ListPlus className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <strong className="block text-sm">
              No request manager connected
            </strong>
            <span className="mt-1 block text-xs leading-relaxed text-base-content/50">
              Add Seerr with its URL and API key.
            </span>
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onConfigure()}
          >
            <Plus className="size-4" /> Add Seerr
          </button>
        </div>
      )}
      {data?.instances.map((instance) => (
        <div
          key={instance.id}
          className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3"
        >
          <ListPlus className="size-4 text-primary" />
          <span className="font-medium">{instance.name}</span>
          <span className="badge badge-warning badge-outline badge-xs">Beta</span>
          <span className="min-w-0 flex-1 truncate text-xs text-base-content/50">
            {instance.url}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => onConfigure(instance)}
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
        {test.isError && <p className="mt-1 text-xs text-error">{test.error.message}</p>}
      </div>
    </section>
  );
}
