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
