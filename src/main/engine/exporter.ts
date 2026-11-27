import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Clip, ExportJobInfo, ExportSettings, Project, TextStyle, Transcript } from '../../shared/types';
import {
  clipEnd,
  computeExportRenderSize,
  dbToLinear,
  newId,
  projectCroppedToRange,
  projectDuration,
  rgbaToHex,
  transitionPlanForClip,
} from '../../shared/project';
import { clipPlaysSource, clipSourceLength, clipSourceTimeAt, clipTimelineSpan } from '../../shared/speedRamp';
import { parseCubeText, serializeGradeAsCubeText } from '../../shared/colorGrade';
import { buildCaptionBlocks } from '../../shared/captions';
import { transformAt, zoomedOffset } from '../../shared/zoomMove';
import { trackAudioActivity, WaveformEnvelopeInput } from '../../shared/audioLevels';
import { checkHardwareEncoders, FFMPEG_BIN, runFfmpegBuffer } from './ffmpeg';

function buildGradeLutFilter(clip: Clip, tmpDir: string, idxSeed: number): string | undefined {
  if (!clip.grade) return undefined;
  let externalCube;
  if (clip.grade.look && clip.grade.look.toLowerCase().endsWith('.cube') && fs.existsSync(clip.grade.look)) {
    externalCube = parseCubeText(fs.readFileSync(clip.grade.look, 'utf8'));
  }
  const cubeText = serializeGradeAsCubeText(clip.grade, externalCube);
  if (!cubeText) return undefined;
  const rawPath = path.join(tmpDir, `grade-${idxSeed}.cube`);
  fs.writeFileSync(rawPath, cubeText, 'utf8');
  return `lut3d=file='${rawPath.replace(/\\/g, '/').replace(':', '\\:')}'`;
}

function buildScaledOffset(clip: Clip, size: { width: number; height: number }, atLocalTime = 0): {
  scaledW: number;
  scaledH: number;
  xExpr: string;
  yExpr: string;
} {
  const tr = transformAt(clip.transform, atLocalTime);
  const scaledW = Math.max(2, Math.round(size.width * tr.scale));
  const scaledH = Math.max(2, Math.round(size.height * tr.scale));
  const dx = Math.round(tr.x * size.width);
  const dy = Math.round(tr.y * size.height);
  return {
    scaledW,
    scaledH,
    xExpr: `(W-w)/2+(${dx})`,
    yExpr: `(H-h)/2+(${dy})`,
  };
}

function computeReframeLayout(
  project: Project,
  outputSize: { width: number; height: number },
  reframeX = 0.5,
  reframeY = 0.5
): {
  canvas: { width: number; height: number };
  crop?: { width: number; height: number; x: number; y: number };
} {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const pa = project.width / Math.max(1, project.height);
  const oa = outputSize.width / Math.max(1, outputSize.height);
  if (Math.abs(pa - oa) <= 0.005) {
    return { canvas: outputSize };
  }
  const canvas =
    pa > oa
      ? { width: even(outputSize.height * pa), height: outputSize.height }
      : { width: outputSize.width, height: even(outputSize.width / pa) };
  const clampVal = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const x = Math.round(clampVal(reframeX * canvas.width - outputSize.width / 2, 0, canvas.width - outputSize.width));
  const y = Math.round(clampVal(reframeY * canvas.height - outputSize.height / 2, 0, canvas.height - outputSize.height));
  return {
    canvas,
    crop: { width: outputSize.width, height: outputSize.height, x, y },
  };
}

function buildPiecewiseRampSetpts(clip: Clip, s0: number, srcSpan: number): string {
  const segs = 12;
  const pts: Array<{ u: number; t: number }> = [];
  for (let i = 0; i <= segs; i++) {
    const u = (srcSpan * i) / segs;
    const t = clipTimelineSpan(clip, s0, s0 + u);
    pts.push({ u, t });
  }
  let expr = `${pts[segs].t.toFixed(5)}`;
  for (let i = segs - 1; i >= 0; i--) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const du = Math.max(1e-5, p1.u - p0.u);
    const slope = (p1.t - p0.t) / du;
    const segExpr = `(${p0.t.toFixed(5)}+(T-${p0.u.toFixed(5)})*${slope.toFixed(5)})`;
    if (i === segs - 1) {
      expr = segExpr;
    } else {
      expr = `if(lt(T,${p1.u.toFixed(5)}),${segExpr},${expr})`;
    }
  }
  return `setpts='(${expr})/TB'`;
}

function buildFfmpegZoomExpr(clip: Clip, canvas: { width: number; height: number }, fps: number, leadIn: number): string {
  const tr = clip.transform!;
  const zoom = tr.zoom!;
  const smooth = zoom.smooth ?? true;
  const rampPart = (a: number, b: number) => {
    if (b - a <= 1e-5) return `gte(u,${a.toFixed(4)})`;
    const raw = `min(1,max(0,(u-${a.toFixed(4)})/${(b - a).toFixed(4)}))`;
    return smooth ? `(${raw}*${raw}*(3-2*${raw}))` : raw;
  };
  const uExpr = `(it-${leadIn.toFixed(4)})`;
  const inPart = rampPart(zoom.p1, zoom.p2).replace(/\bu\b/g, uExpr);
  const outPart = `(1-${rampPart(zoom.p3, zoom.p4).replace(/\bu\b/g, uExpr)})`;
  let kExpr = inPart;
  if (zoom.mode === 'out') kExpr = outPart;
  else if (zoom.mode === 'inOut') kExpr = `if(lt(${uExpr},${zoom.p3.toFixed(4)}),${inPart},${outPart})`;

  const o = zoomedOffset(tr);
  const zExpr = `1+(${(tr.scale - 1).toFixed(5)})*(${kExpr})`;
  const xExpr = `min(max(0,iw/2-(iw/zoom/2)-(${o.x.toFixed(5)}*(${kExpr})*iw/zoom)),iw-iw/zoom)`;
  const yExpr = `min(max(0,ih/2-(ih/zoom/2)-(${o.y.toFixed(5)}*(${kExpr})*ih/zoom)),ih-ih/zoom)`;
  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${canvas.width}x${canvas.height}:fps=${fps}`;
}

function chainAtempo(spd: number): string[] {
  const out: string[] = [];
  let rem = Math.min(100, Math.max(0.05, spd));
  while (rem > 2.0) {
    out.push('atempo=2.0');
    rem /= 2.0;
  }
  while (rem < 0.5) {
    out.push('atempo=0.5');
    rem /= 0.5;
  }
  if (Math.abs(rem - 1) > 1e-3) out.push(`atempo=${rem.toFixed(4)}`);
  return out;
}

function buildCaptionDrawtext(text: string, size: { width: number; height: number }, capSize: number, capPos: number): string {
  const fontSize = Math.round((capSize / 1080) * size.height);
  const yPos = Math.round(capPos * size.height);
  const fontOpt = resolveDrawtextFontOption(text);
  return `drawtext=text='${escapeDrawtext(text)}'${fontOpt}:fontsize=${fontSize}:fontcolor=white:borderw=3:bordercolor=black@0.75:x=(w-text_w)/2:y=${yPos}-text_h/2`;
}

function buildTextDrawtextFilter(tStyle: TextStyle | undefined, size: { width: number; height: number }): string {
  const txt = tStyle?.string ?? 'Text';
  const hex = rgbaToHex(tStyle?.color).replace('#', '0x');
  const fontSize = Math.round(((tStyle?.size ?? 110) / 1080) * size.height);
  const tx = Math.round((tStyle?.x ?? 0.5) * size.width);
  const ty = Math.round((tStyle?.y ?? 0.5) * size.height);
  const fontOpt = resolveDrawtextFontOption(txt, tStyle?.fontName, tStyle?.bold);
  const parts = [
    `drawtext=text='${escapeDrawtext(txt)}'${fontOpt}`,
    `fontsize=${fontSize}`,
    `fontcolor=${hex}`,
    `x=${tx}-text_w/2`,
    `y=${ty}-text_h/2`,
  ];
  const strokePx = Math.round(((tStyle?.strokeWidth ?? 0) / 1080) * size.height);
  if (strokePx > 0) {
    const strokeHex = rgbaToHex(tStyle?.strokeColor ?? { r: 0, g: 0, b: 0, a: 1 }).replace('#', '0x');
    parts.push(`borderw=${strokePx}`, `bordercolor=${strokeHex}`);
  }
  if (tStyle?.bgColor && (tStyle.bgColor.a ?? 1) > 0) {
    const bgHex = rgbaToHex(tStyle.bgColor).replace('#', '0x');
    const bgAlpha = Math.min(1, Math.max(0, tStyle.bgColor.a ?? 0.75)).toFixed(2);
    const padPx = Math.max(2, Math.round(((tStyle.bgPadding ?? 16) / 1080) * size.height));
    parts.push('box=1', `boxcolor=${bgHex}@${bgAlpha}`, `boxborderw=${padPx}`);
  }
  return parts.join(':');
}

/** Renders a single composited JPEG frame of all active video tracks, titles, grades, transforms, and captions at `time`. */
export async function renderTimelineFrameJpeg(
  project: Project,
  time: number,
  transcripts: Record<string, Transcript> = {},
  maxWidth = 854
): Promise<Buffer | undefined> {
  const activeClips: Clip[] = [];
  for (const track of project.videoTracks) {
    if (track.hidden) continue;
    const hit = project.clips
      .filter((c) => c.trackID === track.id && c.kind !== 'audio' && c.start <= time && clipEnd(c) >= time)
      .sort((a, b) => a.start - b.start)[0];
    if (hit) activeClips.push(hit);
  }
  if (!activeClips.length) return undefined;

  const w = Math.max(2, Math.min(maxWidth, project.width) & ~1);
  const h = Math.max(2, Math.round((w * project.height) / Math.max(1, project.width)) & ~1);
  const size = { width: w, height: h };
  const fps = Math.max(1, project.fps || 30);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectrail-frame-'));
  try {
    const args: string[] = ['-hide_banner', '-v', 'error'];
    const inputs: string[] = [];
    const filterSteps: string[] = [`color=c=black:s=${w}x${h}:r=${fps}:d=0.2,setpts=PTS-STARTPTS[base]`];
    let currentV = '[base]';
    let layer = 0;

    for (const clip of activeClips) {
      layer++;
      const tag = `[flayer${layer}]`;
      const nextTag = `[fcomp${layer}]`;
      if (clip.kind === 'solid') {
        const hex = rgbaToHex(clip.color).replace('#', '0x');
        filterSteps.push(`color=c=${hex}:s=${w}x${h}:r=${fps}:d=0.2,setpts=PTS-STARTPTS,format=rgba${tag}`);
        filterSteps.push(`${currentV}${tag}overlay=0:0:eof_action=repeat${nextTag}`);
        currentV = nextTag;
      } else if (clip.kind === 'text') {
        filterSteps.push(
          `color=c=black@0.0:s=${w}x${h}:r=${fps}:d=0.2,setpts=PTS-STARTPTS,format=rgba,${buildTextDrawtextFilter(clip.text, size)}${tag}`
        );
        filterSteps.push(`${currentV}${tag}overlay=0:0:eof_action=repeat${nextTag}`);
        currentV = nextTag;
      } else if (clip.assetID) {
        const asset = project.assets.find((a) => a.id === clip.assetID);
        if (!asset || !fs.existsSync(asset.path)) continue;
        const inIdx = inputs.length;
        inputs.push(asset.path);
        if (clip.kind === 'video') {
          const rawSrc = clipSourceTimeAt(clip, time);
          const srcTime = Math.max(0, Math.min(asset.duration - 0.02, clip.reversed ? asset.duration - rawSrc : rawSrc));
          args.push('-ss', srcTime.toFixed(4), '-t', '0.1', '-i', asset.path);
        } else {
          args.push('-i', asset.path);
        }
        const { scaledW, scaledH, xExpr, yExpr } = buildScaledOffset(clip, size, time - clip.start);
        const ops = [
          'setpts=PTS-STARTPTS',
          `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease`,
        ];
        const lut = buildGradeLutFilter(clip, tmpDir, layer);
        if (lut) ops.push(lut);
        ops.push('format=rgba');
        filterSteps.push(`[${inIdx}:v]${ops.join(',')}${tag}`);
        filterSteps.push(`${currentV}${tag}overlay=x='${xExpr}':y='${yExpr}':eof_action=repeat${nextTag}`);
        currentV = nextTag;
      }
    }

    if (project.captions && !project.captions.hidden) {
      const blk = buildCaptionBlocks(project, transcripts).find((b) => time >= b.start && time <= b.end);
      const txt = blk?.words.map((wd) => wd.text).join(' ').trim();
      if (txt) {
        filterSteps.push(
          `${currentV}${buildCaptionDrawtext(txt, size, project.captions.size, project.captions.position)}[fcap]`
        );
        currentV = '[fcap]';
      }
    }

    args.push('-filter_complex', filterSteps.join(';'), '-map', currentV, '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1');
    return await runFfmpegBuffer(args);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

const WIN_FONT_MAP: Record<string, string[]> = {
  'microsoft yahei': ['msyhbd.ttc', 'msyh.ttc'],
  simhei: ['simhei.ttf'],
  'segoe ui': ['segoeuib.ttf', 'segoeui.ttf'],
  arial: ['arialbd.ttf', 'arial.ttf'],
  georgia: ['georgiab.ttf', 'georgia.ttf'],
  consolas: ['consolab.ttf', 'consola.ttf'],
  impact: ['impact.ttf'],
  'times new roman': ['timesbd.ttf', 'times.ttf'],
};

function resolveDrawtextFontOption(text: string, fontName?: string, bold = false): string {
  const hasNonAscii = /[^\x00-\x7F]/.test(text);
  const winPreferred: string[] = [];
  if (process.platform === 'win32' && fontName) {
    const mapped = WIN_FONT_MAP[fontName.trim().toLowerCase()];
    if (mapped) {
      const ordered = bold ? mapped : [...mapped].reverse();
      ordered.forEach((f) => winPreferred.push(path.join('C:\\Windows\\Fonts', f)));
    }
  }
  const candidates =
    process.platform === 'win32'
      ? hasNonAscii
        ? [
            ...winPreferred,
            'C:\\Windows\\Fonts\\msyh.ttc',
            'C:\\Windows\\Fonts\\simhei.ttf',
            'C:\\Windows\\Fonts\\segoeui.ttf',
            'C:\\Windows\\Fonts\\arial.ttf',
          ]
        : [
            ...winPreferred,
            'C:\\Windows\\Fonts\\segoeui.ttf',
            'C:\\Windows\\Fonts\\arial.ttf',
            'C:\\Windows\\Fonts\\msyh.ttc',
          ]
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Helvetica.ttc'];

  for (const fontPath of candidates) {
    if (fs.existsSync(fontPath)) {
      const escaped = fontPath.replace(/\\/g, '/').replace(':', '\\:');
      return `:fontfile='${escaped}'`;
    }
  }
  return '';
}

function ffmpegFadeCurve(curve?: string): string {
  switch (curve) {
    case 'linear':
      return 'tri';
    case 'easeIn':
      return 'qsin';
    case 'easeOut':
      return 'iqsin';
    case 'smooth':
    default:
      return 'hsin';
  }
}

function buildDuckVolumeFilter(
  project: Project,
  waveforms: Record<string, WaveformEnvelopeInput>,
  trackDuckUnder?: string,
  duckDB = -10
): string | undefined {
  if (!trackDuckUnder) return undefined;
  const anySolo = project.audioTracks.some((t) => t.solo);
  const underTrack = project.audioTracks.find((t) => t.id === trackDuckUnder);
  if (!underTrack || underTrack.muted || (anySolo && !underTrack.solo)) return undefined;
  const spans = trackAudioActivity(trackDuckUnder, project, waveforms);
  if (!spans.length) return undefined;
  const attack = 0.15;
  const release = 0.5;
  const low = dbToLinear(duckDB);
  const diff = (1 - low).toFixed(4);
  const lowStr = low.toFixed(4);
  const exprs = spans.slice(0, 24).map((s) => {
    const a0 = Math.max(0, s.start - attack).toFixed(3);
    const s0 = s.start.toFixed(3);
    const s1 = s.end.toFixed(3);
    const r1 = (s.end + release).toFixed(3);
    return `if(between(t,${a0},${r1}),if(lt(t,${s0}),${lowStr}+${diff}*(${s0}-t)/${attack},if(gt(t,${s1}),${lowStr}+${diff}*(t-${s1})/${release},${lowStr})),1)`;
  });
  let combined = exprs[0];
  for (let i = 1; i < exprs.length; i++) {
    combined = `min(${combined},${exprs[i]})`;
  }
  return `volume='${combined}':eval=frame`;
}

export class ExportManager {
  private jobs = new Map<string, { info: ExportJobInfo; proc?: ChildProcess; cancelled?: boolean }>();
  private onUpdate: (jobs: ExportJobInfo[]) => void;

  constructor(onUpdate: (jobs: ExportJobInfo[]) => void) {
    this.onUpdate = onUpdate;
  }

  list(): ExportJobInfo[] {
    return [...this.jobs.values()].map((j) => ({ ...j.info }));
  }

  cancel(id: string): void {
    const j = this.jobs.get(id);
    if (!j) return;
    j.cancelled = true;
    j.proc?.kill('SIGTERM');
    j.info.status = 'cancelled';
    this.emit();
  }

  private emit(): void {
    this.onUpdate(this.list());
  }

  async startExport(
    rawProject: Project,
    settings: ExportSettings,
    targetFile: string,
    transcripts: Record<string, Transcript> = {},
    waveforms: Record<string, WaveformEnvelopeInput> = {}
  ): Promise<ExportJobInfo> {
    const project =
      settings.rangeOnly && rawProject.playRange
        ? projectCroppedToRange(rawProject, rawProject.playRange.in, rawProject.playRange.out)
        : rawProject;

    const totalDuration = Math.max(0.1, projectDuration(project));
    const size = computeExportRenderSize(project, settings.shape, settings.height);
    const id = newId();
    const info: ExportJobInfo = {
      id,
      file: targetFile,
      status: 'running',
      progress: 0,
      sizeLabel: settings.format === 'audio' ? 'audio' : `${size.width}x${size.height}`,
    };
    const entry: { info: ExportJobInfo; proc?: ChildProcess; cancelled?: boolean } = { info };
    this.jobs.set(id, entry);
    this.emit();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectrail-export-'));
    try {
      const args = await this.buildFfmpegArgs(
        project,
        settings,
        size,
        totalDuration,
        targetFile,
        tmpDir,
        transcripts,
        waveforms
      );
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
        entry.proc = proc;
        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          stderr += text;
          const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
          if (match) {
            const sec = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
            info.progress = Math.min(0.99, Math.max(0, sec / totalDuration));
            this.emit();
          }
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (entry.cancelled) {
            try {
              if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
            } catch {
              // ignore
            }
            resolve();
            return;
          }
          if (code === 0) {
            info.progress = 1;
            info.status = 'done';
            this.emit();
            resolve();
          } else {
            reject(new Error(stderr.slice(-800) || `FFmpeg failed with code ${code}`));
          }
        });
      });
    } catch (err) {
      if (!entry.cancelled) {
        info.status = 'failed';
        info.error = err instanceof Error ? err.message : String(err);
        this.emit();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return { ...info };
  }

  private async buildFfmpegArgs(
    project: Project,
    settings: ExportSettings,
    size: { width: number; height: number },
    totalDuration: number,
    targetFile: string,
    tmpDir: string,
    transcripts: Record<string, Transcript>,
    waveforms: Record<string, WaveformEnvelopeInput>
  ): Promise<string[]> {
    const args: string[] = ['-hide_banner', '-y'];
    const inputs: string[] = [];
    const filterSteps: string[] = [];

    const addInput = (filePath: string, extraArgs: string[] = []): number => {
      const idx = inputs.length;
      inputs.push(filePath);
      args.push(...extraArgs, '-i', filePath);
      return idx;
    };

    const isAudioOnly = settings.format === 'audio';
    let videoLabel = '';
    const reframe = computeReframeLayout(project, size, settings.reframeX, settings.reframeY);
    const canvasSize = reframe.canvas;

    if (!isAudioOnly) {
      // Base black canvas
      filterSteps.push(
        `color=c=black:s=${canvasSize.width}x${canvasSize.height}:r=${project.fps}:d=${totalDuration.toFixed(4)}[base]`
      );
      let currentV = '[base]';
      let layerCounter = 0;

      for (let ti = 0; ti < project.videoTracks.length; ti++) {
        const track = project.videoTracks[ti];
        if (track.hidden) continue;
        const trackClips = project.clips
          .filter((c) => c.trackID === track.id && c.kind !== 'audio')
          .sort((a, b) => a.start - b.start);

        for (const clip of trackClips) {
          layerCounter++;
          const nextTag = `[vcomp${layerCounter}]`;
          const plan = transitionPlanForClip(project, clip);
          const built = await this.buildVideoClipFilter(
            clip,
            plan,
            project,
            canvasSize,
            tmpDir,
            addInput,
            filterSteps,
            layerCounter
          );
          if (!built) continue;
          const layerStart = Math.max(0, clip.start - plan.leadIn);
          const layerEnd = clipEnd(clip) + plan.tailOut;
          filterSteps.push(
            `${currentV}${built.label}overlay=x='${built.xExpr}':y='${built.yExpr}':enable='between(t,${layerStart.toFixed(4)},${layerEnd.toFixed(4)})':eof_action=pass${nextTag}`
          );
          currentV = nextTag;
        }
      }

      if (reframe.crop) {
        const cropTag = '[vreframe]';
        filterSteps.push(
          `${currentV}crop=w=${reframe.crop.width}:h=${reframe.crop.height}:x=${reframe.crop.x}:y=${reframe.crop.y}${cropTag}`
        );
        currentV = cropTag;
      }

      // Burn in captions if present and visible
      if (project.captions && !project.captions.hidden) {
        const blocks = buildCaptionBlocks(project, transcripts);
        for (let bi = 0; bi < blocks.length; bi++) {
          const blk = blocks[bi];
          const txt = blk.words.map((w) => w.text).join(' ').trim();
          if (!txt) continue;
          const nextTag = `[vcap${bi}]`;
          filterSteps.push(
            `${currentV}${buildCaptionDrawtext(txt, size, project.captions.size, project.captions.position)}:enable='between(t,${blk.start.toFixed(4)},${blk.end.toFixed(4)})'${nextTag}`
          );
          currentV = nextTag;
        }
      }
      if (settings.enhanceDetail || size.height > project.height) {
        const sharpTag = '[vcas]';
        filterSteps.push(`${currentV}format=yuv420p,cas=strength=0.42${sharpTag}`);
        currentV = sharpTag;
      }
      videoLabel = currentV;
    }

    // Audio pipeline
    const wantsAudio = isAudioOnly || settings.includeAudio;
    const audioLabels: string[] = [];
    if (wantsAudio) {
      const anySolo = project.audioTracks.some((t) => t.solo);
      let aCount = 0;
      for (const track of project.audioTracks) {
        if (track.muted) continue;
        if (anySolo && !track.solo) continue;
        const clips = project.clips
          .filter((c) => c.trackID === track.id && c.kind === 'audio')
          .sort((a, b) => a.start - b.start);
        const duckFilter = buildDuckVolumeFilter(project, waveforms, track.duckUnder, track.duckDB ?? -10);
        for (const clip of clips) {
          const asset = project.assets.find((a) => a.id === clip.assetID);
          if (!asset || !fs.existsSync(asset.path)) continue;
          aCount++;
          const inIdx = addInput(asset.path);
          const aTag = `[aclip${aCount}]`;
          const s0 = clip.sourceStart ?? 0;
          const srcSpan = clipSourceLength(clip);
          const trimStart = clip.reversed ? Math.max(0, asset.duration - (s0 + srcSpan)) : s0;
          const totalGain = dbToLinear((clip.gainDB ?? 0) + (track.gainDB ?? 0));
          let audioHead = `[${inIdx}:a]atrim=start=${trimStart.toFixed(4)}:duration=${srcSpan.toFixed(4)},asetpts=PTS-STARTPTS`;
          if (clip.reversed) audioHead += ',areverse';

          if (clip.ramp && !clip.freeze) {
            const segs = 8;
            const splitLabels = Array.from({ length: segs }, (_, i) => `[ar${aCount}_${i}]`);
            filterSteps.push(`${audioHead},asplit=${segs}${splitLabels.join('')}`);
            const segOuts: string[] = [];
            for (let i = 0; i < segs; i++) {
              const u0 = (srcSpan * i) / segs;
              const u1 = (srcSpan * (i + 1)) / segs;
              const localDt = Math.max(0.01, clipTimelineSpan(clip, s0 + u0, s0 + u1));
              const segSpd = Math.max(0.05, (u1 - u0) / localDt);
              const segOut = `[ars${aCount}_${i}]`;
              const tempoParts = chainAtempo(segSpd);
              filterSteps.push(
                `${splitLabels[i]}atrim=start=${u0.toFixed(4)}:end=${u1.toFixed(4)},asetpts=PTS-STARTPTS${
                  tempoParts.length ? `,${tempoParts.join(',')}` : ''
                }${segOut}`
              );
              segOuts.push(segOut);
            }
            const joined = `[arj${aCount}]`;
            filterSteps.push(`${segOuts.join('')}concat=n=${segs}:v=0:a=1${joined}`);
            audioHead = joined;
          } else {
            const spd = Math.min(100, Math.max(0.05, srcSpan / Math.max(0.05, clip.duration)));
            const tempoParts = chainAtempo(spd);
            if (tempoParts.length) audioHead += `,${tempoParts.join(',')}`;
          }
          const parts: string[] = [];
          if ((clip.fadeIn ?? 0) > 0) {
            parts.push(`afade=t=in:st=0:d=${(clip.fadeIn ?? 0).toFixed(4)}:curve=${ffmpegFadeCurve(clip.fadeInCurve)}`);
          }
          if ((clip.fadeOut ?? 0) > 0) {
            const st = Math.max(0, clip.duration - (clip.fadeOut ?? 0));
            parts.push(`afade=t=out:st=${st.toFixed(4)}:d=${(clip.fadeOut ?? 0).toFixed(4)}:curve=${ffmpegFadeCurve(clip.fadeOutCurve)}`);
          }
          parts.push(`volume=${totalGain.toFixed(4)}`);
          const delayMs = Math.max(0, Math.round(clip.start * 1000));
          parts.push(`adelay=${delayMs}|${delayMs}`);
          if (duckFilter) parts.push(duckFilter);
          const sep = audioHead.endsWith(']') ? '' : ',';
          filterSteps.push(`${audioHead}${sep}${parts.join(',')}${aTag}`);
          audioLabels.push(aTag);
        }
      }
    }

    let finalAudio = '';
    if (audioLabels.length > 0) {
      const mixedTag = '[amixout]';
      filterSteps.push(
        `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0${mixedTag}`
      );
      if (settings.loudness !== undefined) {
        filterSteps.push(`${mixedTag}loudnorm=I=${settings.loudness.toFixed(1)}:TP=-1.5:LRA=11[anorm]`);
        finalAudio = '[anorm]';
      } else {
        finalAudio = mixedTag;
      }
    } else if (isAudioOnly) {
      filterSteps.push(`anullsrc=r=48000:cl=stereo:d=${totalDuration.toFixed(4)}[asilent]`);
      finalAudio = '[asilent]';
    }

    if (filterSteps.length > 0) {
      args.push('-filter_complex', filterSteps.join(';'));
    }

    if (isAudioOnly) {
      args.push('-map', finalAudio, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', targetFile);
      return args;
    }

    const encoders = await checkHardwareEncoders();
    const vCodec = settings.codec === 'hevc' ? encoders.hevc : encoders.h264;
    const bpp = (settings.quality === 'high' ? 0.2 : 0.085) * (settings.codec === 'hevc' ? 0.62 : 1);
    const bitrate = Math.round(size.width * size.height * Math.min(project.fps, 60) * bpp);

    args.push('-map', videoLabel);
    if (finalAudio) args.push('-map', finalAudio);
    args.push('-t', totalDuration.toFixed(4), '-c:v', vCodec, '-pix_fmt', 'yuv420p', '-b:v', String(bitrate));
    if (finalAudio) {
      args.push('-c:a', 'aac', '-b:a', settings.quality === 'high' ? '256k' : '160k', '-ar', '48000');
    } else {
      args.push('-an');
    }
    args.push('-movflags', '+faststart', targetFile);
    return args;
  }

  private async buildVideoClipFilter(
    clip: Clip,
    plan: ReturnType<typeof transitionPlanForClip>,
    project: Project,
    size: { width: number; height: number },
    tmpDir: string,
    addInput: (filePath: string, extraArgs?: string[]) => number,
    filterSteps: string[],
    idxSeed: number
  ): Promise<{ label: string; xExpr: string; yExpr: string } | undefined> {
    const outTag = `[vclip${idxSeed}]`;
    const layerStart = Math.max(0, clip.start - plan.leadIn);
    const layerEnd = clipEnd(clip) + plan.tailOut;
    const layerDur = Math.max(0.02, layerEnd - layerStart);
    const leadIn = clip.start - layerStart;

    const appendFadesAndReveal = (ops: string[]) => {
      if ((clip.fadeIn ?? 0) > 0) {
        ops.push(`fade=t=in:st=${leadIn.toFixed(4)}:d=${(clip.fadeIn ?? 0).toFixed(4)}:alpha=1`);
      }
      if ((clip.fadeOut ?? 0) > 0) {
        const st = Math.max(0, leadIn + clip.duration - (clip.fadeOut ?? 0));
        ops.push(`fade=t=out:st=${st.toFixed(4)}:d=${(clip.fadeOut ?? 0).toFixed(4)}:alpha=1`);
      }
      if (plan.reveal && plan.reveal.kind !== 'wipe') {
        const st = Math.max(0, plan.reveal.start - layerStart);
        const d = Math.max(0.02, plan.reveal.end - plan.reveal.start);
        ops.push(`fade=t=in:st=${st.toFixed(4)}:d=${d.toFixed(4)}:alpha=1`);
      }
      if (plan.conceal) {
        const st = Math.max(0, plan.conceal.start - layerStart);
        const d = Math.max(0.02, plan.conceal.end - plan.conceal.start);
        ops.push(`fade=t=out:st=${st.toFixed(4)}:d=${d.toFixed(4)}:alpha=1`);
      }
    };

    const finalizeClipChain = (inputExpr: string, ops: string[], xExpr: string, yExpr: string) => {
      appendFadesAndReveal(ops);
      if (plan.reveal && plan.reveal.kind === 'wipe') {
        const rStart = Math.max(0, plan.reveal.start - layerStart);
        const rEnd = Math.min(layerDur, Math.max(rStart + 0.02, plan.reveal.end - layerStart));
        const rDur = Math.max(0.02, rEnd - rStart);
        const preTag = `[vwpre${idxSeed}]`;
        const wipeExpr = `if(lt(T,${rStart.toFixed(4)}),0,if(lte(X,W*(3*pow(min(1,(T-${rStart.toFixed(4)})/${rDur.toFixed(4)}),2)-2*pow(min(1,(T-${rStart.toFixed(4)})/${rDur.toFixed(4)}),3))),alpha(X,Y),0))`;
        if (layerDur > rEnd + 0.04) {
          const splitA = `[vwsa${idxSeed}]`;
          const splitB = `[vwsb${idxSeed}]`;
          const postTag = `[vwpost${idxSeed}]`;
          filterSteps.push(`${inputExpr}${ops.join(',')},split=2${splitA}${splitB}`);
          filterSteps.push(
            `${splitA}trim=start=0:end=${rEnd.toFixed(4)},setpts=PTS-STARTPTS,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${wipeExpr}'${preTag}`
          );
          filterSteps.push(`${splitB}trim=start=${rEnd.toFixed(4)},setpts=PTS-STARTPTS${postTag}`);
          filterSteps.push(`${preTag}${postTag}concat=n=2:v=1:a=0,setpts=PTS+${layerStart.toFixed(4)}/TB${outTag}`);
        } else {
          filterSteps.push(
            `${inputExpr}${ops.join(',')},geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${wipeExpr}',setpts=PTS+${layerStart.toFixed(4)}/TB${outTag}`
          );
        }
        return { label: outTag, xExpr, yExpr };
      }
      ops.push(`setpts=PTS+${layerStart.toFixed(4)}/TB`);
      filterSteps.push(`${inputExpr}${ops.join(',')}${outTag}`);
      return { label: outTag, xExpr, yExpr };
    };

    if (clip.kind === 'solid') {
      const hex = rgbaToHex(clip.color).replace('#', '0x');
      const ops = [
        `color=c=${hex}:s=${size.width}x${size.height}:r=${project.fps}:d=${layerDur.toFixed(4)}`,
        'format=rgba',
      ];
      return finalizeClipChain('', ops, '0', '0');
    }

    if (clip.kind === 'text') {
      const ops = [
        `color=c=black@0.0:s=${size.width}x${size.height}:r=${project.fps}:d=${layerDur.toFixed(4)}`,
        'format=rgba',
        buildTextDrawtextFilter(clip.text, size),
      ];
      return finalizeClipChain('', ops, '0', '0');
    }

    const asset = project.assets.find((a) => a.id === clip.assetID);
    if (!asset || !fs.existsSync(asset.path)) return undefined;

    const extra = clip.kind === 'image' ? ['-loop', '1', '-t', layerDur.toFixed(4)] : [];
    const inIdx = addInput(asset.path, extra);
    const s0 = clip.sourceStart ?? 0;
    const ops: string[] = [];

    if (clip.kind === 'video') {
      if (clip.freeze) {
        ops.push(
          `trim=start=${s0.toFixed(4)}:frames=1`,
          'setpts=PTS-STARTPTS',
          `tpad=stop_mode=clone:stop_duration=${layerDur.toFixed(4)}`
        );
      } else {
        const srcAtLayerStart = Math.max(0, clipSourceTimeAt(clip, layerStart));
        const srcAtLayerEnd = Math.min(asset.duration, clipSourceTimeAt(clip, layerEnd));
        const srcSpan = Math.max(0.02, srcAtLayerEnd - srcAtLayerStart);
        const trimStart = clip.reversed ? Math.max(0, asset.duration - (srcAtLayerStart + srcSpan)) : srcAtLayerStart;
        ops.push(`trim=start=${trimStart.toFixed(4)}:duration=${srcSpan.toFixed(4)}`, 'setpts=PTS-STARTPTS');
        if (clip.reversed) ops.push('reverse');
        if (clip.ramp && clipPlaysSource(clip)) {
          ops.push(buildPiecewiseRampSetpts(clip, srcAtLayerStart, srcSpan));
        } else {
          const avgSpd = Math.min(100, Math.max(0.05, srcSpan / Math.max(0.05, layerDur)));
          if (Math.abs(avgSpd - 1) > 1e-3) ops.push(`setpts=PTS/${avgSpd.toFixed(4)}`);
        }
      }
    }

    const lut = buildGradeLutFilter(clip, tmpDir, idxSeed);
    if (clip.transform?.zoom && clip.transform.scale >= 1.0) {
      ops.push(
        'format=rgba',
        `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd`,
        `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
        buildFfmpegZoomExpr(clip, size, project.fps, leadIn)
      );
      if (lut) ops.push(lut);
      ops.push('format=rgba');
      return finalizeClipChain(`[${inIdx}:v]`, ops, '0', '0');
    }

    const { scaledW, scaledH, xExpr, yExpr } = buildScaledOffset(clip, size);
    ops.push(`scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd`);
    if (lut) ops.push(lut);
    ops.push('format=rgba');
    return finalizeClipChain(`[${inIdx}:v]`, ops, xExpr, yExpr);
  }
}
