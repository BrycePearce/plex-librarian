import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import {
  type HostDiscoveryStatus,
  type ServicePathRoot,
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
  const [removing, setRemoving] = useState<ServicePathRoot>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const discovery = useMutation({
    mutationFn: (action: "enable" | "retry" | "disable") => api.serviceStorage.discovery(action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["service-storage"] }),
  });
  const remove = useMutation({
    mutationFn: (root: ServicePathRoot) => api.serviceStorage.remove(root.id),
    onSuccess: async () => {
      setRemoving(undefined);
      await qc.invalidateQueries({ queryKey: ["service-storage"] });
    },
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
        Run Plex and your connected services on the same Unraid or Linux Docker host. Install the
        helper, then enable discovery once. Different container paths are supported. Sonarr/Radarr
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
          First install the host helper and connect its shared discovery directory to Librarian
          using the{" "}
          <a
            className="link"
            href="https://github.com/BrycePearce/plex-librarian/blob/main/deploy/discovery/README.md"
            target="_blank"
            rel="noreferrer"
          >
            Docker/Unraid installation guide
          </a>. Updating Librarian or reconnecting a service does not install the helper. Plex-only
          use does not require it.
        </p>
      )}
      {showAction && discoveryButton}
      {discovery.error && (
        <p role="alert">
          {status?.enabled
            ? "Discovery could not be updated. Retry, or open Discovery details."
            : "Discovery could not be enabled. Check the host helper using the installation guide above, then try again. Open Discovery details for the error."}
        </p>
      )}
      {status?.enabled && !status.checking && (
        <p role="status" className="text-sm">
          {needsAttention
            ? "Some services need attention. Retry discovery, or open Discovery details."
            : "Discovery refreshes automatically. Each service’s status is shown above."}
        </p>
      )}
      <details open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
        <summary>Discovery details</summary>
        {detailsOpen && (
          <>
            {!showAction && discoveryButton}
            {discovery.error && <p role="alert">{discovery.error.message}</p>}
            {status?.reason && <p className="text-sm text-warning">{status.reason}</p>}
            <p className="text-sm my-2">
              Discovery supports services on one Unraid or Linux Docker host. Unsupported or
              ambiguous layouts stay unavailable. Existing saved mappings are preserved.
            </p>
            {!!query.data.relationships.length && (
              <a
                className="btn btn-sm"
                download="librarian-storage-mappings.json"
                href={"data:application/json;charset=utf-8," +
                  encodeURIComponent(JSON.stringify(query.data.relationships, null, 2))}
              >
                Download mapping backup
              </a>
            )}
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
                      <button
                        type="button"
                        className="btn btn-xs"
                        disabled={remove.isPending || discovery.isPending || status?.checking}
                        onClick={() => {
                          remove.reset();
                          setRemoving(root);
                        }}
                      >
                        Remove mapping
                      </button>
                      {root.configurationIdentity !== endpoint.configurationIdentity
                        ? " · Evidence needs attention"
                        : ""}
                    </div>
                  ))}
                </div>
              );
            })}
            {removing && (
              <div
                className="rounded-lg border border-warning p-3 space-y-2"
                role="group"
                aria-label="Remove saved mapping"
              >
                <p>
                  Remove the saved mapping for{" "}
                  <code>{removing.serviceRoot}</code>? Download a backup first. This does not delete
                  media. Deletion through this path may become unavailable until discovery
                  identifies it again.
                </p>
                {remove.error && <p role="alert">{remove.error.message}</p>}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={remove.isPending}
                  onClick={() => setRemoving(undefined)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(removing)}
                >
                  Confirm remove mapping
                </button>
                <p className="text-xs">
                  After removing the old mappings for a service, use Retry discovery to check its
                  current paths.
                </p>
              </div>
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
