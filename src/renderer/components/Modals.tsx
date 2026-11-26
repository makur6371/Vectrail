import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  History,
  Lightbulb,
  Plug,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import {
  AppUpdateInfo,
  CloudAiConfig,
  ExportSettings,
  MagicHistoryEntry,
  MediaAsset,
  Project,
  Transcript,
} from '../../shared/types';
import { AppThemeName, THEMES } from '../../shared/themes';
import { AgentTarget, AgentTargetStatus, MagicBackend } from '../../main/magic/agentConnect';
import { MCPStatusInfo } from '../../preload';
import { computeExportRenderSize, formatTimecode, projectDuration } from '../../shared/project';
import { DEFAULT_SHORTCUTS, formatEventCombo, mergeShortcutBindings, ShortcutActionId } from '../../shared/shortcuts';
import type { WhisperStatus } from '../../main/engine/analyzer';
import { PreviewCompositor } from '../engine/compositor';

export const ExportModal: React.FC<{
  project: Project;
  title: string;
  transcripts?: Record<string, Transcript>;
  onClose: () => void;
  onStart: (s: ExportSettings) => void;
}> = ({ project, title, transcripts = {}, onClose, onStart }) => {
  const [format, setFormat] = useState<'video' | 'audio'>('video');
  const [shape, setShape] = useState<'original' | 'vertical' | 'square' | 'portrait'>('original');
  const [height, setHeight] = useState<number>(project.height);
  const [codec, setCodec] = useState<'h264' | 'hevc'>('h264');
  const [quality, setQuality] = useState<'high' | 'web'>('high');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [loudness, setLoudness] = useState<string>('-14');
  const [rangeOnly, setRangeOnly] = useState(false);
  const [enhanceDetail, setEnhanceDetail] = useState(false);
  const [fileName, setFileName] = useState(title || 'Vectrail-Export');
  const [reframeX, setReframeX] = useState(0.5);
  const [reframeY, setReframeY] = useState(0.5);
  const [draggingReframe, setDraggingReframe] = useState(false);
  const totalDur = Math.max(0.1, projectDuration(project));
  const [previewTime, setPreviewTime] = useState<number>(Math.min(0.8, totalDur * 0.25));
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const previewCompRef = useRef<PreviewCompositor | null>(null);
  if (!previewCompRef.current) previewCompRef.current = new PreviewCompositor();

  const size = computeExportRenderSize(project, shape, height);
  const isUpscaling = size.height > project.height;
  const srcAspect = project.width / Math.max(1, project.height);
  const dstAspect = size.width / Math.max(1, size.height);
  const isReframed = format === 'video' && shape !== 'original' && Math.abs(srcAspect - dstAspect) > 0.02;
  const cropWFrac = isReframed && srcAspect > dstAspect ? dstAspect / srcAspect : 1;
  const cropHFrac = isReframed && srcAspect < dstAspect ? srcAspect / dstAspect : 1;

  useEffect(() => {
    setReframeX(0.5);
    setReframeY(0.5);
  }, [shape]);

  useEffect(() => {
    if (format === 'audio') return;
    const draw = () => {
      const canvas = previewCanvasRef.current;
      if (!canvas || !previewCompRef.current) return;
      const previewProj: Project = { ...project };
      previewCompRef.current.syncMediaElements(previewProj, previewTime, false);
      previewCompRef.current.renderFrame(canvas, previewProj, previewTime, transcripts);
    };
    previewCompRef.current?.setOnReady(draw);
    draw();
  }, [format, project, previewTime, transcripts]);

  const startReframeDrag = (e: React.MouseEvent) => {
    if (!isReframed || !previewFrameRef.current) return;
    e.preventDefault();
    const rect = previewFrameRef.current.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const initX = reframeX;
    const initY = reframeY;
    setDraggingReframe(true);
    const halfW = cropWFrac / 2;
    const halfH = cropHFrac / 2;
    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / Math.max(1, rect.width);
      const dy = (ev.clientY - startY) / Math.max(1, rect.height);
      setReframeX(Math.min(1 - halfW, Math.max(halfW, initX + dx)));
      setReframeY(Math.min(1 - halfH, Math.max(halfH, initY + dy)));
    };
    const onUp = () => {
      setDraggingReframe(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div
        className="w-[460px] rounded-xl p-4 space-y-3"
        style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold">Export</span>
          <button onClick={onClose} style={{ color: 'var(--text-dim)' }}>
            <X size={15} />
          </button>
        </div>

        {format === 'video' && (
          <div className="space-y-1.5">
            <div
              className="w-full h-40 rounded-lg flex items-center justify-center overflow-hidden relative"
              style={{ background: '#050506', border: '1px solid var(--stroke)' }}
            >
              <div
                ref={previewFrameRef}
                onMouseDown={startReframeDrag}
                className={`relative h-full flex items-center justify-center overflow-hidden ${
                  isReframed ? (draggingReframe ? 'cursor-grabbing' : 'cursor-grab') : ''
                }`}
                style={{ aspectRatio: `${project.width} / ${project.height}`, maxWidth: '100%' }}
                title={isReframed ? 'Drag to reframe export crop' : undefined}
              >
                <canvas
                  ref={previewCanvasRef}
                  width={Math.max(240, Math.round((160 * project.width) / Math.max(1, project.height)))}
                  height={160}
                  className="w-full h-full block"
                />
                {isReframed && (
                  <div
                    className="absolute pointer-events-none rounded-sm"
                    style={{
                      width: `${cropWFrac * 100}%`,
                      height: `${cropHFrac * 100}%`,
                      left: `${(reframeX - cropWFrac / 2) * 100}%`,
                      top: `${(reframeY - cropHFrac / 2) * 100}%`,
                      border: '1.5px solid rgba(255,255,255,0.9)',
                      boxShadow: '0 0 0 9999px rgba(0,0,0,0.58)',
                    }}
                  />
                )}
              </div>
              {isReframed && (
                <span
                  className="pointer-events-none absolute bottom-1.5 right-2 px-1.5 py-0.5 rounded text-[9.5px]"
                  style={{ background: 'rgba(0,0,0,0.68)', color: 'var(--text-dim)' }}
                >
                  Drag to reframe
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>
              <span className="mono-num w-16">{formatTimecode(previewTime, project.fps, true)}</span>
              <input
                type="range"
                min={0}
                max={totalDur}
                step={0.05}
                value={previewTime}
                onChange={(e) => setPreviewTime(Number(e.target.value))}
                className="flex-1"
              />
            </div>
          </div>
        )}

        <label className="block text-[11px]">
          File Name
          <input
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            className="mt-1 w-full px-2 py-1.5 rounded outline-none"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)', color: 'var(--text)' }}
          />
        </label>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <label>
            Format
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as 'video' | 'audio')}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
            >
              <option value="video">Video (MP4)</option>
              <option value="audio">Audio (WAV)</option>
            </select>
          </label>
          <label>
            Shape
            <select
              value={shape}
              disabled={format === 'audio'}
              onChange={(e) => setShape(e.target.value as typeof shape)}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
            >
              <option value="original">Sequence ({project.width}x{project.height})</option>
              <option value="vertical">Vertical 9:16</option>
              <option value="square">Square 1:1</option>
              <option value="portrait">Portrait 4:5</option>
            </select>
          </label>
          <label>
            Resolution
            <select
              value={height}
              disabled={format === 'audio'}
              onChange={(e) => setHeight(Number(e.target.value))}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
            >
              <option value={720}>720p</option>
              <option value={1080}>1080p</option>
              <option value={2160}>4K (2160p)</option>
            </select>
          </label>
          <label>
            Codec & Quality
            <select
              value={`${codec}-${quality}`}
              disabled={format === 'audio'}
              onChange={(e) => {
                const [c, q] = e.target.value.split('-');
                setCodec(c as 'h264' | 'hevc');
                setQuality(q as 'high' | 'web');
              }}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
            >
              <option value="h264-high">H.264 High</option>
              <option value="h264-web">H.264 Web</option>
              <option value="hevc-high">HEVC High</option>
            </select>
          </label>
        </div>

        <div className="flex items-center justify-between text-[11px]">
          <span>Loudness Target</span>
          <select
            value={loudness}
            onChange={(e) => setLoudness(e.target.value)}
            className="px-2 py-1 rounded outline-none"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
          >
            <option value="">Original levels</option>
            <option value="-14">-14 LUFS (YouTube / Social)</option>
            <option value="-16">-16 LUFS (Podcast)</option>
            <option value="-23">-23 LUFS (Broadcast)</option>
          </select>
        </div>

        {project.playRange && (
          <label className="flex items-center gap-2 text-[11px]">
            <input type="checkbox" checked={rangeOnly} onChange={(e) => setRangeOnly(e.target.checked)} />
            Export In/Out range only
          </label>
        )}
        {format === 'video' && (
          <label className="flex items-center gap-2 text-[11px]">
            <input type="checkbox" checked={includeAudio} onChange={(e) => setIncludeAudio(e.target.checked)} />
            Include audio track mix
          </label>
        )}
        <label className="flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={enhanceDetail || isUpscaling}
            onChange={(e) => setEnhanceDetail(e.target.checked)}
          />
          <span>Enhance detail (Lanczos + CAS sharpen{isUpscaling ? ' · auto on upscale' : ''})</span>
        </label>

        <div className="flex items-center justify-between pt-2">
          <span className="mono-num text-[11px]" style={{ color: 'var(--text-dim)' }}>
            {format === 'audio' ? '48 kHz WAV' : `${size.width}x${size.height} · ${project.fps} fps`}
          </span>
          <button
            onClick={() => {
              onStart({
                format,
                shape,
                height,
                codec,
                quality,
                includeAudio,
                loudness: loudness ? Number(loudness) : undefined,
                rangeOnly,
                enhanceDetail: enhanceDetail || isUpscaling,
                reframeX: Number(reframeX.toFixed(3)),
                reframeY: Number(reframeY.toFixed(3)),
                name: fileName.trim() || title || 'Vectrail-Export',
              });
              onClose();
            }}
            className="px-4 py-1.5 rounded-full text-[11px] font-semibold"
            style={{ background: 'var(--text)', color: 'var(--on-text)' }}
          >
            Export...
          </button>
        </div>
      </div>
    </div>
  );
};

interface MagicIdea {
  name: string;
  prompt: string;
}

const IDEAS_IMPROVE: MagicIdea[] = [
  {
    name: 'Tighten it',
    prompt: 'Make this shorter so people keep watching: trim slow starts and ends of shots.',
  },
  {
    name: 'Cut to the beat',
    prompt: 'Recut this to the beat of the music with energetic pacing.',
  },
  {
    name: 'Smooth it out',
    prompt: 'Smooth this out with clean dissolve transitions and balanced levels.',
  },
  {
    name: 'One look',
    prompt: 'Give every shot the Warm film look so it feels like one cohesive film.',
  },
];

const IDEAS_CREATE: MagicIdea[] = [
  {
    name: 'Highlight reel',
    prompt: 'Make a 30 second highlight cut of the best moments to the beat of the music.',
  },
  {
    name: 'Vertical reel',
    prompt: 'Make a fast 20 second vertical 9:16 video for Reels and TikTok, cut to the beat.',
  },
  {
    name: 'Timelapse',
    prompt: 'Make a timelapse over the music: speed every shot up 8x.',
  },
  {
    name: 'Calm cut',
    prompt: 'Make a calm 45 second story cut with Film print look and gentle dissolves.',
  },
];

const IDEAS_SOUND: MagicIdea[] = [
  {
    name: 'Even out levels',
    prompt: 'Make all audio clips the same output level.',
  },
];

const MAGIC_TAB_STORAGE_KEY = 'vectrail.magicTab.v1';

function loadSavedMagicTab(): MagicBackend {
  try {
    const v = localStorage.getItem(MAGIC_TAB_STORAGE_KEY);
    if (v === 'claude' || v === 'codex' || v === 'cloud' || v === 'local') return v;
  } catch {
    // ignore storage errors
  }
  return 'local';
}

const MAGIC_AGENT_MODELS: Record<'claude' | 'codex', Array<{ id: string; label: string }>> = {
  claude: [
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
  ],
};

const MAGIC_EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
];

export const MagicPopover: React.FC<{
  assets: MediaAsset[];
  selectedIds: string[];
  hasEdit: boolean;
  prompt: string;
  history: MagicHistoryEntry[];
  onChangePrompt: (p: string) => void;
  onSubmit: (prompt: string, backend: MagicBackend, options?: { model?: string; effort?: string }) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}> = ({ assets, selectedIds, hasEdit, prompt, history, onChangePrompt, onSubmit, onOpenSettings, onClose }) => {
  const [backend, setBackend] = useState<MagicBackend>(loadSavedMagicTab);
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudModel, setCloudModel] = useState('gpt-4o-mini');
  const [cliModels, setCliModels] = useState<Record<'claude' | 'codex', string>>(() => {
    try {
      const raw = localStorage.getItem('vectrail.magicCliModels.v1');
      if (raw) return JSON.parse(raw) as Record<'claude' | 'codex', string>;
    } catch {
      // ignore
    }
    return { claude: 'claude-sonnet-4-6', codex: 'gpt-5.3-codex' };
  });
  const [cliEffort, setCliEffort] = useState<string>(() => {
    try {
      return localStorage.getItem('vectrail.magicCliEffort.v1') || 'medium';
    } catch {
      return 'medium';
    }
  });
  const [agents, setAgents] = useState<AgentTargetStatus[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [ideasOpen, setIdeasOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);

  useEffect(() => {
    void window.vectrail.getCloudAiConfig().then((cfg) => {
      const ready = Boolean(cfg.apiKey.trim());
      setCloudReady(ready);
      setCloudModel(cfg.model || 'gpt-4o-mini');
    });
    void window.vectrail.getAgentStatuses().then(setAgents);
  }, []);

  const selectTab = (next: MagicBackend) => {
    setBackend(next);
    setIdeasOpen(false);
    setHistoryOpen(false);
    try {
      localStorage.setItem(MAGIC_TAB_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  };

  const mentionQuery = useMemo(() => {
    const m = prompt.match(/@([^\s]*)$/);
    return m ? m[1].toLowerCase() : null;
  }, [prompt]);

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) return [];
    const all = [
      { id: 'playhead', label: 'playhead', sub: 'Current playhead time' },
      ...(selectedIds.length ? [{ id: 'selected', label: 'selected', sub: `${selectedIds.length} selected clip(s)` }] : []),
      ...assets.map((a) => ({ id: a.id, label: a.name.replace(/\s+/g, '_'), sub: a.kind })),
    ];
    return all.filter((o) => o.label.toLowerCase().includes(mentionQuery)).slice(0, 6);
  }, [mentionQuery, assets, selectedIds.length]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  const insertMention = (label: string) => {
    onChangePrompt(prompt.replace(/@([^\s]*)$/, `@${label} `));
  };

  const claudeStatus = agents.find((a) => a.id === 'claudeCode');
  const codexStatus = agents.find((a) => a.id === 'codex');
  const activeExternalStatus = backend === 'claude' ? claudeStatus : backend === 'codex' ? codexStatus : undefined;
  const needsExternalConnect =
    (backend === 'claude' || backend === 'codex') && activeExternalStatus && !activeExternalStatus.connected;
  const missingExternalCli =
    (backend === 'claude' || backend === 'codex') && activeExternalStatus && !activeExternalStatus.installed;

  const handleConnectExternal = async () => {
    if (!activeExternalStatus || connecting) return;
    setConnecting(true);
    try {
      const next = await window.vectrail.connectAgent(activeExternalStatus.id);
      setAgents(next);
    } finally {
      setConnecting(false);
    }
  };

  const backends: Array<{ id: MagicBackend; label: string; dot: string }> = [
    { id: 'claude', label: 'Claude', dot: '#D97757' },
    { id: 'codex', label: 'Codex', dot: '#10A37F' },
    { id: 'cloud', label: 'Cloud AI', dot: '#FF6B35' },
    { id: 'local', label: 'Local', dot: '#EAECEF' },
  ];

  const placeholder = (() => {
    const name = backends.find((b) => b.id === backend)?.label ?? 'Magic';
    if (backend === 'local') {
      return hasEdit
        ? 'Describe what to change (length, pace, look, music, vertical), or leave empty to polish the cut.'
        : 'Describe the video you want (length, pace, look, music, vertical), or leave empty for the best cut.';
    }
    return hasEdit
      ? `Describe what to change, or leave empty and ${name} will make the best edit it can.`
      : `Describe the video you want, or leave empty and ${name} will cut from your Media.`;
  })();

  const submitWithOptions = () => {
    if (backend === 'claude' || backend === 'codex') {
      onSubmit(prompt, backend, { model: cliModels[backend], effort: cliEffort });
    } else {
      onSubmit(prompt, backend);
    }
  };

  return (
    <div className="fixed top-11 right-[112px] z-50 w-[392px]">
      <div
        className="rounded-xl p-3.5 space-y-2.5 shadow-2xl backdrop-blur-md"
        style={{ background: 'var(--panel)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div
          className="grid grid-cols-4 gap-0.5 p-0.5 rounded-lg"
          style={{ background: 'var(--bg)' }}
        >
          {backends.map((b) => {
            const active = backend === b.id;
            return (
              <button
                key={b.id}
                onClick={() => selectTab(b.id)}
                className="inline-flex items-center justify-center gap-1.5 h-7 rounded-md text-[11px] font-semibold transition-colors"
                style={{
                  background: active ? 'var(--raised)' : 'transparent',
                  color: active ? 'var(--text)' : 'var(--text-dim)',
                  border: active ? '1px solid rgba(255,255,255,0.08)' : '1px solid transparent',
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: b.dot }} />
                {b.label}
              </button>
            );
          })}
        </div>

        {missingExternalCli ? (
          <div className="py-4 px-3 text-center space-y-2.5">
            <div className="text-[13px] font-semibold">
              Install {backend === 'claude' ? 'Claude Code' : 'Codex CLI'}
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
              {backend === 'claude'
                ? 'Claude Code CLI was not detected on PATH. Install it, then connect Vectrail in one click.'
                : 'Codex CLI was not detected on PATH. Install it, then connect Vectrail in one click.'}
            </div>
            <div className="flex justify-center gap-2 pt-1">
              <button
                onClick={onOpenSettings}
                className="px-3.5 py-1.5 rounded-full text-[11px] font-semibold"
                style={{ background: 'var(--text)', color: 'var(--on-text)' }}
              >
                Open AI Agents
              </button>
            </div>
          </div>
        ) : needsExternalConnect ? (
          <div className="py-4 px-3 text-center space-y-2.5">
            <div className="text-[13px] font-semibold">
              Connect {backend === 'claude' ? 'Claude' : 'Codex'}
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
              Let {backend === 'claude' ? 'Claude' : 'Codex'} edit directly through Vectrail&apos;s MCP server using your own plan.
            </div>
            <div className="flex flex-col items-center gap-1.5 pt-1">
              <button
                disabled={connecting}
                onClick={() => void handleConnectExternal()}
                className="px-4 py-1.5 rounded-full text-[11px] font-semibold"
                style={{ background: 'var(--text)', color: 'var(--on-text)' }}
              >
                {connecting ? 'Connecting...' : `Connect ${backend === 'claude' ? 'Claude' : 'Codex'}`}
              </button>
              <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                No extra API key needed
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between pt-0.5">
              <span className="text-[12.5px] font-semibold">
                {hasEdit ? 'What should change?' : 'What should it make?'}
              </span>
              <div className="flex items-center gap-1 relative">
                <button
                  onClick={() => {
                    setIdeasOpen((v) => !v);
                    setHistoryOpen(false);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px]"
                  style={{ background: 'var(--button)', color: 'var(--text-dim)' }}
                >
                  <Lightbulb size={11} /> Ideas <ChevronDown size={10} />
                </button>
                {history.length > 0 && (
                  <button
                    onClick={() => {
                      setHistoryOpen((v) => !v);
                      setIdeasOpen(false);
                    }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px]"
                    style={{ background: 'var(--button)', color: 'var(--text-dim)' }}
                    title="Prompt history"
                  >
                    <History size={11} />
                  </button>
                )}
                <button onClick={onClose} className="p-0.5 rounded" style={{ color: 'var(--text-dim)' }} title="Close (Esc)">
                  <X size={13} />
                </button>

                {ideasOpen && (
                  <div
                    className="absolute right-0 top-7 z-50 w-64 rounded-lg p-1.5 shadow-2xl space-y-1 max-h-72 overflow-y-auto"
                    style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
                  >
                    {hasEdit && (
                      <>
                        <div className="px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                          Improve
                        </div>
                        {IDEAS_IMPROVE.map((idea) => (
                          <button
                            key={idea.name}
                            onClick={() => {
                              onChangePrompt(idea.prompt);
                              setIdeasOpen(false);
                            }}
                            className="w-full text-left px-2 py-1 rounded text-[11px] hover:bg-white/5"
                            style={{ color: 'var(--text)' }}
                          >
                            {idea.name}
                          </button>
                        ))}
                      </>
                    )}
                    <div className="px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                      Create
                    </div>
                    {IDEAS_CREATE.map((idea) => (
                      <button
                        key={idea.name}
                        onClick={() => {
                          onChangePrompt(idea.prompt);
                          setIdeasOpen(false);
                        }}
                        className="w-full text-left px-2 py-1 rounded text-[11px] hover:bg-white/5"
                        style={{ color: 'var(--text)' }}
                      >
                        {idea.name}
                      </button>
                    ))}
                    <div className="px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                      Sound
                    </div>
                    {IDEAS_SOUND.map((idea) => (
                      <button
                        key={idea.name}
                        onClick={() => {
                          onChangePrompt(idea.prompt);
                          setIdeasOpen(false);
                        }}
                        className="w-full text-left px-2 py-1 rounded text-[11px] hover:bg-white/5"
                        style={{ color: 'var(--text)' }}
                      >
                        {idea.name}
                      </button>
                    ))}
                  </div>
                )}

                {historyOpen && (
                  <div
                    className="absolute right-0 top-7 z-50 w-72 rounded-lg p-1.5 shadow-2xl space-y-0.5 max-h-64 overflow-y-auto"
                    style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
                  >
                    {history.map((h, i) => (
                      <button
                        key={`${h.timestamp}-${i}`}
                        onClick={() => {
                          onChangePrompt(h.text);
                          setHistoryOpen(false);
                        }}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left text-[11px] hover:bg-white/5"
                      >
                        <span className="truncate" style={{ color: 'var(--text)' }}>
                          {h.text}
                        </span>
                        <span
                          className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-semibold capitalize"
                          style={{ background: 'var(--raised)', color: 'var(--text-dim)' }}
                        >
                          {h.tab}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <textarea
              autoFocus
              rows={3}
              value={prompt}
              onChange={(e) => onChangePrompt(e.target.value)}
              placeholder={placeholder}
              className="w-full p-2.5 rounded-lg text-[12px] outline-none resize-none"
              style={{ background: 'var(--sheet-field)', color: 'var(--text)', border: '1px solid var(--sheet-field-stroke)' }}
              onKeyDown={(e) => {
                if (mentionOptions.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setMentionIndex((i) => (i + 1) % mentionOptions.length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length);
                    return;
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault();
                    insertMention(mentionOptions[mentionIndex].label);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitWithOptions();
                  return;
                }
                if (e.key === 'Escape') onClose();
              }}
            />

            {mentionOptions.length > 0 && (
              <div
                className="rounded-lg p-1 space-y-0.5 max-h-36 overflow-y-auto"
                style={{ background: 'var(--field)', border: '1px solid var(--stroke)' }}
              >
                {mentionOptions.map((opt, idx) => (
                  <button
                    key={opt.id}
                    onClick={() => insertMention(opt.label)}
                    className="w-full flex items-center justify-between px-2 py-1 rounded text-[11px]"
                    style={{
                      background: idx === mentionIndex ? 'var(--hover)' : 'transparent',
                      color: 'var(--text)',
                    }}
                  >
                    <span>@{opt.label}</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                      {opt.sub}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between pt-0.5">
              <div className="text-[10.5px] flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--text-faint)' }}>
                {backend === 'cloud' ? (
                  cloudReady ? (
                    <span>Model: {cloudModel}</span>
                  ) : (
                    <button onClick={onOpenSettings} className="underline" style={{ color: 'var(--accent)' }}>
                      Configure API Key in Settings
                    </button>
                  )
                ) : backend === 'local' ? (
                  <span>Instant beat &amp; rule planner · On this PC</span>
                ) : (
                  <>
                    <select
                      value={cliModels[backend]}
                      onChange={(e) => {
                        const next = { ...cliModels, [backend]: e.target.value };
                        setCliModels(next);
                        try {
                          localStorage.setItem('vectrail.magicCliModels.v1', JSON.stringify(next));
                        } catch {
                          // ignore
                        }
                      }}
                      className="px-2 py-0.5 rounded-full text-[10px] outline-none"
                      style={{ background: 'var(--button)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                      title="Model"
                    >
                      {MAGIC_AGENT_MODELS[backend].map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={cliEffort}
                      onChange={(e) => {
                        setCliEffort(e.target.value);
                        try {
                          localStorage.setItem('vectrail.magicCliEffort.v1', e.target.value);
                        } catch {
                          // ignore
                        }
                      }}
                      className="px-2 py-0.5 rounded-full text-[10px] outline-none"
                      style={{ background: 'var(--button)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                      title="Reasoning effort"
                    >
                      {MAGIC_EFFORTS.map((ef) => (
                        <option key={ef.id} value={ef.id}>
                          {ef.label}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              <button
                disabled={backend === 'cloud' && !cloudReady}
                onClick={submitWithOptions}
                className="px-4 py-1.5 rounded-full text-[11px] font-semibold disabled:opacity-40"
                style={{ background: 'var(--text)', color: 'var(--on-text)' }}
              >
                Make it
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export const MagicNotePopover: React.FC<{
  worker: string;
  detail?: string;
  summary: string;
  changed: boolean;
  onUndo: () => void;
  onClose: () => void;
}> = ({ worker, detail, summary, changed, onUndo, onClose }) => {
  return (
    <div className="fixed top-11 right-[112px] z-50 w-[340px]">
      <div
        className="rounded-xl p-3.5 space-y-2.5 shadow-2xl backdrop-blur-md"
        style={{ background: 'var(--panel)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div className="flex items-center gap-2">
          <Sparkles size={13} style={{ color: 'var(--accent)' }} />
          <span className="text-[12px] font-semibold">{worker}</span>
          {detail && (
            <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
              {detail}
            </span>
          )}
        </div>
        <div className="text-[12px] leading-relaxed select-text" style={{ color: 'var(--text)' }}>
          {summary || 'Done.'}
        </div>
        <div className="flex items-center justify-between pt-0.5">
          {changed ? (
            <button
              onClick={() => {
                onClose();
                onUndo();
              }}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-medium"
              style={{ background: 'var(--button)', color: 'var(--text)' }}
            >
              <RotateCcw size={11} /> Undo
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={onClose}
            className="px-3.5 py-1 rounded-full text-[11px] font-semibold"
            style={{ background: 'var(--text)', color: 'var(--on-text)' }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export const SettingsModal: React.FC<{
  theme: AppThemeName;
  shortcutMap: Record<string, string>;
  magicAnimated?: boolean;
  onChangeMagicAnimated?: (enabled: boolean) => void;
  onUpdateShortcuts: (next: Record<string, string>) => void;
  onChangeTheme: (t: AppThemeName) => void;
  onClose: () => void;
}> = ({ theme, shortcutMap, magicAnimated = true, onChangeMagicAnimated, onUpdateShortcuts, onChangeTheme, onClose }) => {
  const [tab, setTab] = useState<'general' | 'shortcuts'>('general');
  const [mcp, setMcp] = useState<MCPStatusInfo | null>(null);
  const [agents, setAgents] = useState<AgentTargetStatus[]>([]);
  const [whisper, setWhisper] = useState<WhisperStatus | null>(null);
  const [cloudAi, setCloudAi] = useState<CloudAiConfig>({ baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' });
  const [cloudStatus, setCloudStatus] = useState('');
  const [cloudBusy, setCloudBusy] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlErr, setDlErr] = useState('');
  const [autoSave, setAutoSave] = useState(true);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null);

  useEffect(() => {
    void window.vectrail.getMcpStatus().then(setMcp);
    void window.vectrail.getAgentStatuses().then(setAgents);
    void window.vectrail.getWhisperStatus().then(setWhisper);
    void window.vectrail.getCloudAiConfig().then(setCloudAi);
    void window.vectrail.getAutoSave().then(setAutoSave);
  }, []);

  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecordingId(null);
        return;
      }
      const combo = formatEventCombo(e);
      if (!combo) return;
      const next = { ...shortcutMap, [recordingId]: combo };
      onUpdateShortcuts(next);
      setRecordingId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recordingId, shortcutMap, onUpdateShortcuts]);

  const toggleAgent = async (item: AgentTargetStatus) => {
    const next = item.connected
      ? await window.vectrail.disconnectAgent(item.id as AgentTarget)
      : await window.vectrail.connectAgent(item.id as AgentTarget);
    setAgents(next);
  };

  const bindings = mergeShortcutBindings(shortcutMap);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div
        className="w-[520px] max-h-[82vh] flex flex-col rounded-xl p-4 space-y-3"
        style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold mr-2">Settings</span>
            {(['general', 'shortcuts'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="px-2.5 py-0.5 rounded text-[11px] capitalize"
                style={{
                  background: tab === t ? 'var(--raised)' : 'transparent',
                  color: tab === t ? 'var(--text)' : 'var(--text-dim)',
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-dim)' }}>
            <X size={15} />
          </button>
        </div>

        {tab === 'general' ? (
          <div className="space-y-4 overflow-y-auto pr-1">
            <div>
          <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
            APPEARANCE
          </div>
          <div className="flex gap-2">
            {(Object.keys(THEMES) as AppThemeName[]).map((name) => (
              <button
                key={name}
                onClick={() => onChangeTheme(name)}
                className="flex-1 py-1.5 rounded text-[11px] capitalize"
                style={{
                  background: theme === name ? 'var(--accent)' : 'var(--sheet-field)',
                  color: theme === name ? '#FFF' : 'var(--text)',
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
            CLOUD AI (OPENAI-COMPATIBLE API)
          </div>
          <div
            className="p-2.5 rounded space-y-2"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
          >
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <label>
                Base URL
                <input
                  value={cloudAi.baseUrl}
                  onChange={(e) => setCloudAi({ ...cloudAi, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="mono-num mt-1 w-full px-2 py-1 rounded outline-none"
                  style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
                />
              </label>
              <label>
                Model
                <input
                  value={cloudAi.model}
                  onChange={(e) => setCloudAi({ ...cloudAi, model: e.target.value })}
                  placeholder="gpt-4o-mini"
                  className="mono-num mt-1 w-full px-2 py-1 rounded outline-none"
                  style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
                />
              </label>
            </div>
            <label className="block text-[11px]">
              API Key
              <input
                type="password"
                value={cloudAi.apiKey}
                onChange={(e) => setCloudAi({ ...cloudAi, apiKey: e.target.value })}
                placeholder="sk-..."
                className="mono-num mt-1 w-full px-2 py-1 rounded outline-none"
                style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
              />
            </label>
            <div className="flex items-center justify-between pt-0.5">
              <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
                {cloudStatus || 'Used by Magic -> Cloud AI'}
              </span>
              <div className="flex gap-1.5">
                <button
                  disabled={cloudBusy}
                  onClick={async () => {
                    setCloudBusy(true);
                    setCloudStatus('Testing...');
                    const saved = await window.vectrail.saveCloudAiConfig(cloudAi);
                    setCloudAi(saved);
                    const res = await window.vectrail.testCloudAiConnection(saved);
                    setCloudStatus(res.message);
                    setCloudBusy(false);
                  }}
                  className="px-2.5 py-1 rounded text-[11px]"
                  style={{ background: 'var(--button)', color: 'var(--text)' }}
                >
                  Test
                </button>
                <button
                  onClick={async () => {
                    const saved = await window.vectrail.saveCloudAiConfig(cloudAi);
                    setCloudAi(saved);
                    setCloudStatus('Saved');
                  }}
                  className="px-2.5 py-1 rounded text-[11px] font-medium"
                  style={{ background: 'var(--accent)', color: '#FFF' }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-dim)' }}>
              AI AGENTS & MCP SERVER
            </span>
            {mcp && (
              <label className="flex items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={mcp.enabled}
                  onChange={async (e) => setMcp(await window.vectrail.setMcpEnabled(e.target.checked))}
                />
                Enabled
              </label>
            )}
          </div>
          {mcp && (
            <div
              className="mono-num px-2.5 py-1.5 rounded text-[11px] mb-2.5 flex items-center justify-between"
              style={{ background: 'var(--sheet-field)', color: 'var(--text-dim)' }}
            >
              <span>{mcp.endpoint}</span>
              <span style={{ color: mcp.running ? '#30D158' : 'var(--text-faint)' }}>
                {mcp.running ? 'LISTENING' : 'OFF'}
              </span>
            </div>
          )}
          <div className="space-y-1.5">
            {agents.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between px-2.5 py-2 rounded"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div>
                  <div className="text-[12px] font-medium">{a.title}</div>
                  <div className="mono-num text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {a.detail}
                  </div>
                </div>
                <button
                  onClick={() => void toggleAgent(a)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px]"
                  style={{
                    background: a.connected ? 'rgba(48, 209, 88, 0.16)' : 'var(--button)',
                    color: a.connected ? '#30D158' : 'var(--text)',
                  }}
                >
                  {a.connected ? <Check size={12} /> : <Plug size={12} />}
                  {a.connected ? 'Connected' : 'Connect'}
                </button>
              </div>
            ))}
          </div>
          <div
            className="flex items-center justify-between px-2.5 py-2 rounded mt-2"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
          >
            <div>
              <div className="text-[11px] font-medium">Connect another AI app</div>
              <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                Copy MCP setup prompt for Cursor, Windsurf, or custom clients
              </div>
            </div>
            <button
              onClick={() => {
                const endpoint = mcp?.endpoint ?? 'http://127.0.0.1:47920/mcp';
                const text = `Connect to the local Vectrail MCP video editor server at ${endpoint} (HTTP JSON-RPC 2.0 POST, or check %APPDATA%\\Vectrail\\Runtime\\mcp-port.json for the active port) and call initialize + tools/list to start editing.`;
                void navigator.clipboard.writeText(text);
                setCopiedPrompt(true);
                setTimeout(() => setCopiedPrompt(false), 1600);
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px]"
              style={{ background: 'var(--button)', color: 'var(--text)' }}
            >
              {copiedPrompt ? <Check size={11} /> : <Copy size={11} />}
              {copiedPrompt ? 'Copied' : 'Copy Prompt'}
            </button>
          </div>
        </div>

            <div>
              <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
                WHISPER SPEECH TRANSCRIPTION
              </div>
              <div
                className="flex items-center justify-between px-2.5 py-2 rounded"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div>
                  <div className="text-[11px] font-medium">
                    {whisper?.modelName ? `Model ready: ${whisper.modelName}` : 'No Whisper GGML model downloaded'}
                  </div>
                  <div className="mono-num text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {whisper?.supported ? 'FFmpeg whisper.cpp filter available' : 'Whisper filter unavailable'}
                  </div>
                  {dlErr && <div className="text-[10px] text-red-400 mt-0.5">{dlErr}</div>}
                </div>
                <button
                  disabled={dlBusy || !whisper?.supported}
                  onClick={async () => {
                    setDlBusy(true);
                    setDlErr('');
                    try {
                      await window.vectrail.downloadWhisperModel('tiny');
                      setWhisper(await window.vectrail.getWhisperStatus());
                    } catch (err) {
                      setDlErr(err instanceof Error ? err.message : String(err));
                    } finally {
                      setDlBusy(false);
                    }
                  }}
                  className="px-2.5 py-1 rounded text-[11px]"
                  style={{ background: 'var(--button)', color: 'var(--text)' }}
                >
                  {dlBusy ? 'Downloading...' : whisper?.modelPath ? 'Ready' : 'Download Tiny (75 MB)'}
                </button>
              </div>
            </div>

            <div>
              <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
                PROJECT & UPDATES
              </div>
              <label
                className="flex items-center justify-between px-2.5 py-2 rounded mb-2 cursor-pointer"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div>
                  <div className="text-[11px] font-medium">Auto-save saved projects</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    Automatically writes edits to the opened .vectrail file
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={autoSave}
                  onChange={async (e) => setAutoSave(await window.vectrail.setAutoSave(e.target.checked))}
                />
              </label>
              <label
                className="flex items-center justify-between px-2.5 py-2 rounded mb-2 cursor-pointer"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div>
                  <div className="text-[11px] font-medium">Show AI animations &amp; cursors</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    Scan brackets, shimmer dots, ghost previews, and live AI cursors
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={magicAnimated}
                  onChange={async (e) => {
                    const val = await window.vectrail.setMagicAnimated(e.target.checked);
                    onChangeMagicAnimated?.(val);
                  }}
                />
              </label>
              <div
                className="flex items-center justify-between px-2.5 py-2 rounded"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div>
                  <div className="text-[11px] font-medium">Vectrail v1.0.0 · Built by Makur</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {updateInfo
                      ? updateInfo.error
                        ? updateInfo.error
                        : updateInfo.hasUpdate
                        ? `New version v${updateInfo.latestVersion} available`
                        : `Up to date (v${updateInfo.currentVersion})`
                      : 'Inspired by Editroom for macOS'}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  {updateInfo?.hasUpdate && updateInfo.releaseUrl && (
                    <button
                      onClick={() => void window.vectrail.openExternalUrl(updateInfo.releaseUrl!)}
                      className="px-2.5 py-1 rounded text-[11px] font-medium"
                      style={{ background: 'var(--accent)', color: '#FFF' }}
                    >
                      Download
                    </button>
                  )}
                  <button
                    disabled={updateBusy}
                    onClick={async () => {
                      setUpdateBusy(true);
                      setUpdateInfo(await window.vectrail.checkForUpdates());
                      setUpdateBusy(false);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px]"
                    style={{ background: 'var(--button)', color: 'var(--text)' }}
                  >
                    <RefreshCw size={11} className={updateBusy ? 'animate-spin' : ''} />
                    Check
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                Click any binding and press a new key combination.
              </span>
              <button
                onClick={() => {
                  const defaults: Record<string, string> = {};
                  DEFAULT_SHORTCUTS.forEach((b) => (defaults[b.id] = b.combo));
                  onUpdateShortcuts(defaults);
                }}
                className="px-2 py-0.5 rounded text-[10px]"
                style={{ background: 'var(--button)', color: 'var(--chip)' }}
              >
                Reset Defaults
              </button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {bindings.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between px-2.5 py-1.5 rounded"
                  style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
                >
                  <span className="text-[11px]">{b.label}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setRecordingId(b.id)}
                      className="mono-num px-2 py-0.5 rounded text-[10px]"
                      style={{
                        background: recordingId === b.id ? 'var(--accent)' : 'var(--button)',
                        color: recordingId === b.id ? '#FFF' : b.combo ? 'var(--text)' : 'var(--text-faint)',
                      }}
                    >
                      {recordingId === b.id ? 'Press key...' : b.combo || 'None'}
                    </button>
                    {b.combo && (
                      <button
                        onClick={() => onUpdateShortcuts({ ...shortcutMap, [b.id]: '' })}
                        className="p-1 rounded hover:opacity-80"
                        style={{ color: 'var(--text-faint)' }}
                        title="Clear shortcut"
                      >
                        <X size={11} />
                      </button>
                    )}
                    {b.combo !== DEFAULT_SHORTCUTS.find((d) => d.id === b.id)?.combo && (
                      <button
                        onClick={() => {
                          const defCombo = DEFAULT_SHORTCUTS.find((d) => d.id === b.id)?.combo ?? '';
                          onUpdateShortcuts({ ...shortcutMap, [b.id]: defCombo });
                        }}
                        className="p-1 rounded hover:opacity-80"
                        style={{ color: 'var(--text-dim)' }}
                        title="Restore default"
                      >
                        <RotateCcw size={10} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
