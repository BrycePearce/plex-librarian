export interface IgnoredContentItem {
  ratingKey: string;
  libraryKey: string;
  libraryTitle: string;
  title: string;
  type: 'movie' | 'show';
  thumb: string | null;
  year: number | null;
  createdAt: number | null;
  ignored: boolean;
}

export interface IgnoredContentResponse {
  items: IgnoredContentItem[];
}
