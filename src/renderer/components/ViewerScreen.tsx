import React, { useEffect, useRef, useState } from 'react';
import {
  Film,
  Maximize2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { Project, Transcript } from '../../shared/types';
import { formatTimecode, parseTimecode, projectDuration } from '../../shared/project';
import { PreviewCompositor } from '../engine/compositor';

interface ViewerScreenProps {
  project: Project;
  playhead: number;
  playing: boolean;
  loop: boolean;
  meter: { left: number; right: number };
  transcripts: Record<string, Transcript>;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onStep: (frames: number) => void;
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
  onTogglePlay,
  onSeek,
  onStep,
  onToggleLoop,
  onImport,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const compositorRef = useRef<PreviewCompositor | null>(null);
  const [editingTime, setEditingTime] = useState(false);
  const [timeInput, setTimeInput] = useState('');
  const latestRef = useRef({ project, playhead, transcripts });
  latestRef.current = { project, playhead, transcripts };

  if (!compositorRef.current) compositorRef.current = new PreviewCompositor();

  useEffect(() => {
    let raf = 0;
    let readyRaf = 0;
    compositorRef.current?.setOnReady(() => {
      cancelAnimationFrame(readyRaf);
      readyRaf = requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        const latest = latestRef.current;
        if (canvas && compositorRef.current) {
          compositorRef.current.renderFrame(canvas, latest.project, latest.playhead, latest.transcripts);
        }
      });
    });
    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas && compositorRef.current) {
        compositorRef.current.syncMediaElements(project, playhead, playing);
        compositorRef.current.renderFrame(canvas, project, playhead, transcripts);
      }
      if (playing) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(readyRaf);
    };
  }, [project, playhead, playing, transcripts]);

  const dur = Math.max(0.01, projectDuration(project));
  const hasClips = project.clips.length > 0;

  const handleFullscreen = () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current.requestFullscreen();
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-col min-w-0 h-full"
      style={{ background: 'var(--bg)' }}
    >
      <div className="flex-1 relative flex items-center justify-center p-4 min-h-0">
        {!hasClips && project.assets.length === 0 ? (
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
            <canvas
              ref={canvasRef}
              width={Math.min(1280, project.width)}
              height={Math.max(2, Math.round((Math.min(1280, project.width) * project.height) / Math.max(1, project.width)))}
              className="max-w-full max-h-full rounded shadow-2xl"
              style={{ background: '#000', border: '1px solid var(--stroke)', aspectRatio: `${project.width} / ${project.height}` }}
            />
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

        <div className="flex items-center gap-2">
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
        </div>

        <div className="flex items-center gap-3">
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
