export interface HistoricalAccessDiagnostic {
  code:
    | 'missing_root'
    | 'access_denied'
    | 'read_only'
    | 'sample_absent'
    | 'timeout'
    | 'unsupported'
    | 'invalid_folder';
  folder?: string;
  details?: string;
}
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
    | 'ready_to_enable'
    | 'not_enabled'
    | 'waiting_for_sample'
    | 'checking'
    | 'setup_needed'
    | 'available'
    | 'access_lost';
  sample: string | null;
  reason: string | null;
  diagnostic?: HistoricalAccessDiagnostic;
  checkedAt: number | null;
  succeededAt: number | null;
  problemRevision: string | null;
  dismissedRevision: string | null;
}
export interface HistoricalDownloadPreview {
  /** No filesystem sizes or eligibility have been verified yet. */
  discovery?: boolean;
  fingerprint: string;
  candidates: Array<{
    id: string;
    path: string;
    size: number;
    ownerCount: number;
    /** Display-only association with the preview's Arr actions. */
    actionIds?: string[];
  }>;
  skipped: Array<{ source: string; reason: string; details?: string }>;
  /** Covered by eligible selected service actions; never part of optional unlink consent. */
  handled?: Array<
    { source: string; path?: string; service: 'qb'; actionIds: string[]; instanceId?: number }
  >;
}
