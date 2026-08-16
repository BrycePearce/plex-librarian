export interface QbittorrentInstance {
  id: number;
  name: string;
  url: string;
  usernameConfigured: boolean;
  passwordConfigured: boolean;
}

export interface QbittorrentIntegrationSettings {
  envConfigured: boolean;
  instances: QbittorrentInstance[];
  targets: Array<{ instanceKey: string; name: string; environmentOwned: boolean }>;
  pathMappings: QbittorrentPathMapping[];
}

export interface QbittorrentPathMapping {
  id: number;
  instanceKey: string;
  qbittorrentPath: string;
  localPath: string;
  caseSensitive: boolean;
  revision: number;
  validationQbittorrentPath: string;
  validationLocalPath: string;
  validationSize: number;
}

export interface SaveQbittorrentPathMappingRequest {
  instanceKey: string;
  qbittorrentPath: string;
  localPath: string;
  caseSensitive: boolean;
  validationQbittorrentPath: string;
  validationLocalPath: string;
  validationSize: number;
}

export interface SaveQbittorrentInstanceRequest {
  name: string;
  url: string;
  username: string;
  password: string;
}

export interface UpdateQbittorrentInstanceRequest {
  name: string;
  url: string;
  username?: string;
  password?: string;
}
