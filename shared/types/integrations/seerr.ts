export interface SeerrInstance {
  id: number;
  name: string;
  url: string;
  apiKeyConfigured: boolean;
  requestsSyncedAt: number | null;
  requestsSyncError: string | null;
}

export interface SeerrIntegrationSettings {
  instances: SeerrInstance[];
}

export interface SaveSeerrInstanceRequest {
  name: string;
  url: string;
  apiKey: string;
}

export interface UpdateSeerrInstanceRequest {
  name: string;
  url: string;
  apiKey?: string;
}
