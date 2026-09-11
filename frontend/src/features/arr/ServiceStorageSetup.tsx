import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import {
  type HostDiscoveryStatus,
  type ServicePathRoot,
  type ServiceStorageEndpoint,
} from "../../../../shared/serviceStorage.ts";

export function discoveryRefreshInterval(status?: HostDiscoveryStatus): number | false {
  if (!status?.enabled) return false;
  return status.checking ? 2000 : 30_000;
}

export function ServiceStorageSetup() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["service-storage"],
    queryFn: () => api.serviceStorage.get(),
    retry: false,
    refetchInterval: (query) => discoveryRefreshInterval(query.state.data?.discovery),
    refetchIntervalInBackground: false,
  });
  const [editing, setEditing] = useState<
    { endpoint: ServiceStorageEndpoint; root?: ServicePathRoot }
  >();
  const [advanced, setAdvanced] = useState(false);
  const discovery = useMutation({
    mutationFn: (action: "enable" | "retry" | "disable") => api.serviceStorage.discovery(action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["service-storage"] }),
  });
  if (query.isPending) return <p role="status">Checking discovery status…</p>;
  if (query.error) {
    return (
      <div role="alert">
        Could not load discovery status.{" "}
        <button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  const status = query.data.discovery;
  const endpoints = query.data.endpoints.filter((endpoint) => endpoint.supportedMedia !== false);
  const needsAttention = !!status?.reason ||
    endpoints.some((endpoint) =>
      status?.services.find((service) => service.serviceKey === endpoint.key)?.state !== "ready"
    );
  const showAction = !status?.enabled || needsAttention || !!discovery.error;
  const discoveryButton = (
    <button
      type="button"
      className="btn btn-sm"
      disabled={discovery.isPending || status?.checking}
      onClick={() => discovery.mutate(status?.enabled ? "retry" : "enable")}
    >
      {status?.enabled ? "Retry discovery" : "Enable host discovery"}
    </button>
  );
  return (
    <section className="space-y-3" aria-label="Host discovery">
      <h3 className="font-semibold">Host discovery</h3>
      <p className="text-sm">
        Connect your services, then enable discovery once for this Linux Docker host. Sonarr/Radarr
        and qBittorrent remain optional and unchecked when deleting.
      </p>
      {endpoints.map((endpoint) => {
        const service = status?.services.find((s) => s.serviceKey === endpoint.key);
        return (
          <p key={endpoint.key}>
            <strong>{endpoint.name}</strong> ·{" "}
            {(service?.connected ?? !!endpoint.connectionTestedAt)
              ? "Connected"
              : "Connection not tested"} · Discovery: {!status?.enabled
              ? "Not enabled"
              : status.checking
              ? "Checking"
              : service?.state === "ready"
              ? "Ready"
              : "Needs attention"}
          </p>
        );
      })}
      {status?.checking && <p role="status">Checking host and connected services…</p>}
      {!status?.enabled && (
        <p className="text-sm">
          Discovery requires the optional host helper. If it is not installed, follow the{" "}
          <a
            className="link"
            href="https://github.com/BrycePearce/plex-librarian/blob/main/deploy/discovery/README.md"
            target="_blank"
            rel="noreferrer"
          >
            Docker/Unraid installation guide
          </a>. Plex-only use does not require a helper.
        </p>
      )}
      {showAction && discoveryButton}
      {discovery.error && (
        <p role="alert">
          {status?.enabled
            ? "Discovery could not be updated. Retry, or open Advanced for details."
            : "Discovery could not be enabled. Check the host helper using the installation guide above, then try again. Details are in Advanced."}
        </p>
      )}
      {status?.enabled && !status.checking && (
        <p role="status" className="text-sm">
          {needsAttention
            ? "Some services need attention. Retry discovery, or open Advanced for details."
            : "Discovery refreshes automatically. Each service’s status is shown above."}
        </p>
      )}
      <details open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
        <summary>Advanced</summary>
        {advanced && (
          <>
            {!showAction && discoveryButton}
            {discovery.error && <p role="alert">{discovery.error.message}</p>}
            {status?.reason && <p className="text-sm text-warning">{status.reason}</p>}
            <p className="text-sm my-2">
              Manual relationships for unsupported layouts are explicit configuration assertions.
              Automatic discovery preserves these overrides. Remove a manual relationship to let
              discovery manage it again.
            </p>
            {status?.enabled && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={discovery.isPending}
                onClick={() => discovery.mutate("disable")}
              >
                Disable host discovery
              </button>
            )}
            {query.data.endpoints.map((endpoint) => {
              const service = status?.services.find((s) => s.serviceKey === endpoint.key);
              const saved = query.data.relationships.filter((r) => r.serviceKey === endpoint.key);
              return (
                <div key={endpoint.key} className="rounded-lg border border-base-300 p-3 space-y-2">
                  <strong>{endpoint.name}</strong>
                  {service?.reason && <p className="text-sm text-warning">{service.reason}</p>}
                  {saved.map((root) => (
                    <div key={root.id} className="text-sm break-all">
                      {root.serviceRoot} → {root.storageRoot}
                      {root.configurationIdentity !== endpoint.configurationIdentity
                        ? " · Evidence needs attention"
                        : ""}
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
                    onClick={() =>
                      setEditing({ endpoint })}
                  >
                    Add relationship
                  </button>
                </div>
              );
            })}
            {editing && (
              <RelationshipForm
                key={`${editing.endpoint.key}:${editing.root?.id ?? "new"}`}
                {...editing}
                onDone={() => {
                  setEditing(undefined);
                  void qc.invalidateQueries({ queryKey: ["service-storage"] });
                }}
              />
            )}
          </>
        )}
      </details>
      <p className="text-xs">
        Discovery describes configuration coverage. Each deletion preview separately checks the
        selected media, destinations, current downloads, and retained content.
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
