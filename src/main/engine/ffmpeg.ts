import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { MediaAsset, MediaKind } from '../../shared/types';
import { newId, standardFPS } from '../../shared/project';

const execFileAsync = promisify(execFile);

function findBinary(name: 'ffmpeg' | 'ffprobe'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates: string[] = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', exe));
  }
  candidates.push(path.resolve(process.cwd(), 'resources', 'ffmpeg', exe));
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const wingetBase = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(wingetBase)) {
      try {
        for (const pkg of fs.readdirSync(wingetBase)) {
          if (!pkg.toLowerCase().includes('ffmpeg')) continue;
          const pkgDir = path.join(wingetBase, pkg);
          for (const sub of fs.readdirSync(pkgDir)) {
            const bin = path.join(pkgDir, sub, 'bin', exe);
            if (fs.existsSync(bin)) candidates.push(bin);
          }
        }
      } catch {
        // ignore scanning errors
      }
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return exe;
}

export const FFMPEG_BIN = findBinary('ffmpeg');
export const FFPROBE_BIN = findBinary('ffprobe');

export function getCacheDir(sub: string): string {
  const override = process.env.EDITROOM_CACHE_DIR;
  if (override) {
    const dir = path.join(override, sub);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const primary = path.join(appData, 'EditroomWindows', sub);
  try {
    fs.mkdirSync(primary, { recursive: true });
    return primary;
  } catch {
    const fallback = path.join(os.tmpdir(), 'EditroomWindows', sub);
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export function fileHashKey(filePath: string): string {
  let stamp = filePath;
  try {
    const st = fs.statSync(filePath);
    stamp = `${filePath}|${st.size}|${st.mtimeMs}`;
  } catch {
    // fallback to path
  }
  return crypto.createHash('sha1').update(stamp).digest('hex').slice(0, 16);
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff', '.tif']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']);

export async function probeMediaAsset(filePath: string): Promise<MediaAsset> {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();
  const name = path.basename(resolved);
  if (IMAGE_EXTS.has(ext)) {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', resolved],
      { windowsHide: true }
    );
    const info = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
    const vs = info.streams?.[0];
    return {
      id: newId(),
      path: resolved,
      name,
      kind: 'image',
      duration: 5,
      width: vs?.width ?? 1920,
      height: vs?.height ?? 1080,
      fps: 30,
      hasAudio: false,
    };
  }

  const { stdout } = await execFileAsync(
    FFPROBE_BIN,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', resolved],
    { windowsHide: true }
  );
  const info = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      duration?: string;
    }>;
  };
  const streams = info.streams ?? [];
  const vStream = streams.find((s) => s.codec_type === 'video');
  const aStream = streams.find((s) => s.codec_type === 'audio');
  const kind: MediaKind = vStream && !AUDIO_EXTS.has(ext) ? 'video' : 'audio';
  let duration = Number.parseFloat(info.format?.duration ?? vStream?.duration ?? aStream?.duration ?? '0') || 0;
  if (duration <= 0) duration = 1;

  let fps = 30;
  const rateStr = vStream?.avg_frame_rate || vStream?.r_frame_rate;
  if (rateStr && rateStr.includes('/')) {
    const [num, den] = rateStr.split('/').map(Number);
    if (num > 0 && den > 0) fps = standardFPS(num / den);
  }

  return {
    id: newId(),
    path: resolved,
    name,
    kind,
    duration,
    width: vStream?.width ?? 0,
    height: vStream?.height ?? 0,
    fps,
    hasAudio: Boolean(aStream),
  };
}

export interface WaveformData {
  peaksPerSecond: number;
  peaks: number[];
}

export async function extractWaveform(filePath: string, peaksPerSecond = 120): Promise<WaveformData> {
  const cacheFile = path.join(getCacheDir('Waveforms'), `${fileHashKey(filePath)}-${peaksPerSecond}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as WaveformData;
    } catch {
      // re-extract
    }
  }

  const sampleRate = 8000;
  const samplesPerPeak = Math.max(1, Math.floor(sampleRate / peaksPerSecond));
  const pcm = await runFfmpegBuffer([
    '-v',
    'error',
    '-i',
    filePath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-f',
    'f32le',
    'pipe:1',
  ]);

  const floats = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
  const peaks: number[] = [];
  for (let i = 0; i < floats.length; i += samplesPerPeak) {
    let mx = 0;
    const end = Math.min(floats.length, i + samplesPerPeak);
    for (let j = i; j < end; j++) {
      const v = Math.abs(floats[j]);
      if (v > mx) mx = v;
    }
    peaks.push(Math.round(Math.min(1, mx) * 1000) / 1000);
  }
  const out: WaveformData = { peaksPerSecond, peaks };
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(out), 'utf8');
  } catch {
    // ignore cache write failure
  }
  return out;
}

export function runFfmpegBuffer(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(Buffer.concat(errChunks).toString('utf8') || `ffmpeg exited ${code}`));
    });
  });
}

export async function extractFrameJpeg(
  filePath: string,
  timeSec: number,
  maxSide = 640
): Promise<Buffer> {
  const args = [
    '-v',
    'error',
    '-ss',
    Math.max(0, timeSec).toFixed(3),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
    '-f',
    'image2',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ];
  return runFfmpegBuffer(args);
}

export async function extractThumbnailStrip(
  asset: MediaAsset,
  count = 8
): Promise<string[]> {
  if (asset.kind === 'audio') return [];
  const cacheDir = path.join(getCacheDir('Thumbs'), `${fileHashKey(asset.path)}-${count}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const files: string[] = [];
  const times =
    asset.kind === 'image'
      ? [0]
      : Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * Math.max(0.1, asset.duration));

  for (let i = 0; i < times.length; i++) {
    const outPath = path.join(cacheDir, `f${i}.jpg`);
    if (!fs.existsSync(outPath)) {
      try {
        const buf = await extractFrameJpeg(asset.path, times[i], 240);
        fs.writeFileSync(outPath, buf);
      } catch {
        continue;
      }
    }
    if (fs.existsSync(outPath)) {
      const b64 = fs.readFileSync(outPath).toString('base64');
      files.push(`data:image/jpeg;base64,${b64}`);
    }
  }
  return files;
}

export async function buildContactSheet(
  asset: MediaAsset,
  frames = 6,
  explicitTimes?: number[]
): Promise<{ dataUrl: string; base64: string; times: number[] } | undefined> {
  if (asset.kind === 'audio') return undefined;
  const clampedFrames = Math.min(12, Math.max(1, frames));
  if (asset.kind === 'image') {
    const buf = await extractFrameJpeg(asset.path, 0, 720);
    const base64 = buf.toString('base64');
    return { dataUrl: `data:image/jpeg;base64,${base64}`, base64, times: [0] };
  }

  const times = explicitTimes?.length
    ? explicitTimes.slice(0, 12).map((t) => Math.min(Math.max(0, t), Math.max(0, asset.duration - 0.05)))
    : Array.from({ length: clampedFrames }, (_, i) => ((i + 0.5) / clampedFrames) * asset.duration);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editroom-sheet-'));
  try {
    const inputs: string[] = [];
    for (let i = 0; i < times.length; i++) {
      const fPath = path.join(tmpDir, `t${i}.jpg`);
      const buf = await extractFrameJpeg(asset.path, times[i], 360);
      fs.writeFileSync(fPath, buf);
      inputs.push(fPath);
    }
    if (!inputs.length) return undefined;
    const cols = Math.min(3, inputs.length);
    const rows = Math.ceil(inputs.length / cols);
    const args: string[] = ['-v', 'error'];
    for (const p of inputs) args.push('-i', p);
    const filter = `${inputs.map((_, idx) => `[${idx}:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=#111111[v${idx}]`).join(';')};${inputs.map((_, idx) => `[v${idx}]`).join('')}xstack=inputs=${inputs.length}:layout=${Array.from({ length: inputs.length }, (_, idx) => `${(idx % cols) * 320}_${Math.floor(idx / cols) * 180}`).join('|')}[out]`;
    args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1');
    const buf = inputs.length === 1 ? fs.readFileSync(inputs[0]) : await runFfmpegBuffer(args);
    const base64 = buf.toString('base64');
    void rows;
    return { dataUrl: `data:image/jpeg;base64,${base64}`, base64, times };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

let cachedEncoders: { h264: string; hevc: string } | undefined;

async function canOpenEncoder(encoder: string): Promise<boolean> {
  try {
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=256x256:r=30:d=0.05',
        '-frames:v',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        encoder,
        '-f',
        'null',
        '-',
      ],
      { windowsHide: true, timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
}

export async function checkHardwareEncoders(): Promise<{ h264: string; hevc: string }> {
  if (cachedEncoders) return cachedEncoders;
  try {
    const { stdout } = await execFileAsync(FFMPEG_BIN, ['-v', 'quiet', '-encoders'], { windowsHide: true });
    let h264 = 'libx264';
    for (const candidate of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
      if (stdout.includes(candidate) && (await canOpenEncoder(candidate))) {
        h264 = candidate;
        break;
      }
    }
    let hevc = 'libx265';
    for (const candidate of ['hevc_nvenc', 'hevc_qsv', 'hevc_amf']) {
      if (stdout.includes(candidate) && (await canOpenEncoder(candidate))) {
        hevc = candidate;
        break;
      }
    }
    cachedEncoders = { h264, hevc };
    return cachedEncoders;
  } catch {
    cachedEncoders = { h264: 'libx264', hevc: 'libx265' };
    return cachedEncoders;
  }
}

const CHROMIUM_NATIVE_VIDEO_EXTS = new Set(['.mp4', '.m4v', '.webm']);
const CHROMIUM_NATIVE_VCODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const CHROMIUM_NATIVE_ACODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

export async function ensurePlayableProxy(asset: MediaAsset): Promise<string | undefined> {
  if (asset.kind !== 'video' || !fs.existsSync(asset.path)) return undefined;
  const ext = path.extname(asset.path).toLowerCase();
  let vCodec = '';
  let aCodec = '';
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', asset.path],
      { windowsHide: true }
    );
    const info = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string }> };
    vCodec = (info.streams?.find((s) => s.codec_type === 'video')?.codec_name ?? '').toLowerCase();
    aCodec = (info.streams?.find((s) => s.codec_type === 'audio')?.codec_name ?? '').toLowerCase();
  } catch {
    return undefined;
  }

  const vOk = !vCodec || CHROMIUM_NATIVE_VCODECS.has(vCodec);
  const aOk = !aCodec || CHROMIUM_NATIVE_ACODECS.has(aCodec);
  if (CHROMIUM_NATIVE_VIDEO_EXTS.has(ext) && vOk && aOk) {
    return undefined;
  }
  if (ext === '.mov' && vCodec === 'h264' && aOk) {
    return undefined;
  }

  const proxyPath = path.join(getCacheDir('Playable'), `${fileHashKey(asset.path)}.mp4`);
  if (fs.existsSync(proxyPath)) return proxyPath;
  const tmpPath = `${proxyPath}.tmp.mp4`;
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    const args: string[] = ['-hide_banner', '-v', 'error', '-y', '-i', asset.path];
    if (vCodec === 'h264') {
      args.push('-c:v', 'copy');
    } else {
      args.push('-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p');
    }
    if (aCodec) {
      if (aCodec === 'aac' && vCodec === 'h264') {
        args.push('-c:a', 'copy');
      } else {
        args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
      }
    } else {
      args.push('-an');
    }
    args.push('-movflags', '+faststart', tmpPath);
    await execFileAsync(FFMPEG_BIN, args, { windowsHide: true, timeout: 120000 });
    fs.renameSync(tmpPath, proxyPath);
    return proxyPath;
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    return undefined;
  }
}
