import React, { useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  Compass,
  Eye,
  EyeOff,
  Film,
  Link2,
  Lock,
  Magnet,
  MousePointer,
  Maximize2,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  Unlock,
  Volume2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AgentCursorState, Clip, ColorGrade, MarkerTint, Project, Track, TransitionKind } from '../../shared/types';
import { WaveformData } from '../../main/engine/ffmpeg';
import { AppThemeName, THEMES } from '../../shared/themes';
import { useI18n } from '../i18n';
import {
  applyStickyEdgeShift,
  clipEnd,
  clipName,
  formatTimecode,
  linkedIds,
  newId,
  projectDuration,
  resolveOverlaps,
  snapFrame,
  snapPoints,
  trimClipHead,
  trimClipTail,
  trimLimits,
} from '../../shared/project';

const MARKER_HEX: Record<MarkerTint, string> = {
  orange: '#FF4A1C',
  red: '#FF453A',
  yellow: '#FFD60A',
  green: '#30D158',
  blue: '#0A84FF',
  purple: '#BF5AF2',
};

interface TimelinePanelProps {
  project: Project;
  playhead: number;
  selectedIds: string[];
  theme?: AppThemeName;
  tool: 'select' | 'cut';
  snapping: boolean;
  sticky: boolean;
  showStrip: boolean;
  skim: boolean;
  audioScrub?: boolean;
  zoomPx: number;
  height?: number;
  copiedGrade?: ColorGrade;
  thumbs: Record<string, string[]>;
  waveforms: Record<string, WaveformData>;
  agentCursor?: AgentCursorState;
  onSetTool: (t: 'select' | 'cut') => void;
  onToggleSnap: () => void;
  onToggleSticky: () => void;
  onToggleStrip: () => void;
  onToggleSkim: () => void;
  onToggleAudioScrub?: () => void;
  onSetZoom: (z: number) => void;
  onZoomToFit: () => void;
  onSeek: (t: number) => void;
  onSkimTime?: (t: number | null) => void;
  onScrubAudio?: (t: number) => void;
  onSelectClips: (ids: string[]) => void;
  onMutate: (fn: (p: Project) => void, recordHistory?: boolean) => void;
  onSplitAtPlayhead: () => void;
  onDeleteSelected: (ripple: boolean) => void;
  onAddText: () => void;
  onAddMarker: () => void;
  onAutoEdit: () => void;
  onCloseAllGaps?: () => void;
  onEvenLevels?: () => void;
  onDropAsset?: (assetID: string, time: number, trackID?: string) => void;
  onCopyGrade?: (grade: ColorGrade) => void;
  onDuplicateClip?: (clipID: string) => void;
  onFreezeFrame?: (clipID: string) => void;
  onReverseClip?: (clipID: string) => void;
  onDetachAudio?: (clipID: string) => void;
}

const RULER_H = 26;
const VIDEO_LANE_H = 54;
const AUDIO_LANE_H = 44;
const LANE_GAP = 4;

function gainDbToRowY(gainDB: number, rowY: number, rowH: number): number {
  const clamped = Math.max(-48, Math.min(12, gainDB));
  const norm = (clamped + 48) / 60;
  return rowY + rowH - 6 - norm * Math.max(8, rowH - 12);
}

function rowYToGainDb(y: number, rowY: number, rowH: number): number {
  const span = Math.max(8, rowH - 12);
  const norm = Math.max(0, Math.min(1, (rowY + rowH - 6 - y) / span));
  return Math.round((norm * 60 - 48) * 10) / 10;
}

export const TimelinePanel: React.FC<TimelinePanelProps> = ({
  project,
  playhead,
  selectedIds,
  theme = 'dark',
  tool,
  snapping,
  sticky,
  showStrip,
  skim,
  audioScrub = false,
  zoomPx,
  height = 320,
  copiedGrade,
  thumbs,
  waveforms,
  agentCursor,
  onSetTool,
  onToggleSnap,
  onToggleSticky,
  onToggleStrip,
  onToggleSkim,
  onToggleAudioScrub,
  onSetZoom,
  onZoomToFit,
  onSeek,
  onSkimTime,
  onScrubAudio,
  onSelectClips,
  onMutate,
  onSplitAtPlayhead,
  onDeleteSelected,
  onAddText,
  onAddMarker,
  onAutoEdit,
  onCloseAllGaps,
  onEvenLevels,
  onDropAsset,
  onCopyGrade,
  onDuplicateClip,
  onFreezeFrame,
  onReverseClip,
  onDetachAudio,
}) => {
  const { L } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const [viewportW, setViewportW] = useState<number>(1100);
  const [hoverCursor, setHoverCursor] = useState<string>('default');
  const [skimX, setSkimX] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clip: Clip } | null>(null);
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);
  const [gainReadout, setGainReadout] = useState<{ x: number; y: number; db: number } | null>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setViewportW(Math.max(600, el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dragRef = useRef<{
    mode: 'scrub' | 'move' | 'trimL' | 'trimR' | 'trans' | 'fadeIn' | 'fadeOut' | 'gain' | 'marker' | 'rangeIn' | 'rangeOut' | 'marquee';
    clipID?: string;
    markerID?: string;
    dragIds?: string[];
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    additive?: boolean;
    initialSelected?: string[];
    origStart: number;
    origDuration: number;
    origTransDur?: number;
    origGainDB?: number;
    rowY?: number;
    rowH?: number;
    snapshot: Project;
  } | null>(null);

  const videoRows = [...project.videoTracks].reverse();
  const audioRows = project.audioTracks;
  const allRows: Array<{ track: Track; label: string; y: number; h: number }> = [];
  let curY = RULER_H + 4;
  for (let i = 0; i < videoRows.length; i++) {
    const idx = videoRows.length - i;
    allRows.push({ track: videoRows[i], label: `V${idx}`, y: curY, h: VIDEO_LANE_H });
    curY += VIDEO_LANE_H + LANE_GAP;
  }
  curY += 6;
  for (let i = 0; i < audioRows.length; i++) {
    allRows.push({ track: audioRows[i], label: `A${i + 1}`, y: curY, h: AUDIO_LANE_H });
    curY += AUDIO_LANE_H + LANE_GAP;
  }
  const latestDragHandlersRef = useRef({
    onMutate,
    onSeek,
    onSkimTime,
    onScrubAudio,
    onSelectClips,
    snapping,
    sticky,
    audioScrub,
    zoomPx,
    allRows,
  });
  latestDragHandlersRef.current = {
    onMutate,
    onSeek,
    onSkimTime,
    onScrubAudio,
    onSelectClips,
    snapping,
    sticky,
    audioScrub,
    zoomPx,
    allRows,
  };
  const totalH = Math.max(240, curY + 12);
  const maxDur = Math.max(20, projectDuration(project) + 8);
  const totalW = Math.max(viewportW, Math.ceil(maxDur * zoomPx));
  const rulerEndSec = Math.ceil(totalW / zoomPx);

  const getCachedImg = (src: string): HTMLImageElement | undefined => {
    let img = imgCacheRef.current.get(src);
    if (!img) {
      img = new Image();
      img.src = src;
      imgCacheRef.current.set(src, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : undefined;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = totalW * dpr;
    canvas.height = totalH * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const pal = THEMES[theme] ?? THEMES.dark;
    const colBg = pal.bg;
    const colLane = pal.lane;
    const colLaneAlt = pal.laneAlt;
    const colVideo = pal.video;
    const colAudio = pal.audio;
    const colStroke = pal.clipStroke;
    const colAccent = pal.accent;
    const colDim = pal.textDim;
    const colFaint = pal.textFaint;
    const isLight = pal.isLight;
    const colRulerLine = isLight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)';
    const colRulerTick = isLight ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.12)';
    const colGuide = isLight ? colAccent : '#FFFFFF';
    const colClipLabel = '#F2F2F0';
    ctx.lineWidth = 1;

    ctx.fillStyle = colBg;
    ctx.fillRect(0, 0, totalW, totalH);

    ctx.fillStyle = colLane;
    ctx.fillRect(0, 0, totalW, RULER_H);
    ctx.strokeStyle = colRulerLine;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H);
    ctx.lineTo(totalW, RULER_H);
    ctx.stroke();

    const stepSec = zoomPx >= 90 ? 1 : zoomPx >= 35 ? 2 : 5;
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
    ctx.textBaseline = 'top';
    for (let s = 0; s <= rulerEndSec; s += stepSec) {
      const x = Math.round(s * zoomPx) + 0.5;
      ctx.strokeStyle = colRulerTick;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 6);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillStyle = isLight ? colDim : colFaint;
      ctx.fillText(formatTimecode(s, project.fps, true), x + 4, 6);
    }

    if (project.playRange) {
      const x1 = project.playRange.in * zoomPx;
      const x2 = project.playRange.out * zoomPx;
      ctx.fillStyle = 'rgba(255, 74, 28, 0.08)';
      ctx.fillRect(x1, RULER_H, Math.max(2, x2 - x1), totalH - RULER_H);
      ctx.fillStyle = 'rgba(255, 74, 28, 0.45)';
      ctx.fillRect(x1, RULER_H - 4, Math.max(2, x2 - x1), 4);
    }

    allRows.forEach((row, idx) => {
      ctx.fillStyle = idx % 2 === 0 ? colLane : colLaneAlt;
      ctx.fillRect(0, row.y, totalW, row.h);
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.055)' : 'rgba(255,255,255,0.035)';
      ctx.beginPath();
      ctx.moveTo(0, row.y + row.h - 0.5);
      ctx.lineTo(totalW, row.y + row.h - 0.5);
      ctx.stroke();
    });

    for (const row of allRows) {
      const clips = project.clips.filter((c) => c.trackID === row.track.id);
      for (const clip of clips) {
        const x = clip.start * zoomPx;
        const w = Math.max(4, clip.duration * zoomPx);
        const y = row.y + 2;
        const h = row.h - 4;
        const isSel = selectedIds.includes(clip.id);
        const isAgentActive = agentCursor?.clipID === clip.id;

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 5);
        ctx.clip();

        ctx.fillStyle = clip.kind === 'audio' ? colAudio : colVideo;
        ctx.fillRect(x, y, w, h);

        if (showStrip && (clip.kind === 'video' || clip.kind === 'image')) {
          const strip = clip.assetID ? thumbs[clip.assetID] ?? [] : [];
          if (strip.length > 0) {
            const tileW = 46;
            const count = Math.max(1, Math.ceil(w / tileW));
            for (let ti = 0; ti < count; ti++) {
              const imgSrc = strip[Math.min(strip.length - 1, Math.floor((ti / count) * strip.length))];
              const img = getCachedImg(imgSrc);
              if (img) {
                ctx.globalAlpha = 0.72;
                ctx.drawImage(img, x + ti * tileW, y, tileW - 1, h);
              }
            }
            ctx.globalAlpha = 1;
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(x, y, w, 16);
          }
        } else if (clip.kind === 'solid') {
          ctx.fillStyle = `rgba(${Math.round((clip.color?.r ?? 0.2) * 255)},${Math.round((clip.color?.g ?? 0.2) * 255)},${Math.round((clip.color?.b ?? 0.25) * 255)},0.85)`;
          ctx.fillRect(x, y, w, h);
        } else if (clip.kind === 'text') {
          ctx.fillStyle = 'rgba(255, 74, 28, 0.14)';
          ctx.fillRect(x, y, w, h);
        }

        if (clip.kind === 'audio' && clip.assetID && waveforms[clip.assetID]) {
          const wf = waveforms[clip.assetID];
          const midY = y + h * 0.56;
          const ampMax = h * 0.36;
          ctx.fillStyle = 'rgba(242, 242, 240, 0.68)';
          const pxStep = 2;
          for (let px = 0; px < w; px += pxStep) {
            const tSec = (clip.sourceStart ?? 0) + (px / zoomPx) * (clip.speed ?? 1);
            const idxWf = Math.min(wf.peaks.length - 1, Math.max(0, Math.floor(tSec * wf.peaksPerSecond)));
            const peak = wf.peaks[idxWf] ?? 0;
            const barH = Math.max(1.5, peak * ampMax);
            ctx.fillRect(x + px, midY - barH, 1.5, barH * 2);
          }
        }

        if ((clip.fadeIn ?? 0) > 0) {
          const fw = Math.min(w, (clip.fadeIn ?? 0) * zoomPx);
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + fw, y);
          ctx.lineTo(x, y + h);
          ctx.closePath();
          ctx.fill();
        }
        if ((clip.fadeOut ?? 0) > 0) {
          const fw = Math.min(w, (clip.fadeOut ?? 0) * zoomPx);
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          ctx.beginPath();
          ctx.moveTo(x + w, y);
          ctx.lineTo(x + w - fw, y);
          ctx.lineTo(x + w, y + h);
          ctx.closePath();
          ctx.fill();
        }

        if (clip.transitionIn) {
          const tw = Math.min(w, clip.transitionIn.duration * zoomPx);
          ctx.fillStyle = 'rgba(255, 74, 28, 0.22)';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + tw, y);
          ctx.lineTo(x, y + h);
          ctx.closePath();
          ctx.fill();
          const hx = x + tw;
          ctx.strokeStyle = 'rgba(255, 74, 28, 0.85)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(hx, y + 1);
          ctx.lineTo(hx, y + 15);
          ctx.stroke();
          ctx.fillStyle = '#FF4A1C';
          ctx.beginPath();
          ctx.roundRect(hx - 3, y + 3, 6, 8, 2);
          ctx.fill();
        }

        if (clip.kind === 'audio') {
          const gy = gainDbToRowY(clip.gainDB ?? 0, y, h);
          ctx.strokeStyle = isSel ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.32)';
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(x + 2, gy);
          ctx.lineTo(x + w - 2, gy);
          ctx.stroke();
        }

        if (w > 24 && (isSel || (clip.fadeIn ?? 0) > 0 || (clip.fadeOut ?? 0) > 0)) {
          const fiX = x + Math.min(w * 0.45, Math.max(5, (clip.fadeIn ?? 0) * zoomPx));
          const foX = x + w - Math.min(w * 0.45, Math.max(5, (clip.fadeOut ?? 0) * zoomPx));
          ctx.fillStyle = '#FFFFFF';
          ctx.beginPath();
          ctx.arc(fiX, y + 6, 2.5, 0, Math.PI * 2);
          ctx.arc(foX, y + 6, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.font = '500 10px Inter, Segoe UI, sans-serif';
        ctx.fillStyle = colClipLabel;
        ctx.fillText(clipName(project, clip), x + 6, y + 4);

        const badges: string[] = [];
        if (clip.freeze) badges.push('FREEZE');
        else if (clip.ramp) badges.push('RAMP');
        else if (clip.speed && Math.abs(clip.speed - 1) > 0.01) badges.push(`${clip.speed.toFixed(1)}x`);
        if (clip.reversed) badges.push('REV');
        if (clip.transitionIn) badges.push(clip.transitionIn.kind === 'dipToBlack' ? 'DIP' : clip.transitionIn.kind.toUpperCase());
        if (badges.length > 0 && w > 54) {
          ctx.font = '600 9px "JetBrains Mono", Consolas, monospace';
          ctx.fillStyle = 'rgba(255, 74, 28, 0.9)';
          ctx.fillText(badges.join(' '), x + 6, y + h - 13);
        }
        ctx.restore();

        ctx.strokeStyle = isAgentActive ? '#30D158' : isSel ? (isLight ? colAccent : '#FFFFFF') : colStroke;
        ctx.lineWidth = isSel || isAgentActive ? 1.5 : 1;
        ctx.beginPath();
        ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 5);
        ctx.stroke();
      }
    }

    for (const m of project.markers ?? []) {
      const mx = m.time * zoomPx;
      ctx.fillStyle = MARKER_HEX[m.color ?? 'orange'];
      ctx.beginPath();
      ctx.arc(mx, RULER_H - 6, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (snapGuide !== null) {
      const sx = Math.round(snapGuide * zoomPx) + 0.5;
      ctx.strokeStyle = colGuide;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, RULER_H);
      ctx.lineTo(sx, totalH);
      ctx.stroke();
      ctx.fillStyle = colGuide;
      ctx.beginPath();
      ctx.arc(sx, RULER_H + 3, 2.5, 0, Math.PI * 2);
      ctx.arc(sx, totalH - 3, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const px = playhead * zoomPx;
    ctx.strokeStyle = colAccent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, RULER_H);
    ctx.lineTo(px, totalH);
    ctx.stroke();

    ctx.fillStyle = colAccent;
    ctx.beginPath();
    ctx.moveTo(px - 6, 2);
    ctx.lineTo(px + 6, 2);
    ctx.lineTo(px + 6, 12);
    ctx.lineTo(px, 18);
    ctx.lineTo(px - 6, 12);
    ctx.closePath();
    ctx.fill();

    const readout = formatTimecode(playhead, project.fps);
    ctx.fillStyle = colAccent;
    ctx.beginPath();
    ctx.roundRect(px + 8, 3, 74, 15, 3);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '600 10px "JetBrains Mono", Consolas, monospace';
    ctx.fillText(readout, px + 12, 5);

    if (marquee) {
      const mx = Math.min(marquee.x1, marquee.x2);
      const my = Math.min(marquee.y1, marquee.y2);
      const mw = Math.abs(marquee.x2 - marquee.x1);
      const mh = Math.abs(marquee.y2 - marquee.y1);
      ctx.fillStyle = 'rgba(255, 74, 28, 0.14)';
      ctx.fillRect(mx, my, mw, mh);
      ctx.strokeStyle = colAccent;
      ctx.lineWidth = 1;
      ctx.strokeRect(mx + 0.5, my + 0.5, Math.max(1, mw - 1), Math.max(1, mh - 1));
    }

    if (skim && skimX !== null) {
      const sx = Math.round(skimX) + 0.5;
      ctx.strokeStyle = isLight ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, RULER_H);
      ctx.lineTo(sx, totalH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [project, playhead, selectedIds, theme, zoomPx, showStrip, skim, skimX, thumbs, waveforms, snapGuide, agentCursor, marquee, totalW, totalH]);

  const hitTestClip = (
    x: number,
    y: number
  ): { clip: Clip; edge: 'body' | 'left' | 'right' | 'trans' | 'fadeIn' | 'fadeOut' | 'gain'; rowY: number; rowH: number } | undefined => {
    for (const row of allRows) {
      if (y < row.y || y > row.y + row.h) continue;
      const cy = row.y + 2;
      const ch = row.h - 4;
      for (const c of project.clips) {
        if (c.trackID !== row.track.id) continue;
        const cx = c.start * zoomPx;
        const cw = Math.max(4, c.duration * zoomPx);
        if (x >= cx && x <= cx + cw) {
          if (c.transitionIn) {
            const tw = Math.min(cw, c.transitionIn.duration * zoomPx);
            if (Math.abs(x - (cx + tw)) <= 6 && y <= row.y + 18) {
              return { clip: c, edge: 'trans', rowY: cy, rowH: ch };
            }
          }
          if (cw > 24 && Math.abs(y - (cy + 6)) <= 6) {
            const fiX = cx + Math.min(cw * 0.45, Math.max(5, (c.fadeIn ?? 0) * zoomPx));
            const foX = cx + cw - Math.min(cw * 0.45, Math.max(5, (c.fadeOut ?? 0) * zoomPx));
            if (Math.abs(x - fiX) <= 7) return { clip: c, edge: 'fadeIn', rowY: cy, rowH: ch };
            if (Math.abs(x - foX) <= 7) return { clip: c, edge: 'fadeOut', rowY: cy, rowH: ch };
          }
          if (x - cx <= 7) return { clip: c, edge: 'left', rowY: cy, rowH: ch };
          if (cx + cw - x <= 7) return { clip: c, edge: 'right', rowY: cy, rowH: ch };
          if (c.kind === 'audio') {
            const gy = gainDbToRowY(c.gainDB ?? 0, cy, ch);
            if (Math.abs(y - gy) <= 5) return { clip: c, edge: 'gain', rowY: cy, rowH: ch };
          }
          return { clip: c, edge: 'body', rowY: cy, rowH: ch };
        }
      }
    }
    return undefined;
  };

  const computeDragResult = (
    p: Project,
    drag: NonNullable<typeof dragRef.current>,
    x: number,
    y: number,
    useSnap: boolean,
    useSticky: boolean,
    pxPerSec: number,
    finalize: boolean
  ): number | null => {
    const dt = (x - drag.startX) / pxPerSec;
    const base = JSON.parse(JSON.stringify(drag.snapshot)) as Project;
    Object.assign(p, base);

    if (drag.mode === 'marker' && drag.markerID) {
      const m = (p.markers ?? []).find((mk) => mk.id === drag.markerID);
      if (m) m.time = snapFrame(Math.max(0, x / pxPerSec), p.fps);
      return null;
    }
    if ((drag.mode === 'rangeIn' || drag.mode === 'rangeOut') && p.playRange) {
      const t = snapFrame(Math.max(0, x / pxPerSec), p.fps);
      if (drag.mode === 'rangeIn') {
        p.playRange = { in: Math.min(p.playRange.out - 0.1, t), out: p.playRange.out };
      } else {
        p.playRange = { in: p.playRange.in, out: Math.max(p.playRange.in + 0.1, t) };
      }
      return null;
    }

    if (!drag.clipID) return null;
    const seedIds = drag.dragIds && drag.dragIds.length > 0 ? drag.dragIds : [drag.clipID];
    const group = linkedIds(p, seedIds);
    const primary = p.clips.find((c) => c.id === drag.clipID);
    if (!primary) return null;

    if (drag.mode === 'fadeIn') {
      const dur = Math.max(0, Math.min(primary.duration * 0.5, x / pxPerSec - primary.start));
      primary.fadeIn = Math.round(dur * 20) / 20;
      return null;
    }
    if (drag.mode === 'fadeOut') {
      const dur = Math.max(0, Math.min(primary.duration * 0.5, clipEnd(primary) - x / pxPerSec));
      primary.fadeOut = Math.round(dur * 20) / 20;
      return null;
    }
    if (drag.mode === 'gain' && drag.rowY !== undefined && drag.rowH !== undefined) {
      const db = rowYToGainDb(y, drag.rowY, drag.rowH);
      primary.gainDB = Math.abs(db) < 0.4 ? 0 : db;
      return null;
    }

    if (drag.mode === 'trans') {
      if (primary.transitionIn) {
        const maxDur = Math.max(0.1, Math.min(3, primary.duration));
        const nextDur = Math.round(Math.min(maxDur, Math.max(0.1, (drag.origTransDur ?? 0.5) + dt)) * 20) / 20;
        primary.transitionIn = { ...primary.transitionIn, duration: nextDur };
      }
      return null;
    }

    const snapPts = useSnap ? snapPoints(drag.snapshot, group) : [];
    const snapTol = 8 / pxPerSec;
    let snappedAt: number | null = null;
    const findSnap = (candidate: number): number => {
      for (const pt of snapPts) {
        if (Math.abs(candidate - pt) <= snapTol) {
          snappedAt = pt;
          return pt;
        }
      }
      return candidate;
    };

    if (drag.mode === 'move') {
      let nextStart = Math.max(0, drag.origStart + dt);
      if (useSnap) {
        const sHead = findSnap(nextStart);
        if (snappedAt !== null) nextStart = sHead;
        else {
          const sTail = findSnap(nextStart + drag.origDuration);
          if (snappedAt !== null) nextStart = sTail - drag.origDuration;
        }
      }
      const delta = snapFrame(nextStart, p.fps) - drag.origStart;
      for (const c of p.clips) {
        if (group.has(c.id)) c.start = Math.max(0, snapFrame(c.start + delta, p.fps));
      }
    } else if (drag.mode === 'trimL') {
      const [lo, hi] = trimLimits(p, primary, true, group);
      let d = Math.min(hi, Math.max(lo, dt));
      if (useSnap) {
        const target = findSnap(drag.origStart + d);
        if (snappedAt !== null) d = Math.min(hi, Math.max(lo, target - drag.origStart));
      }
      for (const c of p.clips) {
        if (group.has(c.id)) trimClipHead(c, snapFrame(drag.origStart + d, p.fps));
      }
    } else if (drag.mode === 'trimR') {
      const [lo, hi] = trimLimits(p, primary, false, group);
      let d = Math.min(hi, Math.max(lo, dt));
      const origEnd = drag.origStart + drag.origDuration;
      if (useSnap) {
        const target = findSnap(origEnd + d);
        if (snappedAt !== null) d = Math.min(hi, Math.max(lo, target - origEnd));
      }
      const newEnd = snapFrame(origEnd + d, p.fps);
      const edgeDelta = newEnd - origEnd;
      const trackIDs = new Set<string>();
      for (const c of p.clips) {
        if (group.has(c.id)) {
          trackIDs.add(c.trackID);
          trimClipTail(c, newEnd);
        }
      }
      if (useSticky && Math.abs(edgeDelta) > 1e-4) {
        applyStickyEdgeShift(p, group, trackIDs, origEnd, edgeDelta);
      }
    }
    if (finalize) resolveOverlaps(p, group);
    return snappedAt;
  };

  useEffect(() => {
    const onWinMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      const canvas = canvasRef.current;
      if (!drag || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const {
        onMutate: mutateFn,
        onSeek: seekFn,
        onSkimTime: skimFn,
        onScrubAudio: scrubAudioFn,
        onSelectClips: selectFn,
        snapping: useSnap,
        sticky: useSticky,
        audioScrub: useAudioScrub,
        zoomPx: pxPerSec,
        allRows: rows,
      } = latestDragHandlersRef.current;
      if (Math.hypot(x - drag.startX, y - drag.startY) > 3) drag.moved = true;
      drag.lastX = x;
      drag.lastY = y;

      if (drag.mode === 'scrub') {
        const targetT = Math.max(0, x / pxPerSec);
        seekFn(targetT);
        if (useAudioScrub) scrubAudioFn?.(targetT);
        return;
      }
      if (drag.mode === 'marker' || drag.mode === 'rangeIn' || drag.mode === 'rangeOut') {
        mutateFn((p) => {
          computeDragResult(p, drag, x, y, useSnap, useSticky, pxPerSec, false);
        }, false);
        return;
      }
      if (drag.mode === 'marquee') {
        if (!drag.moved) return;
        const x1 = Math.max(0, Math.min(drag.startX, x));
        const x2 = Math.max(0, Math.max(drag.startX, x));
        const y1 = Math.max(RULER_H, Math.min(drag.startY, y));
        const y2 = Math.max(RULER_H, Math.max(drag.startY, y));
        setMarquee({ x1, y1, x2, y2 });
        const hits: string[] = [];
        for (const row of rows) {
          if (row.y + row.h < y1 || row.y > y2) continue;
          for (const c of drag.snapshot.clips) {
            if (c.trackID !== row.track.id) continue;
            const cx1 = c.start * pxPerSec;
            const cx2 = cx1 + Math.max(4, c.duration * pxPerSec);
            if (cx2 >= x1 && cx1 <= x2) hits.push(c.id);
          }
        }
        const baseSel = drag.additive ? drag.initialSelected ?? [] : [];
        selectFn([...new Set([...baseSel, ...hits])]);
        return;
      }
      if (!drag.clipID) return;
      let snappedAt: number | null = null;
      let trimPreviewTime: number | null = null;
      mutateFn((p) => {
        snappedAt = computeDragResult(p, drag, x, y, useSnap, useSticky, pxPerSec, false);
        const primary = p.clips.find((c) => c.id === drag.clipID);
        if (drag.mode === 'gain' && primary) {
          setGainReadout({ x: ev.clientX, y: ev.clientY, db: primary.gainDB ?? 0 });
        }
        if (primary && drag.mode === 'trimL') trimPreviewTime = primary.start + 0.01;
        else if (primary && drag.mode === 'trimR') trimPreviewTime = Math.max(primary.start, clipEnd(primary) - 0.02);
      }, false);
      setSnapGuide(snappedAt);
      if (trimPreviewTime !== null) skimFn?.(trimPreviewTime);
    };

    const onWinUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setSnapGuide(null);
      setMarquee(null);
      setGainReadout(null);
      setHoverCursor(tool === 'cut' ? 'crosshair' : 'default');
      const { onMutate: mutateFn, onSeek: seekFn, onSkimTime: skimFn, onSelectClips: selectFn, snapping: useSnap, sticky: useSticky, zoomPx: pxPerSec } =
        latestDragHandlersRef.current;
      skimFn?.(null);
      if (drag.mode === 'marquee') {
        if (!drag.moved) {
          if (!drag.additive) selectFn([]);
          seekFn(Math.max(0, drag.startX / pxPerSec));
        }
        return;
      }
      if (drag.mode === 'marker' && drag.markerID && !drag.moved) {
        setEditingMarkerId(drag.markerID);
        return;
      }
      if (drag.mode !== 'scrub' && (drag.clipID || drag.markerID || drag.mode === 'rangeIn' || drag.mode === 'rangeOut') && drag.moved) {
        mutateFn((p) => {
          Object.assign(p, JSON.parse(JSON.stringify(drag.snapshot)) as Project);
        }, false);
        mutateFn((p) => {
          computeDragResult(p, drag, drag.lastX, drag.lastY, useSnap, useSticky, pxPerSec, true);
        }, true);
      }
    };

    window.addEventListener('mousemove', onWinMove);
    window.addEventListener('mouseup', onWinUp);
    return () => {
      window.removeEventListener('mousemove', onWinMove);
      window.removeEventListener('mouseup', onWinUp);
    };
  }, [tool]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setContextMenu(null);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = Math.max(0, x / zoomPx);

    if (e.button === 2) {
      const hitCtx = hitTestClip(x, y);
      if (hitCtx) {
        if (!selectedIds.includes(hitCtx.clip.id)) {
          onSelectClips([hitCtx.clip.id]);
        }
        setContextMenu({ x: e.clientX, y: e.clientY, clip: hitCtx.clip });
      }
      return;
    }

    if (y <= RULER_H) {
      const hitMarker = (project.markers ?? []).find((m) => Math.abs(m.time * zoomPx - x) <= 7);
      if (hitMarker) {
        onSeek(hitMarker.time);
        dragRef.current = {
          mode: 'marker',
          markerID: hitMarker.id,
          startX: x,
          startY: y,
          lastX: x,
          lastY: y,
          moved: false,
          origStart: hitMarker.time,
          origDuration: 0,
          snapshot: JSON.parse(JSON.stringify(project)) as Project,
        };
        return;
      }
      if (project.playRange) {
        const inX = project.playRange.in * zoomPx;
        const outX = project.playRange.out * zoomPx;
        if (Math.abs(x - inX) <= 6 || Math.abs(x - outX) <= 6) {
          const isIn = Math.abs(x - inX) <= Math.abs(x - outX);
          dragRef.current = {
            mode: isIn ? 'rangeIn' : 'rangeOut',
            startX: x,
            startY: y,
            lastX: x,
            lastY: y,
            moved: false,
            origStart: isIn ? project.playRange.in : project.playRange.out,
            origDuration: 0,
            snapshot: JSON.parse(JSON.stringify(project)) as Project,
          };
          return;
        }
      }
      setEditingMarkerId(null);
      onSeek(time);
      dragRef.current = {
        mode: 'scrub',
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        moved: false,
        origStart: time,
        origDuration: 0,
        snapshot: project,
      };
      return;
    }
    setEditingMarkerId(null);

    const hit = hitTestClip(x, y);
    if (!hit) {
      dragRef.current = {
        mode: 'marquee',
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        moved: false,
        additive: e.shiftKey,
        initialSelected: [...selectedIds],
        origStart: time,
        origDuration: 0,
        snapshot: project,
      };
      return;
    }

    const hitRow = allRows.find((r) => r.track.id === hit.clip.trackID);
    if (hitRow?.track.locked) {
      onSelectClips([hit.clip.id]);
      return;
    }

    if (tool === 'cut') {
      onMutate((p) => {
        const group = [...linkedIds(p, [hit.clip.id])];
        const tSnap = snapFrame(time, p.fps);
        for (const id of group) {
          const idx = p.clips.findIndex((c) => c.id === id);
          if (idx < 0) continue;
          const orig = p.clips[idx];
          if (tSnap <= orig.start + 0.05 || tSnap >= clipEnd(orig) - 0.05) continue;
          const right = JSON.parse(JSON.stringify(orig)) as Clip;
          right.id = crypto.randomUUID();
          right.fadeIn = 0;
          trimClipHead(right, tSnap);
          orig.fadeOut = 0;
          trimClipTail(orig, tSnap);
          p.clips.push(right);
        }
      });
      return;
    }

    let nextSelected = [hit.clip.id];
    if (e.shiftKey) {
      nextSelected = selectedIds.includes(hit.clip.id)
        ? selectedIds.filter((id) => id !== hit.clip.id)
        : [...selectedIds, hit.clip.id];
      onSelectClips(nextSelected);
    } else if (selectedIds.includes(hit.clip.id)) {
      nextSelected = selectedIds;
    } else {
      onSelectClips(nextSelected);
    }
    const snapProj = JSON.parse(JSON.stringify(project)) as Project;
    let activeClipId = hit.clip.id;
    let activeDragIds = hit.edge === 'body' ? nextSelected : [hit.clip.id];
    if (hit.edge === 'body' && e.altKey) {
      const dupGroup = linkedIds(snapProj, nextSelected);
      const linkRemap = new Map<string, string>();
      const newIds: string[] = [];
      for (const orig of [...snapProj.clips]) {
        if (!dupGroup.has(orig.id)) continue;
        const copy = JSON.parse(JSON.stringify(orig)) as Clip;
        copy.id = newId();
        if (copy.linkID) {
          if (!linkRemap.has(copy.linkID)) linkRemap.set(copy.linkID, newId());
          copy.linkID = linkRemap.get(copy.linkID);
        }
        snapProj.clips.push(copy);
        newIds.push(copy.id);
        if (orig.id === hit.clip.id) activeClipId = copy.id;
      }
      activeDragIds = newIds;
      onSelectClips(newIds);
    }

    dragRef.current = {
      mode:
        hit.edge === 'trans'
          ? 'trans'
          : hit.edge === 'fadeIn'
          ? 'fadeIn'
          : hit.edge === 'fadeOut'
          ? 'fadeOut'
          : hit.edge === 'gain'
          ? 'gain'
          : hit.edge === 'left'
          ? 'trimL'
          : hit.edge === 'right'
          ? 'trimR'
          : 'move',
      clipID: activeClipId,
      dragIds: activeDragIds,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      moved: false,
      origStart: hit.clip.start,
      origDuration: hit.clip.duration,
      origTransDur: hit.clip.transitionIn?.duration,
      origGainDB: hit.clip.gainDB ?? 0,
      rowY: hit.rowY,
      rowH: hit.rowH,
      snapshot: snapProj,
    };
    setHoverCursor(
      hit.edge === 'gain'
        ? 'ns-resize'
        : hit.edge === 'body'
        ? 'grabbing'
        : hit.edge === 'trans' || hit.edge === 'fadeIn' || hit.edge === 'fadeOut'
        ? 'ew-resize'
        : 'ew-resize'
    );
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (skim) {
      setSkimX(x);
      const skimT = Math.max(0, x / zoomPx);
      onSkimTime?.(skimT);
      if (audioScrub) onScrubAudio?.(skimT);
    } else if (skimX !== null) {
      setSkimX(null);
      onSkimTime?.(null);
    }
    if (tool === 'cut') {
      setHoverCursor('crosshair');
      return;
    }
    const hit = y > RULER_H ? hitTestClip(x, y) : undefined;
    if (!hit) setHoverCursor('default');
    else
      setHoverCursor(
        hit.edge === 'gain'
          ? 'ns-resize'
          : hit.edge === 'body'
          ? 'grab'
          : hit.edge === 'trans'
          ? 'col-resize'
          : 'ew-resize'
      );
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = scroller.getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      const anchorTime = (scroller.scrollLeft + pointerX) / zoomPx;
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const nextZoom = Math.min(240, Math.max(12, Math.round(zoomPx * factor)));
      onSetZoom(nextZoom);
      requestAnimationFrame(() => {
        if (scrollerRef.current) {
          scrollerRef.current.scrollLeft = Math.max(0, anchorTime * nextZoom - pointerX);
        }
      });
    } else if (e.shiftKey && Math.abs(e.deltaY) > 0) {
      e.preventDefault();
      scroller.scrollLeft += e.deltaY;
    }
  };

  const toggleTrackProp = (trackID: string, key: 'hidden' | 'muted' | 'solo' | 'locked') => {
    onMutate((p) => {
      const t = [...p.videoTracks, ...p.audioTracks].find((x) => x.id === trackID);
      if (t) t[key] = !t[key];
    });
  };

  const activeMarker = editingMarkerId
    ? (project.markers ?? []).find((m) => m.id === editingMarkerId)
    : undefined;

  return (
    <div
      className="flex flex-col shrink-0 relative"
      style={{ height, background: 'var(--panel)' }}
    >
      <div
        className="flex items-center justify-between px-3 h-9 shrink-0"
        style={{ borderBottom: '1px solid var(--stroke)' }}
      >
        <div className="flex items-center gap-1">
          <button
            onClick={() => onSetTool('select')}
            className="vt-hover inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
            style={{
              background: tool === 'select' ? 'var(--raised)' : 'transparent',
              color: tool === 'select' ? 'var(--text)' : 'var(--text-dim)',
            }}
            title={L('选择工具 (V)', 'Select Tool (V)')}
          >
            <MousePointer size={12} strokeWidth={1.5} /> {L('选择', 'Select')}
          </button>
          <button
            onClick={() => onSetTool('cut')}
            className="vt-hover inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
            style={{
              background: tool === 'cut' ? 'var(--raised)' : 'transparent',
              color: tool === 'cut' ? 'var(--accent)' : 'var(--text-dim)',
            }}
            title={L('剃刀分割工具 (C)', 'Blade / Cut Tool (C)')}
          >
            <Scissors size={12} strokeWidth={1.5} /> {L('分割', 'Cut')}
          </button>
          <div className="h-3.5 w-px mx-1" style={{ background: 'var(--stroke)' }} />
          <button
            onClick={onSplitAtPlayhead}
            className="vt-hover px-2 py-1 rounded text-[11px] transition-colors"
            style={{ color: 'var(--text-dim)' }}
            title={L('在播放头分割 (Ctrl+K)', 'Split at Playhead (Ctrl+K)')}
          >
            {L('切断', 'Split')}
          </button>
          <button
            onClick={() => onDeleteSelected(false)}
            className="vt-hover p-1.5 rounded transition-colors"
            style={{ color: selectedIds.length ? 'var(--text)' : 'var(--text-faint)' }}
            title={L('删除选中 (Del)', 'Delete (Del)')}
          >
            <Trash2 size={13} strokeWidth={1.5} />
          </button>
          <button
            onClick={onAddText}
            className="vt-hover inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
            style={{ color: 'var(--text-dim)' }}
            title={L('添加文字 (Ctrl+T)', 'Add Title (Ctrl+T)')}
          >
            <Type size={12} strokeWidth={1.5} /> {L('文字', 'Text')}
          </button>
          <button
            onClick={onAddMarker}
            className="vt-hover p-1.5 rounded transition-colors"
            style={{ color: 'var(--text-dim)' }}
            title={L('添加标记 (M)', 'Add Marker (M)')}
          >
            <Bookmark size={13} strokeWidth={1.5} />
          </button>
          <button
            onClick={onAutoEdit}
            className="vt-hover inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
            style={{ color: 'var(--text-dim)' }}
            title={L('智能一键剪辑', 'Auto Edit Montage')}
          >
            <Sparkles size={12} style={{ color: 'var(--accent)' }} /> {L('一键剪辑', 'Auto Edit')}
          </button>
        </div>

        <div className="flex items-center gap-2">
          {agentCursor && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-medium"
              style={{ background: 'rgba(48, 209, 88, 0.14)', color: '#30D158' }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#30D158]" />
              {agentCursor.name}
              {agentCursor.activity ? ` · ${agentCursor.activity}` : ''}
            </div>
          )}
          {project.playRange && (
            <div
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]"
              style={{ background: 'var(--raised)', border: '1px solid var(--stroke)', color: 'var(--text-dim)' }}
            >
              <button
                onClick={() => onSeek(project.playRange!.in)}
                className="mono-num hover:underline"
                title="Go to In (I)"
              >
                In {formatTimecode(project.playRange.in, project.fps, true)}
              </button>
              <span>–</span>
              <button
                onClick={() => onSeek(project.playRange!.out)}
                className="mono-num hover:underline"
                title="Go to Out (O)"
              >
                Out {formatTimecode(project.playRange.out, project.fps, true)}
              </button>
              <button
                onClick={() =>
                  onMutate((p) => {
                    delete p.playRange;
                  })
                }
                className="ml-0.5 hover:opacity-80"
                title="Clear In / Out (Alt+X)"
              >
                <X size={10} />
              </button>
            </div>
          )}
          <button
            onClick={onToggleStrip}
            className="vt-hover inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
            style={{
              background: showStrip ? 'var(--raised)' : 'transparent',
              color: showStrip ? 'var(--text)' : 'var(--text-faint)',
            }}
            title={L('胶片缩略图 (Shift+T)', 'Filmstrip Thumbnails (Shift+T)')}
          >
            <Film size={12} strokeWidth={1.5} /> {L('缩略图', 'Strip')}
          </button>
          <button
            onClick={onToggleSnap}
            className="vt-hover inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
            style={{
              background: snapping ? 'var(--raised)' : 'transparent',
              color: snapping ? 'var(--text)' : 'var(--text-faint)',
            }}
            title={L('磁性吸附 (N)', 'Snapping (N)')}
          >
            <Magnet size={12} strokeWidth={1.5} /> {L('吸附', 'Snap')}
          </button>
          <button
            onClick={onToggleSticky}
            className="vt-hover inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
            style={{
              background: sticky ? 'var(--raised)' : 'transparent',
              color: sticky ? 'var(--text)' : 'var(--text-faint)',
            }}
            title={L('波纹跟随 (R)：裁剪边缘时自动平移后续片段', 'Sticky Edges (R): move downstream clips when trimming')}
          >
            <Link2 size={12} strokeWidth={1.5} /> {L('波纹', 'Sticky')}
          </button>
          <button
            onClick={onToggleSkim}
            className="vt-hover inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
            style={{
              background: skim ? 'var(--raised)' : 'transparent',
              color: skim ? 'var(--accent)' : 'var(--text-faint)',
            }}
            title={L('悬停预览 (Y)：鼠标划过时间线实时看帧', 'Skimming (Y): hover timeline to preview frames')}
          >
            <Compass size={12} strokeWidth={1.5} /> {L('掠览', 'Skim')}
          </button>
          {onToggleAudioScrub && (
            <button
              onClick={onToggleAudioScrub}
              className="vt-hover inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
              style={{
                background: audioScrub ? 'var(--raised)' : 'transparent',
                color: audioScrub ? 'var(--text)' : 'var(--text-faint)',
              }}
              title={L('音频擦洗 (Shift+S)：拖动时同步听声', 'Audio Scrubbing (Shift+S): hear sound while scrubbing or skimming')}
            >
              <Volume2 size={12} strokeWidth={1.5} /> {L('声音', 'Audio')}
            </button>
          )}
          <button
            onClick={() => onSetZoom(Math.max(12, zoomPx * 0.8))}
            className="vt-hover p-1 rounded transition-colors"
            style={{ color: 'var(--text-dim)' }}
            title={L('缩小时间线 (-)', 'Zoom Out (-)')}
          >
            <ZoomOut size={13} />
          </button>
          <button
            onClick={() => onSetZoom(Math.min(240, zoomPx * 1.25))}
            className="vt-hover p-1 rounded transition-colors"
            style={{ color: 'var(--text-dim)' }}
            title={L('放大时间线 (+)', 'Zoom In (+)')}
          >
            <ZoomIn size={13} />
          </button>
          <button
            onClick={onZoomToFit}
            className="vt-hover p-1 rounded transition-colors"
            style={{ color: 'var(--text-dim)' }}
            title={L('适应全长 (Shift+Z)', 'Zoom to Fit (Shift+Z)')}
          >
            <Maximize2 size={12} />
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div
          className="w-24 shrink-0 overflow-hidden"
          style={{ background: 'var(--panel)', borderRight: '1px solid var(--stroke)' }}
        >
          <div
            className="flex items-center justify-between px-2 text-[10px]"
            style={{ height: RULER_H, borderBottom: '1px solid var(--stroke)', color: 'var(--text-faint)' }}
          >
            <span>{L('轨道', 'TRACKS')}</span>
            <button
              onClick={() =>
                onMutate((p) => {
                  p.videoTracks.push({ id: crypto.randomUUID(), kind: 'video' });
                })
              }
              title={L('新增视频轨', 'Add Video Track')}
            >
              <Plus size={11} />
            </button>
          </div>
          {allRows.map((row) => (
            <div
              key={row.track.id}
              className="flex items-center justify-between px-2"
              style={{ height: row.h + LANE_GAP }}
            >
              <span className="mono-num text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>
                {row.label}
              </span>
              <div className="flex items-center gap-1">
                {row.track.kind === 'video' ? (
                  <button
                    onClick={() => toggleTrackProp(row.track.id, 'hidden')}
                    style={{ color: row.track.hidden ? 'var(--accent)' : 'var(--text-faint)' }}
                  >
                    {row.track.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => toggleTrackProp(row.track.id, 'muted')}
                      className="text-[10px] font-semibold px-1 rounded"
                      style={{
                        background: row.track.muted ? 'var(--accent)' : 'transparent',
                        color: row.track.muted ? '#FFF' : 'var(--text-faint)',
                      }}
                    >
                      M
                    </button>
                    <button
                      onClick={() => toggleTrackProp(row.track.id, 'solo')}
                      className="text-[10px] font-semibold px-1 rounded"
                      style={{
                        background: row.track.solo ? 'var(--text)' : 'transparent',
                        color: row.track.solo ? 'var(--on-text)' : 'var(--text-faint)',
                      }}
                    >
                      S
                    </button>
                  </>
                )}
                <button
                  onClick={() => toggleTrackProp(row.track.id, 'locked')}
                  style={{ color: row.track.locked ? 'var(--accent)' : 'var(--text-faint)' }}
                >
                  {row.track.locked ? <Lock size={10} /> : <Unlock size={10} />}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div
          ref={scrollerRef}
          data-magic-anchor="timeline-canvas"
          data-magic-zoom={zoomPx}
          className="flex-1 overflow-auto"
          onWheel={handleWheel}
          onDragOver={(e) => {
            if (
              e.dataTransfer.types.includes('application/x-vectrail-asset') ||
              e.dataTransfer.types.includes('application/x-editroom-asset')
            ) {
              e.preventDefault();
            }
          }}
          onDrop={(e) => {
            const assetID =
              e.dataTransfer.getData('application/x-vectrail-asset') ||
              e.dataTransfer.getData('application/x-editroom-asset');
            if (!assetID || !onDropAsset || !canvasRef.current) return;
            e.preventDefault();
            const rect = canvasRef.current.getBoundingClientRect();
            const x = Math.max(0, e.clientX - rect.left);
            const y = e.clientY - rect.top;
            const row = allRows.find((r) => y >= r.y && y <= r.y + r.h);
            onDropAsset(assetID, snapFrame(x / zoomPx, project.fps), row?.track.id);
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: totalW, height: totalH, display: 'block', cursor: hoverCursor }}
            onContextMenu={(e) => e.preventDefault()}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => {
              if (skimX !== null) setSkimX(null);
              onSkimTime?.(null);
            }}
          />
        </div>
      </div>

      {activeMarker && (
        <div
          className="absolute top-9 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-1.5 rounded-lg shadow-xl text-[11px]"
          style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
        >
          <span className="mono-num text-[10px]" style={{ color: 'var(--text-dim)' }}>
            {formatTimecode(activeMarker.time, project.fps)}
          </span>
          <input
            value={activeMarker.name}
            onChange={(e) =>
              onMutate((p) => {
                const m = p.markers?.find((x) => x.id === activeMarker.id);
                if (m) m.name = e.target.value;
              })
            }
            className="w-32 px-2 py-0.5 rounded text-[11px] outline-none"
            style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
          />
          <div className="flex items-center gap-1">
            {(Object.keys(MARKER_HEX) as MarkerTint[]).map((tint) => (
              <button
                key={tint}
                onClick={() =>
                  onMutate((p) => {
                    const m = p.markers?.find((x) => x.id === activeMarker.id);
                    if (m) m.color = tint;
                  })
                }
                className="w-3 h-3 rounded-full"
                style={{
                  background: MARKER_HEX[tint],
                  outline: (activeMarker.color ?? 'orange') === tint ? '2px solid var(--text)' : 'none',
                }}
                title={tint}
              />
            ))}
          </div>
          <button
            onClick={() => {
              onMutate((p) => {
                p.markers = (p.markers ?? []).filter((x) => x.id !== activeMarker.id);
              });
              setEditingMarkerId(null);
            }}
            className="px-1.5 py-0.5 rounded text-[10px]"
            style={{ background: 'var(--button)', color: '#FF453A' }}
          >
            {L('删除', 'Delete')}
          </button>
          <button
            onClick={() => setEditingMarkerId(null)}
            className="px-1.5 py-0.5 rounded text-[10px]"
            style={{ color: 'var(--text-dim)' }}
          >
            {L('完成', 'Done')}
          </button>
        </div>
      )}

      {gainReadout && (
        <div
          className="fixed z-50 pointer-events-none mono-num px-2 py-0.5 rounded text-[10px] font-semibold shadow-lg"
          style={{
            left: gainReadout.x + 10,
            top: gainReadout.y - 24,
            background: 'var(--sheet)',
            color: 'var(--text)',
            border: '1px solid var(--stroke)',
          }}
        >
          {gainReadout.db > 0 ? `+${gainReadout.db.toFixed(1)}` : gainReadout.db.toFixed(1)} dB
        </div>
      )}

      {contextMenu && (
        <div
          className="fixed z-50 w-44 rounded-lg py-1 shadow-2xl text-[11px]"
          style={{
            left: Math.min(window.innerWidth - 190, contextMenu.x),
            top: Math.min(window.innerHeight - 280, contextMenu.y),
            background: 'var(--sheet)',
            border: '1px solid var(--sheet-field-stroke)',
          }}
          onMouseLeave={() => setContextMenu(null)}
        >
          {[
            {
              label: L('在播放头分割', 'Split at Playhead'),
              action: () => onSplitAtPlayhead(),
            },
            {
              label: L('复制副本', 'Duplicate'),
              action: () => onDuplicateClip?.(contextMenu.clip.id),
            },
            ...(onEvenLevels
              ? [{ label: L('均衡所有音量', 'Even Out Audio Levels'), action: () => onEvenLevels() }]
              : []),
            ...(onCloseAllGaps
              ? [{ label: L('消除全部间隙', 'Close All Gaps'), action: () => onCloseAllGaps() }]
              : []),
            ...(contextMenu.clip.kind !== 'audio'
              ? [
                  {
                    label: L('复制调色', 'Copy Grade'),
                    action: () => onCopyGrade?.(contextMenu.clip.grade ?? {}),
                  },
                  ...(copiedGrade
                    ? [
                        {
                          label: L('粘贴调色', 'Paste Grade'),
                          action: () =>
                            onMutate((p) => {
                              const c = p.clips.find((x) => x.id === contextMenu.clip.id);
                              if (c) c.grade = JSON.parse(JSON.stringify(copiedGrade)) as ColorGrade;
                            }),
                        },
                      ]
                    : []),
                  {
                    label: L('定格画面 (2秒)', 'Freeze Frame (2s)'),
                    action: () => onFreezeFrame?.(contextMenu.clip.id),
                  },
                  ...((
                    [
                      { kind: 'dissolve', label: L('入场叠化 (0.5s)', 'Dissolve In (0.5s)') },
                      { kind: 'dipToBlack', label: L('黑场过渡 (0.5s)', 'Dip to Black (0.5s)') },
                      { kind: 'wipe', label: L('擦除转场 (0.5s)', 'Wipe In (0.5s)') },
                    ] as Array<{ kind: TransitionKind; label: string }>
                  ).map((tr) => ({
                    label: tr.label,
                    action: () =>
                      onMutate((p) => {
                        const c = p.clips.find((x) => x.id === contextMenu.clip.id);
                        if (c) c.transitionIn = { kind: tr.kind, duration: Math.min(0.5, c.duration) };
                      }),
                  }))),
                  ...(contextMenu.clip.transitionIn
                    ? [
                        {
                          label: L('移除转场', 'Remove Transition'),
                          action: () =>
                            onMutate((p) => {
                              const c = p.clips.find((x) => x.id === contextMenu.clip.id);
                              if (c) delete c.transitionIn;
                            }),
                        },
                      ]
                    : []),
                ]
              : []),
            {
              label: contextMenu.clip.reversed ? L('取消倒放', 'Un-reverse') : L('倒放片段', 'Reverse Clip'),
              action: () => onReverseClip?.(contextMenu.clip.id),
            },
            ...(contextMenu.clip.linkID
              ? [
                  {
                    label: L('分离音画', 'Detach Audio'),
                    action: () => onDetachAudio?.(contextMenu.clip.id),
                  },
                ]
              : []),
            {
              label: L('删除', 'Delete'),
              danger: true,
              action: () => onDeleteSelected(false),
            },
            {
              label: L('波纹删除', 'Ripple Delete'),
              danger: true,
              action: () => onDeleteSelected(true),
            },
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => {
                item.action();
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 vt-hover"
              style={{
                color: item.danger ? '#FF453A' : 'var(--text)',
                background: 'transparent',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
