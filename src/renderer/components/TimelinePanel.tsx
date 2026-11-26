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
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AgentCursorState, Clip, ColorGrade, MarkerTint, Project, Track, TransitionKind } from '../../shared/types';
import { WaveformData } from '../../main/engine/ffmpeg';
import {
  applyStickyEdgeShift,
  clipEnd,
  clipName,
  formatTimecode,
  linkedIds,
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
  tool: 'select' | 'cut';
  snapping: boolean;
  sticky: boolean;
  showStrip: boolean;
  skim: boolean;
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
  onSetZoom: (z: number) => void;
  onZoomToFit: () => void;
  onSeek: (t: number) => void;
  onSkimTime?: (t: number | null) => void;
  onSelectClips: (ids: string[]) => void;
  onMutate: (fn: (p: Project) => void, recordHistory?: boolean) => void;
  onSplitAtPlayhead: () => void;
  onDeleteSelected: (ripple: boolean) => void;
  onAddText: () => void;
  onAddMarker: () => void;
  onAutoEdit: () => void;
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

export const TimelinePanel: React.FC<TimelinePanelProps> = ({
  project,
  playhead,
  selectedIds,
  tool,
  snapping,
  sticky,
  showStrip,
  skim,
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
  onSetZoom,
  onZoomToFit,
  onSeek,
  onSkimTime,
  onSelectClips,
  onMutate,
  onSplitAtPlayhead,
  onDeleteSelected,
  onAddText,
  onAddMarker,
  onAutoEdit,
  onDropAsset,
  onCopyGrade,
  onDuplicateClip,
  onFreezeFrame,
  onReverseClip,
  onDetachAudio,
}) => {
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
    mode: 'scrub' | 'move' | 'trimL' | 'trimR' | 'trans' | 'marquee';
    clipID?: string;
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
  const latestDragHandlersRef = useRef({ onMutate, onSeek, onSkimTime, onSelectClips, snapping, sticky, zoomPx, allRows });
  latestDragHandlersRef.current = { onMutate, onSeek, onSkimTime, onSelectClips, snapping, sticky, zoomPx, allRows };
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

    const styles = getComputedStyle(document.documentElement);
    const colBg = styles.getPropertyValue('--bg').trim() || '#0A0A0A';
    const colLane = styles.getPropertyValue('--lane').trim() || '#0D0D0D';
    const colLaneAlt = styles.getPropertyValue('--lane-alt').trim() || '#0A0A0A';
    const colVideo = styles.getPropertyValue('--video').trim() || '#1E1E1E';
    const colAudio = styles.getPropertyValue('--audio').trim() || '#151515';
    const colStroke = styles.getPropertyValue('--clip-stroke').trim() || '#2C2C2C';
    const colAccent = styles.getPropertyValue('--accent').trim() || '#FF4A1C';
    const colText = styles.getPropertyValue('--text').trim() || '#F2F2F0';
    const colFaint = styles.getPropertyValue('--text-faint').trim() || '#5C5C59';

    ctx.fillStyle = colBg;
    ctx.fillRect(0, 0, totalW, totalH);

    ctx.fillStyle = colLane;
    ctx.fillRect(0, 0, totalW, RULER_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H);
    ctx.lineTo(totalW, RULER_H);
    ctx.stroke();

    const stepSec = zoomPx >= 90 ? 1 : zoomPx >= 35 ? 2 : 5;
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
    ctx.textBaseline = 'top';
    for (let s = 0; s <= rulerEndSec; s += stepSec) {
      const x = Math.round(s * zoomPx) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 6);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillStyle = colFaint;
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

        ctx.font = '500 10px Inter, Segoe UI, sans-serif';
        ctx.fillStyle = colText;
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

        ctx.strokeStyle = isAgentActive ? '#30D158' : isSel ? '#FFFFFF' : colStroke;
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
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, RULER_H);
      ctx.lineTo(sx, totalH);
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
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
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, RULER_H);
      ctx.lineTo(sx, totalH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [project, playhead, selectedIds, zoomPx, showStrip, skim, skimX, thumbs, waveforms, snapGuide, agentCursor, marquee, totalW, totalH]);

  const hitTestClip = (x: number, y: number): { clip: Clip; edge: 'body' | 'left' | 'right' | 'trans' } | undefined => {
    for (const row of allRows) {
      if (y < row.y || y > row.y + row.h) continue;
      for (const c of project.clips) {
        if (c.trackID !== row.track.id) continue;
        const cx = c.start * zoomPx;
        const cw = Math.max(4, c.duration * zoomPx);
        if (x >= cx && x <= cx + cw) {
          if (c.transitionIn) {
            const tw = Math.min(cw, c.transitionIn.duration * zoomPx);
            if (Math.abs(x - (cx + tw)) <= 6 && y <= row.y + 18) return { clip: c, edge: 'trans' };
          }
          if (x - cx <= 7) return { clip: c, edge: 'left' };
          if (cx + cw - x <= 7) return { clip: c, edge: 'right' };
          return { clip: c, edge: 'body' };
        }
      }
    }
    return undefined;
  };

  const computeDragResult = (
    p: Project,
    drag: NonNullable<typeof dragRef.current>,
    x: number,
    useSnap: boolean,
    useSticky: boolean,
    pxPerSec: number,
    finalize: boolean
  ): number | null => {
    const dt = (x - drag.startX) / pxPerSec;
    const base = JSON.parse(JSON.stringify(drag.snapshot)) as Project;
    Object.assign(p, base);
    if (!drag.clipID) return null;
    const seedIds = drag.dragIds && drag.dragIds.length > 0 ? drag.dragIds : [drag.clipID];
    const group = linkedIds(p, seedIds);
    const primary = p.clips.find((c) => c.id === drag.clipID);
    if (!primary) return null;

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
        onSelectClips: selectFn,
        snapping: useSnap,
        sticky: useSticky,
        zoomPx: pxPerSec,
        allRows: rows,
      } = latestDragHandlersRef.current;
      if (Math.hypot(x - drag.startX, y - drag.startY) > 3) drag.moved = true;
      drag.lastX = x;
      drag.lastY = y;

      if (drag.mode === 'scrub') {
        seekFn(Math.max(0, x / pxPerSec));
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
        snappedAt = computeDragResult(p, drag, x, useSnap, useSticky, pxPerSec, false);
        const primary = p.clips.find((c) => c.id === drag.clipID);
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
      if (drag.mode !== 'scrub' && drag.clipID && drag.moved) {
        mutateFn((p) => {
          Object.assign(p, JSON.parse(JSON.stringify(drag.snapshot)) as Project);
        }, false);
        mutateFn((p) => {
          computeDragResult(p, drag, drag.lastX, useSnap, useSticky, pxPerSec, true);
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
        setEditingMarkerId(hitMarker.id);
        return;
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
    dragRef.current = {
      mode:
        hit.edge === 'trans'
          ? 'trans'
          : hit.edge === 'left'
          ? 'trimL'
          : hit.edge === 'right'
          ? 'trimR'
          : 'move',
      clipID: hit.clip.id,
      dragIds: hit.edge === 'body' ? nextSelected : [hit.clip.id],
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      moved: false,
      origStart: hit.clip.start,
      origDuration: hit.clip.duration,
      origTransDur: hit.clip.transitionIn?.duration,
      snapshot: snapProj,
    };
    setHoverCursor(hit.edge === 'body' ? 'grabbing' : hit.edge === 'trans' ? 'col-resize' : 'ew-resize');
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (skim) {
      setSkimX(x);
      onSkimTime?.(Math.max(0, x / zoomPx));
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
    else setHoverCursor(hit.edge === 'body' ? 'grab' : hit.edge === 'trans' ? 'col-resize' : 'ew-resize');
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
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px]"
            style={{
              background: tool === 'select' ? 'var(--raised)' : 'transparent',
              color: tool === 'select' ? 'var(--text)' : 'var(--text-dim)',
            }}
            title="Select Tool (V)"
          >
            <MousePointer size={12} strokeWidth={1.5} /> Select
          </button>
          <button
            onClick={() => onSetTool('cut')}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px]"
            style={{
              background: tool === 'cut' ? 'var(--raised)' : 'transparent',
              color: tool === 'cut' ? 'var(--accent)' : 'var(--text-dim)',
            }}
            title="Blade / Cut Tool (C)"
          >
            <Scissors size={12} strokeWidth={1.5} /> Cut
          </button>
          <div className="h-3.5 w-px mx-1" style={{ background: 'var(--stroke)' }} />
          <button
            onClick={onSplitAtPlayhead}
            className="px-2 py-1 rounded text-[11px]"
            style={{ color: 'var(--text-dim)' }}
            title="Split at Playhead (Ctrl+K)"
          >
            Split
          </button>
          <button
            onClick={() => onDeleteSelected(false)}
            className="p-1.5 rounded"
            style={{ color: selectedIds.length ? 'var(--text)' : 'var(--text-faint)' }}
            title="Delete (Del)"
          >
            <Trash2 size={13} strokeWidth={1.5} />
          </button>
          <button
            onClick={onAddText}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px]"
            style={{ color: 'var(--text-dim)' }}
            title="Add Title (Ctrl+T)"
          >
            <Type size={12} strokeWidth={1.5} /> Text
          </button>
          <button
            onClick={onAddMarker}
            className="p-1.5 rounded"
            style={{ color: 'var(--text-dim)' }}
            title="Add Marker (M)"
          >
            <Bookmark size={13} strokeWidth={1.5} />
          </button>
          <button
            onClick={onAutoEdit}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px]"
            style={{ color: 'var(--text-dim)' }}
            title="Auto Edit Montage"
          >
            <Sparkles size={12} style={{ color: 'var(--accent)' }} /> Auto Edit
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
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px]"
            style={{
              background: showStrip ? 'var(--raised)' : 'transparent',
              color: showStrip ? 'var(--text)' : 'var(--text-faint)',
            }}
            title="Filmstrip Thumbnails (Shift+T)"
          >
            <Film size={12} strokeWidth={1.5} /> Strip
          </button>
          <button
            onClick={onToggleSnap}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px]"
            style={{
              background: snapping ? 'var(--raised)' : 'transparent',
              color: snapping ? 'var(--text)' : 'var(--text-faint)',
            }}
            title="Snapping (N)"
          >
            <Magnet size={12} strokeWidth={1.5} /> Snap
          </button>
          <button
            onClick={onToggleSticky}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px]"
            style={{
              background: sticky ? 'var(--raised)' : 'transparent',
              color: sticky ? 'var(--text)' : 'var(--text-faint)',
            }}
            title="Sticky Edges (R): move downstream clips when trimming"
          >
            <Link2 size={12} strokeWidth={1.5} /> Sticky
          </button>
          <button
            onClick={onToggleSkim}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px]"
            style={{
              background: skim ? 'var(--raised)' : 'transparent',
              color: skim ? 'var(--accent)' : 'var(--text-faint)',
            }}
            title="Skimming (Y): hover timeline to preview frames"
          >
            <Compass size={12} strokeWidth={1.5} /> Skim
          </button>
          <button
            onClick={() => onSetZoom(Math.max(12, zoomPx * 0.8))}
            className="p-1 rounded"
            style={{ color: 'var(--text-dim)' }}
            title="Zoom Out (-)"
          >
            <ZoomOut size={13} />
          </button>
          <button
            onClick={() => onSetZoom(Math.min(240, zoomPx * 1.25))}
            className="p-1 rounded"
            style={{ color: 'var(--text-dim)' }}
            title="Zoom In (+)"
          >
            <ZoomIn size={13} />
          </button>
          <button
            onClick={onZoomToFit}
            className="p-1 rounded"
            style={{ color: 'var(--text-dim)' }}
            title="Zoom to Fit (Shift+Z)"
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
            <span>TRACKS</span>
            <button
              onClick={() =>
                onMutate((p) => {
                  p.videoTracks.push({ id: crypto.randomUUID(), kind: 'video' });
                })
              }
              title="Add Video Track"
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
                        background: row.track.solo ? '#F2F2F0' : 'transparent',
                        color: row.track.solo ? '#0A0A0A' : 'var(--text-faint)',
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
                  outline: (activeMarker.color ?? 'orange') === tint ? '2px solid #FFF' : 'none',
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
            Delete
          </button>
          <button
            onClick={() => setEditingMarkerId(null)}
            className="px-1.5 py-0.5 rounded text-[10px]"
            style={{ color: 'var(--text-dim)' }}
          >
            Done
          </button>
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
              label: 'Split at Playhead',
              action: () => onSplitAtPlayhead(),
            },
            {
              label: 'Duplicate',
              action: () => onDuplicateClip?.(contextMenu.clip.id),
            },
            ...(contextMenu.clip.kind !== 'audio'
              ? [
                  {
                    label: 'Copy Grade',
                    action: () => onCopyGrade?.(contextMenu.clip.grade ?? {}),
                  },
                  ...(copiedGrade
                    ? [
                        {
                          label: 'Paste Grade',
                          action: () =>
                            onMutate((p) => {
                              const c = p.clips.find((x) => x.id === contextMenu.clip.id);
                              if (c) c.grade = JSON.parse(JSON.stringify(copiedGrade)) as ColorGrade;
                            }),
                        },
                      ]
                    : []),
                  {
                    label: 'Freeze Frame (2s)',
                    action: () => onFreezeFrame?.(contextMenu.clip.id),
                  },
                  ...((
                    [
                      { kind: 'dissolve', label: 'Dissolve In (0.5s)' },
                      { kind: 'dipToBlack', label: 'Dip to Black (0.5s)' },
                      { kind: 'wipe', label: 'Wipe In (0.5s)' },
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
                          label: 'Remove Transition',
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
              label: contextMenu.clip.reversed ? 'Un-reverse' : 'Reverse Clip',
              action: () => onReverseClip?.(contextMenu.clip.id),
            },
            ...(contextMenu.clip.linkID
              ? [
                  {
                    label: 'Detach Audio',
                    action: () => onDetachAudio?.(contextMenu.clip.id),
                  },
                ]
              : []),
            {
              label: 'Delete',
              danger: true,
              action: () => onDeleteSelected(false),
            },
            {
              label: 'Ripple Delete',
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
              className="w-full text-left px-3 py-1.5 hover:opacity-90"
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
