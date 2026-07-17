import { createFileRoute, redirect } from "@tanstack/react-router";
import { Server, ExternalLink, Library } from "lucide-react";
import { usePlexSetupFlow } from "../features/setup/usePlexSetupFlow";
import { api } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import "../components/workspace.css";

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: queryKeys.auth.status,
      queryFn: api.auth.status,
    });
    if (status.configured) throw redirect({ to: "/dashboard" });
  },
  component: SetupPage,
});

function SetupPage() {
  const {
    step,
    authUrl,
    pinExpired,
    servers,
    automaticServer,
    isConfiguredHandoff,
    envIncomplete,
    isStartingSignIn,
    signInError,
    authorizationError,
    isConnecting,
    connectionError,
    connectingServerId,
    startSignIn,
    restart,
    connectServer,
    retryConnection,
  } = usePlexSetupFlow();

  return (
    <div className="setup-page flex items-center justify-center min-h-[calc(100vh-8rem)]">
      {step === "initial" && !isConfiguredHandoff && (
        <div className="card workspace-surface setup-card w-full max-w-md">
          <div className="card-body items-center text-center gap-6">
            <span className="setup-brand-mark">
              <Library className="size-7" />
            </span>
            <span className="workspace-eyebrow">Library intelligence</span>
            <h1 className="card-title text-3xl">Welcome</h1>
            <p className="text-base-content/60">
              Sign in with Plex to get started.
            </p>
            {envIncomplete ? (
              <div className="alert alert-error text-sm text-left">
                PLEX_URL and PLEX_TOKEN must either both be set or both be left
                blank. Fix the container configuration and restart Plex
                Librarian.
              </div>
            ) : (
              <button
                type="button"
                className="btn w-full bg-plex hover:bg-plex/90 border-plex hover:border-plex/90 text-white px-7.5 py-3.25 font-plex text-[16px] font-bold"
                onClick={startSignIn}
                disabled={isStartingSignIn}
              >
                {isStartingSignIn ? (
                  <span className="loading loading-spinner" />
                ) : (
                  "Sign in with Plex"
                )}
              </button>
            )}
            {signInError && (
              <div className="alert alert-error text-sm">
                {signInError.message}
              </div>
            )}
          </div>
        </div>
      )}

      {isConfiguredHandoff && (
        <div
          className="flex flex-1 items-center justify-center"
          aria-label="Opening dashboard"
        >
          <span className="loading loading-ring loading-lg text-primary" />
        </div>
      )}

      {step === "polling" && (
        <div className="card workspace-surface setup-card w-full max-w-md">
          <div className="card-body items-center text-center gap-6 py-10">
            {pinExpired ? (
              <div className="alert alert-warning text-sm w-full">
                Link expired. Start over to try again.
              </div>
            ) : authorizationError ? (
              <div className="alert alert-error text-sm w-full">
                {authorizationError.message}
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
              onClick={restart}
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {step === "connecting" && (
        <div className="card workspace-surface setup-card w-full max-w-md">
          <div className="card-body items-center text-center gap-6 py-10">
            {!connectionError && (
              <span className="loading loading-ring w-16 text-plex" />
            )}
            <div className="flex flex-col gap-1">
              <h2 className="card-title text-2xl justify-center">
                Connecting to {automaticServer?.name ?? "your server"}
              </h2>
              <p className="text-base-content/60">
                Finding the best address and starting your first sync…
              </p>
            </div>
            {connectionError && (
              <>
                <div className="alert alert-error text-sm w-full">
                  {connectionError.message}
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={retryConnection}
                >
                  Try again
                </button>
              </>
            )}
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
                const isThisServerConnecting =
                  isConnecting &&
                  connectingServerId === server.machineIdentifier;
                return (
                  <button
                    type="button"
                    key={`${server.name}:${bestConn.uri}`}
                    className="btn btn-outline justify-start gap-3 h-auto py-3"
                    onClick={() => connectServer(server)}
                    disabled={isConnecting}
                  >
                    {isThisServerConnecting ? (
                      <span className="loading loading-spinner w-5 h-5 shrink-0" />
                    ) : (
                      <Server className="w-5 h-5 shrink-0" />
                    )}
                    <div className="text-left min-w-0">
                      <div className="font-semibold">{server.name}</div>
                      <div className="text-xs text-base-content/50 truncate">
                        {isThisServerConnecting
                          ? "Finding the best connection…"
                          : "Plex Media Server"}
                      </div>
                    </div>
                    {!isThisServerConnecting && bestConn.local && (
                      <span className="badge badge-success badge-sm ml-auto shrink-0">
                        local
                      </span>
                    )}
                    {!isThisServerConnecting &&
                      !bestConn.local &&
                      bestConn.relay && (
                        <span className="badge badge-warning badge-sm ml-auto shrink-0">
                          relay
                        </span>
                      )}
                  </button>
                );
              })}
              {servers.length === 0 && (
                <p className="text-base-content/40 text-sm text-center py-4">
                  Plex did not report an owned server with a usable address for
                  this account. Make sure your server is online, then start
                  over.
                </p>
              )}
            </div>
            {connectionError && (
              <div className="alert alert-error text-sm">
                {connectionError.message}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
