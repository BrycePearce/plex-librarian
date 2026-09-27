// Public API facade; endpoints are grouped by domain under ./api/.
export type * from "./api/types.ts";
export { ApiError, deletionOperationIdFromError, isNotFoundError } from "./api/client.ts";

import {
  arrApi,
  historicalAccessApi,
  integrationCompatibilityApi,
  qbittorrentApi,
  seerrApi,
} from "./api/integrations.ts";
import { deletionOperationsApi, serviceDeletionsApi } from "./api/deletions.ts";
import { librariesApi } from "./api/libraries.ts";
import { duplicatesApi } from "./api/duplicates.ts";
import {
  authApi,
  eventsApi,
  mediaRemovalsApi,
  settingsApi,
  syncApi,
  toolsApi,
  usersApi,
} from "./api/application.ts";

export const api = {
  historicalAccess: historicalAccessApi,
  serviceDeletions: serviceDeletionsApi,
  auth: authApi,
  libraries: librariesApi,
  tools: toolsApi,
  duplicates: duplicatesApi,
  deletionOperations: deletionOperationsApi,
  settings: settingsApi,
  arr: arrApi,
  qbittorrent: qbittorrentApi,
  seerr: seerrApi,
  integrationCompatibility: integrationCompatibilityApi,
  users: usersApi,
  sync: syncApi,
  events: eventsApi,
  mediaRemovals: mediaRemovalsApi,
};
