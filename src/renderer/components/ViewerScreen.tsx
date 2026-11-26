import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Film,
  Maximize2,
  Pause,
  Play,
  Plus,
  Repeat,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react';
import { Clip, MediaAsset, Project, Transcript } from '../../shared/types';
import { clipEnd, formatTimecode, parseTimecode, projectDuration } from '../../shared/project';
import { PreviewCompositor } from '../engine/compositor';

export interface PinnedSourceState {
  asset: MediaAsset;
  time: number;
  inTime?: number;
  outTime?: number;
}

interface ViewerScreenProps {
  project: Project;
  playhead: number;
  playing: boolean;
  loop: boolean;
  meter: { left: number; right: number };
  transcripts: Record<string, Transcript>;
  selectedClip?: Clip;
  shuttleRate?: number;
  skimTime?: number | null;
  sourcePreview?: { asset: MediaAsset; time: number } | null;
  pinnedSource?: PinnedSourceState | null;
  onChangePinnedSource?: (next: PinnedSourceState | null) => void;
  onInsertSourceRange?: (asset: MediaAsset, inTime?: number, outTime?: number) => void;
  onMutate?: (fn: (p: Project) => void, recordHistory?: boolean) => void;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onStep: (frames: number) => void;
  onJumpEdit?: (forward: boolean) => void;
  onToggleLoop: () => void;
  onImport: () => void;
}

export const ViewerScreen: React.FC<ViewerScreenProps> = ({
  project,
  playhead,
  playing,
  loop,
  meter,
  transcripts,
  selectedClip,
  shuttleRate = 1,
  skimTime = null,
  sourcePreview = null,
  pinnedSource = null,
  onChangePinnedSource,
  onInsertSourceRange,
  onMutate,
  onTogglePlay,
  onSeek,
  onStep,
  onJumpEdit,
  onToggleLoop,
  onImport,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const compositorRef = useRef<PreviewCompositor | null>(null);
  const [editingTime, setEditingTime] = useState(false);
  const [timeInput, setTimeInput] = useState('');
  const [snapGuides, setSnapGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const [viewerZoom, setViewerZoom] = useState<number | null>(null);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const activeSource = sourcePreview ?? (!playing ? pinnedSource : null);
  const viewTime = !playing && !activeSource && skimTime !== null ? skimTime : playhead;
  const latestRef = useRef({ project, playhead: viewTime, transcripts, activeSource });
  latestRef.current = { project, playhead: viewTime, transcripts, activeSource };

  if (!compositorRef.current) compositorRef.current = new PreviewCompositor();

  useEffect(() => {
    let raf = 0;
    let readyRaf = 0;
    compositorRef.current?.setOnReady(() => {
      cancelAnimationFrame(readyRaf);
      readyRaf = requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        const latest = latestRef.current;
        if (!canvas || !compositorRef.current) return;
        if (latest.activeSource) {
          compositorRef.current.renderSourcePreview(canvas, latest.activeSource.asset, latest.activeSource.time);
        } else {
          compositorRef.current.renderFrame(canvas, latest.project, latest.playhead, latest.transcripts);
        }
      });
    });
    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas && compositorRef.current) {
        if (activeSource) {
          compositorRef.current.renderSourcePreview(canvas, activeSource.asset, activeSource.time);
        } else {
          compositorRef.current.syncMediaElements(project, viewTime, playing);
          compositorRef.current.renderFrame(canvas, project, viewTime, transcripts);
        }
      }
      if (playing && !activeSource) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(readyRaf);
    };
  }, [project, viewTime, playing, transcripts, activeSource]);

  const dur = Math.max(0.01, projectDuration(project));
  const hasClips = project.clips.length > 0;
  const gizmoClip =
    !activeSource &&
    selectedClip &&
    selectedClip.kind !== 'audio' &&
    playhead >= selectedClip.start - 1e-4 &&
    playhead <= clipEnd(selectedClip) + 1e-4
      ? selectedClip
      : undefined;

  const startTransformDrag = (mode: 'move' | 'scale', e: React.MouseEvent) => {
    if (!gizmoClip || !canvasRef.current || !onMutate) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = canvasRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const isText = gizmoClip.kind === 'text';
    const initX = isText ? gizmoClip.text?.x ?? 0.5 : gizmoClip.transform?.x ?? 0;
    const initY = isText ? gizmoClip.text?.y ?? 0.5 : gizmoClip.transform?.y ?? 0;
    const initScale = isText ? (gizmoClip.text?.size ?? 110) / 110 : gizmoClip.transform?.scale ?? 1;
    const initCenterPxX = rect.left + (isText ? initX : 0.5 + initX) * rect.width;
    const initCenterPxY = rect.top + (isText ? initY : 0.5 + initY) * rect.height;
    const initDist = Math.max(12, Math.hypot(startX - initCenterPxX, startY - initCenterPxY));

    const applyDelta = (clientX: number, clientY: number, recordHistory: boolean) => {
      if (mode === 'move') {
        let nx = initX + (clientX - startX) / rect.width;
        let ny = initY + (clientY - startY) / rect.height;
        const centerTarget = isText ? 0.5 : 0;
        const snapX = Math.abs(nx - centerTarget) < 0.018;
        const snapY = Math.abs(ny - centerTarget) < 0.018;
        if (snapX) nx = centerTarget;
        if (snapY) ny = centerTarget;
        setSnapGuides({ x: snapX, y: snapY });
        onMutate((p) => {
          const target = p.clips.find((c) => c.id === gizmoClip.id);
          if (!target) return;
          if (target.kind === 'text' && target.text) {
            target.text = {
              ...target.text,
              x: Math.round(Math.min(1, Math.max(0, nx)) * 1000) / 1000,
              y: Math.round(Math.min(1, Math.max(0, ny)) * 1000) / 1000,
            };
          } else {
            target.transform = {
              ...(target.transform ?? { scale: 1, x: 0, y: 0 }),
              x: Math.round(nx * 1000) / 1000,
              y: Math.round(ny * 1000) / 1000,
            };
          }
        }, recordHistory);
      } else {
        const dist = Math.max(8, Math.hypot(clientX - initCenterPxX, clientY - initCenterPxY));
        const nextScale = Math.min(6, Math.max(0.1, initScale * (dist / initDist)));
        onMutate((p) => {
          const target = p.clips.find((c) => c.id === gizmoClip.id);
          if (!target) return;
          if (target.kind === 'text' && target.text) {
            target.text = {
              ...target.text,
              size: Math.round(Math.min(360, Math.max(20, nextScale * 110))),
            };
          } else {
            target.transform = {
              ...(target.transform ?? { scale: 1, x: 0, y: 0 }),
              scale: Math.round(nextScale * 100) / 100,
            };
          }
        }, recordHistory);
      }
    };

    const onMove = (ev: MouseEvent) => applyDelta(ev.clientX, ev.clientY, false);
    const onUp = (ev: MouseEvent) => {
      setSnapGuides({ x: false, y: false });
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 1.5) {
        applyDelta(startX, startY, false);
        applyDelta(ev.clientX, ev.clientY, true);
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleFullscreen = () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current.requestFullscreen();
  };

  const gizmoBox = (() => {
    if (!gizmoClip) return null;
    if (gizmoClip.kind === 'text') {
      const scale = Math.min(1.4, Math.max(0.2, (gizmoClip.text?.size ?? 110) / 260));
      const cx = (gizmoClip.text?.x ?? 0.5) * 100;
      const cy = (gizmoClip.text?.y ?? 0.5) * 100;
      const bw = Math.min(92, Math.max(20, scale * 54));
      const bh = Math.min(70, Math.max(10, scale * 22));
      return { left: cx - bw / 2, top: cy - bh / 2, width: bw, height: bh };
    }
    const sc = gizmoClip.transform?.scale ?? 1;
    const cx = (0.5 + (gizmoClip.transform?.x ?? 0)) * 100;
    const cy = (0.5 + (gizmoClip.transform?.y ?? 0)) * 100;
    const bw = Math.min(100, Math.max(8, sc * 100));
    const bh = Math.min(100, Math.max(8, sc * 100));
    return { left: cx - bw / 2, top: cy - bh / 2, width: bw, height: bh };
  })();

  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-col min-w-0 h-full"
      style={{ background: 'var(--bg)' }}
    >
      <div
        className={`flex-1 relative flex p-4 min-h-0 ${viewerZoom ? 'overflow-auto items-center justify-center' : 'overflow-hidden items-center justify-center'}`}
      >
        {!hasClips && !activeSource && project.assets.length === 0 ? (
          <div
            onClick={onImport}
            className="w-full max-w-md h-52 rounded-xl flex flex-col items-center justify-center cursor-pointer transition-colors"
            style={{ background: '#050505', border: '1px solid var(--stroke)' }}
          >
            <Film size={28} strokeWidth={1.3} style={{ color: 'var(--text-dim)' }} className="mb-3" />
            <div className="text-[13px] font-medium" style={{ color: 'var(--text)' }}>
              Drop video, audio or images anywhere
            </div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--text-faint)' }}>
              or press Ctrl+I to import
            </div>
          </div>
        ) : (
          <div
            className="relative flex items-center justify-center w-full h-full"
            style={{ maxWidth: '100%', maxHeight: '100%' }}
          >
            <div
              data-magic-anchor="viewer"
              className="relative max-w-full max-h-full"
              style={
                viewerZoom
                  ? {
                      width: Math.round((project.width * viewerZoom) / (window.devicePixelRatio || 1)),
                      height: Math.round((project.height * viewerZoom) / (window.devicePixelRatio || 1)),
                      flexShrink: 0,
                    }
                  : { aspectRatio: `${project.width} / ${project.height}`, height: '100%', maxHeight: '100%' }
              }
            >
              <canvas
                ref={canvasRef}
                width={Math.min(1280, project.width)}
                height={Math.max(
                  2,
                  Math.round((Math.min(1280, project.width) * project.height) / Math.max(1, project.width))
                )}
                className="w-full h-full block rounded shadow-2xl"
                style={{ background: '#000', border: '1px solid var(--stroke)' }}
              />

              {activeSource && (
                <div
                  className="absolute top-2.5 left-2.5 flex items-center gap-2 px-2.5 py-1 rounded-full text-[10px] font-semibold pointer-events-none"
                  style={{ background: 'rgba(16,17,20,0.86)', border: '1px solid var(--accent)', color: '#F2F2F0' }}
                >
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                  <span>SOURCE</span>
                  <span style={{ color: 'var(--text-dim)' }}>{activeSource.asset.name}</span>
                  <span className="mono-num">{formatTimecode(activeSource.time, project.fps, true)}</span>
                </div>
              )}

              {!activeSource && (
                <div
                  className="absolute top-2.5 right-2.5 flex items-center gap-1.5 pointer-events-none"
                >
                  {!playing && skimTime !== null && (
                    <span
                      className="mono-num px-2 py-0.5 rounded-full text-[10px] font-semibold"
                      style={{ background: 'rgba(255, 74, 28, 0.88)', color: '#FFFFFF' }}
                    >
                      SKIM · {formatTimecode(skimTime, project.fps, true)}
                    </span>
                  )}
                  {Math.abs(shuttleRate - 1) > 0.05 && playing && (
                    <span
                      className="mono-num px-2 py-0.5 rounded-full text-[10px] font-semibold"
                      style={{ background: 'var(--accent)', color: '#FFFFFF' }}
                    >
                      {shuttleRate > 0 ? `${shuttleRate}x` : `${shuttleRate}x`}
                    </span>
                  )}
                  <span
                    className="mono-num px-2 py-0.5 rounded-full text-[10px]"
                    style={{ background: 'rgba(16,17,20,0.72)', color: 'var(--text-dim)', border: '1px solid var(--stroke)' }}
                  >
                    {project.width}x{project.height} · {project.fps}fps
                  </span>
                </div>
              )}

              {gizmoBox && onMutate && (
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                  {snapGuides.x && (
                    <div
                      className="absolute top-0 bottom-0 w-px"
                      style={{ left: '50%', background: 'var(--accent)', opacity: 0.8 }}
                    />
                  )}
                  {snapGuides.y && (
                    <div
                      className="absolute left-0 right-0 h-px"
                      style={{ top: '50%', background: 'var(--accent)', opacity: 0.8 }}
                    />
                  )}
                  <div
                    onMouseDown={(e) => startTransformDrag('move', e)}
                    className="absolute pointer-events-auto cursor-move"
                    style={{
                      left: `${gizmoBox.left}%`,
                      top: `${gizmoBox.top}%`,
                      width: `${gizmoBox.width}%`,
                      height: `${gizmoBox.height}%`,
                      border: '1px dashed rgba(255, 74, 28, 0.85)',
                    }}
                    title="Drag to reposition · drag corners to scale"
                  >
                    {[
                      { pos: '-top-1 -left-1 cursor-nwse-resize' },
                      { pos: '-top-1 -right-1 cursor-nesw-resize' },
                      { pos: '-bottom-1 -left-1 cursor-nesw-resize' },
                      { pos: '-bottom-1 -right-1 cursor-nwse-resize' },
                    ].map((h, i) => (
                      <div
                        key={i}
                        onMouseDown={(e) => startTransformDrag('scale', e)}
                        className={`absolute w-2.5 h-2.5 rounded-sm ${h.pos}`}
                        style={{ background: '#FFFFFF', border: '1.5px solid var(--accent)' }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {!sourcePreview && pinnedSource && onChangePinnedSource && (
                <div
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] shadow-xl"
                  style={{ background: 'rgba(16,17,20,0.92)', border: '1px solid var(--stroke)' }}
                >
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0.05, pinnedSource.asset.duration)}
                    step={0.02}
                    value={pinnedSource.time}
                    onChange={(e) => onChangePinnedSource({ ...pinnedSource, time: Number(e.target.value) })}
                    className="w-28"
                    title="Scrub source"
                  />
                  <button
                    onClick={() => onChangePinnedSource({ ...pinnedSource, inTime: pinnedSource.time })}
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{ background: 'var(--button)', color: pinnedSource.inTime !== undefined ? 'var(--accent)' : 'var(--text)' }}
                    title="Set Source In"
                  >
                    In {pinnedSource.inTime !== undefined ? formatTimecode(pinnedSource.inTime, project.fps, true) : ''}
                  </button>
                  <button
                    onClick={() => onChangePinnedSource({ ...pinnedSource, outTime: pinnedSource.time })}
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{ background: 'var(--button)', color: pinnedSource.outTime !== undefined ? 'var(--accent)' : 'var(--text)' }}
                    title="Set Source Out"
                  >
                    Out {pinnedSource.outTime !== undefined ? formatTimecode(pinnedSource.outTime, project.fps, true) : ''}
                  </button>
                  <button
                    onClick={() => {
                      onInsertSourceRange?.(pinnedSource.asset, pinnedSource.inTime, pinnedSource.outTime);
                      onChangePinnedSource(null);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold"
                    style={{ background: 'var(--accent)', color: '#FFFFFF' }}
                  >
                    <Plus size={11} /> Insert
                  </button>
                  <button
                    onClick={() => onChangePinnedSource(null)}
                    className="p-0.5 rounded"
                    style={{ color: 'var(--text-dim)' }}
                    title="Back to Timeline"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div
        className="flex items-center justify-between px-4 h-11 shrink-0"
        style={{ background: 'var(--transport)', borderTop: '1px solid var(--stroke)' }}
      >
        <div className="flex items-center gap-2">
          {editingTime ? (
            <input
              autoFocus
              onFocus={(e) => e.target.select()}
              value={timeInput}
              onChange={(e) => setTimeInput(e.target.value)}
              onBlur={() => {
                setEditingTime(false);
                const parsed = parseTimecode(timeInput, project.fps);
                if (parsed !== undefined) onSeek(Math.min(dur, Math.max(0, parsed)));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditingTime(false);
              }}
              className="mono-num w-28 px-2 py-0.5 rounded text-[13px] outline-none"
              style={{ background: 'var(--field)', color: 'var(--text)', border: '1px solid var(--accent)' }}
            />
          ) : (
            <button
              onClick={() => {
                setTimeInput(formatTimecode(playhead, project.fps));
                setEditingTime(true);
              }}
              className="mono-num text-[15px] font-medium tracking-tight hover:opacity-80"
              style={{ color: 'var(--text)' }}
              title="Click to enter timecode"
            >
              {formatTimecode(playhead, project.fps)}
            </button>
          )}
          <span className="mono-num text-[11px]" style={{ color: 'var(--text-faint)' }}>
            / {formatTimecode(dur, project.fps)}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {onJumpEdit && (
            <button
              onClick={() => onJumpEdit(false)}
              className="p-1.5 rounded hover:opacity-80"
              style={{ color: 'var(--text-dim)' }}
              title="Previous edit (Up)"
            >
              <ChevronsLeft size={14} strokeWidth={1.6} />
            </button>
          )}
          <button
            onClick={() => onStep(-1)}
            className="p-1.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-dim)' }}
            title="Previous frame (Left)"
          >
            <SkipBack size={14} strokeWidth={1.5} />
          </button>
          <button
            onClick={onTogglePlay}
            className="w-8 h-8 rounded-full flex items-center justify-center transition-transform active:scale-95"
            style={{ background: 'var(--text)', color: 'var(--on-text)' }}
            title="Play / Pause (Space)"
          >
            {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="ml-0.5" />}
          </button>
          <button
            onClick={() => onStep(1)}
            className="p-1.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-dim)' }}
            title="Next frame (Right)"
          >
            <SkipForward size={14} strokeWidth={1.5} />
          </button>
          {onJumpEdit && (
            <button
              onClick={() => onJumpEdit(true)}
              className="p-1.5 rounded hover:opacity-80"
              style={{ color: 'var(--text-dim)' }}
              title="Next edit (Down)"
            >
              <ChevronsRight size={14} strokeWidth={1.6} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex flex-col gap-0.5 w-16" title="Stereo Level">
            {[meter.left, meter.right].map((lvl, idx) => (
              <div key={idx} className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--well)' }}>
                <div
                  className="h-full transition-all duration-75"
                  style={{
                    width: `${Math.min(100, Math.round(lvl * 100))}%`,
                    background: lvl > 0.9 ? 'var(--accent)' : 'var(--meter-low)',
                  }}
                />
              </div>
            ))}
          </div>
          <div className="relative">
            <button
              onClick={() => setZoomMenuOpen((v) => !v)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-medium"
              style={{ background: 'var(--field)', color: 'var(--text-dim)', border: '1px solid var(--stroke)' }}
              title="Viewer zoom"
            >
              {viewerZoom === null ? 'Fit' : `${Math.round(viewerZoom * 100)}%`}
              <ChevronDown size={10} />
            </button>
            {zoomMenuOpen && (
              <div
                className="absolute right-0 bottom-7 z-40 w-24 rounded-lg py-1 shadow-2xl"
                style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                {[
                  { label: 'Fit', value: null },
                  { label: '50%', value: 0.5 },
                  { label: '100%', value: 1 },
                  { label: '200%', value: 2 },
                ].map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => {
                      setViewerZoom(opt.value);
                      setZoomMenuOpen(false);
                    }}
                    className="w-full text-left px-2.5 py-1 text-[11px] hover:bg-white/10"
                    style={{ color: viewerZoom === opt.value ? 'var(--accent)' : 'var(--text)' }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onToggleLoop}
            className="p-1.5 rounded"
            style={{ color: loop ? 'var(--accent)' : 'var(--text-dim)' }}
            title="Loop (L)"
          >
            <Repeat size={13} strokeWidth={1.5} />
          </button>
          <button
            onClick={handleFullscreen}
            className="p-1.5 rounded"
            style={{ color: 'var(--text-dim)' }}
            title="Fullscreen (F)"
          >
            <Maximize2 size={13} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
};
