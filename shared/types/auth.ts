export interface AuthStatus {
  configured: boolean;
  source: 'env' | 'db' | null;
  reachable?: boolean;
  reason?: 'token_revoked' | 'env_incomplete';
  // Best-effort — omitted if the plex.tv account lookup failed or hasn't been configured.
  user?: { username: string; thumb: string | null };
}

export interface PlexPin {
  pinId: number;
  code: string;
  authUrl: string;
}

export interface PlexConnection {
  uri: string;
  local: boolean;
  relay: boolean;
}

export interface PlexServer {
  name: string;
  accessToken: string;
  machineIdentifier: string;
  connections: PlexConnection[];
}

export type PinPollResult =
  | { status: 'pending' }
  | { status: 'complete'; servers: PlexServer[] };
