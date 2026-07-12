import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  skipToken,
} from "@tanstack/react-query";
import { Server, ExternalLink, Library } from "lucide-react";
import { api, invalidateServerScopedQueries } from "../lib/api";
import type { PlexServer } from "../lib/api";
import "../components/workspace.css";

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ["auth", "status"],
      queryFn: api.auth.status,
    });
    if (status.configured) throw redirect({ to: "/dashboard" });
  },
  component: SetupPage,
});

type Step = "initial" | "polling" | "pick-server";

function SetupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("initial");
  const [pinId, setPinId] = useState<number | null>(null);
  const [authUrl, setAuthUrl] = useState("");
  const [pinExpired, setPinExpired] = useState(false);
  const authPopup = useRef<Window | null>(null);
  const [servers, setServers] = useState<PlexServer[]>([]);

  const createPin = useMutation({
    mutationFn: () => api.auth.createPin(),
    onSuccess: (data) => {
      setPinId(data.pinId);
      setAuthUrl(data.authUrl);
      setPinExpired(false);
      authPopup.current = globalThis.open(data.authUrl, "plex-auth", "width=800,height=700");
      setStep("polling");
    },
  });

  useEffect(() => {
    if (step !== "polling") return;
    const timer = setTimeout(() => setPinExpired(true), 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [step]);

  const { data: pollData } = useQuery({
    queryKey: ["auth", "pin", pinId],
    queryFn:
      step === "polling" && pinId !== null && !pinExpired
        ? () => api.auth.pollPin(pinId)
        : skipToken,
    refetchInterval: 2_000,
  });

  useEffect(() => {
    if (pollData?.status === "complete") {
      authPopup.current?.close();
      setServers(pollData.servers);
      setStep("pick-server");
    }
  }, [pollData]);

  const chooseServer = useMutation({
    mutationFn: ({ server, uri }: { server: PlexServer; uri: string }) =>
      api.auth.chooseServer(uri, server.accessToken, server.machineIdentifier, server.name),
    onSuccess: async () => {
      await qc.refetchQueries({ queryKey: ["auth", "status"] });
      await invalidateServerScopedQueries(qc);
      // Prefetch the dashboard's own queries against the newly-connected server before
      // navigating, so they're already resolved by the time it mounts — otherwise the
      // dashboard can't tell, before its own fetches land, whether this is a returning
      // user's populated grid or a brand-new server with nothing synced yet.
      await Promise.all([
        qc.prefetchQuery({
          queryKey: ["libraries"],
          queryFn: () => api.libraries.list(),
        }),
        qc.prefetchQuery({
          queryKey: ["sync", "history"],
          queryFn: () => api.sync.history(10),
        }),
      ]);
      void navigate({ to: "/dashboard" });
    },
  });

  return (
    <div className="setup-page flex items-center justify-center min-h-[calc(100vh-8rem)]">
      {step === "initial" && (
        <div className="card workspace-surface setup-card w-full max-w-md">
          <div className="card-body items-center text-center gap-6">
            <span className="setup-brand-mark"><Library className="size-7" /></span>
            <span className="workspace-eyebrow">Library intelligence</span>
            <h1 className="card-title text-3xl">Welcome</h1>
            <p className="text-base-content/60">
              Sign in with Plex to get started.
            </p>
            <button
              type="button"
              className="btn w-full bg-plex hover:bg-plex/90 border-plex hover:border-plex/90 text-white px-7.5 py-3.25 font-plex text-[16px] font-bold"
              onClick={() => createPin.mutate()}
              disabled={createPin.isPending}
            >
              {createPin.isPending ? (
                <span className="loading loading-spinner" />
              ) : (
                "Sign in with Plex"
              )}
            </button>
            {createPin.isError && (
              <div className="alert alert-error text-sm">
                {createPin.error.message}
              </div>
            )}
          </div>
        </div>
      )}

      {step === "polling" && (
        <div className="card workspace-surface setup-card w-full max-w-md">
          <div className="card-body items-center text-center gap-6 py-10">
            {pinExpired ? (
              <div className="alert alert-warning text-sm w-full">
                Link expired. Start over to try again.
              </div>
            ) : (
              <>
                <span className="loading loading-ring w-16 text-plex" />
                <div className="flex flex-col gap-1">
                  <h2 className="card-title text-2xl justify-center">
                    Waiting for authorization
                  </h2>
                  <p className="text-base-content/60">
                    Complete sign-in in the Plex tab that just opened.
                  </p>
                </div>
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-outline btn-sm gap-2"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open Plex
                </a>
              </>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm text-base-content/50"
              onClick={() => {
                setStep("initial");
                setPinId(null);
              }}
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {step === "pick-server" && (
        <div className="card workspace-surface setup-card w-full max-w-md">
          <div className="card-body gap-4">
            <h2 className="card-title text-2xl">Choose your server</h2>
            <p className="text-base-content/60 text-sm text-center">
              Select the server you want to monitor. Only servers you own are
              shown.
            </p>
            <div className="flex flex-col gap-2">
              {servers.map((server) => {
                const bestConn = server.connections[0];
                if (!bestConn) return null;
                // Choosing a server blocks server-side on both connecting to Plex and
                // kicking off the initial sync before it responds — worth its own
                // per-button spinner rather than just a disabled state, since on a slow
                // connection that round trip can take a noticeable moment.
                const isConnecting = chooseServer.isPending &&
                  chooseServer.variables?.server.machineIdentifier ===
                    server.machineIdentifier;
                return (
                  <button
                    type="button"
                    key={`${server.name}:${bestConn.uri}`}
                    className="btn btn-outline justify-start gap-3 h-auto py-3"
                    onClick={() =>
                      chooseServer.mutate({ server, uri: bestConn.uri })
                    }
                    disabled={chooseServer.isPending}
                  >
                    {isConnecting
                      ? <span className="loading loading-spinner w-5 h-5 shrink-0" />
                      : <Server className="w-5 h-5 shrink-0" />}
                    <div className="text-left min-w-0">
                      <div className="font-semibold">{server.name}</div>
                      <div className="text-xs text-base-content/50 truncate">
                        {isConnecting ? "Connecting…" : bestConn.uri}
                      </div>
                    </div>
                    {!isConnecting && bestConn.local && (
                      <span className="badge badge-success badge-sm ml-auto shrink-0">
                        local
                      </span>
                    )}
                    {!isConnecting && !bestConn.local && bestConn.relay && (
                      <span className="badge badge-warning badge-sm ml-auto shrink-0">
                        relay
                      </span>
                    )}
                  </button>
                );
              })}
              {servers.length === 0 && (
                <p className="text-base-content/40 text-sm text-center py-4">
                  No servers found on this account.
                </p>
              )}
            </div>
            {chooseServer.isError && (
              <div className="alert alert-error text-sm">
                {chooseServer.error.message}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
