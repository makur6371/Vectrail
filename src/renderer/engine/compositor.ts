import { ColorGrade, MediaAsset, Project, ScrubStripInfo, TextStyle, Transcript } from '../../shared/types';
import { bakeGradeLUT, GRADE_CUBE_DIM, isGradeNeutral, parseCubeText, ParsedCubeLUT } from '../../shared/colorGrade';
import {
  clipEnd,
  clipFadeGainAt,
  rgbaToHex,
  transitionEdgeProgress,
  transitionPlanForClip,
} from '../../shared/project';
import { clipSourceTimeAt, clipSpeedAt } from '../../shared/speedRamp';
import { transformAt } from '../../shared/zoomMove';
import { buildCaptionBlocks } from '../../shared/captions';

function drawTextOverlay(ctx: CanvasRenderingContext2D, tStyle: TextStyle, W: number, H: number): void {
  const px = (tStyle.size / 1080) * H;
  ctx.font = `${tStyle.bold ? '700' : '400'} ${px}px ${tStyle.fontName || 'Inter, Segoe UI, sans-serif'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = tStyle.x * W;
  const cy = tStyle.y * H;

  if (tStyle.bgColor && (tStyle.bgColor.a ?? 1) > 0) {
    const pad = ((tStyle.bgPadding ?? 16) / 1080) * H;
    const metrics = ctx.measureText(tStyle.string || ' ');
    const boxW = metrics.width + pad * 2.2;
    const boxH = px * 1.15 + pad * 1.2;
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * Math.min(1, Math.max(0, tStyle.bgColor.a ?? 0.75));
    ctx.fillStyle = rgbaToHex(tStyle.bgColor);
    ctx.beginPath();
    ctx.roundRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH, Math.min(boxH / 2, pad * 0.75 + 4));
    ctx.fill();
    ctx.globalAlpha = prevAlpha;
  }

  const strokeW = ((tStyle.strokeWidth ?? 0) / 1080) * H;
  if (strokeW > 0.25) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = strokeW * 2;
    ctx.strokeStyle = rgbaToHex(tStyle.strokeColor ?? { r: 0, g: 0, b: 0, a: 1 });
    ctx.strokeText(tStyle.string, cx, cy);
  }

  ctx.fillStyle = rgbaToHex(tStyle.color);
  ctx.fillText(tStyle.string, cx, cy);
}

const VS_SRC = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS_SRC = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D u_tex;
uniform sampler3D u_lut;
uniform int u_useLut;
uniform float u_alpha;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_useLut == 1) {
    vec3 graded = texture(u_lut, clamp(c.rgb, 0.0, 1.0)).rgb;
    c.rgb = graded;
  }
  outColor = vec4(c.rgb, c.a * u_alpha);
}`;

class WebGLGrader {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  private lutCache = new Map<string, Uint8Array>();
  private cubeFileCache = new Map<string, ParsedCubeLUT>();

  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return;
    this.gl = gl;
    const vs = this.compile(gl, gl.VERTEX_SHADER, VS_SRC);
    const fs = this.compile(gl, gl.FRAGMENT_SHADER, FS_SRC);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    this.program = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 1,
         1, -1, 1, 1,
        -1,  1, 0, 0,
         1,  1, 1, 0,
      ]),
      gl.STATIC_DRAW
    );
    const locPos = gl.getAttribLocation(prog, 'a_pos');
    const locUv = gl.getAttribLocation(prog, 'a_uv');
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(locUv);
    gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 16, 8);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }

  private compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
    return s;
  }

  async ensureExternalCube(path?: string): Promise<void> {
    if (!path || !path.toLowerCase().endsWith('.cube') || this.cubeFileCache.has(path)) return;
    const text = await window.vectrail.readTextFile(path);
    if (text) {
      const parsed = parseCubeText(text);
      if (parsed) this.cubeFileCache.set(path, parsed);
    }
  }

  render(
    source: HTMLVideoElement | HTMLImageElement,
    width: number,
    height: number,
    grade?: ColorGrade,
    alpha = 1
  ): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || !this.program || !this.tex || !this.lutTex) return null;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      return null;
    }
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_tex'), 0);

    const useLut = grade && !isGradeNeutral(grade);
    if (useLut && grade) {
      const key = JSON.stringify(grade);
      let lut = this.lutCache.get(key);
      if (!lut) {
        const ext = grade.look ? this.cubeFileCache.get(grade.look) : undefined;
        const fLut = bakeGradeLUT(grade, ext);
        if (fLut) {
          const bytes = new Uint8Array(fLut.length);
          for (let i = 0; i < fLut.length; i++) {
            bytes[i] = Math.max(0, Math.min(255, Math.round(fLut[i] * 255)));
          }
          lut = bytes;
          if (this.lutCache.size > 120) this.lutCache.clear();
          this.lutCache.set(key, lut);
        }
      }
      if (lut) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
        gl.texImage3D(
          gl.TEXTURE_3D,
          0,
          gl.RGBA8,
          GRADE_CUBE_DIM,
          GRADE_CUBE_DIM,
          GRADE_CUBE_DIM,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          lut
        );
        gl.uniform1i(gl.getUniformLocation(this.program, 'u_lut'), 1);
        gl.uniform1i(gl.getUniformLocation(this.program, 'u_useLut'), 1);
      } else {
        gl.uniform1i(gl.getUniformLocation(this.program, 'u_useLut'), 0);
      }
    } else {
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_useLut'), 0);
    }

    gl.uniform1f(gl.getUniformLocation(this.program, 'u_alpha'), alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

export class PreviewCompositor {
  private videos = new Map<string, HTMLVideoElement>();
  private images = new Map<string, HTMLImageElement>();
  private scrubStrips: Record<string, ScrubStripInfo> = {};
  private scrubImages = new Map<string, HTMLImageElement>();
  private grader = new WebGLGrader();
  private onReady?: () => void;

  setOnReady(cb?: () => void): void {
    this.onReady = cb;
  }

  setScrubStrips(strips: Record<string, ScrubStripInfo> = {}): void {
    this.scrubStrips = strips;
  }

  private getScrubFrame(assetId: string, sourceTime: number): HTMLImageElement | null {
    const strip = this.scrubStrips[assetId];
    if (!strip || !strip.files.length || strip.rate <= 0) return null;
    const idx = Math.min(strip.files.length - 1, Math.max(0, Math.round(sourceTime * strip.rate)));
    const pickUrl = (i: number) => this.mediaUrl(strip.files[i]);
    const load = (i: number) => {
      const url = pickUrl(i);
      let img = this.scrubImages.get(url);
      if (!img) {
        img = document.createElement('img');
        img.crossOrigin = 'anonymous';
        img.src = url;
        img.addEventListener('load', () => this.onReady?.());
        if (this.scrubImages.size > 480) this.scrubImages.clear();
        this.scrubImages.set(url, img);
      }
      return img;
    };
    const target = load(idx);
    if (target.complete && target.naturalWidth > 0) return target;
    for (const offset of [-1, 1, -2, 2]) {
      const ni = idx + offset;
      if (ni >= 0 && ni < strip.files.length) {
        const neighbor = this.scrubImages.get(pickUrl(ni));
        if (neighbor && neighbor.complete && neighbor.naturalWidth > 0) return neighbor;
      }
    }
    return null;
  }

  private mediaUrl(filePath: string): string {
    return `vectrail-media://local?path=${encodeURIComponent(filePath)}`;
  }

  private getVideo(asset: MediaAsset): HTMLVideoElement {
    const srcPath = asset.playablePath ?? asset.path;
    let el = this.videos.get(srcPath);
    if (!el) {
      el = document.createElement('video');
      el.crossOrigin = 'anonymous';
      el.src = this.mediaUrl(srcPath);
      el.muted = true;
      el.preload = 'auto';
      el.playsInline = true;
      el.addEventListener('loadedmetadata', () => {
        const pending = Number(el!.dataset.pendingSeek);
        if (Number.isFinite(pending) && pending >= 0) {
          el!.currentTime = pending;
          delete el!.dataset.pendingSeek;
        }
        this.onReady?.();
      });
      el.addEventListener('loadeddata', () => this.onReady?.());
      el.addEventListener('canplay', () => this.onReady?.());
      el.addEventListener('seeked', () => this.onReady?.());
      el.addEventListener('error', () => {
        console.error('[Vectrail] video load error:', srcPath, el?.error?.code, el?.error?.message);
      });
      this.videos.set(srcPath, el);
    }
    return el;
  }

  private getImage(asset: MediaAsset): HTMLImageElement {
    let el = this.images.get(asset.path);
    if (!el) {
      el = document.createElement('img');
      el.crossOrigin = 'anonymous';
      el.src = this.mediaUrl(asset.path);
      el.addEventListener('load', () => this.onReady?.());
      this.images.set(asset.path, el);
    }
    return el;
  }

  renderSourcePreview(canvas: HTMLCanvasElement, asset: MediaAsset, time: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    if (asset.kind === 'image') {
      const img = this.getImage(asset);
      if (!img.complete || img.naturalWidth === 0) return;
      const ratio = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      const dw = img.naturalWidth * ratio;
      const dh = img.naturalHeight * ratio;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      return;
    }

    if (asset.kind === 'video') {
      const el = this.getVideo(asset);
      if (!el.paused) el.pause();
      const clamped = Math.max(0, Math.min(Math.max(0, asset.duration - 0.02), time));
      if (Math.abs(el.currentTime - clamped) > 0.04) {
        if (el.readyState < 1) el.dataset.pendingSeek = String(clamped);
        else el.currentTime = clamped;
      }
      const videoSettled = el.readyState >= 2 && el.videoWidth > 0 && !el.seeking && Math.abs(el.currentTime - clamped) <= 0.08;
      const scrubImg = !videoSettled ? this.getScrubFrame(asset.id, clamped) : null;
      const drawable: CanvasImageSource | null = videoSettled
        ? el
        : scrubImg ?? (el.readyState >= 2 && el.videoWidth > 0 ? el : null);
      if (!drawable) return;
      const mw = drawable === el ? el.videoWidth : (drawable as HTMLImageElement).naturalWidth;
      const mh = drawable === el ? el.videoHeight : (drawable as HTMLImageElement).naturalHeight;
      if (mw <= 0 || mh <= 0) return;
      const ratio = Math.min(w / mw, h / mh);
      const dw = mw * ratio;
      const dh = mh * ratio;
      ctx.drawImage(drawable, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
  }

  syncMediaElements(project: Project, playhead: number, playing: boolean): void {
    const activeAssetIDs = new Set<string>();
    for (const track of project.videoTracks) {
      if (track.hidden) continue;
      for (const clip of project.clips) {
        if (clip.trackID !== track.id || clip.kind !== 'video' || !clip.assetID) continue;
        const plan = transitionPlanForClip(project, clip);
        if (playhead < clip.start - plan.leadIn || playhead > clipEnd(clip) + plan.tailOut) continue;
        const asset = project.assets.find((a) => a.id === clip.assetID);
        if (!asset) continue;
        activeAssetIDs.add(asset.id);
        const el = this.getVideo(asset);
        const rawSrc = clipSourceTimeAt(clip, playhead);
        const targetSrc = Math.max(
          0,
          Math.min(asset.duration - 0.02, clip.reversed ? asset.duration - rawSrc : rawSrc)
        );
        if (clip.grade?.look) void this.grader.ensureExternalCube(clip.grade.look);
        if (playing && !clip.freeze && !clip.reversed) {
          const curSpeed = clipSpeedAt(clip, playhead - clip.start);
          el.playbackRate = Math.min(4, Math.max(0.1, curSpeed || 1));
          if (Math.abs(el.currentTime - targetSrc) > 0.25) {
            if (el.readyState < 1) el.dataset.pendingSeek = String(targetSrc);
            else el.currentTime = targetSrc;
          }
          if (el.paused && el.readyState >= 2) void el.play().catch(() => {});
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - targetSrc) > 0.03) {
            if (el.readyState < 1) el.dataset.pendingSeek = String(targetSrc);
            else el.currentTime = targetSrc;
          }
        }
      }
    }
    for (const asset of project.assets) {
      if (asset.kind === 'video' && !activeAssetIDs.has(asset.id)) {
        const el = this.videos.get(asset.playablePath ?? asset.path);
        if (el && !el.paused) el.pause();
      }
    }
  }

  renderFrame(
    canvas: HTMLCanvasElement,
    project: Project,
    playhead: number,
    transcripts: Record<string, Transcript> = {}
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);

    for (const track of project.videoTracks) {
      if (track.hidden) continue;
      const active = project.clips
        .filter((c) => {
          if (c.trackID !== track.id || c.kind === 'audio') return false;
          const plan = transitionPlanForClip(project, c);
          return playhead >= c.start - plan.leadIn && playhead <= clipEnd(c) + plan.tailOut;
        })
        .sort((a, b) => a.start - b.start);

      for (const clip of active) {
        const plan = transitionPlanForClip(project, clip);
        const fadeT = Math.min(Math.max(playhead, clip.start), clipEnd(clip));
        let alpha = clipFadeGainAt(clip, fadeT);
        if (plan.reveal && plan.reveal.kind !== 'wipe') {
          alpha *= transitionEdgeProgress(plan.reveal, playhead);
        }
        if (plan.conceal) {
          alpha *= 1 - transitionEdgeProgress(plan.conceal, playhead);
        }
        alpha = Math.min(1, Math.max(0, alpha));
        if (alpha <= 0.001) continue;

        ctx.save();
        ctx.globalAlpha = alpha;
        if (plan.reveal && plan.reveal.kind === 'wipe' && playhead < plan.reveal.end) {
          const p = transitionEdgeProgress(plan.reveal, playhead);
          const wipeFrac = p * p * (3 - 2 * p);
          ctx.beginPath();
          ctx.rect(0, 0, W * wipeFrac, H);
          ctx.clip();
        }

        if (clip.kind === 'solid') {
          ctx.fillStyle = rgbaToHex(clip.color);
          ctx.fillRect(0, 0, W, H);
        } else if (clip.kind === 'text') {
          const tStyle = clip.text;
          if (tStyle) {
            drawTextOverlay(ctx, tStyle, W, H);
          }
        } else if (clip.assetID) {
          const asset = project.assets.find((a) => a.id === clip.assetID);
          if (asset) {
            let drawable: CanvasImageSource | null = null;
            let mw = asset.width;
            let mh = asset.height;
            if (asset.kind === 'image') {
              const img = this.getImage(asset);
              if (img.complete && img.naturalWidth > 0) {
                drawable = img;
                mw = img.naturalWidth;
                mh = img.naturalHeight;
              }
            } else {
              const vid = this.getVideo(asset);
              const rawSrc = clipSourceTimeAt(clip, playhead);
              const targetSrc = Math.max(
                0,
                Math.min(Math.max(0, asset.duration - 0.02), clip.reversed ? asset.duration - rawSrc : rawSrc)
              );
              const videoSettled =
                vid.readyState >= 2 &&
                vid.videoWidth > 0 &&
                !vid.seeking &&
                Math.abs(vid.currentTime - targetSrc) <= 0.12;
              const scrubImg = !videoSettled ? this.getScrubFrame(asset.id, targetSrc) : null;
              if (videoSettled) {
                drawable = vid;
                mw = vid.videoWidth || asset.width;
                mh = vid.videoHeight || asset.height;
              } else if (scrubImg) {
                drawable = scrubImg;
                mw = scrubImg.naturalWidth || asset.width;
                mh = scrubImg.naturalHeight || asset.height;
              } else if (vid.readyState >= 2 && vid.videoWidth > 0) {
                drawable = vid;
                mw = vid.videoWidth || asset.width;
                mh = vid.videoHeight || asset.height;
              }
            }
            if (drawable) {
              const tr = transformAt(clip.transform, playhead - clip.start);
              const fitScale = Math.min(W / Math.max(1, mw), H / Math.max(1, mh));
              const dw = mw * fitScale * tr.scale;
              const dh = mh * fitScale * tr.scale;
              const dx = (W - dw) / 2 + tr.x * W;
              const dy = (H - dh) / 2 + tr.y * H;

              const graded =
                clip.grade && !isGradeNeutral(clip.grade)
                  ? this.grader.render(drawable, Math.max(2, Math.round(mw)), Math.max(2, Math.round(mh)), clip.grade, 1)
                  : null;
              ctx.drawImage(graded ?? drawable, dx, dy, dw, dh);
            }
          }
        }
        ctx.restore();
      }
    }

    if (project.captions && !project.captions.hidden) {
      const blocks = buildCaptionBlocks(project, transcripts);
      const active = blocks.find((b) => playhead >= b.start && playhead <= b.end);
      if (active) {
        const fontPx = Math.round((project.captions.size / 1080) * H);
        ctx.save();
        ctx.font = `700 ${fontPx}px Inter, Segoe UI, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, fontPx * 0.12);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        const cy = project.captions.position * H;
        if (project.captions.highlight && active.words.length > 0) {
          const spaceW = ctx.measureText(' ').width;
          const widths = active.words.map((w) => ctx.measureText(w.text).width);
          const totalW = widths.reduce((a, b) => a + b, 0) + spaceW * Math.max(0, active.words.length - 1);
          let curX = W / 2 - totalW / 2;
          ctx.textAlign = 'left';
          active.words.forEach((w, idx) => {
            const isCurrent = playhead >= w.start && playhead <= w.end;
            ctx.fillStyle = isCurrent ? '#FF4A1C' : '#FFFFFF';
            ctx.strokeText(w.text, curX, cy);
            ctx.fillText(w.text, curX, cy);
            curX += widths[idx] + spaceW;
          });
        } else {
          const text = active.words.map((w) => w.text).join(' ');
          ctx.textAlign = 'center';
          ctx.fillStyle = '#FFFFFF';
          ctx.strokeText(text, W / 2, cy);
          ctx.fillText(text, W / 2, cy);
        }
        ctx.restore();
      }
    }
  }
}
