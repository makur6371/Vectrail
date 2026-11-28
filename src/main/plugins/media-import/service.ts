import fs from 'node:fs';
import path from 'node:path';
import type { ProjectStore } from '../../state';
import type { PluginSummary } from '../../../shared/djiTypes';
import type {
  VideoImportEngineStatus,
  VideoImportMedia,
  VideoImportTask,
} from '../../../shared/mediaImportTypes';
import type { VectrailPlugin } from '../types';
import { probeMediaAsset } from '../../engine/ffmpeg';
import {
  createDownload,
  defaultDownloadDirectory,
  detectPlatform,
  extractUrls,
  getEngineStatus,
  resolveMedia,
  resolveDouyinMedia,
  resolveBugPkMedia,
} from './engine';
import http from 'node:http';
import https from 'node:https';

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'web-video';
}

export class MediaImportService implements VectrailPlugin {
  readonly id = 'media-link-import';
  readonly name = 'Universal Video Link Import';
  readonly nameZh = '万能视频链接解析导入';
  readonly version = '0.1.0';
  readonly description =
    'Paste links from Douyin, XHS, Kuaishou, Bilibili, YouTube, TikTok and more; resolve, download, verify, and import media with yt-dlp.';
  readonly descriptionZh =
    '粘贴抖音、小红书、快手、B 站、YouTube、TikTok 等链接，自动解析、下载、FFprobe 校验并导入素材库。';
  readonly defaultEnabled = true;

  private engine: VideoImportEngineStatus & { binary: string } = {
    id: 'yt-dlp',
    available: false,
    binary: 'yt-dlp',
  };
  private media = new Map<string, VideoImportMedia>();
  private tasks = new Map<string, VideoImportTask>();
  private readonly cancelHandles = new Map<string, () => void>();
  private readonly listeners = new Set<(tasks: VideoImportTask[]) => void>();

  constructor(private readonly store: ProjectStore) {}

  onTasks(fn: (tasks: VideoImportTask[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const tasks = this.listTasks();
    for (const listener of this.listeners) listener(tasks);
  }

  private updateTask(taskId: string, patch: Partial<VideoImportTask>): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.emit();
  }

  snapshotTasks(): VideoImportTask[] {
    return this.listTasks();
  }

  listTasks(): VideoImportTask[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async healthCheck(): Promise<VideoImportEngineStatus & { binary: string }> {
    this.engine = await getEngineStatus();
    return this.engine;
  }

  async init(): Promise<void> {
    await this.healthCheck();
  }

  async dispose(): Promise<void> {
    for (const cancel of this.cancelHandles.values()) cancel();
    this.cancelHandles.clear();
  }

  getHealth(): { healthy: boolean; error?: string } {
    return { healthy: this.engine.available, error: this.engine.error };
  }

  async resolveLink(input: string): Promise<VideoImportMedia> {
    if (detectPlatform(extractUrls(input)[0] ?? '') === 'douyin') {
      try {
        const douyin = await resolveDouyinMedia(input);
        this.media.set(douyin.sourceUrl, douyin);
        return douyin;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.engine.available) await this.healthCheck();
        if (!this.engine.available) throw new Error(`${message} (yt-dlp unavailable)`);
      }
    }
    try {
      const bugPk = await resolveBugPkMedia(extractUrls(input)[0] ?? '');
      this.media.set(bugPk.sourceUrl, bugPk);
      return bugPk;
    } catch {
      // Continue with yt-dlp.
    }
    if (!this.engine.available) await this.healthCheck();
    if (!this.engine.available) {
      throw new Error(
        'yt-dlp is not installed or not on PATH. Install Python yt-dlp, or place yt-dlp(.exe) beside Vectrail.'
      );
    }
    const url = extractUrls(input)[0];
    if (!url) throw new Error('No valid http(s) link found.');
    const media = await resolveMedia(this.engine.binary, url);
    this.media.set(media.sourceUrl, media);
    return media;
  }

  async importLinks(input: string, formatId?: string): Promise<VideoImportTask[]> {
    const urls = extractUrls(input);
    if (urls.length === 0) throw new Error('No valid http(s) link found.');
    const tasks: VideoImportTask[] = [];
    for (const url of urls) {
      const task: VideoImportTask = {
        id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sourceUrl: url,
        platform: detectPlatform(url),
        engine: 'yt-dlp',
        formatId: formatId ?? 'bv*+ba/b',
        title: 'Resolving...',
        status: 'resolving',
        downloadedBytes: 0,
        totalBytes: null,
        speedBytesPerSec: 0,
        etaSeconds: null,
        importedAssetIds: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.tasks.set(task.id, task);
      tasks.push(task);
      void this.runTask(task).catch(() => undefined);
    }
    this.emit();
    return tasks;
  }

  cancelTask(taskId: string): void {
    this.cancelHandles.get(taskId)?.();
    this.cancelHandles.delete(taskId);
    this.updateTask(taskId, { status: 'cancelled', speedBytesPerSec: 0, etaSeconds: null });
  }

  async retryTask(taskId: string): Promise<VideoImportTask[]> {
    const task = this.tasks.get(taskId);
    if (!task) return this.listTasks();
    if (task.status !== 'failed' && task.status !== 'cancelled') return this.listTasks();
    this.updateTask(taskId, { status: 'resolving', error: undefined, downloadedBytes: 0 });
    void this.runTask(task).catch(() => undefined);
    return this.listTasks();
  }

  clearFinishedTasks(): void {
    for (const [id, task] of this.tasks) {
      if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
        this.tasks.delete(id);
        this.cancelHandles.delete(id);
      }
    }
    this.emit();
  }

  private async runTask(task: VideoImportTask): Promise<void> {
    try {
      let media = this.media.get(task.sourceUrl);
      if (!media || media.formats.length === 0) {
        media = await this.resolveLink(task.sourceUrl);
      }
      const selected =
        media.formats.find((format) => format.id === task.formatId) ??
        media.formats.find((format) => format.hasVideo) ??
        media.formats[0];
      const directory = defaultDownloadDirectory();
      const outputTemplate = path.join(directory, `${Date.now()}-${sanitizeFilename(media.title)}.%(ext)s`);
      this.updateTask(task.id, {
        title: media.title,
        formatId: selected?.id ?? 'best',
        status: 'downloading',
        totalBytes: selected?.filesize ?? selected?.filesizeApprox ?? null,
      });

      if (media.engine === 'douyin-dtk' && selected?.url) {
        const destination = await this.downloadDirect(
          selected.url.startsWith('//') ? `https:${selected?.url}` : selected?.url,
          outputTemplate.replace('.%(ext)s', '.mp4'),
          (downloaded, total, speed) => {
            this.updateTask(task.id, {
              downloadedBytes: downloaded,
              totalBytes: total,
              speedBytesPerSec: speed,
              etaSeconds: total && speed > 0 ? Math.ceil((total - downloaded) / speed) : null,
            });
          }
        );
        fs.renameSync(destination, outputTemplate.replace('.%(ext)s', '.mp4'));
      } else {
        const handle = createDownload(
          this.engine.binary,
          task.sourceUrl,
          selected?.id ?? 'best',
          outputTemplate,
          (downloaded, total, speed) => {
            this.updateTask(task.id, {
              downloadedBytes: downloaded,
              totalBytes: total ?? task.totalBytes,
              speedBytesPerSec: speed,
              etaSeconds: total && speed > 0 ? Math.ceil((total - downloaded) / speed) : null,
            });
          },
          (line) => {
            if (/Merging formats|Deleting original file/i.test(line)) {
              this.updateTask(task.id, { status: 'merging' });
            }
          }
        );
        this.cancelHandles.set(task.id, handle.cancel);
        await handle.promise;
        this.cancelHandles.delete(task.id);
      }

      const files = fs
        .readdirSync(directory)
        .map((entry) => path.join(directory, entry))
        .filter((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile())
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      const destination = files[0];
      if (!destination) throw new Error('Download completed but no output file was found.');

      const probe = await probeMediaAsset(destination);
      if (probe.kind !== 'video' && probe.kind !== 'audio') {
        throw new Error('FFprobe could not identify a playable media stream.');
      }
      const imported = await this.store.importFiles([destination]);
      this.updateTask(task.id, {
        status: 'done',
        destinationPath: destination,
        downloadedBytes: fs.statSync(destination).size,
        totalBytes: fs.statSync(destination).size,
        speedBytesPerSec: 0,
        etaSeconds: 0,
        importedAssetIds: imported.map((asset) => asset.id),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateTask(task.id, {
        status: message === 'Cancelled' ? 'cancelled' : 'failed',
        error: message === 'Cancelled' ? undefined : message,
        speedBytesPerSec: 0,
        etaSeconds: null,
      });
    }
  }

  private downloadDirect(
    url: string,
    destination: string,
    onProgress: (downloaded: number, total: number | null, speed: number) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const partPath = `${destination}.part`;
      const protocol = url.startsWith('https:') ? https : http;
      let downloaded = 0;
      let lastTick = Date.now();
      let windowBytes = 0;
      const request = protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
        const total = Number(response.headers['content-length']) || null;
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
          const location = response.headers.location;
          if (location) {
            response.resume();
            this.downloadDirect(new URL(location, url).toString(), destination, onProgress).then(resolve, reject);
            return;
          }
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Direct download HTTP ${response.statusCode}`));
          return;
        }
        const output = fs.createWriteStream(partPath);
        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          windowBytes += chunk.length;
          const now = Date.now();
          if (now - lastTick >= 250) {
            onProgress(downloaded, total, Math.round((windowBytes / (now - lastTick)) * 1000));
            lastTick = now;
            windowBytes = 0;
          }
        });
        response.pipe(output);
        output.on('finish', () => {
          if (fs.existsSync(destination)) fs.unlinkSync(destination);
          fs.renameSync(partPath, destination);
          onProgress(fs.statSync(destination).size, fs.statSync(destination).size, 0);
          resolve(destination);
        });
        output.on('error', reject);
        response.on('error', reject);
      });
      request.on('error', reject);
      this.cancelHandles.set(
        'direct-download-current',
        () => {
          request.destroy(new Error('Cancelled'));
        }
      );
    });
  }
}

export function toPluginSummary(plugin: MediaImportService): PluginSummary {
  const health = plugin.getHealth();
  return {
    id: plugin.id,
    name: plugin.name,
    nameZh: plugin.nameZh,
    version: plugin.version,
    description: plugin.description,
    descriptionZh: plugin.descriptionZh,
    enabled: true,
    healthy: health.healthy,
    error: health.error,
  };
}
