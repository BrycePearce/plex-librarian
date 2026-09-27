import { apiFetch } from "./client.ts";
import type {
  ArrInstance,
  ArrIntegrationSettings,
  ArrRootFoldersRequest,
  ArrRootFoldersResponse,
  ArrStorageVerificationRequest,
  ArrStorageVerificationResponse,
  IntegrationCompatibilityCheck,
  IntegrationCompatibilityResponse,
  QbittorrentInstance,
  QbittorrentIntegrationSettings,
  QbittorrentPathMapping,
  QbittorrentStoragePathsResponse,
  SaveArrInstanceRequest,
  SaveQbittorrentInstanceRequest,
  SaveQbittorrentPathMappingRequest,
  SaveSeerrInstanceRequest,
  SeerrInstance,
  SeerrIntegrationSettings,
  UpdateArrInstanceRequest,
  UpdateQbittorrentInstanceRequest,
  UpdateSeerrInstanceRequest,
} from "@shared/types";

export const historicalAccessApi = {
  saveDraft: (
    instanceId: number,
    configuration:
      import("../../../../shared/historicalDownloads.ts").HistoricalAccessConfiguration,
    id?: string,
  ) =>
    apiFetch<{ id: string }>("/historical-download-access/draft", {
      method: "POST",
      body: JSON.stringify({ instanceId, configuration, id }),
    }),
  enable: (id: string, revision: string) =>
    apiFetch("/historical-download-access/enable", {
      method: "POST",
      body: JSON.stringify({ id, revision }),
    }),
  discover: (instanceId: number) =>
    apiFetch("/historical-download-access/discover", {
      method: "POST",
      body: JSON.stringify({ instanceId }),
    }),
  get: () =>
    apiFetch<
      {
        serverId: number | null;
        statuses: import("../../../../shared/historicalDownloads.ts").HistoricalAccessStatus[];
        suggestedLocalFolders?: string[];
      }
    >("/historical-download-access"),
  save: (
    instanceId: number,
    configuration:
      import("../../../../shared/historicalDownloads.ts").HistoricalAccessConfiguration,
    id?: string,
  ) =>
    apiFetch("/historical-download-access", {
      method: "POST",
      body: JSON.stringify({ instanceId, configuration, id }),
    }),
  check: (id: string) =>
    apiFetch<
      { statuses: import("../../../../shared/historicalDownloads.ts").HistoricalAccessStatus[] }
    >("/historical-download-access/check", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  dismiss: () => apiFetch("/historical-download-access/dismiss", { method: "POST" }),
};

export const arrApi = {
  get: () => apiFetch<ArrIntegrationSettings>("/integrations/arr"),
  savePathMappings: (id: number, pathMappings: ArrInstance["pathMappings"]) =>
    apiFetch<ArrInstance>(`/integrations/arr/instances/${id}/path-mappings`, {
      method: "PUT",
      body: JSON.stringify({ pathMappings }),
    }),
  verifyStorage: (request: ArrStorageVerificationRequest) =>
    apiFetch<ArrStorageVerificationResponse>("/integrations/arr/verify-storage", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  rootFolders: (request: ArrRootFoldersRequest) =>
    apiFetch<ArrRootFoldersResponse>("/integrations/arr/root-folders", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  createInstance: (instance: SaveArrInstanceRequest) =>
    apiFetch<ArrInstance>("/integrations/arr/instances", {
      method: "POST",
      body: JSON.stringify(instance),
    }),
  updateInstance: (id: number, instance: UpdateArrInstanceRequest) =>
    apiFetch<ArrInstance>(`/integrations/arr/instances/${id}`, {
      method: "PATCH",
      body: JSON.stringify(instance),
    }),
  testInstance: (id: number) =>
    apiFetch<IntegrationCompatibilityCheck>(`/integrations/arr/instances/${id}/test`, {
      method: "POST",
    }),
  deleteInstance: (id: number) =>
    apiFetch<{ ok: true }>(`/integrations/arr/instances/${id}`, {
      method: "DELETE",
    }),
  saveLibraryMapping: (libraryKey: string, instanceIds: number[], addImportExclusion: boolean) =>
    apiFetch<{ ok: true }>(`/integrations/arr/libraries/${encodeURIComponent(libraryKey)}`, {
      method: "PUT",
      body: JSON.stringify({ instanceIds, addImportExclusion }),
    }),
};

export const qbittorrentApi = {
  get: () => apiFetch<QbittorrentIntegrationSettings>("/integrations/qbittorrent"),
  storagePaths: () =>
    apiFetch<QbittorrentStoragePathsResponse>("/integrations/qbittorrent/storage-paths"),
  createInstance: (instance: SaveQbittorrentInstanceRequest) =>
    apiFetch<QbittorrentInstance>("/integrations/qbittorrent/instances", {
      method: "POST",
      body: JSON.stringify(instance),
    }),
  updateInstance: (id: number, instance: UpdateQbittorrentInstanceRequest) =>
    apiFetch<QbittorrentInstance>(`/integrations/qbittorrent/instances/${id}`, {
      method: "PATCH",
      body: JSON.stringify(instance),
    }),
  testInstance: (id: number) =>
    apiFetch<IntegrationCompatibilityCheck>(`/integrations/qbittorrent/instances/${id}/test`, {
      method: "POST",
    }),
  deleteInstance: (id: number) =>
    apiFetch<{ ok: true }>(`/integrations/qbittorrent/instances/${id}`, {
      method: "DELETE",
    }),
  updatePathMapping: (id: number, mapping: SaveQbittorrentPathMappingRequest) =>
    apiFetch<QbittorrentPathMapping>(`/integrations/qbittorrent/path-mappings/${id}`, {
      method: "PUT",
      body: JSON.stringify(mapping),
    }),
  createPathMapping: (mapping: SaveQbittorrentPathMappingRequest) =>
    apiFetch<QbittorrentPathMapping>("/integrations/qbittorrent/path-mappings", {
      method: "POST",
      body: JSON.stringify(mapping),
    }),
};

export const seerrApi = {
  get: () => apiFetch<SeerrIntegrationSettings>("/integrations/seerr"),
  createInstance: (instance: SaveSeerrInstanceRequest) =>
    apiFetch<SeerrInstance>("/integrations/seerr/instances", {
      method: "POST",
      body: JSON.stringify(instance),
    }),
  updateInstance: (id: number, instance: UpdateSeerrInstanceRequest) =>
    apiFetch<SeerrInstance>(`/integrations/seerr/instances/${id}`, {
      method: "PATCH",
      body: JSON.stringify(instance),
    }),
  testInstance: (id: number) =>
    apiFetch<IntegrationCompatibilityCheck>(`/integrations/seerr/instances/${id}/test`, {
      method: "POST",
    }),
  deleteInstance: (id: number) =>
    apiFetch<{ ok: true }>(`/integrations/seerr/instances/${id}`, {
      method: "DELETE",
    }),
};

export const integrationCompatibilityApi = {
  get: () => apiFetch<IntegrationCompatibilityResponse>("/integrations/compatibility"),
};
