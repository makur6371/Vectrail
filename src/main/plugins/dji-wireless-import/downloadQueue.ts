import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DjiDownloadTask, DjiRemoteMediaItem } from '../../../shared/djiTypes';
import { recordTransferSuccess, resolveUniqueDestPath } from './integrity';
import type { DjiLibraryImporter } from './libraryImporter';

export interface DownloadQueueOptions {
  getBaseUrl: () => string;
  getDownloadDir: () => string;
  getConcurrency: () => 1 | 2;
  getAutoImport: () => boolean;
  importer: DjiLibraryImporter;
  onUpdate: () => void;
  onImported?: (task: DjiDownloadTask) => void;
}

export class DjiDownloadQueue {
  private tasks: DjiDownloadTask[] = [];
  private active = 0;
  private cancelledIds = new Set<string>();
  private activeAborts = new Map<string, () => void>();

  constructor(private readonly opts: DownloadQueueOptions) {}

  static buildRelativeMediaUrl(storage: 0 | 1, mediaPath: string): string {
    return `/v2?storage=${storage}&path=${encodeURIComponent(mediaPath).replace(/%2F/gi, '/')}`;
  }

  static remoteMediaCandidates(item: Pick<DjiRemoteMediaItem, 'mediaPath' | 'ext' | 'thumbPath'>): string[] {
    const candidates = [
      item.mediaPath,
      item.ext ? `${item.mediaPath}.${item.ext}` : item.mediaPath,
      item.thumbPath,
    ].filter((value): value is string => Boolean(value));
    return [...new Set(candidates)];
  }

  static originalMediaCandidates(item: Pick<DjiRemoteMediaItem, 'mediaPath' | 'ext' | 'thumbPath'>): string[] {
    const candidates = [
      item.ext ? `${item.mediaPath}.${item.ext}` : item.mediaPath,
      item.mediaPath,
      item.thumbPath,
    ].filter((value): value is string => Boolean(value));
    return [...new Set(candidates)];
  }

  list(): DjiDownloadTask[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  enqueue(items: DjiRemoteMediaItem[]): DjiDownloadTask[] {
    const dir = this.opts.getDownloadDir();
    fs.mkdirSync(dir, { recursive: true });
    const reservedPaths = new Set(
      this.tasks
        .filter((t) => t.status === 'queued' || t.status === 'downloading' || t.status === 'verifying' || t.status === 'importing')
        .map((t) => path.resolve(t.destPath))
    );
    const added: DjiDownloadTask[] = [];
    for (const item of items) {
      const existing = this.tasks.find(
        (t) =>
          t.mediaId === item.id &&
          (t.status === 'queued' || t.status === 'downloading' || t.status === 'verifying' || t.status === 'importing')
      );
      if (existing) continue;
      const destPath = resolveUniqueDestPath(dir, item.name, item.mediaPath, item.storage, reservedPaths);
      reservedPaths.add(path.resolve(destPath));
      const task: DjiDownloadTask = {
        id: `dji-dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        mediaId: item.id,
        name: item.name,
        mediaPath: item.mediaPath,
        ext: item.ext,
        storage: item.storage,
        size: item.size,
        downloadedBytes: 0,
        speedBytesPerSec: 0,
        etaSeconds: null,
        status: 'queued',
        destPath,
      };
      this.tasks.unshift(task);
      added.push(task);
    }
    this.opts.onUpdate();
    void this.pump();
    return added;
  }

  cancel(taskId: string): void {
    this.cancelledIds.add(taskId);
    const abort = this.activeAborts.get(taskId);
    if (abort) abort();
    const task = this.tasks.find((t) => t.id === taskId);
    if (task && (task.status === 'queued' || task.status === 'downloading')) {
      task.status = 'cancelled';
      task.speedBytesPerSec = 0;
      task.etaSeconds = null;
      this.opts.onUpdate();
    }
  }

  retry(taskId: string): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.status === 'failed' || task.status === 'cancelled') {
      this.cancelledIds.delete(taskId);
      task.status = 'queued';
      task.error = undefined;
      task.speedBytesPerSec = 0;
      task.etaSeconds = null;
      this.opts.onUpdate();
      void this.pump();
    }
  }

  clearFinished(): void {
    this.tasks = this.tasks.filter((t) => t.status === 'queued' || t.status === 'downloading' || t.status === 'verifying' || t.status === 'importing');
    this.opts.onUpdate();
  }

  cancelAll(): void {
    for (const task of this.tasks) {
      if (task.status === 'queued' || task.status === 'downloading') {
        this.cancelledIds.add(task.id);
        const abort = this.activeAborts.get(task.id);
        if (abort) abort();
        task.status = 'cancelled';
        task.speedBytesPerSec = 0;
        task.etaSeconds = null;
      }
    }
    this.opts.onUpdate();
  }

  private async pump(): Promise<void> {
    const limit = this.opts.getConcurrency();
    while (this.active < limit) {
      const next = this.tasks.find((t) => t.status === 'queued');
      if (!next) break;
      this.active++;
      void this.runTask(next).finally(() => {
        this.active--;
        void this.pump();
      });
    }
  }

  private async runTask(task: DjiDownloadTask): Promise<void> {
    if (this.cancelledIds.has(task.id)) {
      task.status = 'cancelled';
      this.opts.onUpdate();
      return;
    }
    const baseUrl = this.opts.getBaseUrl();
    const candidates = DjiDownloadQueue.remoteMediaCandidates(task);
    const partPath = `${task.destPath}.part`;
    fs.mkdirSync(path.dirname(task.destPath), { recursive: true });

    task.status = 'downloading';
    task.error = undefined;
    this.opts.onUpdate();

    const maxRetries = 4;
    let attempt = 0;
    while (attempt <= maxRetries) {
      if (this.cancelledIds.has(task.id)) {
        task.status = 'cancelled';
        this.opts.onUpdate();
        return;
      }
      try {
        let result: Awaited<ReturnType<DjiDownloadQueue['downloadWithResume']>> | undefined;
        let lastError: unknown = new Error('No remote media path succeeded.');
        for (const candidate of candidates) {
          try {
            result = await this.downloadWithResume(
              baseUrl,
              DjiDownloadQueue.buildRelativeMediaUrl(task.storage, candidate),
              task,
              partPath
            );
            break;
          } catch (err) {
            lastError = err;
            if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
            if (!String(err instanceof Error ? err.message : err).includes('HTTP error 404')) throw err;
          }
        }
        if (!result) throw lastError;
        if (this.cancelledIds.has(task.id)) {
          task.status = 'cancelled';
          this.opts.onUpdate();
          return;
        }
        task.status = 'verifying';
        this.opts.onUpdate();
        if (task.size > 0 && result.size !== task.size) {
          throw new Error(`Size mismatch: expected ${task.size}, got ${result.size}`);
        }
        if (fs.existsSync(task.destPath)) fs.unlinkSync(task.destPath);
        fs.renameSync(partPath, task.destPath);
        task.hashHex = result.hashHex;
        task.resumedFrom = result.resumedFrom;

        recordTransferSuccess({
          mediaPath: task.mediaPath,
          storage: task.storage,
          size: result.size,
          hashHex: result.hashHex,
          localPath: task.destPath,
          importedAt: Date.now(),
        });

        if (this.opts.getAutoImport()) {
          task.status = 'importing';
          this.opts.onUpdate();
          task.importedAssetIds = await this.opts.importer.importLocalFile(task.destPath);
        }

        task.status = 'done';
        task.speedBytesPerSec = 0;
        task.etaSeconds = 0;
        this.opts.onUpdate();
        this.opts.onImported?.(task);
        return;
      } catch (err) {
        if (this.cancelledIds.has(task.id)) {
          task.status = 'cancelled';
          this.opts.onUpdate();
          return;
        }
        attempt++;
        if (attempt > maxRetries) {
          task.status = 'failed';
          task.speedBytesPerSec = 0;
          task.etaSeconds = null;
          task.error = err instanceof Error ? err.message : String(err);
          this.opts.onUpdate();
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(4000, attempt * 800)));
      }
    }
  }

  private async downloadWithResume(
    baseUrl: string,
    urlPath: string,
    task: DjiDownloadTask,
    partPath: string
  ): Promise<{ size: number; hashHex: string; resumedFrom: number }> {
    let hash = crypto.createHash('sha256');
    let pos = 0;
    if (fs.existsSync(partPath)) {
      const existingSize = fs.statSync(partPath).size;
      if (task.size > 0 && existingSize > task.size) {
        fs.unlinkSync(partPath);
      } else if (existingSize > 0) {
        await new Promise<void>((resolve, reject) => {
          const rs = fs.createReadStream(partPath);
          rs.on('data', (chunk: Buffer | string) => {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            hash.update(buf);
            pos += buf.length;
          });
          rs.on('error', reject);
          rs.on('end', resolve);
        });
      }
    }
    const resumedFrom = pos;
    task.downloadedBytes = pos;

    if (task.size > 0 && pos >= task.size) {
      return { size: pos, hashHex: hash.digest('hex'), resumedFrom };
    }

    const target = new URL(urlPath, baseUrl);
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = pos > 0 ? { Range: `bytes=${pos}-` } : {};
      let effectiveResumedFrom = resumedFrom;
      const req = http.request(
        target,
        { method: 'GET', headers, timeout: 15000 },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status === 416) {
            res.resume();
            if (task.size > 0 && pos === task.size) {
              resolve({ size: pos, hashHex: hash.digest('hex'), resumedFrom: effectiveResumedFrom });
              return;
            }
            if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
            reject(new Error('HTTP 416 range mismatch, restarting'));
            return;
          }
          if (status !== 200 && status !== 206) {
            res.resume();
            if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
            reject(new Error(`Camera HTTP error ${status}`));
            return;
          }
          if (status === 200 && pos > 0) {
            if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
            pos = 0;
            effectiveResumedFrom = 0;
            task.downloadedBytes = 0;
            hash = crypto.createHash('sha256');
          }
          const clHeader = res.headers['content-length'];
          if (status === 200 && clHeader && task.size <= 0) {
            const parsed = Number.parseInt(String(clHeader), 10);
            if (Number.isFinite(parsed) && parsed > 0) task.size = parsed;
          }

          const ws = fs.createWriteStream(partPath, { flags: pos > 0 ? 'a' : 'w' });
          let lastTick = Date.now();
          let windowBytes = 0;
          let settled = false;

          const cleanup = () => {
            this.activeAborts.delete(task.id);
          };
          this.activeAborts.set(task.id, () => {
            req.destroy();
            ws.destroy();
          });

          res.on('data', (chunk: Buffer) => {
            if (this.cancelledIds.has(task.id)) {
              req.destroy();
              return;
            }
            ws.write(chunk);
            hash.update(chunk);
            pos += chunk.length;
            windowBytes += chunk.length;
            task.downloadedBytes = pos;
            const now = Date.now();
            const dt = (now - lastTick) / 1000;
            if (dt >= 0.25) {
              const speed = windowBytes / dt;
              task.speedBytesPerSec = Math.round(speed);
              task.etaSeconds =
                task.size > 0 && speed > 0 ? Math.max(0, Math.ceil((task.size - pos) / speed)) : null;
              lastTick = now;
              windowBytes = 0;
              this.opts.onUpdate();
            }
          });

          res.on('end', () => {
            ws.end(() => {
              cleanup();
              if (settled) return;
              settled = true;
              if (task.size > 0 && pos < task.size) {
                reject(new Error(`Short read at ${pos}/${task.size}`));
                return;
              }
              resolve({ size: pos, hashHex: hash.digest('hex'), resumedFrom: effectiveResumedFrom });
            });
          });

          res.on('error', (err) => {
            ws.destroy();
            cleanup();
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('HTTP camera connection timed out'));
      });
      req.on('error', (err) => {
        this.activeAborts.delete(task.id);
        reject(err);
      });
      req.end();
    });
  }
}
