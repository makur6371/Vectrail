export type VideoImportPlatform =
  | 'douyin'
  | 'xiaohongshu'
  | 'kuaishou'
  | 'bilibili'
  | 'youtube'
  | 'tiktok'
  | 'instagram'
  | 'twitter'
  | 'weibo'
  | 'wechat_channels'
  | 'facebook'
  | 'vimeo'
  | 'generic';

export type VideoImportTaskStatus =
  | 'resolving'
  | 'downloading'
  | 'merging'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface VideoImportFormat {
  id: string;
  label: string;
  url?: string;
  extension: string;
  height: number;
  fps: number;
  filesize: number | null;
  filesizeApprox: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface VideoImportMedia {
  engine: string;
  platform: VideoImportPlatform;
  sourceUrl: string;
  id: string;
  title: string;
  description: string;
  author: string;
  authorId: string;
  duration: number;
  thumbnailUrl?: string;
  formats: VideoImportFormat[];
  subtitles: Array<{ language: string; url: string; automatic: boolean }>;
  gallery: string[];
}

export interface VideoImportTask {
  id: string;
  sourceUrl: string;
  platform: VideoImportPlatform;
  engine: string;
  formatId: string;
  title: string;
  status: VideoImportTaskStatus;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  destinationPath?: string;
  importedAssetIds: string[];
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export interface VideoImportEngineStatus {
  id: string;
  available: boolean;
  version?: string;
  error?: string;
}

export interface VideoImportLinkRoute {
  id: 'yt-dlp' | 'dtk-native' | 'bugpk';
  label: string;
  labelZh: string;
  available: boolean;
  version?: string;
  error?: string;
}
