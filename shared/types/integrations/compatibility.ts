export type IntegrationCompatibilityKind = 'radarr' | 'sonarr' | 'qbittorrent' | 'seerr';

export type IntegrationCompatibilityStatus =
  | 'compatible'
  | 'unverified'
  | 'limited'
  | 'incompatible'
  | 'unreachable';

export interface IntegrationCompatibilityCheck {
  key: string;
  instanceId: number | null;
  kind: IntegrationCompatibilityKind;
  name: string;
  version: string | null;
  apiVersion: string | null;
  status: IntegrationCompatibilityStatus;
  message: string | null;
}

export interface IntegrationCompatibilityResponse {
  checkedAt: number;
  checks: IntegrationCompatibilityCheck[];
}
