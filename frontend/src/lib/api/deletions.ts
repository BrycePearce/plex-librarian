import { apiFetch } from "./client.ts";
import type {
  DeletionActivityResponse,
  DeletionOperation,
  DeletionOperationArrLinksResponse,
  DeletionOperationsResponse,
  FinishRelocationResponse,
} from "@shared/types";

export const serviceDeletionsApi = {
  historicalPreview: (
    choices: import("../../../../shared/serviceOwnedDeletion.ts").ServiceDeletionChoices,
    signal?: AbortSignal,
  ) =>
    apiFetch<import("../../../../shared/historicalDownloads.ts").HistoricalDownloadPreview>(
      "/service-deletions/historical-preview",
      { method: "POST", body: JSON.stringify(choices), signal },
    ),
  preview: (
    choices: import("../../../../shared/serviceOwnedDeletion.ts").ServiceDeletionChoices,
    signal?: AbortSignal,
  ) =>
    apiFetch<import("../../../../shared/serviceOwnedDeletion.ts").ServiceDeletionPreview>(
      "/service-deletions/preview",
      { method: "POST", body: JSON.stringify(choices), signal },
    ),
  create: (request: import("../../../../shared/serviceOwnedDeletion.ts").ServiceDeletionRequest) =>
    apiFetch<import("../../../../shared/serviceOwnedDeletion.ts").ServiceDeletionCreated>(
      "/service-deletions",
      { method: "POST", body: JSON.stringify(request) },
    ),
};

export const deletionOperationsApi = {
  activity: (params: { limit: number; offset: number }) =>
    apiFetch<DeletionActivityResponse>(
      `/deletion-operations/activity?limit=${params.limit}&offset=${params.offset}`,
    ),
  list: (
    params: {
      status?:
        | "queued"
        | "running"
        | "waiting_retry"
        | "completed"
        | "completed_with_warning"
        | "needs_attention"
        | "cancelled";
      attention?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) q.set(key, String(value));
    }
    return apiFetch<DeletionOperationsResponse>(`/deletion-operations?${q}`);
  },
  get: (id: string) =>
    apiFetch<DeletionOperation>(`/deletion-operations/${encodeURIComponent(id)}`),
  arrLinks: (id: string) =>
    apiFetch<DeletionOperationArrLinksResponse>(
      `/deletion-operations/${encodeURIComponent(id)}/arr-links`,
    ),
  cancel: (id: string) =>
    apiFetch<DeletionOperation>(`/deletion-operations/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  retry: (id: string, outcome: "needs_attention" | "warning" | "all" = "all") =>
    apiFetch<DeletionOperation>(`/deletion-operations/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      body: JSON.stringify({ outcome }),
    }),
  acceptSeasonRemovedAndUnmonitored: (id: string, targetId: number) =>
    apiFetch<DeletionOperation>(
      `/deletion-operations/${
        encodeURIComponent(id)
      }/targets/${targetId}/accept-removed-unmonitored`,
      {
        method: "POST",
        body: JSON.stringify({ acknowledge: true }),
      },
    ),
  retrySeasonReassignment: (id: string, targetId: number) =>
    apiFetch<DeletionOperation>(
      `/deletion-operations/${
        encodeURIComponent(id)
      }/targets/${targetId}/retry-sonarr-reassignment`,
      { method: "POST" },
    ),
  dismiss: (id: string) =>
    apiFetch<DeletionOperation>(`/deletion-operations/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ acknowledge: true }),
    }),
  resolve: (id: string) =>
    apiFetch<{
      resolution: "resumed" | "cancelled";
      operation: DeletionOperation;
    }>(`/deletion-operations/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
    }),
  finishRelocation: (
    id: string,
    targetId: number,
    guidanceId: string,
    destinationPlaybackConfirmed: boolean,
  ) =>
    apiFetch<FinishRelocationResponse>(
      `/deletion-operations/${encodeURIComponent(id)}/targets/${targetId}/finish-relocation`,
      {
        method: "POST",
        body: JSON.stringify({ guidanceId, destinationPlaybackConfirmed }),
      },
    ),
  runRelocationSync: (id: string, targetId: number) =>
    apiFetch<FinishRelocationResponse>(
      `/deletion-operations/${encodeURIComponent(id)}/targets/${targetId}/relocation-sync`,
      { method: "POST" },
    ),
};
