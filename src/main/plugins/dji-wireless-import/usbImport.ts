import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DjiUsbImportTask, DjiUsbVolume } from '../../../shared/djiTypes';
import { getDjiPluginSettings } from '../../settings';

const execFileAsync = promisify(execFile);

const DJI_DIR_RE = /^(DJI|OSMO|\d{3}\w*)$/i;
const DJI_FILE_RE = /^(DJI|CAM)_\d{8,14}/i;
const SKIP_EXTS = new Set(['LRF', 'LRV', 'XRF', 'SCR', 'THM']);

function volumeLetters(): string[] {
  const letters: string[] = [];
  for (let code = 65; code <= 90; code++) letters.push(String.fromCharCode(code));
  return letters;
}

function getDjiDownloadDir(): string {
  return getDjiPluginSettings().downloadDir;
}

async function driveType(root: string): Promise<string | null> {
  try {
    const res = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceName='${root}'\").DriveType`,
    ], { timeout: 4000, windowsHide: true });
    return res.stdout.trim() || null;
  } catch {
    return null;
  }
}

export class DjiUsbImporter {
  private readonly tasks = new Map<string, DjiUsbImportTask>();
  private cancelled = new Set<string>();
  async listVolumes(): Promise<DjiUsbVolume[]> {
    const volumes: DjiUsbVolume[] = [];
    for (const letter of volumeLetters()) {
      const rootPath = `${letter}:\\`;
      const type = await driveType(rootPath);
      if (type !== '2') continue;
      const dcim = path.join(rootPath, 'DCIM');
      if (!fs.existsSync(dcim)) continue;
      let djiFolder: string | null = null;
      let hasMedia = false;
      try {
        for (const folder of fs.readdirSync(dcim, { withFileTypes: true })) {
          if (!folder.isDirectory() || !DJI_DIR_RE.test(folder.name)) continue;
          djiFolder = folder.name;
          hasMedia = fs.readdirSync(path.join(dcim, folder.name), { withFileTypes: true })
            .some((entry) => entry.isFile() && DJI_FILE_RE.test(entry.name));
          if (hasMedia) break;
        }
      } catch {
        continue;
      }
      if (!djiFolder || !hasMedia) continue;

      const files: DjiUsbVolume['files'] = [];
      for (const folder of fs.readdirSync(dcim, { withFileTypes: true })) {
        if (!folder.isDirectory()) continue;
        const folderPath = path.join(dcim, folder.name);
        for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name.startsWith('.')) continue;
          const ext = path.extname(entry.name).replace('.', '').toUpperCase();
          if (SKIP_EXTS.has(ext)) continue;
          try {
            const stat = fs.statSync(path.join(folderPath, entry.name));
            files.push({
              id: `usb:${letter}:${folder.name}:${entry.name}`,
              name: entry.name,
              folder: folder.name,
              relativePath: `DCIM/${folder.name}/${entry.name}`,
              ext,
              kind: ext === 'MP4' || ext === 'MOV' ? 'video' : 'photo',
              size: stat.size,
              sourcePath: path.join(folderPath, entry.name),
            });
          } catch {
            continue;
          }
        }
      }
      if (files.length > 0) volumes.push({ id: `usb-${letter}`, letter, label: `DJI USB (${letter}:)`, files });
    }
    return volumes;
  }

  listVolumesSync(): DjiUsbVolume[] {
    const volumes: DjiUsbVolume[] = [];
    for (const letter of volumeLetters()) {
      const rootPath = `${letter}:\\`;
      const dcim = path.join(rootPath, 'DCIM');
      try {
        if (!fs.existsSync(dcim)) continue;
        const folders = fs.readdirSync(dcim, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && DJI_DIR_RE.test(entry.name));
        if (folders.length === 0) continue;
        const files: DjiUsbVolume['files'] = [];
        for (const folder of folders) {
          const folderPath = path.join(dcim, folder.name);
          for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
            if (!entry.isFile() || entry.name.startsWith('.')) continue;
            const ext = path.extname(entry.name).replace('.', '').toUpperCase();
            if (SKIP_EXTS.has(ext)) continue;
            files.push({
              id: `usb:${letter}:${folder.name}:${entry.name}`,
              name: entry.name,
              folder: folder.name,
              relativePath: `DCIM/${folder.name}/${entry.name}`,
              ext,
              kind: ext === 'MP4' || ext === 'MOV' ? 'video' : 'photo',
              size: fs.statSync(path.join(folderPath, entry.name)).size,
              sourcePath: path.join(folderPath, entry.name),
            });
          }
        }
        if (files.length > 0) volumes.push({ id: `usb-${letter}`, letter, label: `DJI USB (${letter}:)`, files });
      } catch {
        continue;
      }
    }
    return volumes;
  }

  async importFiles(fileIds: string[]): Promise<DjiUsbImportTask[]> {
    const volumes = await this.listVolumes();
    const selected = volumes.flatMap((v) => v.files).filter((f) => fileIds.includes(f.id));
    const tasks: DjiUsbImportTask[] = [];
    for (const file of selected) {
      const task: DjiUsbImportTask = {
        id: `usb-task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        fileId: file.id,
        name: file.name,
        sourcePath: file.sourcePath,
        size: file.size,
        copiedBytes: 0,
        speedBytesPerSec: 0,
        etaSeconds: null,
        status: 'copying',
      };
      tasks.push(task);
    }
    for (const task of tasks) this.tasks.set(task.id, task);
    void this.runQueue(tasks);
    return tasks;
  }

  listTasks(): DjiUsbImportTask[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  cancel(taskId: string): void {
    this.cancelled.add(taskId);
  }

  clearFinished(): void {
    for (const [id, task] of this.tasks) {
      if (task.status !== 'copying') this.tasks.delete(id);
    }
  }

  private async runQueue(tasks: DjiUsbImportTask[]): Promise<void> {
    for (const task of tasks) {
      if (this.cancelled.has(task.id)) {
        task.status = 'failed';
        task.error = 'Cancelled';
        continue;
      }
      const startedAt = Date.now();
      let copied = 0;
      try {
        const dest = path.join(getDjiDownloadDir(), task.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const hash = crypto.createHash('sha256');
        await new Promise<void>((resolve, reject) => {
          const input = fs.createReadStream(task.sourcePath, { highWaterMark: 4 * 1024 * 1024 });
          const output = fs.createWriteStream(`${dest}.part`);
          input.on('data', (raw: Buffer | string) => {
            const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
            if (this.cancelled.has(task.id)) {
              input.destroy();
              output.destroy();
              reject(new Error('Cancelled'));
              return;
            }
            output.write(chunk);
            hash.update(chunk);
            copied += chunk.length;
            task.copiedBytes = copied;
            const elapsed = Math.max(0.25, (Date.now() - startedAt) / 1000);
            task.speedBytesPerSec = Math.round(copied / elapsed);
            task.etaSeconds = task.size > 0 ? Math.max(0, Math.ceil((task.size - copied) / task.speedBytesPerSec)) : null;
          });
          input.on('error', reject);
          output.on('error', reject);
          output.on('finish', resolve);
          input.pipe(output);
        });
        if (copied !== task.size) throw new Error(`Short copy: ${copied}/${task.size}`);
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        fs.renameSync(`${dest}.part`, dest);
        task.destPath = dest;
        task.status = 'done';
      } catch (err) {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
      } finally {
        task.speedBytesPerSec = 0;
        task.etaSeconds = null;
      }
    }
  }
}
