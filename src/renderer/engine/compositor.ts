import { ColorGrade, MediaAsset, Project, Transcript } from '../../shared/types';
import { bakeGradeLUT, GRADE_CUBE_DIM, isGradeNeutral, parseCubeText, ParsedCubeLUT } from '../../shared/colorGrade';
import { clipFadeGainAt, clipEnd, rgbaToHex } from '../../shared/project';
import { clipSourceTimeAt } from '../../shared/speedRamp';
import { transformAt } from '../../shared/zoomMove';
import { buildCaptionBlocks } from '../../shared/captions';

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
    const text = await window.editroom.readTextFile(path);
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
  private grader = new WebGLGrader();
  private onReady?: () => void;

  setOnReady(cb?: () => void): void {
    this.onReady = cb;
  }

  private mediaUrl(filePath: string): string {
    return `editroom-media://local?path=${encodeURIComponent(filePath)}`;
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
        console.error('[Editroom] video load error:', srcPath, el?.error?.code, el?.error?.message);
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

  syncMediaElements(project: Project, playhead: number, playing: boolean): void {
    const activeAssetIDs = new Set<string>();
    for (const track of project.videoTracks) {
      if (track.hidden) continue;
      for (const clip of project.clips) {
        if (clip.trackID !== track.id || clip.kind !== 'video' || !clip.assetID) continue;
        if (playhead < clip.start || playhead > clipEnd(clip)) continue;
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
          el.playbackRate = Math.min(4, Math.max(0.1, clip.speed ?? 1));
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
        .filter((c) => c.trackID === track.id && c.kind !== 'audio' && playhead >= c.start && playhead <= clipEnd(c))
        .sort((a, b) => a.start - b.start);

      for (const clip of active) {
        const fadeAlpha = clipFadeGainAt(clip, playhead);
        let transAlpha = 1;
        let wipeProgress: number | undefined;
        let dipBlackAlpha = 0;
        if (clip.transitionIn && playhead < clip.start + clip.transitionIn.duration) {
          const prog = Math.min(1, Math.max(0, (playhead - clip.start) / Math.max(1e-4, clip.transitionIn.duration)));
          if (clip.transitionIn.kind === 'dissolve') transAlpha = prog;
          else if (clip.transitionIn.kind === 'dipToBlack') {
            dipBlackAlpha = prog < 0.5 ? prog * 2 : (1 - prog) * 2;
            transAlpha = prog < 0.5 ? 0 : 1;
          }
          else if (clip.transitionIn.kind === 'wipe') wipeProgress = prog;
        }
        if (dipBlackAlpha > 0.001) {
          ctx.save();
          ctx.globalAlpha = dipBlackAlpha;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.restore();
        }
        const alpha = fadeAlpha * transAlpha;
        if (alpha <= 0.001) continue;

        ctx.save();
        ctx.globalAlpha = alpha;
        if (wipeProgress !== undefined) {
          ctx.beginPath();
          ctx.rect(0, 0, W * wipeProgress, H);
          ctx.clip();
        }

        if (clip.kind === 'solid') {
          ctx.fillStyle = rgbaToHex(clip.color);
          ctx.fillRect(0, 0, W, H);
        } else if (clip.kind === 'text') {
          const tStyle = clip.text;
          if (tStyle) {
            const px = (tStyle.size / 1080) * H;
            ctx.font = `${tStyle.bold ? '700' : '400'} ${px}px ${tStyle.fontName || 'Inter, Segoe UI, sans-serif'}`;
            ctx.fillStyle = rgbaToHex(tStyle.color);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(tStyle.string, tStyle.x * W, tStyle.y * H);
          }
        } else if (clip.assetID) {
          const asset = project.assets.find((a) => a.id === clip.assetID);
          if (asset) {
            const mediaEl = asset.kind === 'image' ? this.getImage(asset) : this.getVideo(asset);
            const ready =
              asset.kind === 'image'
                ? (mediaEl as HTMLImageElement).complete && (mediaEl as HTMLImageElement).naturalWidth > 0
                : (mediaEl as HTMLVideoElement).readyState >= 2;
            if (ready) {
              const mw = asset.kind === 'image' ? (mediaEl as HTMLImageElement).naturalWidth : (mediaEl as HTMLVideoElement).videoWidth || asset.width;
              const mh = asset.kind === 'image' ? (mediaEl as HTMLImageElement).naturalHeight : (mediaEl as HTMLVideoElement).videoHeight || asset.height;
              const tr = transformAt(clip.transform, playhead - clip.start);
              const fitScale = Math.min(W / Math.max(1, mw), H / Math.max(1, mh));
              const dw = mw * fitScale * tr.scale;
              const dh = mh * fitScale * tr.scale;
              const dx = (W - dw) / 2 + tr.x * W;
              const dy = (H - dh) / 2 + tr.y * H;

              const graded =
                clip.grade && !isGradeNeutral(clip.grade)
                  ? this.grader.render(mediaEl, Math.max(2, Math.round(mw)), Math.max(2, Math.round(mh)), clip.grade, 1)
                  : null;
              ctx.drawImage(graded ?? mediaEl, dx, dy, dw, dh);
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
