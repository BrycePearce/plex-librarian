import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import {
  type ServicePathRoot,
  type ServiceStorageEndpoint,
  storageContains,
} from "../../../../shared/serviceStorage.ts";

export function ServiceStorageSetup() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["service-storage"],
    queryFn: () => api.serviceStorage.get(true),
    retry: false,
  });
  const [editing, setEditing] = useState<
    { endpoint: ServiceStorageEndpoint; root?: ServicePathRoot }
  >();
  const [advanced, setAdvanced] = useState(false);
  const confirm = useMutation({
    mutationFn: (fingerprint: string) => api.serviceStorage.confirm(fingerprint),
    onSuccess: (data) => {
      qc.setQueryData(["service-storage"], data);
    },
  });
  if (query.isPending) {
    return <p role="status">Testing connections and discovering current service roots…</p>;
  }
  if (query.error) {
    return (
      <div role="alert">
        Could not load storage relationships.{" "}
        <button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <section className="space-y-3" aria-label="Deletion readiness">
      <h3 className="font-semibold">Deletion setup</h3>
      <p className="text-sm">
        Librarian discovers your services and reuses saved setup for future media. Sonarr/Radarr and
        qBittorrent remain optional and unchecked when deleting.
      </p>
      <p className="text-sm">
        {query.data.endpoints.filter((endpoint) => endpoint.supportedMedia !== false).map((
          endpoint,
        ) => (
          <span key={endpoint.key} className="inline-block mr-3">
            {endpoint.name}:{" "}
            {endpoint.connectionTestedAt ? "Connected" : "Connection needs attention"}
          </span>
        ))}
      </p>
      {query.data.automation?.status === "ready" && (
        <p role="status" className="text-success">
          {query.data.automation.unavailableServices?.length
            ? "Setup ready for the available services. "
            : "Setup ready. "}
          Librarian will reuse this setup for future media.
        </p>
      )}
      {query.data.automation?.status === "confirmation_required" &&
        query.data.automation.proposal && (
        <div className="rounded-lg border border-base-300 p-3 space-y-2">
          <p>
            One confirmation: does <code>{query.data.automation.proposal.sharedRoot}</code>{" "}
            point to the same storage in {query.data.automation.proposal.serviceNames.join(", ")}?
          </p>
          <p className="text-sm">
            Confirm only if these services share that directory, with case-sensitive paths and no
            hidden path aliases. Librarian will save the relationships together; no media mount or
            per-title setup is needed.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={confirm.isPending || confirm.isError || query.isFetching}
            onClick={() => confirm.mutate(query.data.automation!.proposal!.fingerprint)}
          >
            {confirm.isPending ? "Saving setup…" : "Yes, these services share this storage"}
          </button>
        </div>
      )}
      {(!query.data.automation || query.data.automation.status === "unavailable") && (
        <p role="status" className="text-warning">
          {query.data.automation?.reason ??
            "Automatic setup is unavailable for this configuration."}{" "}
          Affected deletion choices remain unavailable. Browsing and independently eligible deletion
          choices remain available.
        </p>
      )}
      {query.data.automation?.unavailableServices?.map((service) => (
        <p key={service.serviceKey} role="status" className="text-warning">
          {service.name} deletion is not ready. {service.reason}{" "}
          You can continue with the other available services.
        </p>
      ))}
      {confirm.error && (
        <p role="alert">
          Setup was not confirmed: {confirm.error.message}{" "}
          Refresh connections and review the current proposal before trying again.
        </p>
      )}
      <button
        type="button"
        className="btn btn-sm"
        disabled={query.isFetching}
        onClick={() => {
          confirm.reset();
          void query.refetch();
        }}
      >
        Refresh connections
      </button>
      <details open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
        <summary>Advanced</summary>
        <p className="text-sm my-2">
          Service paths and manual relationships for custom layouts. These are configuration
          assertions, not filesystem verification.
        </p>
        {advanced && query.data.endpoints.map((endpoint) => {
          const saved = query.data.relationships.filter((root) => root.serviceKey === endpoint.key);
          const ready = saved.length > 0 && saved.every((root) =>
            !root.hasAliases && root.configurationIdentity === endpoint.configurationIdentity
          ) && endpoint.roots.every((path) =>
            saved.some((root) =>
              storageContains(root.serviceRoot, path, root.caseSensitive)
            )
          );
          return (
            <div key={endpoint.key} className="rounded-lg border border-base-300 p-3 space-y-2">
              <p>
                <strong>{endpoint.name}</strong> ·{" "}
                {endpoint.connectionTestedAt ? "Connected" : "Connection needs attention"} ·{" "}
                {ready ? "Relationships confirmed" : "Confirm storage relationships"}
              </p>
              {endpoint.discoveryError && (
                <p className="text-sm text-warning">{endpoint.discoveryError}</p>
              )}
              {endpoint.roots.length === 0 && (
                <p className="text-sm">
                  No roots were discovered. You can enter a reusable root now, including for an
                  empty library.
                </p>
              )}
              {saved.map((root) => (
                <div key={root.id} className="text-sm break-all">
                  {root.serviceRoot} → {root.storageRoot}
                  {root.configurationIdentity !== endpoint.configurationIdentity
                    ? " · Connection changed; confirm again"
                    : ""}
                  {root.hasAliases ? " · Aliases declared; affected deletion is blocked" : ""}{" "}
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => setEditing({ endpoint, root })}
                  >
                    Edit
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setEditing({ endpoint })}
              >
                Add relationship
              </button>
            </div>
          );
        })}
        {advanced && editing && (
          <RelationshipForm
            key={`${editing.endpoint.key}:${editing.root?.id ?? "new"}`}
            {...editing}
            onDone={() => {
              setEditing(undefined);
              void qc.invalidateQueries({ queryKey: ["service-storage"] });
            }}
          />
        )}
      </details>
      <p className="text-xs">
        Readiness confirms configuration coverage. Each deletion preview still checks the current
        selection, complete download manifests, and retained media.
      </p>
    </section>
  );
}

function RelationshipForm(
  { endpoint, root, onDone }: {
    endpoint: ServiceStorageEndpoint;
    root?: ServicePathRoot;
    onDone: () => void;
  },
) {
  const [serviceRoot, setServiceRoot] = useState(root?.serviceRoot ?? endpoint.roots[0] ?? "");
  const [storageRoot, setStorageRoot] = useState(root?.storageRoot ?? "");
  const [caseSensitive, setCaseSensitive] = useState(root?.caseSensitive ?? true);
  const [hasAliases, setHasAliases] = useState(root?.hasAliases ?? false);
  const [confirmed, setConfirmed] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.serviceStorage.save({
        serviceKey: endpoint.key,
        configurationIdentity: endpoint.configurationIdentity,
        serviceRoot,
        storageRoot,
        caseSensitive,
        hasAliases,
        confirmed: true,
        ...(root ? { id: root.id, revision: root.revision } : {}),
      }),
    onSuccess: onDone,
  });
  const remove = useMutation({
    mutationFn: () => api.serviceStorage.remove(root!.id),
    onSuccess: onDone,
  });
  return (
    <form
      className="space-y-3 rounded-lg border border-primary p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (confirmed) save.mutate();
      }}
    >
      <h4 className="font-semibold">{endpoint.name}: confirm a storage relationship</h4>
      <label className="block">
        Path in this service<input
          className="input w-full"
          list="service-root-hints"
          value={serviceRoot}
          onChange={(event) => {
            setServiceRoot(event.target.value);
            setConfirmed(false);
          }}
          placeholder="/tv"
          required
        />
      </label>
      <datalist id="service-root-hints">
        {endpoint.roots.map((path) => <option key={path} value={path} />)}
      </datalist>
      <label className="block">
        Shared storage root<input
          className="input w-full"
          value={storageRoot}
          onChange={(event) => {
            setStorageRoot(event.target.value);
            setConfirmed(false);
          }}
          placeholder="/storage/media/TV"
          required
        />
      </label>
      <p className="text-sm">
        Use the same shared prefix for the same directory across services. For example, Plex /tv and
        Sonarr /data/media/TV can both map to /storage/media/TV. This is a comparison namespace, not
        a folder to mount in Librarian.
      </p>
      <details>
        <summary>Advanced</summary>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => {
              setCaseSensitive(event.target.checked);
              setConfirmed(false);
            }}
          />Paths are case-sensitive
        </label>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={hasAliases}
            onChange={(event) => {
              setHasAliases(event.target.checked);
              setConfirmed(false);
            }}
          />This root contains unresolved symlink, bind-mount, or path aliases
        </label>
        <p className="text-xs">
          Declared aliases block affected deletion until resolved. Use distinct shared prefixes for
          different copies. Hardlinks with different directory entries may be retained
          independently; reclaimed disk space is not measured.
        </p>
      </details>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />I confirm this relationship and the declared case and alias rules.
      </label>
      {(save.error || remove.error) && <p role="alert">{(save.error ?? remove.error)?.message}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={!confirmed || save.isPending || remove.isPending}
        >
          Save relationship
        </button>
        <button type="button" className="btn btn-sm" onClick={onDone}>Cancel</button>
        {root && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={save.isPending || remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove relationship
          </button>
        )}
      </div>
    </form>
  );
}
