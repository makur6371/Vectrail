import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ClipAnalysis, ClipSample, MediaAsset, MusicAnalysis, Transcript, TranscriptWord } from '../../shared/types';
import { FFMPEG_BIN, fileHashKey, getCacheDir, runFfmpegBuffer } from './ffmpeg';

const execFileAsync = promisify(execFile);

const ANALYSIS_VERSION = 2;

function cacheFile(filePath: string, kind: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(getCacheDir('Analysis'), `${base}-${fileHashKey(filePath)}-${kind}-v${ANALYSIS_VERSION}.json`);
}

export interface MediaNoteEntry {
  text: string;
  by?: string;
  updatedAt: string;
}

export function getMediaNotesPath(): string {
  return path.join(getCacheDir('Notes'), 'media-notes.json');
}

export function readAllMediaNotes(): Record<string, MediaNoteEntry> {
  const p = getMediaNotesPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, MediaNoteEntry>;
  } catch {
    return {};
  }
}

export function saveMediaNote(assetPath: string, text: string, by?: string): void {
  const all = readAllMediaNotes();
  all[path.resolve(assetPath)] = { text, by, updatedAt: new Date().toISOString() };
  fs.writeFileSync(getMediaNotesPath(), JSON.stringify(all, null, 2), 'utf8');
}

export function getMediaNote(assetPath: string): MediaNoteEntry | undefined {
  return readAllMediaNotes()[path.resolve(assetPath)];
}

function measureRgbFrame(buf: Buffer, width: number, height: number, prev?: Buffer, time = 0): ClipSample {
  const total = width * height;
  let lumaSum = 0;
  let sharpSum = 0;
  let motionSum = 0;
  let colorSum = 0;
  let skinCount = 0;
  let diffSharpCount = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 3;
      const r = buf[idx] / 255;
      const g = buf[idx + 1] / 255;
      const b = buf[idx + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += l;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      colorSum += mx - mn;

      // Skin-tone region heuristic for face presence
      if (buf[idx] > 95 && buf[idx + 1] > 40 && buf[idx + 2] > 20 && buf[idx] > buf[idx + 1] && buf[idx] > buf[idx + 2] && Math.abs(buf[idx] - buf[idx + 1]) > 15) {
        skinCount++;
      }

      const rightIdx = idx + 3;
      const downIdx = idx + width * 3;
      const lr = (0.2126 * buf[rightIdx] + 0.7152 * buf[rightIdx + 1] + 0.0722 * buf[rightIdx + 2]) / 255;
      const ld = (0.2126 * buf[downIdx] + 0.7152 * buf[downIdx + 1] + 0.0722 * buf[downIdx + 2]) / 255;
      sharpSum += Math.abs(l - lr) + Math.abs(l - ld);
      diffSharpCount++;

      if (prev) {
        motionSum +=
          (Math.abs(buf[idx] - prev[idx]) +
            Math.abs(buf[idx + 1] - prev[idx + 1]) +
            Math.abs(buf[idx + 2] - prev[idx + 2])) /
          (3 * 255);
      }
    }
  }

  const skinRatio = skinCount / Math.max(1, total);
  const faces = skinRatio > 0.04 && skinRatio < 0.55 ? 1 : 0;
  const luma = lumaSum / Math.max(1, diffSharpCount);
  const sharpness = sharpSum / Math.max(1, diffSharpCount);
  const motion = prev ? motionSum / Math.max(1, diffSharpCount) : 0;
  const color = colorSum / Math.max(1, diffSharpCount);

  return {
    time: Math.round(time * 100) / 100,
    luma,
    sharpness,
    motion,
    color,
    faces,
    utility: motion < 0.005 && color < 0.08 && sharpness > 0.08,
  };
}

export async function analyzeVisualAsset(asset: MediaAsset): Promise<ClipAnalysis | undefined> {
  const cf = cacheFile(asset.path, 'clip');
  if (fs.existsSync(cf)) {
    try {
      return JSON.parse(fs.readFileSync(cf, 'utf8')) as ClipAnalysis;
    } catch {
      // recompute
    }
  }
  if (asset.kind === 'audio') return undefined;

  const w = 160;
  const h = 90;
  const frameBytes = w * h * 3;
  const sampleFps = asset.kind === 'image' ? 1 : 2;
  const args = [
    '-v',
    'error',
    '-i',
    asset.path,
    ...(asset.kind === 'image' ? ['-frames:v', '1'] : ['-vf', `fps=${sampleFps},scale=${w}:${h}:flags=fast_bilinear`]),
    ...(asset.kind === 'image' ? ['-vf', `scale=${w}:${h}:flags=fast_bilinear`] : []),
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ];
  const raw = await runFfmpegBuffer(args);
  const count = Math.floor(raw.byteLength / frameBytes);
  if (count <= 0) return undefined;

  const samples: ClipSample[] = [];
  let prev: Buffer | undefined;
  for (let i = 0; i < count; i++) {
    const slice = raw.subarray(i * frameBytes, (i + 1) * frameBytes);
    samples.push(measureRgbFrame(slice, w, h, prev, i / sampleFps));
    prev = slice;
  }

  let created: string | undefined;
  try {
    created = fs.statSync(asset.path).birthtime.toISOString();
  } catch {
    // ignore
  }
  const out: ClipAnalysis = { duration: asset.duration, created, samples };
  try {
    fs.writeFileSync(cf, JSON.stringify(out), 'utf8');
  } catch {
    // ignore
  }
  return out;
}

export async function analyzeMusicAsset(asset: MediaAsset): Promise<MusicAnalysis | undefined> {
  const cf = cacheFile(asset.path, 'music');
  if (fs.existsSync(cf)) {
    try {
      return JSON.parse(fs.readFileSync(cf, 'utf8')) as MusicAnalysis;
    } catch {
      // recompute
    }
  }

  const sampleRate = 8000;
  const raw = await runFfmpegBuffer([
    '-v',
    'error',
    '-i',
    asset.path,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-f',
    'f32le',
    'pipe:1',
  ]);
  const x = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  if (x.length < sampleRate) return undefined;

  const hop = 160; // 50 fps
  const fps = sampleRate / hop;
  const frames = Math.floor(x.length / hop);
  const rms = new Float32Array(frames);
  const bass = new Float32Array(frames);
  let lp = 0;
  const alpha = 0.08;

  for (let f = 0; f < frames; f++) {
    let s2 = 0;
    let b2 = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) {
      const v = x[start + i];
      lp += alpha * (v - lp);
      s2 += v * v;
      b2 += lp * lp;
    }
    rms[f] = Math.sqrt(s2 / hop);
    bass[f] = Math.sqrt(b2 / hop);
  }

  const onset = new Float32Array(frames);
  const bassOnset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    onset[f] = Math.max(0, rms[f] - rms[f - 1]);
    bassOnset[f] = Math.max(0, bass[f] - bass[f - 1]);
  }

  // Tempo estimation 68..168 BPM
  let bestBpm = 120;
  let bestScore = -1;
  for (let bpm = 68; bpm <= 168; bpm += 0.5) {
    const lag = Math.round((60 / bpm) * fps);
    let corr = 0;
    for (let f = lag; f < frames; f++) {
      corr += onset[f] * onset[f - lag] + 0.5 * bassOnset[f] * bassOnset[f - lag];
    }
    if (corr > bestScore) {
      bestScore = corr;
      bestBpm = bpm;
    }
  }

  const period = (60 / bestBpm) * fps;
  let bestPhase = 0;
  let phaseScore = -1;
  for (let p = 0; p < Math.ceil(period); p++) {
    let s = 0;
    for (let t = p; t < frames; t += period) {
      s += onset[Math.floor(t)] + 0.5 * bassOnset[Math.floor(t)];
    }
    if (s > phaseScore) {
      phaseScore = s;
      bestPhase = p;
    }
  }

  const beats: number[] = [];
  for (let t = bestPhase; t < frames; t += period) {
    beats.push((t + 0.5) / fps);
  }
  let barPhase = 0;
  let barScore = -1;
  for (let m = 0; m < 4; m++) {
    let s = 0;
    for (let i = m; i < beats.length; i += 4) {
      const k = Math.min(frames - 1, Math.round(beats[i] * fps));
      s += bassOnset[k] + 0.25 * onset[k];
    }
    if (s > barScore) {
      barScore = s;
      barPhase = m;
    }
  }

  const energy: number[] = [];
  for (let i = 0; i < beats.length; i++) {
    const lo = Math.floor(beats[i] * fps);
    const hi = Math.min(frames, i + 1 < beats.length ? Math.floor(beats[i + 1] * fps) : Math.floor(lo + period));
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += rms[k];
    energy.push(hi > lo ? sum / (hi - lo) : 0);
  }
  const maxE = Math.max(...energy, 1e-6);
  const normEnergy = energy.map((v) => Math.round((v / maxE) * 1000) / 1000);

  const out: MusicAnalysis = {
    duration: x.length / sampleRate,
    bpm: Math.round(bestBpm * 100) / 100,
    beats,
    barPhase,
    energy: normEnergy,
  };
  try {
    fs.writeFileSync(cf, JSON.stringify(out), 'utf8');
  } catch {
    // ignore
  }
  return out;
}

export function getCachedTranscript(assetPath: string): Transcript | undefined {
  const cf = cacheFile(assetPath, 'transcript-v3');
  if (!fs.existsSync(cf)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(cf, 'utf8')) as Transcript;
  } catch {
    return undefined;
  }
}

export function saveCachedTranscript(assetPath: string, transcript: Transcript): void {
  const cf = cacheFile(assetPath, 'transcript-v3');
  fs.writeFileSync(cf, JSON.stringify(transcript), 'utf8');
}

export function computeClipSceneTags(analysis: ClipAnalysis): string[] {
  const samples = analysis.samples;
  if (!samples.length) return [];
  const n = samples.length;
  const avgLuma = samples.reduce((s, x) => s + x.luma, 0) / n;
  const avgMotion = samples.reduce((s, x) => s + x.motion, 0) / n;
  const avgColor = samples.reduce((s, x) => s + x.color, 0) / n;
  const avgSharp = samples.reduce((s, x) => s + x.sharpness, 0) / n;
  const maxFaces = Math.max(...samples.map((x) => x.faces));

  const tags: string[] = [];
  if (avgLuma >= 0.62) tags.push('bright', 'daylight');
  else if (avgLuma <= 0.25) tags.push('dark', 'night', 'low-light');
  if (avgMotion >= 0.14) tags.push('action', 'high-motion', 'dynamic');
  else if (avgMotion <= 0.03) tags.push('calm', 'steady', 'static');
  if (avgColor >= 0.28) tags.push('vivid', 'colorful');
  else if (avgColor <= 0.08) tags.push('muted', 'monochrome');
  if (avgSharp >= 0.22) tags.push('sharp', 'crisp');
  if (maxFaces > 0) tags.push('people', 'person', 'face');
  return tags;
}

export interface WhisperStatus {
  supported: boolean;
  modelPath?: string;
  modelName?: string;
  modelsDir: string;
}

export function findWhisperModel(): string | undefined {
  const dirs = [getCacheDir('Models')];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'models'));
  dirs.push(path.resolve(process.cwd(), 'resources', 'models'));
  const preferred = ['ggml-base.bin', 'ggml-small.bin', 'ggml-tiny.bin', 'ggml-base.en.bin', 'ggml-tiny.en.bin'];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of preferred) {
      const p = path.join(dir, name);
      if (fs.existsSync(p) && fs.statSync(p).size > 1_000_000) return p;
    }
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.bin')) {
          const p = path.join(dir, f);
          if (fs.statSync(p).size > 1_000_000) return p;
        }
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

let whisperFilterSupported: boolean | undefined;

export async function getWhisperStatus(): Promise<WhisperStatus> {
  if (whisperFilterSupported === undefined) {
    try {
      const { stdout } = await execFileAsync(FFMPEG_BIN, ['-hide_banner', '-filters'], { windowsHide: true });
      whisperFilterSupported = stdout.includes('whisper');
    } catch {
      whisperFilterSupported = false;
    }
  }
  const modelPath = findWhisperModel();
  return {
    supported: whisperFilterSupported,
    modelPath,
    modelName: modelPath ? path.basename(modelPath) : undefined,
    modelsDir: getCacheDir('Models'),
  };
}

export async function downloadWhisperModel(size: 'tiny' | 'base' = 'tiny'): Promise<string> {
  const fileName = size === 'base' ? 'ggml-base.bin' : 'ggml-tiny.bin';
  const dest = path.join(getCacheDir('Models'), fileName);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const candidates = [
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName}`,
    `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/${fileName}`,
  ];
  const tmp = `${dest}.download`;
  const cleanupTmp = () => {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  };

  const downloadRedirect = (u: string, redirects = 0): Promise<void> =>
    new Promise((resolve, reject) => {
      if (redirects > 6) return reject(new Error('Too many redirects downloading Whisper model.'));
      const req = https
        .get(u, { headers: { 'User-Agent': 'Vectrail/1.0' }, timeout: 30000 }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const nextUrl = new URL(res.headers.location, u).toString();
            void downloadRedirect(nextUrl, redirects + 1).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} downloading ${fileName}`));
          }
          const file = fs.createWriteStream(tmp);
          res.pipe(file);
          file.on('finish', () => {
            file.close((closeErr) => {
              if (closeErr) {
                cleanupTmp();
                reject(closeErr);
                return;
              }
              try {
                fs.renameSync(tmp, dest);
                resolve();
              } catch (renameErr) {
                cleanupTmp();
                reject(renameErr);
              }
            });
          });
          file.on('error', (err) => {
            cleanupTmp();
            reject(err);
          });
        })
        .on('error', (err) => {
          cleanupTmp();
          reject(err);
        })
        .on('timeout', () => {
          req.destroy(new Error(`Timed out downloading ${fileName}`));
        });
    });

  let lastErr: unknown;
  for (const url of candidates) {
    try {
      await downloadRedirect(url);
      return dest;
    } catch (err) {
      lastErr = err;
      cleanupTmp();
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function transcribeMediaAsset(asset: MediaAsset, language = 'auto'): Promise<Transcript> {
  const cached = getCachedTranscript(asset.path);
  if (cached && cached.words.length > 0) return cached;

  const status = await getWhisperStatus();
  if (!status.supported) {
    throw new Error('FFmpeg in this environment does not include the whisper filter.');
  }
  const modelPath = status.modelPath ?? (await downloadWhisperModel('tiny'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectrail-whisper-'));
  const jsonOut = path.join(tmpDir, 'transcript.json');
  try {
    const escModel = modelPath.replace(/\\/g, '/').replace(':', '\\:');
    const escDest = jsonOut.replace(/\\/g, '/').replace(':', '\\:');
    const langOpt = language && language !== 'auto' ? `:language=${language}` : '';
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-hide_banner',
        '-v',
        'error',
        '-y',
        '-i',
        asset.path,
        '-vn',
        '-af',
        `whisper=model='${escModel}'${langOpt}:format=json:destination='${escDest}'`,
        '-f',
        'null',
        '-',
      ],
      { windowsHide: true, timeout: 300000 }
    );

    const words: TranscriptWord[] = [];
    if (fs.existsSync(jsonOut)) {
      const rawText = fs.readFileSync(jsonOut, 'utf8').trim();
      const lines = rawText.startsWith('[') ? [] : rawText.split(/\r?\n/).filter(Boolean);
      const segments: Array<{ start?: number; end?: number; text?: string; words?: Array<{ start?: number; end?: number; word?: string; text?: string }> }> = [];
      if (rawText.startsWith('[')) {
        const arr = JSON.parse(rawText) as typeof segments;
        segments.push(...arr);
      } else {
        for (const line of lines) {
          try {
            segments.push(JSON.parse(line));
          } catch {
            // ignore malformed line
          }
        }
      }
      for (const seg of segments) {
        if (Array.isArray(seg.words) && seg.words.length > 0) {
          for (const w of seg.words) {
            const t = String(w.word ?? w.text ?? '').trim();
            if (!t) continue;
            words.push({ start: Number(w.start ?? 0), end: Number(w.end ?? 0), text: t });
          }
        } else if (seg.text) {
          const parts = seg.text.trim().split(/\s+/).filter(Boolean);
          const s0 = Number(seg.start ?? 0);
          const s1 = Math.max(s0 + 0.1, Number(seg.end ?? s0 + 0.5));
          const step = (s1 - s0) / Math.max(1, parts.length);
          parts.forEach((p, idx) => {
            words.push({
              start: Math.round((s0 + idx * step) * 1000) / 1000,
              end: Math.round((s0 + (idx + 1) * step) * 1000) / 1000,
              text: p,
            });
          });
        }
      }
    }
    const maxEnd = words.reduce((mx, w) => Math.max(mx, w.end), 0);
    if (maxEnd > Math.max(asset.duration * 1.5, 5)) {
      for (const w of words) {
        w.start = Math.round((w.start / 1000) * 1000) / 1000;
        w.end = Math.round((w.end / 1000) * 1000) / 1000;
      }
    }
    const transcript: Transcript = { duration: asset.duration, words };
    saveCachedTranscript(asset.path, transcript);
    return transcript;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
