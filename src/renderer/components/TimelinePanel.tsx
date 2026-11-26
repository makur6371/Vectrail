import React, { useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  Eye,
  EyeOff,
  Lock,
  Magnet,
  MousePointer,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  Unlock,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AgentCursorState, Clip, Project, Track } from '../../shared/types';
import { WaveformData } from '../../main/engine/ffmpeg';
import {
  clipEnd,
  clipName,
  formatTimecode,
  linkedIds,
  projectDuration,
  snapFrame,
  snapPoints,
  trimClipHead,
  trimClipTail,
  trimLimits,
} from '../../shared/project';

interface TimelinePanelProps {
  project: Project;
  playhead: number;
  selectedIds: string[];
  tool: 'select' | 'cut';
  snapping: boolean;
  zoomPx: number;
  thumbs: Record<string, string[]>;
  waveforms: Record<string, WaveformData>;
  agentCursor?: AgentCursorState;
  onSetTool: (t: 'select' | 'cut') => void;
  onToggleSnap: () => void;
  onSetZoom: (z: number) => void;
  onSeek: (t: number) => void;
  onSelectClips: (ids: string[]) => void;
  onMutate: (fn: (p: Project) => void, recordHistory?: boolean) => void;
  onSplitAtPlayhead: () => void;
  onDeleteSelected: (ripple: boolean) => void;
  onAddText: () => void;
  onAddMarker: () => void;
  onAutoEdit: () => void;
  onDropAsset?: (assetID: string, time: number, trackID?: string) => void;
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
  zoomPx,
  thumbs,
  waveforms,
  agentCursor,
  onSetTool,
  onToggleSnap,
  onSetZoom,
  onSeek,
  onSelectClips,
  onMutate,
  onSplitAtPlayhead,
  onDeleteSelected,
  onAddText,
  onAddMarker,
  onAutoEdit,
  onDropAsset,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const [viewportW, setViewportW] = useState<number>(1100);

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
    mode: 'scrub' | 'move' | 'trimL' | 'trimR';
    clipID?: string;
    startX: number;
    origStart: number;
    origDuration: number;
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

        if (clip.kind === 'video' || clip.kind === 'image') {
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
      ctx.fillStyle = colAccent;
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

    if (agentCursor && agentCursor.time !== undefined) {
      const ax = agentCursor.time * zoomPx;
      ctx.strokeStyle = '#30D158';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ax, RULER_H);
      ctx.lineTo(ax, totalH);
      ctx.stroke();
      ctx.fillStyle = '#30D158';
      ctx.fillRect(ax - 2, 2, 54, 15);
      ctx.fillStyle = '#0A0A0A';
      ctx.font = '600 9px Inter, sans-serif';
      ctx.fillText(agentCursor.name, ax + 3, 4);
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
  }, [project, playhead, selectedIds, zoomPx, thumbs, waveforms, snapGuide, agentCursor, totalW, totalH]);

  const hitTestClip = (x: number, y: number): { clip: Clip; edge: 'body' | 'left' | 'right' } | undefined => {
    for (const row of allRows) {
      if (y < row.y || y > row.y + row.h) continue;
      for (const c of project.clips) {
        if (c.trackID !== row.track.id) continue;
        const cx = c.start * zoomPx;
        const cw = Math.max(4, c.duration * zoomPx);
        if (x >= cx && x <= cx + cw) {
          if (x - cx <= 7) return { clip: c, edge: 'left' };
          if (cx + cw - x <= 7) return { clip: c, edge: 'right' };
          return { clip: c, edge: 'body' };
        }
      }
    }
    return undefined;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = Math.max(0, x / zoomPx);

    if (y <= RULER_H) {
      onSeek(time);
      dragRef.current = { mode: 'scrub', startX: x, origStart: time, origDuration: 0, snapshot: project };
      return;
    }

    const hit = hitTestClip(x, y);
    if (!hit) {
      onSelectClips([]);
      onSeek(time);
      dragRef.current = { mode: 'scrub', startX: x, origStart: time, origDuration: 0, snapshot: project };
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

    onSelectClips([hit.clip.id]);
    const snapProj = JSON.parse(JSON.stringify(project)) as Project;
    dragRef.current = {
      mode: hit.edge === 'left' ? 'trimL' : hit.edge === 'right' ? 'trimR' : 'move',
      clipID: hit.clip.id,
      startX: x,
      origStart: hit.clip.start,
      origDuration: hit.clip.duration,
      snapshot: snapProj,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dt = (x - drag.startX) / zoomPx;

    if (drag.mode === 'scrub') {
      onSeek(Math.max(0, x / zoomPx));
      return;
    }

    if (!drag.clipID) return;
    const snapPts = snapping ? snapPoints(drag.snapshot, linkedIds(drag.snapshot, [drag.clipID])) : [];
    const snapTol = 8 / zoomPx;
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

    onMutate((p) => {
      const base = JSON.parse(JSON.stringify(drag.snapshot)) as Project;
      Object.assign(p, base);
      const group = linkedIds(p, [drag.clipID!]);
      const primary = p.clips.find((c) => c.id === drag.clipID);
      if (!primary) return;

      if (drag.mode === 'move') {
        let nextStart = Math.max(0, drag.origStart + dt);
        if (snapping) {
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
        const target = findSnap(drag.origStart + d);
        if (snappedAt !== null) d = Math.min(hi, Math.max(lo, target - drag.origStart));
        for (const c of p.clips) {
          if (group.has(c.id)) trimClipHead(c, snapFrame(drag.origStart + d, p.fps));
        }
      } else if (drag.mode === 'trimR') {
        const [lo, hi] = trimLimits(p, primary, false, group);
        let d = Math.min(hi, Math.max(lo, dt));
        const origEnd = drag.origStart + drag.origDuration;
        const target = findSnap(origEnd + d);
        if (snappedAt !== null) d = Math.min(hi, Math.max(lo, target - origEnd));
        for (const c of p.clips) {
          if (group.has(c.id)) trimClipTail(c, snapFrame(origEnd + d, p.fps));
        }
      }
    }, false);
    setSnapGuide(snappedAt);
  };

  const handleMouseUp = () => {
    dragRef.current = null;
    setSnapGuide(null);
  };

  const toggleTrackProp = (trackID: string, key: 'hidden' | 'muted' | 'solo' | 'locked') => {
    onMutate((p) => {
      const t = [...p.videoTracks, ...p.audioTracks].find((x) => x.id === trackID);
      if (t) t[key] = !t[key];
    });
  };

  return (
    <div
      className="flex flex-col shrink-0"
      style={{ height: 320, background: 'var(--panel)', borderTop: '1px solid var(--stroke)' }}
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
          <button
            onClick={onToggleSnap}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px]"
            style={{
              background: snapping ? 'var(--raised)' : 'transparent',
              color: snapping ? 'var(--text)' : 'var(--text-faint)',
            }}
            title="Snapping (S)"
          >
            <Magnet size={12} strokeWidth={1.5} /> Snap
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
          className="flex-1 overflow-auto"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-editroom-asset')) {
              e.preventDefault();
            }
          }}
          onDrop={(e) => {
            const assetID = e.dataTransfer.getData('application/x-editroom-asset');
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
            style={{ width: totalW, height: totalH, display: 'block', cursor: tool === 'cut' ? 'crosshair' : 'default' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />
        </div>
      </div>
    </div>
  );
};
