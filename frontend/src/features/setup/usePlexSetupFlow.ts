import { useCallback, useEffect, useReducer, useRef } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "../../lib/api.ts";
import { resetServerScopedQueries } from "../../lib/queryCache.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import type { PlexServer } from "../../lib/api.ts";

export type PlexSetupStep =
  | "initial"
  | "polling"
  | "connecting"
  | "pick-server";

interface SetupFlowState {
  step: PlexSetupStep;
  pinId: number | null;
  authUrl: string;
  pinExpired: boolean;
  servers: PlexServer[];
}

type SetupFlowAction =
  | { type: "pin-created"; pinId: number; authUrl: string }
  | { type: "pin-expired" }
  | { type: "servers-resolved"; servers: PlexServer[] }
  | { type: "restart" };

const initialState: SetupFlowState = {
  step: "initial",
  pinId: null,
  authUrl: "",
  pinExpired: false,
  servers: [],
};

function setupFlowReducer(
  state: SetupFlowState,
  action: SetupFlowAction,
): SetupFlowState {
  switch (action.type) {
    case "pin-created":
      return {
        ...initialState,
        step: "polling",
        pinId: action.pinId,
        authUrl: action.authUrl,
      };
    case "pin-expired":
      return state.step === "polling" ? { ...state, pinExpired: true } : state;
    case "servers-resolved":
      return {
        ...state,
        step: action.servers.length === 1 ? "connecting" : "pick-server",
        servers: action.servers,
      };
    case "restart":
      return initialState;
  }
}

export function usePlexSetupFlow() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [{ step, pinId, authUrl, pinExpired, servers }, dispatch] = useReducer(
    setupFlowReducer,
    initialState,
  );
  const authPopup = useRef<Window | null>(null);
  const handledPinId = useRef<number | null>(null);

  const { data: authStatus } = useQuery({
    queryKey: queryKeys.auth.status,
    queryFn: api.auth.status,
  });

  const {
    mutate: requestPin,
    reset: resetPinRequest,
    isPending: isStartingSignIn,
    error: signInError,
  } = useMutation({
    mutationFn: () => api.auth.createPin(),
    onSuccess: (data) => {
      handledPinId.current = null;
      dispatch({
        type: "pin-created",
        pinId: data.pinId,
        authUrl: data.authUrl,
      });
      // The popup is created synchronously in startSignIn so browser popup blockers see
      // a direct user gesture. Navigate that existing window once the PIN request lands.
      if (authPopup.current) authPopup.current.location.href = data.authUrl;
    },
    onError: () => {
      authPopup.current?.close();
      authPopup.current = null;
    },
  });

  const {
    mutate: mutateServer,
    reset: resetServerMutation,
    isPending: isConnecting,
    isSuccess: isConnected,
    error: connectionError,
    variables: connectingServer,
  } = useMutation({
    mutationFn: (server: PlexServer) =>
      api.auth.chooseServer(
        server.connections.map((connection) => connection.uri),
        server.accessToken,
        server.machineIdentifier,
        server.name,
      ),
    onSuccess: async () => {
      // Hold the success beat at least as long as the ring-collapse finale so
      // the resolution reads before the dashboard swap; the cache work below
      // runs concurrently, so this rarely adds real wait.
      const finaleBeat = new Promise((resolve) => setTimeout(resolve, 900));
      await queryClient.refetchQueries({ queryKey: queryKeys.auth.status });
      await resetServerScopedQueries(queryClient);
      // Cache warming is an optimization, not part of connecting the server. A failed
      // dashboard request must never turn a successful setup into an error state.
      await Promise.allSettled([
        queryClient.prefetchQuery({
          queryKey: queryKeys.libraries.all,
          queryFn: () => api.libraries.list(),
        }),
        queryClient.prefetchQuery({
          queryKey: queryKeys.sync.history,
          queryFn: () => api.sync.history(10),
        }),
      ]);
      await finaleBeat;
      void navigate({ to: "/dashboard" });
    },
  });

  const connectServer = useCallback(
    (server: PlexServer) => mutateServer(server),
    [mutateServer],
  );

  const startSignIn = useCallback(() => {
    authPopup.current?.close();
    authPopup.current = globalThis.open(
      "about:blank",
      "plex-auth",
      "width=800,height=700",
    );
    requestPin();
  }, [requestPin]);

  const restart = useCallback(() => {
    authPopup.current?.close();
    authPopup.current = null;
    handledPinId.current = null;
    resetPinRequest();
    resetServerMutation();
    dispatch({ type: "restart" });
  }, [resetPinRequest, resetServerMutation]);

  const retryConnection = useCallback(() => {
    const server = servers[0];
    if (server) connectServer(server);
  }, [connectServer, servers]);

  useEffect(() => {
    if (step !== "polling") return;
    const timer = setTimeout(
      () => dispatch({ type: "pin-expired" }),
      5 * 60 * 1000,
    );
    return () => clearTimeout(timer);
  }, [step]);

  useEffect(() => () => authPopup.current?.close(), []);

  // The route guard handles normal visits, but a query-driven remount can occur during
  // the successful setup handoff. Never let that remount paint the initial Welcome state
  // after auth has already become configured; send it straight to the dashboard instead.
  useEffect(() => {
    if (authStatus?.configured && step === "initial") {
      void navigate({ to: "/dashboard" });
    }
  }, [authStatus?.configured, navigate, step]);

  const { data: pollData, error: authorizationError } = useQuery({
    queryKey: queryKeys.auth.pin(pinId),
    queryFn: step === "polling" && pinId !== null && !pinExpired
      ? () => api.auth.pollPin(pinId)
      : skipToken,
    refetchInterval: 2_000,
  });

  useEffect(() => {
    if (
      step !== "polling" ||
      pinId === null ||
      pollData?.status !== "complete" ||
      handledPinId.current === pinId
    ) {
      return;
    }

    handledPinId.current = pinId;
    authPopup.current?.close();
    const connectableServers = pollData.servers.filter(
      (server) => server.connections.length > 0,
    );
    dispatch({ type: "servers-resolved", servers: connectableServers });
    if (connectableServers.length === 1) {
      connectServer(connectableServers[0]);
    }
  }, [connectServer, pinId, pollData, step]);

  return {
    step,
    authUrl,
    pinExpired,
    servers,
    automaticServer: servers[0] ?? null,
    isConfiguredHandoff: authStatus?.configured === true && step === "initial",
    envIncomplete: authStatus?.reason === "env_incomplete",
    isStartingSignIn,
    signInError,
    authorizationError,
    isConnecting,
    isConnected,
    connectionError,
    connectingServerId: connectingServer?.machineIdentifier ?? null,
    startSignIn,
    restart,
    connectServer,
    retryConnection,
  };
}
