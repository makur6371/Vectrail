import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  VideoImportLinkRoute,
  VideoImportMedia,
  VideoImportEngineStatus,
  VideoImportPlatform,
} from '../../../shared/mediaImportTypes';
import { FFPROBE_BIN } from '../../engine/ffmpeg';
import { detectPythonAndBleak } from '../dji-wireless-import/wifiManager';

const execFileAsync = promisify(execFile);

const PLATFORM_HOSTS: Array<[VideoImportPlatform, RegExp]> = [
  ['douyin', /(?:^|\.)douyin\.com$/i],
  ['xiaohongshu', /(?:^|\.)xiaohongshu\.com$/i],
  ['kuaishou', /(?:^|\.)kuaishou\.com$/i],
  ['bilibili', /(?:^|\.)bilibili\.com$/i],
  ['youtube', /(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$/i],
  ['tiktok', /(?:^|\.)tiktok\.com$/i],
  ['instagram', /(?:^|\.)instagram\.com$/i],
  ['twitter', /(?:^|\.)twitter\.com$|(?:^|\.)x\.com$/i],
  ['weibo', /(?:^|\.)weibo\.com$|(?:^|\.)weibo\.cn$/i],
  ['facebook', /(?:^|\.)facebook\.com$/i],
  ['vimeo', /(?:^|\.)vimeo\.com$/i],
];

export function extractUrls(input: string): string[] {
  const matches = input.match(/https?:\/\/[^\s"'<>）】\]]+/gi) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[),.]+$/, '')))];
}

export function detectPlatform(url: string): VideoImportPlatform {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [platform, pattern] of PLATFORM_HOSTS) {
      if (pattern.test(host)) return platform;
    }
  } catch {
    // Invalid URL falls through.
  }
  return 'generic';
}

export async function getEngineStatus(binary?: string): Promise<VideoImportEngineStatus & { binary: string }> {
  const resolved = binary ?? 'yt-dlp';
  const candidates: string[] = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'yt-dlp.exe'));
  candidates.push(path.resolve(process.cwd(), 'resources', 'ffmpeg', 'yt-dlp.exe'));
  if (process.platform !== 'win32') candidates.push(resolved);
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version'], {
        windowsHide: true,
        timeout: 6000,
        maxBuffer: 1024 * 1024,
      });
      return { id: 'yt-dlp', available: true, version: stdout.trim(), binary: candidate };
    } catch {
      // Try the next candidate.
    }
  }
  return {
    id: 'yt-dlp',
    available: false,
    binary: resolved,
    error: 'yt-dlp was not found on PATH or in resources/ffmpeg.',
  };
}

function resolveDouyinScript(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'plugins', 'media-import', 'douyin_dtk.py'),
    path.resolve(__dirname, '../../../../plugins/media-import/douyin_dtk.py'),
    process.resourcesPath ? path.join(process.resourcesPath, 'plugins', 'media-import', 'douyin_dtk.py') : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export async function getDouyinRouteStatus(): Promise<VideoImportLinkRoute> {
  const script = resolveDouyinScript();
  const python = await detectPythonAndBleak();
  if (!script) {
    return { id: 'douyin-dtk', label: 'DTK native', labelZh: 'DTK 本地线路', available: false, error: 'douyin_dtk.py not found' };
  }
  if (!python.pythonPath || !python.pythonAvailable) {
    return { id: 'douyin-dtk', label: 'DTK native', labelZh: 'DTK 本地线路', available: false, error: 'Python 3.12+ not found' };
  }
  try {
    const { stdout } = await execFileAsync(python.pythonPath, [script, '--check'], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const status = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '{}') as { ok?: boolean; version?: string; error?: string };
    if (!status.ok) throw new Error(status.error ?? 'DTK route unavailable');
    return { id: 'douyin-dtk', label: 'DTK native', labelZh: 'DTK 本地线路', available: true, version: status.version };
  } catch (err) {
    return {
      id: 'douyin-dtk',
      label: 'DTK native',
      labelZh: 'DTK 本地线路',
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolvePython(): string | null {
  const candidates = [process.env.PYTHON, 'python', 'py'];
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return null;
}

export async function resolveDouyinMedia(input: string): Promise<VideoImportMedia> {
  const script = resolveDouyinScript();
  if (!script) throw new Error('Douyin DTK sidecar is missing.');
  const python = await detectPythonAndBleak();
  const pythonPath = python.pythonPath ?? resolvePython();
  if (!pythonPath) throw new Error('Python 3.12+ is required for the Douyin DTK route.');
  const { stdout } = await execFileAsync(pythonPath, [script, '--resolve', input], {
    windowsHide: true,
    timeout: 45000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: [process.env.PYTHONPATH, 'dtk'].filter(Boolean).join(';'),
    },
  });
  const lines = stdout.trim().split(/\r?\n/);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'));
  if (!jsonLine) throw new Error(lines.filter(Boolean).at(-1) ?? 'DTK route returned no data.');
  const parsed = JSON.parse(jsonLine) as
    | ({ ok: true } & {
        id: string;
        title: string;
        author: string;
        durationMs: number;
        thumbnail?: string | null;
        formats: Array<{
          id: string;
          label: string;
          url: string;
          height: number;
          width: number;
          size_bytes: number | null;
          watermark: boolean;
        }>;
      })
    | { ok: false; error: string };
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    engine: 'douyin-dtk',
    platform: 'douyin',
    sourceUrl: input,
    id: parsed.id,
    title: parsed.title,
    description: '',
    author: parsed.author,
    authorId: parsed.id,
    duration: Math.round((parsed.durationMs ?? 0) / 1000),
    thumbnailUrl: parsed.thumbnail ?? undefined,
    formats: parsed.formats
      .filter((format) => !format.watermark)
      .map((format) => ({
        id: format.id,
        label: format.label,
        extension: 'mp4',
        height: format.height,
        fps: 0,
        filesize: format.size_bytes,
        filesizeApprox: format.size_bytes,
        hasVideo: true,
        hasAudio: true,
      })),
    subtitles: [],
    gallery: [],
  };
}

export function ytDlpArguments(url: string): string[] {
  return [
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificates',
    '--socket-timeout',
    '20',
    '--retries',
    '3',
    url,
  ];
}

export async function resolveMedia(binary: string, url: string): Promise<VideoImportMedia> {
  const { stdout } = await execFileAsync(binary, ytDlpArguments(url), {
    windowsHide: true,
    timeout: 45000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const info = JSON.parse(stdout) as {
    id?: string;
    display_id?: string;
    title?: string;
    description?: string;
    uploader?: string;
    uploader_id?: string;
    duration?: number;
    thumbnail?: string;
    extractor_key?: string;
    formats?: Array<{
      format_id?: string;
      format_note?: string;
      ext?: string;
      height?: number;
      fps?: number;
      filesize?: number | null;
      filesize_approx?: number | null;
      vcodec?: string;
      acodec?: string;
      protocol?: string;
    }>;
    subtitles?: Record<string, Array<{ url?: string; ext?: string }>>;
    automatic_captions?: Record<string, Array<{ url?: string; ext?: string }>>;
    thumbnails?: Array<{ url?: string }>;
    gallery?: string[];
    entries?: unknown[];
  };
  if (!info.id && Array.isArray(info.entries)) {
    throw new Error('Playlist imports are not supported in this preview; paste an individual video link.');
  }
  const platform = detectPlatform(url);
  const formats = (info.formats ?? [])
    .filter((format) => format.vcodec !== 'none' || format.acodec !== 'none')
    .filter((format) => format.protocol !== 'm3u8_native')
    .map((format) => ({
      id: String(format.format_id ?? format.ext ?? 'auto'),
      label:
        format.format_note ??
        (format.height ? `${format.height}p` : format.vcodec !== 'none' ? 'Video' : 'Audio'),
      extension: format.ext ?? 'mp4',
      height: format.height ?? 0,
      fps: format.fps ?? 0,
      filesize: format.filesize ?? null,
      filesizeApprox: format.filesize_approx ?? null,
      hasVideo: format.vcodec !== 'none',
      hasAudio: format.acodec !== 'none',
    }));
  return {
    engine: info.extractor_key ?? 'yt-dlp',
    platform,
    sourceUrl: url,
    id: String(info.id ?? info.display_id ?? Date.now()),
    title: info.title ?? 'Untitled media',
    description: info.description ?? '',
    author: info.uploader ?? '',
    authorId: info.uploader_id ?? '',
    duration: info.duration ?? 0,
    thumbnailUrl: info.thumbnail ?? info.thumbnails?.at(-1)?.url,
    formats: formats.sort((a, b) => b.height - a.height || Number(b.hasAudio) - Number(a.hasAudio)),
    subtitles: [
      ...Object.entries(info.subtitles ?? {}).flatMap(([language, tracks]) =>
        tracks.filter((t) => t.url).map((t) => ({ language, url: t.url!, automatic: false }))
      ),
      ...Object.entries(info.automatic_captions ?? {}).flatMap(([language, tracks]) =>
        tracks.filter((t) => t.url).map((t) => ({ language, url: t.url!, automatic: true }))
      ),
    ],
    gallery: info.gallery ?? [],
  };
}

export interface DownloadHandle {
  cancel(): void;
  promise: Promise<void>;
}

export function createDownload(
  binary: string,
  url: string,
  formatId: string,
  outputTemplate: string,
  onProgress: (downloaded: number, total: number | null, speed: number) => void,
  onLog: (line: string) => void
): DownloadHandle {
  const args = [
    '--newline',
    '--no-warnings',
    '--no-playlist',
    '--no-part',
    '--concurrent-fragments',
    '4',
    '--retries',
    '5',
    '--format',
    `${formatId}+bestaudio/best`,
    '--merge-output-format',
    'mp4',
    '--ffmpeg-location',
    path.dirname(FFPROBE_BIN),
    '--progress-template',
    'download:VECTRAIL %(progress.downloaded_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s',
    '-o',
    outputTemplate,
    url,
  ];
  const child = spawn(binary, args, { windowsHide: true });
  let cancelled = false;
  const promise = new Promise<void>((resolve, reject) => {
    const handleData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split(/\r?\n|\r/)) {
        if (!line) continue;
        if (line.startsWith('VECTRAIL ')) {
          const [, downloaded, total, speed] = line.split(/\s+/);
          onProgress(Number(downloaded) || 0, Number(total) || null, Number(speed) || 0);
        } else {
          onLog(line);
        }
      }
    };
    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (cancelled) reject(new Error('Cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}`));
    });
  });
  return {
    cancel: () => {
      cancelled = true;
      child.kill();
    },
    promise,
  };
}

export function defaultDownloadDirectory(): string {
  const homeVideos = path.join(os.homedir(), 'Videos', 'Vectrail', 'WebImport');
  fs.mkdirSync(homeVideos, { recursive: true });
  return homeVideos;
}
