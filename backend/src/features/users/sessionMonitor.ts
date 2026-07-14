import { getActiveServer, PlexClient } from '../../integrations/plex/index.ts';
import type { PlexActiveSession } from '../../integrations/plex/index.ts';
import type { SessionMonitorHealth } from '@plex-librarian/shared/types.ts';
import { recordPlaybackObservation } from './observationService.ts';
import { sessionEventsForSnapshot } from './sessionState.ts';

const SESSION_POLL_MS = 15_000;
const ACTIVE_SERVER_CHECK_MS = 30_000;
const NOTIFICATION_DEBOUNCE_MS = 250;
const MIN_RECONCILE_INTERVAL_MS = 2_000;
const MAX_RECONNECT_MS = 60_000;

let health: SessionMonitorHealth = {
  status: 'starting',
  lastSnapshotAt: null,
  lastObservationAt: null,
  activeSessionCount: 0,
  message: null,
};

export function getSessionMonitorHealth(): SessionMonitorHealth {
  return { ...health };
}

export function buildPlexNotificationUrl(serverUrl: string, token: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/:/websockets/notifications`;
  url.search = '';
  url.searchParams.set('X-Plex-Token', token);
  return url.toString();
}

type ActiveConnection = {
  key: string;
  serverId: number;
  client: PlexClient;
  notificationUrl: string;
};

export function startPlexSessionMonitor(): void {
  let active: ActiveConnection | null = null;
  let sessions = new Map<string, PlexActiveSession>();
  let socket: WebSocket | null = null;
  let generation = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcilePromise: Promise<void> | null = null;
  let reconcileAgain = false;
  let lastReconcileStartedAt = 0;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer !== null) clearTimeout(timer);
  };

  const closeSocket = () => {
    generation++;
    clearTimer(reconnectTimer);
    reconnectTimer = null;
    clearTimer(debounceTimer);
    debounceTimer = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  };

  const reconcile = (): Promise<void> => {
    if (!active) return Promise.resolve();
    if (reconcilePromise) {
      reconcileAgain = true;
      return reconcilePromise;
    }
    const remainingThrottleMs = MIN_RECONCILE_INTERVAL_MS -
      (Date.now() - lastReconcileStartedAt);
    if (remainingThrottleMs > 0) {
      if (debounceTimer === null) {
        const timer = setTimeout(() => {
          debounceTimer = null;
          void reconcile();
        }, remainingThrottleMs);
        debounceTimer = timer;
        Deno.unrefTimer(timer);
      }
      return Promise.resolve();
    }
    lastReconcileStartedAt = Date.now();
    const target = active;
    const targetGeneration = generation;
    reconcilePromise = (async () => {
      try {
        const snapshot = await target.client.activeSessions();
        if (active !== target || generation !== targetGeneration) return;
        const now = Math.floor(Date.now() / 1000);
        const transition = sessionEventsForSnapshot(sessions, snapshot);
        sessions = transition.next;
        health = {
          ...health,
          status: socket?.readyState === WebSocket.OPEN ? 'connected' : 'polling',
          lastSnapshotAt: now,
          activeSessionCount: snapshot.length,
          message: null,
        };

        for (const { event, session } of transition.events) {
          const result = await recordPlaybackObservation({
            serverId: target.serverId,
            plexAccountId: session.accountId,
            accountIdKind: 'session',
            username: session.username,
            observedAt: now,
            event,
            ratingKey: session.ratingKey,
            ip: session.ip,
            playerUuid: session.playerUuid,
            playerTitle: session.playerTitle,
            isLocal: session.isLocal,
            source: 'session_monitor',
            sessionKey: session.sessionKey,
          });
          if (result === 'inserted' || result === 'merged') {
            health = { ...health, lastObservationAt: now };
          } else if (result === 'ambiguous') {
            console.warn(
              `Session monitor: user "${session.username}" matched multiple roster rows — skipping ${event}`,
            );
          }
        }
      } catch {
        if (active !== target || generation !== targetGeneration) return;
        health = {
          ...health,
          status: health.lastSnapshotAt === null ? 'disconnected' : 'polling',
          message: 'Unable to read Plex sessions',
        };
      }
    })().finally(() => {
      reconcilePromise = null;
      if (reconcileAgain) {
        reconcileAgain = false;
        void reconcile();
      }
    });
    return reconcilePromise;
  };

  const scheduleReconcile = () => {
    if (debounceTimer !== null) return;
    const remainingThrottleMs = MIN_RECONCILE_INTERVAL_MS -
      (Date.now() - lastReconcileStartedAt);
    const timer = setTimeout(() => {
      debounceTimer = null;
      void reconcile();
    }, Math.max(NOTIFICATION_DEBOUNCE_MS, remainingThrottleMs));
    debounceTimer = timer;
    Deno.unrefTimer(timer);
  };

  const openSocket = () => {
    if (!active || socket) return;
    const target = active;
    const targetGeneration = ++generation;
    try {
      socket = new WebSocket(target.notificationUrl);
    } catch {
      health = {
        ...health,
        status: health.lastSnapshotAt === null ? 'disconnected' : 'polling',
        // Never surface the constructor error: runtimes may include the complete
        // token-bearing WebSocket URL in it.
        message: 'Unable to open Plex notification connection',
      };
      scheduleReconnect(target, targetGeneration);
      return;
    }

    socket.onopen = () => {
      if (active !== target || generation !== targetGeneration) return;
      reconnectAttempt = 0;
      health = { ...health, status: 'connected', message: null };
      scheduleReconcile();
    };
    socket.onmessage = () => {
      if (active === target && generation === targetGeneration) scheduleReconcile();
    };
    socket.onerror = () => {
      if (active === target && generation === targetGeneration) {
        health = { ...health, message: 'Plex notification connection interrupted' };
      }
    };
    socket.onclose = () => {
      if (active !== target || generation !== targetGeneration) return;
      socket = null;
      health = {
        ...health,
        status: health.lastSnapshotAt === null ? 'disconnected' : 'polling',
      };
      scheduleReconnect(target, targetGeneration);
    };
  };

  function scheduleReconnect(target: ActiveConnection, targetGeneration: number) {
    if (active !== target || generation !== targetGeneration || reconnectTimer !== null) return;
    const base = Math.min(MAX_RECONNECT_MS, 1_000 * 2 ** reconnectAttempt++);
    const delay = Math.round(base + Math.random() * base * 0.25);
    const timer = setTimeout(() => {
      reconnectTimer = null;
      if (active === target) openSocket();
    }, delay);
    reconnectTimer = timer;
    Deno.unrefTimer(timer);
  }

  const refreshActiveServer = async () => {
    try {
      const server = await getActiveServer();
      if (!server) {
        if (active) closeSocket();
        active = null;
        sessions.clear();
        health = {
          status: 'disconnected',
          lastSnapshotAt: null,
          lastObservationAt: health.lastObservationAt,
          activeSessionCount: 0,
          message: 'Plex is not configured',
        };
        return;
      }
      const key = `${server.serverId}:${server.url}:${server.accessToken}`;
      if (active?.key === key) return;

      closeSocket();
      sessions.clear();
      lastReconcileStartedAt = 0;
      active = {
        key,
        serverId: server.serverId,
        client: new PlexClient(server.url, server.accessToken, server.clientId),
        notificationUrl: buildPlexNotificationUrl(server.url, server.accessToken),
      };
      health = {
        status: 'starting',
        lastSnapshotAt: null,
        lastObservationAt: null,
        activeSessionCount: 0,
        message: null,
      };
      openSocket();
      await reconcile();
    } catch {
      health = {
        ...health,
        status: 'disconnected',
        message: 'Unable to resolve the active Plex server',
      };
    }
  };

  void refreshActiveServer();
  const activeServerTimer = setInterval(() => void refreshActiveServer(), ACTIVE_SERVER_CHECK_MS);
  const sessionPollTimer = setInterval(() => void reconcile(), SESSION_POLL_MS);
  Deno.unrefTimer(activeServerTimer);
  Deno.unrefTimer(sessionPollTimer);
}
