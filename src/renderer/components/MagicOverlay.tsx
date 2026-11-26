import React, { useEffect, useRef, useState } from 'react';
import { applyMagicStep, MagicChoreography, MagicChoreoStep } from '../../shared/magicPlan';
import { clipName } from '../../shared/project';
import { AgentCursorState, ColorGrade, MagicProgressEvent, Project, TransitionKind } from '../../shared/types';

const RULER_H = 26;
const VIDEO_LANE_H = 54;
const AUDIO_LANE_H = 44;
const LANE_GAP = 4;
const PRESENCE_LINGER_MS = 12000;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

export interface MagicShowSession {
  choreography: MagicChoreography;
  summary: string;
  detail: string;
  worker: string;
  prompt: string;
  tab: string;
  changed: boolean;
}

interface MagicOverlayProps {
  project: Project;
  zoomPx: number;
  thinking: MagicProgressEvent | null;
  show: MagicShowSession | null;
  agentCursor?: AgentCursorState;
  animationsEnabled: boolean;
  onStopMagic: () => void;
  onTogglePlay?: () => void;
  onShowProjectUpdate: (next: Project) => void;
  onShowComplete: (session: MagicShowSession) => void;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function easeInOut(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function quadBezier(a: Point, c: Point, b: Point, t: number): Point {
  const u = clamp01(t);
  const inv = 1 - u;
  return {
    x: inv * inv * a.x + 2 * inv * u * c.x + u * u * b.x,
    y: inv * inv * a.y + 2 * inv * u * c.y + u * u * b.y,
  };
}

function controlPoint(a: Point, b: Point, seed: number, isFirst: boolean): Point {
  if (isFirst) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const turn = (seed % 2 === 0 ? 0.55 : -0.55) * (0.65 + 0.35 * Math.sin(seed * 2.1));
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    return {
      x: a.x + (dx * cos - dy * sin) * 0.45,
      y: a.y + (dx * sin + dy * cos) * 0.45,
    };
  }
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const bend = seed % 2 === 0 ? 0.16 : -0.16;
  return {
    x: midX - (b.y - a.y) * bend,
    y: midY + (b.x - a.x) * bend,
  };
}

function domRect(selector: string): Rect | null {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function listAssetRects(): Array<{ id: string; rect: Rect }> {
  const libRect = domRect('[data-magic-anchor="library"]');
  const els = document.querySelectorAll<HTMLElement>('[data-magic-asset]');
  const out: Array<{ id: string; rect: Rect }> = [];
  els.forEach((el) => {
    const id = el.dataset.magicAsset;
    if (!id) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    if (libRect && (r.bottom < libRect.y || r.top > libRect.y + libRect.h)) return;
    out.push({ id, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
  });
  return out;
}

function getTrackRowGeometry(project: Project): Map<string, { y: number; h: number }> {
  const map = new Map<string, { y: number; h: number }>();
  const videoRows = [...project.videoTracks].reverse();
  let curY = RULER_H + 4;
  for (const vt of videoRows) {
    map.set(vt.id, { y: curY, h: VIDEO_LANE_H });
    curY += VIDEO_LANE_H + LANE_GAP;
  }
  curY += 6;
  for (const at of project.audioTracks) {
    map.set(at.id, { y: curY, h: AUDIO_LANE_H });
    curY += AUDIO_LANE_H + LANE_GAP;
  }
  return map;
}

function getTimelineRectInfo(): { rect: Rect; scrollLeft: number; scrollTop: number; zoomPx: number } | null {
  const el = document.querySelector('[data-magic-anchor="timeline-canvas"]') as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const zoomAttr = Number(el.dataset.magicZoom || '48');
  return {
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    scrollLeft: el.scrollLeft,
    scrollTop: el.scrollTop,
    zoomPx: Number.isFinite(zoomAttr) && zoomAttr > 0 ? zoomAttr : 48,
  };
}

function clipRectOnScreen(
  project: Project,
  trackId: string | undefined,
  start: number,
  duration: number,
  fallbackZoomPx: number
): Rect | null {
  const tl = getTimelineRectInfo();
  if (!tl) return null;
  const z = tl.zoomPx || fallbackZoomPx;
  const rows = getTrackRowGeometry(project);
  const row =
    (trackId ? rows.get(trackId) : undefined) ??
    (project.videoTracks[0] ? rows.get(project.videoTracks[0].id) : undefined) ?? {
      y: RULER_H + 8,
      h: VIDEO_LANE_H,
    };
  const x = tl.rect.x + start * z - tl.scrollLeft;
  const y = tl.rect.y + row.y + 2 - tl.scrollTop;
  const w = Math.max(12, duration * z);
  const h = Math.max(18, row.h - 4);
  return { x, y, w, h };
}

function drawCornerBrackets(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  color: string,
  alpha: number,
  len = 10,
  inset = 0
): void {
  if (alpha <= 0.01) return;
  const x = r.x + inset;
  const y = r.y + inset;
  const w = Math.max(8, r.w - inset * 2);
  const h = Math.max(8, r.h - inset * 2);
  const l = Math.min(len, w * 0.35, h * 0.35);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Top-left
  ctx.moveTo(x, y + l);
  ctx.lineTo(x, y);
  ctx.lineTo(x + l, y);
  // Top-right
  ctx.moveTo(x + w - l, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + l);
  // Bottom-right
  ctx.moveTo(x + w, y + h - l);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w - l, y + h);
  // Bottom-left
  ctx.moveTo(x + l, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + h - l);
  ctx.stroke();
  ctx.restore();
}

function drawScanTarget(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  progress: number,
  fadeAlpha: number,
  accent = '#FFFFFF'
): void {
  if (fadeAlpha <= 0.01) return;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 6);
  ctx.clip();
  ctx.fillStyle = `rgba(255, 255, 255, ${0.06 * fadeAlpha})`;
  ctx.fillRect(r.x, r.y, r.w, r.h);

  if (progress >= 0 && progress <= 1) {
    const sweepX = r.x - 16 + (r.w + 32) * progress;
    const grad = ctx.createLinearGradient(sweepX - 24, r.y, sweepX + 24, r.y);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${0.32 * fadeAlpha})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(sweepX - 24, r.y, 48, r.h);

    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.75 * fadeAlpha;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sweepX, r.y);
    ctx.lineTo(sweepX, r.y + r.h);
    ctx.stroke();
  }
  ctx.restore();
  drawCornerBrackets(ctx, r, '#FFFFFF', 0.82 * fadeAlpha, 9, 2);
}

function dotNoise(a: number, b: number): number {
  return Math.sin(a * 1.7 + Math.sin(b * 1.3)) * 0.5 + Math.sin(b * 2.1 - a * 0.6) * 0.3 + Math.sin((a + b) * 0.9) * 0.2;
}

function drawDotField(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  timeSec: number,
  alpha: number
): void {
  if (alpha <= 0.01 || r.w < 20 || r.h < 20) return;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 6);
  ctx.clip();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.24)';
  ctx.fillRect(r.x, r.y, r.w, r.h);

  const spacing = Math.max(8, Math.min(13, Math.min(r.w, r.h) / 42));
  const reach = Math.max(r.w, r.h) * 0.16;
  const glows: Point[] = [
    {
      x: r.x + r.w * (0.5 + 0.24 * Math.sin(timeSec * 0.85)),
      y: r.y + r.h * (0.48 + 0.2 * Math.cos(timeSec * 0.68)),
    },
    {
      x: r.x + r.w * (0.5 - 0.22 * Math.cos(timeSec * 0.6)),
      y: r.y + r.h * (0.52 + 0.18 * Math.sin(timeSec * 0.92)),
    },
  ];

  for (let py = r.y + spacing / 2; py < r.y + r.h; py += spacing) {
    const v = (py - r.y) / r.h;
    for (let px = r.x + spacing / 2; px < r.x + r.w; px += spacing) {
      const u = (px - r.x) / r.w;
      const rawN = dotNoise(u * 4 + timeSec * 0.6, v * 3.2 - timeSec * 0.44) * 0.5 + 0.5;
      const n = Math.min(1, Math.pow(Math.max(0, rawN), 2.5) * 1.2) * 0.65;
      let glow = 0;
      for (const g of glows) {
        const d = Math.hypot(px - g.x, py - g.y);
        glow = Math.max(glow, 1 - d / reach);
      }
      glow = Math.pow(Math.max(0, glow), 2) * 0.72;
      const level = Math.min(1, n + glow * (1 - n * 0.5));
      const radius = 0.55 + level * spacing * 0.14;
      const dotAlpha = 0.06 + 0.64 * level;
      ctx.fillStyle = `rgba(255, ${Math.round(212 + 43 * level)}, ${Math.round(188 + 67 * level)}, ${dotAlpha * alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawPointerCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  name: string,
  activity?: string,
  alpha = 1
): void {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;

  // Arrow cursor shape anchored at tip (x, y)
  ctx.translate(x, y);
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.6, 13.2);
  ctx.lineTo(8.2, 20.4);
  ctx.lineTo(10.8, 19.1);
  ctx.lineTo(7.2, 12.1);
  ctx.lineTo(12.6, 11.6);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();

  // Pill badge
  const labelText = activity ? `${name} · ${activity}` : name;
  ctx.font = '600 10.5px Inter, system-ui, sans-serif';
  const metrics = ctx.measureText(labelText);
  const pillW = Math.min(220, metrics.width + 14);
  const pillH = 18;
  const px = 11;
  const py = 17;

  ctx.beginPath();
  ctx.roundRect(px, py, pillW, pillH, 9);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const isLight = color.toLowerCase() === '#eaecef' || color.toLowerCase() === '#f2f2f0';
  ctx.fillStyle = isLight ? '#111111' : '#FFFFFF';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, px + 7, py + pillH / 2 + 0.5, pillW - 14);

  ctx.restore();
}

function drawClickRipple(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, progress: number): void {
  if (progress <= 0 || progress >= 1) return;
  ctx.save();
  ctx.globalAlpha = (1 - progress) * 0.75;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(x, y, 4 + progress * 16, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawTransitionMenu(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  selectedKind: TransitionKind | undefined,
  alpha: number
): void {
  if (alpha <= 0.02) return;
  const items: Array<{ id: TransitionKind; label: string }> = [
    { id: 'dissolve', label: 'Dissolve' },
    { id: 'dipToBlack', label: 'Dip to Black' },
    { id: 'wipe', label: 'Wipe' },
  ];
  const w = 116;
  const h = 72;
  const mx = Math.min(window.innerWidth - w - 12, x + 8);
  const my = Math.max(44, y - h - 6);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.roundRect(mx, my, w, h, 8);
  ctx.fillStyle = '#222428';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();

  items.forEach((item, idx) => {
    const iy = my + 5 + idx * 21;
    const active = item.id === (selectedKind ?? 'dissolve');
    if (active) {
      ctx.beginPath();
      ctx.roundRect(mx + 4, iy, w - 8, 19, 4);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = active ? '#FFFFFF' : '#C8C8C4';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.label, mx + 12, iy + 9.5);
  });
  ctx.restore();
}

function drawGradeCard(
  ctx: CanvasRenderingContext2D,
  insp: Rect,
  label: string,
  grade: ColorGrade,
  progress: number,
  color: string
): void {
  const cardW = Math.min(256, insp.w - 20);
  const cardH = 104;
  const cx = insp.x + (insp.w - cardW) / 2;
  const cy = insp.y + 44;
  const t = easeInOut(progress);

  ctx.save();
  ctx.globalAlpha = Math.min(1, progress * 3) * (progress > 0.88 ? (1 - progress) / 0.12 : 1);
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.roundRect(cx, cy, cardW, cardH, 9);
  ctx.fillStyle = '#18191D';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#F2F2F0';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx + 12, cy + 18, cardW - 92);

  if (grade.look) {
    ctx.beginPath();
    ctx.roundRect(cx + cardW - 84, cy + 9, 72, 18, 9);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fill();
    ctx.font = '500 9.5px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#F2F2F0';
    ctx.fillText(grade.look.slice(0, 11), cx + cardW - 76, cy + 18);
  }

  const sliders: Array<{ name: string; norm: number }> = [
    { name: 'Exposure', norm: 0.5 + ((grade.exposure ?? 0.25) / 2) * t },
    { name: 'Contrast', norm: 0.5 + ((grade.contrast ?? 12) / 100) * t },
    { name: 'Warmth', norm: 0.5 + ((grade.temperature ?? 14) / 100) * t },
  ];
  sliders.forEach((s, idx) => {
    const sy = cy + 42 + idx * 21;
    ctx.font = '500 10px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#8E8E93';
    ctx.fillText(s.name, cx + 12, sy);
    const trackX = cx + 76;
    const trackW = cardW - 92;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.roundRect(trackX, sy - 2, trackW, 4, 2);
    ctx.fill();
    const fillPos = clamp01(s.norm) * trackW;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(Math.min(trackX + trackW / 2, trackX + fillPos), sy - 2, Math.abs(fillPos - trackW / 2), 4, 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(trackX + fillPos, sy, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
  });
  ctx.restore();
}

function agentColorFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('claude')) return '#D97757';
  if (lower.includes('codex') || lower.includes('chatgpt')) return '#10A37F';
  if (lower.includes('cloud')) return '#FF6B35';
  if (lower.includes('local')) return '#EAECEF';
  return '#30D158';
}

export const MagicOverlay: React.FC<MagicOverlayProps> = ({
  project,
  zoomPx,
  thinking,
  show,
  agentCursor,
  animationsEnabled,
  onStopMagic,
  onTogglePlay,
  onShowProjectUpdate,
  onShowComplete,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [escHintNudge, setEscHintNudge] = useState(0);

  const latestPropsRef = useRef({
    project,
    zoomPx,
    thinking,
    show,
    agentCursor,
    animationsEnabled,
    onStopMagic,
    onTogglePlay,
    onShowProjectUpdate,
    onShowComplete,
  });
  latestPropsRef.current = {
    project,
    zoomPx,
    thinking,
    show,
    agentCursor,
    animationsEnabled,
    onStopMagic,
    onTogglePlay,
    onShowProjectUpdate,
    onShowComplete,
  };

  // Live presence interpolation state across MCP updates
  const presenceRef = useRef<{
    from: Point;
    to: Point;
    current: Point;
    movedAt: number;
    lastKey: string;
  }>({
    from: { x: 400, y: 200 },
    to: { x: 400, y: 200 },
    current: { x: 400, y: 200 },
    movedAt: 0,
    lastKey: '',
  });

  // Show playback state
  const showRunRef = useRef<{
    session: MagicShowSession | null;
    startedAt: number;
    appliedIds: Set<string>;
    working: Project | null;
    actorPos: Map<string, Point>;
    actorStepId: Map<string, string>;
  }>({
    session: null,
    startedAt: 0,
    appliedIds: new Set(),
    working: null,
    actorPos: new Map(),
    actorStepId: new Map(),
  });

  // Synchronize incoming show session
  useEffect(() => {
    if (!show) {
      showRunRef.current.session = null;
      showRunRef.current.appliedIds.clear();
      showRunRef.current.working = null;
      return;
    }
    if (!animationsEnabled) {
      onShowComplete(show);
      return;
    }
    const btn = domRect('[data-magic-anchor="magicButton"]');
    const spawn: Point = btn ? { x: btn.x + btn.w / 2, y: btn.y + btn.h / 2 } : { x: window.innerWidth - 180, y: 20 };
    const actorPos = new Map<string, Point>();
    for (const a of show.choreography.actors) {
      actorPos.set(a.id, { ...spawn });
    }
    showRunRef.current = {
      session: show,
      startedAt: performance.now(),
      appliedIds: new Set(),
      working: show.choreography.before,
      actorPos,
      actorStepId: new Map(),
    };
  }, [show, animationsEnabled]);

  // Interaction lock while MagicThinking or MagicShow is active
  const isLocked = Boolean((thinking || show) && animationsEnabled);
  useEffect(() => {
    if (!isLocked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        latestPropsRef.current.onStopMagic();
        return;
      }
      if (e.code === 'Space' && latestPropsRef.current.thinking && !latestPropsRef.current.show) {
        e.preventDefault();
        e.stopPropagation();
        latestPropsRef.current.onTogglePlay?.();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setEscHintNudge(performance.now());
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isLocked]);

  // Main 60fps overlay animation loop
  useEffect(() => {
    let raf = 0;
    const startedThinkingAt = performance.now();

    const step = (now: number) => {
      const {
        project: curProj,
        zoomPx: curZoom,
        thinking: curThinking,
        show: curShow,
        agentCursor: curAgent,
        animationsEnabled: animOn,
        onShowProjectUpdate: emitProj,
        onShowComplete: finishShow,
      } = latestPropsRef.current;

      const canvas = canvasRef.current;
      if (!canvas) {
        raf = requestAnimationFrame(step);
        return;
      }
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        raf = requestAnimationFrame(step);
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const tSec = (now - startedThinkingAt) / 1000;

      // 1. MagicThinking Stage
      if (animOn && curThinking && !curShow) {
        const magicBtn = domRect('[data-magic-anchor="magicButton"]');
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        if (magicBtn) {
          ctx.roundRect(magicBtn.x - 4, magicBtn.y - 3, magicBtn.w + 8, magicBtn.h + 6, 16);
        }
        ctx.fill('evenodd');
        ctx.restore();

        const viewerRect = domRect('[data-magic-anchor="viewer"]');
        const assetRects = listAssetRects();
        const stage = curThinking.stage;

        if (stage === 'looking' && assetRects.length > 0) {
          const idx = Math.floor(tSec * 1.45) % assetRects.length;
          const prog = (tSec * 1.45) % 1;
          drawScanTarget(ctx, assetRects[idx].rect, prog, 0.9);
        }

        if (stage === 'analyzing') {
          if (curThinking.focusAssetId) {
            const match = assetRects.find((a) => a.id === curThinking.focusAssetId);
            if (match) drawScanTarget(ctx, match.rect, (tSec * 1.6) % 1, 0.95);
          } else if (assetRects.length > 0) {
            const idx = Math.floor(tSec * 1.8) % assetRects.length;
            drawScanTarget(ctx, assetRects[idx].rect, (tSec * 1.8) % 1, 0.9);
          }
          if (viewerRect) {
            drawScanTarget(ctx, viewerRect, (tSec * 0.95) % 1, 0.72);
          }
        }

        if (stage === 'thinking') {
          if (viewerRect) {
            drawDotField(ctx, viewerRect, tSec, 0.92);
            drawCornerBrackets(ctx, viewerRect, '#FFFFFF', 0.65, 12, 0);
          }
          const draft = curThinking.draftProject;
          const tl = getTimelineRectInfo();
          if (draft && tl) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(tl.rect.x, tl.rect.y, tl.rect.w, tl.rect.h);
            ctx.clip();
            for (const c of draft.clips) {
              const cr = clipRectOnScreen(draft, c.trackID, c.start, c.duration, curZoom);
              if (!cr) continue;
              ctx.beginPath();
              ctx.roundRect(cr.x, cr.y, cr.w, cr.h, 5);
              ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
              ctx.fill();
              ctx.setLineDash([6, 4]);
              ctx.lineDashOffset = -tSec * 28;
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.68)';
              ctx.lineWidth = 1.25;
              ctx.stroke();
              ctx.setLineDash([]);
            }
            ctx.restore();
          }
        }
      }

      // 2. MagicShow Swarm Choreography
      const sr = showRunRef.current;
      if (animOn && sr.session) {
        const elapsed = now - sr.startedAt;
        const { choreography } = sr.session;
        const btn = domRect('[data-magic-anchor="magicButton"]');
        const spawn: Point = btn ? { x: btn.x + btn.w / 2, y: btn.y + btn.h / 2 } : { x: w - 180, y: 20 };
        const assetRects = listAssetRects();
        const inspRect = domRect('[data-magic-anchor="inspector"]');
        const viewerRect = domRect('[data-magic-anchor="viewer"]');
        const tl = getTimelineRectInfo();

        // Draw remaining un-landed ghost outlines cleanly on timeline
        if (tl) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(tl.rect.x, tl.rect.y, tl.rect.w, tl.rect.h);
          ctx.clip();
          for (const stepItem of choreography.steps) {
            if (sr.appliedIds.has(stepItem.id) || !stepItem.clipId) continue;
            const targetClip = choreography.after.clips.find((c) => c.id === stepItem.clipId);
            if (!targetClip) continue;
            const cr = clipRectOnScreen(choreography.after, targetClip.trackID, targetClip.start, targetClip.duration, curZoom);
            if (!cr) continue;
            ctx.beginPath();
            ctx.roundRect(cr.x, cr.y, cr.w, cr.h, 5);
            ctx.setLineDash([5, 4]);
            ctx.lineDashOffset = -tSec * 24;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.restore();
        }

        // Apply steps whose endMs has elapsed
        let dirtyProject = false;
        for (const st of choreography.steps) {
          if (!sr.appliedIds.has(st.id) && elapsed >= st.endMs) {
            sr.appliedIds.add(st.id);
            if (sr.working) {
              sr.working = applyMagicStep(sr.working, st, choreography.after);
              dirtyProject = true;
            }
          }
        }
        if (dirtyProject && sr.working) {
          emitProj(sr.working);
        }

        // Animate each active actor
        for (let aIdx = 0; aIdx < choreography.actors.length; aIdx++) {
          const actor = choreography.actors[aIdx];
          const actorSteps = choreography.steps.filter((s) => s.actor.id === actor.id);
          if (!actorSteps.length) continue;
          const firstStart = actorSteps[0].startMs;
          const lastEnd = actorSteps[actorSteps.length - 1].endMs;
          if (elapsed < firstStart - 80 || elapsed > lastEnd + 420) continue;

          const currentStep: MagicChoreoStep =
            actorSteps.find((s) => elapsed >= s.startMs && elapsed <= s.endMs) ??
            actorSteps.filter((s) => s.endMs <= elapsed).pop() ??
            actorSteps[0];

          const targetClip = currentStep.clipId
            ? choreography.after.clips.find((c) => c.id === currentStep.clipId)
            : undefined;
          const clipRect = targetClip
            ? clipRectOnScreen(choreography.after, targetClip.trackID, targetClip.start, targetClip.duration, curZoom)
            : null;

          let dest: Point = clipRect
            ? { x: clipRect.x + clipRect.w * 0.5, y: clipRect.y + clipRect.h * 0.5 }
            : viewerRect
            ? { x: viewerRect.x + viewerRect.w * 0.5, y: viewerRect.y + viewerRect.h * 0.5 }
            : { x: w * 0.5, y: h * 0.65 };

          if (currentStep.kind === 'grade' && inspRect) {
            dest = { x: inspRect.x + inspRect.w * 0.55, y: inspRect.y + 110 };
          } else if (currentStep.kind === 'transition' && clipRect) {
            dest = { x: clipRect.x + 4, y: clipRect.y + clipRect.h * 0.5 };
          } else if (currentStep.kind === 'trim' && clipRect) {
            dest = { x: clipRect.x + clipRect.w, y: clipRect.y + clipRect.h * 0.5 };
          } else if (currentStep.kind === 'title' && viewerRect && elapsed > (currentStep.startMs + currentStep.endMs) / 2) {
            dest = { x: viewerRect.x + viewerRect.w * 0.5, y: viewerRect.y + viewerRect.h * 0.5 };
          }

          const stepDur = Math.max(1, currentStep.endMs - currentStep.startMs);
          const stepProg = clamp01((elapsed - currentStep.startMs) / stepDur);
          const returningHome = elapsed > lastEnd;
          const returnProg = returningHome ? clamp01((elapsed - lastEnd) / 380) : 0;

          let drawPos: Point;
          if (returningHome) {
            const ctrlPt = controlPoint(dest, spawn, aIdx + 1, false);
            drawPos = quadBezier(dest, ctrlPt, spawn, easeInOut(returnProg));
          } else if (currentStep.kind === 'place' && currentStep.assetId && clipRect) {
            const assetEntry = assetRects.find((a) => a.id === currentStep.assetId);
            const srcPt: Point = assetEntry
              ? { x: assetEntry.rect.x + assetEntry.rect.w * 0.5, y: assetEntry.rect.y + assetEntry.rect.h * 0.5 }
              : spawn;
            if (stepProg < 0.35) {
              const p1 = easeInOut(stepProg / 0.35);
              drawPos = quadBezier(spawn, controlPoint(spawn, srcPt, aIdx, true), srcPt, p1);
            } else {
              const p2 = easeInOut((stepProg - 0.35) / 0.65);
              drawPos = quadBezier(srcPt, controlPoint(srcPt, dest, aIdx + 3, false), dest, p2);
              // Ghost thumbnail dragged by cursor
              ctx.save();
              ctx.globalAlpha = 0.85 * (1 - p2 * 0.25);
              ctx.fillStyle = '#181A1F';
              ctx.strokeStyle = actor.color;
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.roundRect(drawPos.x - 42, drawPos.y - 16, 84, 32, 5);
              ctx.fill();
              ctx.stroke();
              ctx.font = '500 9.5px Inter, system-ui, sans-serif';
              ctx.fillStyle = '#F2F2F0';
              ctx.textBaseline = 'middle';
              ctx.fillText(currentStep.label.replace(/^Placing\s+/, '').slice(0, 12), drawPos.x - 36, drawPos.y);
              ctx.restore();
            }
          } else {
            const lastSid = sr.actorStepId.get(actor.id);
            if (lastSid && lastSid !== currentStep.id) {
              const prevStep = actorSteps.find((s) => s.id === lastSid);
              if (prevStep) {
                const prevClip = prevStep.clipId
                  ? choreography.after.clips.find((c) => c.id === prevStep.clipId)
                  : undefined;
                const prevCr = prevClip
                  ? clipRectOnScreen(choreography.after, prevClip.trackID, prevClip.start, prevClip.duration, curZoom)
                  : null;
                const prevDest = prevCr
                  ? { x: prevCr.x + prevCr.w * 0.5, y: prevCr.y + prevCr.h * 0.5 }
                  : dest;
                sr.actorPos.set(actor.id, prevDest);
              }
            }
            sr.actorStepId.set(actor.id, currentStep.id);
            const prevPt = sr.actorPos.get(actor.id) ?? spawn;
            const travel = easeInOut(Math.min(1, stepProg * 1.6));
            drawPos = quadBezier(prevPt, controlPoint(prevPt, dest, aIdx, prevPt.x === spawn.x && prevPt.y === spawn.y), dest, travel);
          }

          // Snap & cut lines
          if (!returningHome && tl && (currentStep.snapTimes?.length || currentStep.cutTime !== undefined) && stepProg > 0.5) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(tl.rect.x, tl.rect.y + RULER_H, tl.rect.w, tl.rect.h - RULER_H);
            ctx.clip();
            if (currentStep.snapTimes) {
              ctx.setLineDash([4, 3]);
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
              ctx.lineWidth = 1;
              for (const stTime of currentStep.snapTimes) {
                const sx = tl.rect.x + stTime * (tl.zoomPx || curZoom) - tl.scrollLeft;
                ctx.beginPath();
                ctx.moveTo(sx, tl.rect.y + RULER_H);
                ctx.lineTo(sx, tl.rect.y + tl.rect.h);
                ctx.stroke();
              }
              ctx.setLineDash([]);
            }
            if (currentStep.cutTime !== undefined) {
              const cxLine = tl.rect.x + currentStep.cutTime * (tl.zoomPx || curZoom) - tl.scrollLeft;
              ctx.strokeStyle = '#FF4A1C';
              ctx.lineWidth = 1.6;
              ctx.beginPath();
              ctx.moveTo(cxLine, tl.rect.y + RULER_H);
              ctx.lineTo(cxLine, tl.rect.y + tl.rect.h);
              ctx.stroke();
            }
            ctx.restore();
          }

          // Floating Transition Menu
          if (!returningHome && currentStep.kind === 'transition' && stepProg > 0.32 && stepProg < 0.94) {
            drawTransitionMenu(ctx, dest.x, dest.y, actor.color, currentStep.transitionKind, 0.96);
          }

          // Floating Grade Card over Inspector
          if (!returningHome && currentStep.kind === 'grade' && inspRect && currentStep.grade) {
            const lbl = targetClip ? clipName(choreography.after, targetClip) : 'Shot';
            drawGradeCard(ctx, inspRect, lbl, currentStep.grade, stepProg, actor.color);
          }

          // Click ripple near end of step
          if (!returningHome && stepProg > 0.72 && stepProg < 0.98) {
            drawClickRipple(ctx, dest.x, dest.y, actor.color, (stepProg - 0.72) / 0.26);
          }

          const alpha = returningHome ? 1 - returnProg : 1;
          drawPointerCursor(
            ctx,
            drawPos.x,
            drawPos.y,
            actor.color,
            actor.name,
            returningHome ? undefined : currentStep.label,
            alpha
          );
        }

        if (elapsed >= choreography.totalDurationMs) {
          const completed = sr.session;
          sr.session = null;
          finishShow(completed);
        }
      }

      // 3. External MCP AgentPresence Cursor (gliding & bobbing between calls)
      if (animOn && !curThinking && !curShow && curAgent) {
        const age = Date.now() - curAgent.updatedAt;
        if (age < PRESENCE_LINGER_MS) {
          const fadeAlpha = age > PRESENCE_LINGER_MS - 600 ? (PRESENCE_LINGER_MS - age) / 600 : 1;
          const color = agentColorFor(curAgent.name);

          let targetPt: Point | null = null;
          let highlightRect: Rect | null = null;
          let isScanTarget = false;

          if (curAgent.targetKind === 'asset' && curAgent.assetID) {
            const assetEntry = listAssetRects().find((a) => a.id === curAgent.assetID);
            if (assetEntry) {
              highlightRect = assetEntry.rect;
              isScanTarget = true;
              targetPt = {
                x: assetEntry.rect.x + assetEntry.rect.w * 0.72,
                y: assetEntry.rect.y + assetEntry.rect.h * 0.62,
              };
            }
          } else if (curAgent.targetKind === 'viewer') {
            const vr = domRect('[data-magic-anchor="viewer"]');
            if (vr) {
              highlightRect = vr;
              isScanTarget = true;
              targetPt = { x: vr.x + vr.w * 0.62, y: vr.y + vr.h * 0.6 };
            }
          } else if (curAgent.targetKind === 'inspector') {
            const ir = domRect('[data-magic-anchor="inspector"]');
            if (ir) {
              targetPt = { x: ir.x + ir.w * 0.5, y: ir.y + 135 };
            }
          }

          if (!targetPt && curAgent.clipID) {
            const c = curProj.clips.find((x) => x.id === curAgent.clipID);
            if (c) {
              const cr = clipRectOnScreen(curProj, c.trackID, c.start, c.duration, curZoom);
              if (cr) {
                highlightRect = cr;
                targetPt = { x: cr.x + Math.min(cr.w * 0.5, 42), y: cr.y + cr.h * 0.5 };
              }
            }
          }

          if (!targetPt) {
            const tl = getTimelineRectInfo();
            if (tl) {
              const tVal = curAgent.time ?? 0;
              const tx = tl.rect.x + tVal * (tl.zoomPx || curZoom) - tl.scrollLeft;
              targetPt = {
                x: Math.max(tl.rect.x + 24, Math.min(tl.rect.x + tl.rect.w - 40, tx)),
                y: tl.rect.y + RULER_H + 34,
              };
            }
          }

          if (targetPt) {
            const key = `${curAgent.updatedAt}-${curAgent.clipID ?? ''}-${curAgent.assetID ?? ''}-${curAgent.targetKind ?? ''}`;
            const pr = presenceRef.current;
            if (pr.lastKey !== key) {
              pr.from = { ...pr.current };
              pr.to = { ...targetPt };
              pr.movedAt = now;
              pr.lastKey = key;
            } else {
              pr.to = { ...targetPt };
            }
            const moveT = easeInOut(clamp01((now - pr.movedAt) / 360));
            pr.current = quadBezier(pr.from, controlPoint(pr.from, pr.to, 2, false), pr.to, moveT);

            if (highlightRect) {
              if (isScanTarget) {
                drawScanTarget(ctx, highlightRect, age < 1400 ? (age % 900) / 900 : -1, fadeAlpha * 0.85, color);
              } else {
                drawCornerBrackets(ctx, highlightRect, color, fadeAlpha * 0.85, 8, -2);
              }
            }
            if (age < 420) {
              drawClickRipple(ctx, pr.to.x, pr.to.y, color, age / 420);
            }
            const bob = moveT >= 1 ? Math.sin((now / 1000) * 2.2) * 2.2 : 0;
            drawPointerCursor(ctx, pr.current.x, pr.current.y + bob, color, curAgent.name, curAgent.activity, fadeAlpha);
          }
        }
      }

      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  const showEscHint = isLocked && (escHintNudge > 0 && performance.now() - escHintNudge < 2400 || Boolean(thinking));

  return (
    <>
      {isLocked && (
        <div
          className="fixed inset-0 z-40"
          style={{ top: 40 }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setEscHintNudge(performance.now());
          }}
          onContextMenu={(e) => e.preventDefault()}
        />
      )}
      <canvas
        ref={canvasRef}
        className="fixed inset-0 z-[45] pointer-events-none w-screen h-screen"
      />
      {showEscHint && (
        <div
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[46] pointer-events-none px-3 py-1 rounded-full text-[11px] font-medium transition-opacity"
          style={{
            background: 'rgba(0, 0, 0, 0.72)',
            color: 'rgba(255, 255, 255, 0.82)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
          }}
        >
          Press Esc to cancel
        </div>
      )}
    </>
  );
};
