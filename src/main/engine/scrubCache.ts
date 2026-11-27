import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MediaAsset, ScrubStripInfo } from '../../shared/types';
import { FFMPEG_BIN, fileHashKey, getCacheDir } from './ffmpeg';

const execFileAsync = promisify(execFile);

const SCRUB_RATE = 8;
const SCRUB_MAX_SIDE = 960;

export class ScrubCacheManager {
  private strips = new Map<string, ScrubStripInfo>();
  private queue: MediaAsset[] = [];
  private workingId: string | null = null;
  private onReady?: (assetId: string, strip: ScrubStripInfo) => void;

  constructor(onReady?: (assetId: string, strip: ScrubStripInfo) => void) {
    this.onReady = onReady;
  }

  get(assetId: string): ScrubStripInfo | undefined {
    return this.strips.get(assetId);
  }

  snapshot(): Record<string, ScrubStripInfo> {
    const out: Record<string, ScrubStripInfo> = {};
    for (const [k, v] of this.strips.entries()) out[k] = v;
    return out;
  }

  forget(assetId: string): void {
    this.strips.delete(assetId);
    this.queue = this.queue.filter((a) => a.id !== assetId);
  }

  enqueue(asset: MediaAsset): void {
    if (asset.kind !== 'video' || asset.duration <= 0 || !fs.existsSync(asset.path)) return;
    if (this.strips.has(asset.id) || this.workingId === asset.id) return;
    if (this.queue.some((a) => a.id === asset.id)) return;
    this.queue.push(asset);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.workingId || !this.queue.length) return;
    const asset = this.queue.shift()!;
    this.workingId = asset.id;
    try {
      const strip = await this.buildStrip(asset);
      if (strip && strip.files.length > 0) {
        this.strips.set(asset.id, strip);
        this.onReady?.(asset.id, strip);
      }
    } catch {
      // non-fatal scrub warmup error
    } finally {
      this.workingId = null;
      if (this.queue.length) void this.pump();
    }
  }

  private async buildStrip(asset: MediaAsset): Promise<ScrubStripInfo | undefined> {
    const dir = path.join(getCacheDir('Scrub'), `${fileHashKey(asset.path)}-${SCRUB_RATE}`);
    const manifestPath = path.join(dir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ScrubStripInfo;
        if (parsed.files?.length && fs.existsSync(parsed.files[0])) return parsed;
      } catch {
        // rebuild
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    // Cap total scrub frames on ultra-long recordings so disk stays bounded
    const rate = asset.duration > 300 ? 2 : asset.duration > 90 ? 4 : SCRUB_RATE;
    const outPattern = path.join(dir, 'f%05d.jpg');
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-hide_banner',
        '-v',
        'error',
        '-y',
        '-i',
        asset.path,
        '-vf',
        `fps=${rate},scale='min(${SCRUB_MAX_SIDE},iw)':'min(${SCRUB_MAX_SIDE},ih)':force_original_aspect_ratio=decrease`,
        '-q:v',
        '5',
        outPattern,
      ],
      { windowsHide: true, timeout: 120000 }
    );
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f) => path.join(dir, f));
    if (!files.length) return undefined;
    const strip: ScrubStripInfo = { rate, files };
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(strip), 'utf8');
    } catch {
      // ignore cache manifest error
    }
    return strip;
  }
}
