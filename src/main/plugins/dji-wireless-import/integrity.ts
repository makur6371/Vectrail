import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getCacheDir } from '../../engine/ffmpeg';

export interface TransferHistoryEntry {
  mediaPath: string;
  storage: 0 | 1;
  size: number;
  hashHex: string;
  localPath: string;
  importedAt: number;
}

function historyFilePath(): string {
  return path.join(getCacheDir('Plugins'), 'dji-wireless-import', 'history.json');
}

export function loadTransferHistory(): TransferHistoryEntry[] {
  const file = historyFilePath();
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? (raw as TransferHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function recordTransferSuccess(entry: TransferHistoryEntry): void {
  const file = historyFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = loadTransferHistory().filter(
    (x) => !(x.mediaPath === entry.mediaPath && x.storage === entry.storage)
  );
  prev.unshift(entry);
  fs.writeFileSync(file, JSON.stringify(prev.slice(0, 2000), null, 2), 'utf8');
}

export function findAlreadyImportedPath(
  mediaPath: string,
  storage: 0 | 1,
  expectedSize: number,
  downloadDir: string,
  fileName: string
): string | undefined {
  const history = loadTransferHistory();
  const hit = history.find((x) => x.mediaPath === mediaPath && x.storage === storage);
  if (hit && fs.existsSync(hit.localPath)) {
    const st = fs.statSync(hit.localPath);
    if (expectedSize <= 0 || st.size === expectedSize) return hit.localPath;
  }
  const candidate = path.join(downloadDir, fileName);
  if (fs.existsSync(candidate)) {
    const st = fs.statSync(candidate);
    const claimedByOther = history.some(
      (x) =>
        path.resolve(x.localPath) === path.resolve(candidate) &&
        (x.mediaPath !== mediaPath || x.storage !== storage)
    );
    if (!claimedByOther && expectedSize > 0 && st.size === expectedSize) return candidate;
  }
  return undefined;
}

export function resolveUniqueDestPath(
  downloadDir: string,
  fileName: string,
  mediaPath: string,
  storage: 0 | 1,
  reservedPaths: ReadonlySet<string>
): string {
  const history = loadTransferHistory();
  const previousHit = history.find((x) => x.mediaPath === mediaPath && x.storage === storage);
  if (previousHit && path.dirname(path.resolve(previousHit.localPath)) === path.resolve(downloadDir)) {
    return previousHit.localPath;
  }

  const parsed = path.parse(fileName);
  const folderTag = path.basename(path.dirname(mediaPath)).replace(/[^\w-]+/g, '') || 'media';
  const candidates = [
    path.join(downloadDir, fileName),
    path.join(downloadDir, `${parsed.name}_s${storage}_${folderTag}${parsed.ext}`),
  ];
  for (let i = 2; i <= 99; i++) {
    candidates.push(path.join(downloadDir, `${parsed.name}_${i}${parsed.ext}`));
  }

  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (reservedPaths.has(normalized)) continue;
    const ownedByOther = history.some(
      (x) =>
        path.resolve(x.localPath) === normalized &&
        (x.mediaPath !== mediaPath || x.storage !== storage)
    );
    if (ownedByOther) continue;
    if (fs.existsSync(candidate) && candidate === candidates[0]) {
      continue;
    }
    return candidate;
  }

  return path.join(downloadDir, `${parsed.name}_${Date.now()}${parsed.ext}`);
}

export async function hashFileSha256(filePath: string): Promise<{ size: number; hashHex: string }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      hash.update(buf);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ size, hashHex: hash.digest('hex') }));
  });
}
