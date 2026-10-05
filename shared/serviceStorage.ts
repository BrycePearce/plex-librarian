export interface ServiceStorageEndpoint {
  key: string;
  name: string;
  configurationIdentity: string;
  libraryKeys: string[];
  roots: string[];
  discoveryError?: string;
  connectionTestedAt?: number;
  supportedMedia?: boolean;
  connectionHost?: string;
  connectionPort?: number;
  connectionPath?: string;
  remotePathHints?: { host: string; remotePath: string; localPath: string }[];
}

export interface ServiceDeletionResponse {
  status: 'succeeded' | 'accepted';
  httpStatus: number;
}
