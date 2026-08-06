export type ArrType = 'radarr' | 'sonarr';

export interface ArrInstance {
  id: number;
  type: ArrType;
  name: string;
  url: string;
  apiKeyConfigured: boolean;
  pathMappings: ArrPathMapping[];
}

export interface ArrPathMapping {
  kind: 'library' | 'download';
  arrPath: string;
  localPath: string;
}

export interface ArrLibraryMapping {
  libraryKey: string;
  instanceId: number;
  addImportExclusion: boolean;
}

export interface ArrIntegrationSettings {
  instances: ArrInstance[];
  mappings: ArrLibraryMapping[];
}

export interface SaveArrInstanceRequest {
  type: ArrType;
  name: string;
  url: string;
  apiKey: string;
  libraryKeys: string[];
  addImportExclusion: boolean;
  pathMappings: ArrPathMapping[];
}

export interface UpdateArrInstanceRequest {
  name: string;
  url: string;
  apiKey?: string;
  libraryKeys: string[];
  addImportExclusion: boolean;
  pathMappings: ArrPathMapping[];
}

export interface SaveArrLibraryMappingRequest {
  instanceIds: number[];
  addImportExclusion: boolean;
}
