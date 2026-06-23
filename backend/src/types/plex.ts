export interface PlexLibrary {
  key: string;
  title: string;
  type: string;
}

export interface PlexItem {
  ratingKey: string;
  title: string;
  type: string;
  thumb: string | null;
  addedAt: number | null;
  lastViewedAt: number | null;
  viewCount: number;
  fileSize: number | null;
  duration: number | null;
  year: number | null;
}

export interface PlexWebhookPayload {
  event: string;
  user: boolean;
  owner: boolean;
  Account: { id: number; title: string };
  Server: { title: string; uuid: string };
  Player: { local: boolean; publicAddress: string; title: string; uuid: string };
  Metadata?: {
    librarySectionType: string;
    ratingKey: string;
    type: string;
    title: string;
    viewCount?: number;
    lastViewedAt?: number;
  };
}
