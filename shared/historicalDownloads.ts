export interface HistoricalAccessConfiguration {
  enabled: boolean;
  remoteRoot: string;
  localRoot: string;
  noRemainingClient: boolean;
}
export interface HistoricalAccessStatus {
  id: string;
  instanceId: number;
  configuration: HistoricalAccessConfiguration;
  revision: string;
  status:
    | 'not_enabled'
    | 'waiting_for_sample'
    | 'checking'
    | 'setup_needed'
    | 'available'
    | 'access_lost';
  sample: string | null;
  reason: string | null;
  checkedAt: number | null;
  succeededAt: number | null;
  problemRevision: string | null;
  dismissedRevision: string | null;
}
export interface HistoricalDownloadPreview {
  fingerprint: string;
  candidates: Array<{ id: string; path: string; size: number; ownerCount: number }>;
  skipped: Array<{ source: string; reason: string }>;
}
