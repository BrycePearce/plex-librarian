import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import {
  ArrowRight,
  Check,
  ExternalLink,
  Library,
  Radio,
  Server,
} from "lucide-react";
import { usePlexSetupFlow } from "../features/setup/usePlexSetupFlow";
import { api } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import "../components/workspace.css";
import "./setup.css";

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
    isConnected,
    connectionError,
    connectingServerId,
    startSignIn,
    restart,
    connectServer,
    retryConnection,
  } = usePlexSetupFlow();
  const ringStep = step === "initial" ? 1 : step === "polling" ? 2 : 3;
  const isFinale = isConnected || isConfiguredHandoff;

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={`setup-page flex items-center justify-center min-h-[calc(100vh-8rem)] ${
          isFinale ? "setup-page-finale" : `setup-page-step-${ringStep}`
        }`}
      >
        <div
          className={`setup-ring-glow ${
            isFinale ? "setup-ring-finale" : `setup-ring-step-${ringStep}`
          }`}
          aria-hidden="true"
        >
          <span className="setup-ring-orbit setup-ring-orbit-1" />
          <span className="setup-ring-orbit setup-ring-orbit-2" />
          <span className="setup-ring-orbit setup-ring-orbit-3" />
          <span className="setup-ring-ripple" />
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {step === "initial" && !isConfiguredHandoff && (
            <SetupStage key="initial">
              <div className="card workspace-surface setup-card w-full max-w-md">
                <SetupPerimeter />
                <div className="card-body items-center text-center gap-6">
                  <SetupProgress current={0} />
                  <span className="setup-brand-mark setup-brand-mark-hero">
                    <Library className="size-7" />
                  </span>
                  <div className="setup-heading-group">
                    <span className="workspace-eyebrow">
                      Library intelligence
                    </span>
                    <h1 className="card-title text-3xl">
                      Welcome to Plex Librarian
                    </h1>
                    <p>Turn your library data into space-saving insight.</p>
                  </div>
                  {envIncomplete
                    ? (
                      <div className="alert alert-error text-sm text-left">
                        PLEX_URL and PLEX_TOKEN must either both be set or both
                        be left blank. Fix the container configuration and
                        restart Plex Librarian.
                      </div>
                    )
                    : (
                      <button
                        type="button"
                        className="btn setup-plex-button w-full bg-plex border-plex text-white px-7.5 py-3.25 font-plex text-[16px] font-bold"
                        onClick={startSignIn}
                        disabled={isStartingSignIn}
                      >
                        {isStartingSignIn
                          ? <span className="loading loading-spinner" />
                          : (
                            <>
                              <span>Sign in with Plex</span>
                              <ArrowRight className="size-4 setup-button-arrow" />
                            </>
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
            </SetupStage>
          )}

          {step === "polling" && (
            <SetupStage key="polling">
              <div className="card workspace-surface setup-card setup-card-authorizing w-full max-w-md">
                <SetupPerimeter
                  trace={!pinExpired && !authorizationError}
                  tone="plex"
                />
                <div className="card-body items-center text-center gap-6 py-10">
                  <SetupProgress current={1} />
                  {pinExpired
                    ? (
                      <div className="alert alert-warning text-sm w-full">
                        Link expired. Start over to try again.
                      </div>
                    )
                    : authorizationError
                    ? (
                      <div className="alert alert-error text-sm w-full">
                        {authorizationError.message}
                      </div>
                    )
                    : (
                      <>
                        <span className="setup-waiting-mark" aria-hidden="true">
                          <Radio className="size-7" />
                        </span>
                        <div className="setup-heading-group">
                          <h2 className="card-title text-2xl justify-center">
                            Waiting for authorization
                          </h2>
                          <p>
                            Complete sign-in in the Plex tab that just opened.
                          </p>
                        </div>
                        <a
                          href={authUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn setup-secondary-button btn-sm gap-2"
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
            </SetupStage>
          )}

          {step === "connecting" && (
            <SetupStage key="connecting">
              <div className="card workspace-surface setup-card w-full max-w-md">
                <SetupPerimeter
                  aura={!connectionError}
                  sealed={isConnected}
                  tone="plex"
                />
                <div className="card-body items-center text-center gap-6 py-10">
                  <SetupProgress current={2} done={isConnected} />
                  {!connectionError && (
                    <span className="setup-connecting-mark" aria-hidden="true">
                      {isConnected
                        ? <Check className="size-7" />
                        : <Server className="size-7" />}
                    </span>
                  )}
                  <div className="setup-heading-group">
                    <h2 className="card-title text-2xl justify-center">
                      {isConnected
                        ? "Connected"
                        : `Connecting to ${
                          automaticServer?.name ?? "your server"
                        }`}
                    </h2>
                    <p>
                      {isConnected
                        ? "Opening your dashboard…"
                        : "Finding the best address and starting your first sync…"}
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
            </SetupStage>
          )}

          {step === "pick-server" && (
            <SetupStage key="pick-server">
              <div className="card workspace-surface setup-card w-full max-w-md">
                <SetupPerimeter
                  trace={!connectionError}
                  calm
                  aura={(isConnecting || isConnected) && !connectionError}
                  sealed={isConnected}
                  tone="plex"
                />
                <div className="card-body gap-5">
                  <SetupProgress current={2} done={isConnected} />
                  <div className="setup-heading-group text-center">
                    <span className="workspace-eyebrow">One last step</span>
                    <h2 className="card-title text-2xl justify-center">
                      Choose your server
                    </h2>
                    <p className="text-sm">
                      Select the server you want to monitor. Only servers you
                      own are shown.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2.5">
                    {servers.map((server) => {
                      const bestConn = server.connections[0];
                      if (!bestConn) return null;
                      // Choosing a server blocks server-side on both connecting to Plex and
                      // kicking off the initial sync before it responds — worth its own
                      // per-button spinner rather than just a disabled state, since on a slow
                      // connection that round trip can take a noticeable moment.
                      const isThisServer =
                        connectingServerId === server.machineIdentifier;
                      const isThisServerConnecting = isConnecting &&
                        isThisServer;
                      const isThisServerConnected = isConnected && isThisServer;
                      const isThisServerBusy = isThisServerConnecting ||
                        isThisServerConnected;
                      return (
                        <button
                          type="button"
                          key={`${server.name}:${bestConn.uri}`}
                          className="setup-server-option justify-start gap-3 h-auto py-3.5"
                          onClick={() => connectServer(server)}
                          disabled={isConnecting || isConnected}
                        >
                          {isThisServerConnected
                            ? (
                              <Check className="setup-server-check w-5 h-5 shrink-0" />
                            )
                            : isThisServerConnecting
                            ? (
                              <span className="loading loading-spinner w-5 h-5 shrink-0" />
                            )
                            : (
                              <span className="setup-server-icon">
                                <Server className="w-5 h-5 shrink-0" />
                              </span>
                            )}
                          <div className="text-left min-w-0 flex-1">
                            <div className="font-semibold">{server.name}</div>
                            <div className="text-xs text-base-content/50 truncate">
                              {isThisServerConnected
                                ? "Connected — opening your dashboard…"
                                : isThisServerConnecting
                                ? "Finding the best connection…"
                                : "Plex Media Server"}
                            </div>
                          </div>
                          {!isThisServerBusy && bestConn.local && (
                            <span className="badge badge-success badge-sm shrink-0">
                              local
                            </span>
                          )}
                          {!isThisServerBusy &&
                            !bestConn.local &&
                            bestConn.relay && (
                            <span className="badge badge-warning badge-sm shrink-0">
                              relay
                            </span>
                          )}
                          {!isThisServerBusy && (
                            <ArrowRight className="setup-server-arrow size-4 shrink-0" />
                          )}
                        </button>
                      );
                    })}
                    {servers.length === 0 && (
                      <p className="text-base-content/40 text-sm text-center py-4">
                        Plex did not report an owned server with a usable
                        address for this account. Make sure your server is
                        online, then start over.
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
            </SetupStage>
          )}
        </AnimatePresence>

        {isConfiguredHandoff && (
          <div
            className="flex flex-1 items-center justify-center"
            aria-label="Opening dashboard"
          >
            <span className="setup-brand-mark setup-brand-mark-hero">
              <Library className="size-7" />
            </span>
          </div>
        )}
      </div>
    </MotionConfig>
  );
}

function SetupStage({ children }: { children: ReactNode }) {
  return (
    <motion.div
      className="setup-stage"
      initial={{ opacity: 0, y: 12, scale: 0.985, filter: "blur(3px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, y: -9, scale: 0.99, filter: "blur(2px)" }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

function SetupProgress({
  current,
  done = false,
}: {
  current: 0 | 1 | 2;
  done?: boolean;
}) {
  // Authorize is the step spent in Plex's world, so its stepper chip speaks
  // Plex orange; the other steps stay in the app's own color.
  const steps: { label: string; plex?: boolean }[] = [
    { label: "Sign in" },
    { label: "Authorize", plex: true },
    { label: "Connect" },
  ];

  return (
    <ol className="setup-progress" aria-label="Setup progress">
      {steps.map(({ label, plex }, index) => {
        const isComplete = done || index < current;
        const isCurrent = !done && index === current;
        const state = isComplete
          ? "is-complete"
          : isCurrent
          ? "is-current"
          : "";
        return (
          <li
            className={plex ? `is-plex ${state}` : state}
            key={label}
            aria-current={isCurrent ? "step" : undefined}
          >
            <span>
              {isComplete ? <Check className="size-2.5" /> : index + 1}
            </span>
            <small>{label}</small>
          </li>
        );
      })}
    </ol>
  );
}

// One border treatment per step: the bare track (sign in), the orbiting
// tracer (authorize — and, calmed, the server picker), or the connection aura
// (connect). The tracer is the aura's unfinished form: an arc lapping the
// border without ever closing, until the aura's ignite draw completes the
// loop (is-yielding fades it out underneath). It's a conic-gradient border
// band rather than an SVG dash — a dash sliding around a closed path breaks
// visibly where the path starts/ends (top-left), while a conic wraps
// seamlessly; it also makes the card comet the same construction as the
// background ring comets.
function SetupPerimeter({
  trace = false,
  calm = false,
  aura = false,
  sealed = false,
  tone = "primary",
}: {
  trace?: boolean;
  calm?: boolean;
  aura?: boolean;
  sealed?: boolean;
  tone?: "primary" | "plex";
}) {
  return (
    <>
      {trace && (
        <span
          className={`setup-trace${calm ? " is-calm" : ""}${
            aura ? " is-yielding" : ""
          }`}
          aria-hidden="true"
        />
      )}
      <svg
        className={`setup-perimeter setup-perimeter-${tone}${
          trace ? " has-trace" : ""
        }${aura ? " has-connection-aura" : ""}${sealed ? " is-sealed" : ""}`}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect
          className="setup-perimeter-track"
          x="1"
          y="1"
          width="98"
          height="98"
          rx="5"
          pathLength="100"
        />
        {aura && (
          <>
            <defs>
              <linearGradient
                id="setup-aura-gradient"
                x1="0"
                y1="0"
                x2="1"
                y2="1"
              >
                <stop className="setup-aura-stop-head" offset="0" />
                <stop className="setup-aura-stop-tail" offset="1" />
              </linearGradient>
            </defs>
            <rect
              className="setup-connection-aura"
              x="0.7"
              y="0.7"
              width="98.6"
              height="98.6"
              rx="5.2"
              pathLength="100"
            />
          </>
        )}
      </svg>
    </>
  );
}
