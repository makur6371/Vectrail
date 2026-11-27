import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  Lightbulb,
  Loader2,
  Plug,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  AppUpdateInfo,
  CloudAiConfig,
  ExportSettings,
  MagicHistoryEntry,
  MagicRunRecord,
  MagicStage,
  MediaAsset,
  Project,
  ScrubStripInfo,
  Transcript,
} from '../../shared/types';
import { AppThemeName, THEMES } from '../../shared/themes';
import { AgentTarget, AgentTargetStatus, MagicBackend } from '../../main/magic/agentConnect';
import { MCPStatusInfo } from '../../preload';
import { computeExportRenderSize, formatTimecode, projectDuration } from '../../shared/project';
import { buildClipLabels, buildMarkerLabels, formatClock } from '../../shared/magicMentions';
import { DEFAULT_SHORTCUTS, formatEventCombo, mergeShortcutBindings, ShortcutActionId } from '../../shared/shortcuts';
import type { WhisperStatus } from '../../main/engine/analyzer';
import type { FfmpegStatus } from '../../main/engine/ffmpeg';
import type { PluginSummary } from '../../shared/djiTypes';
import { EDITING_SKILLS_32, EDITING_TEMPLATES } from '../../shared/editingTemplates';
import { PreviewCompositor } from '../engine/compositor';
import { useI18n } from '../i18n';

const THEME_LABELS_ZH: Record<AppThemeName, string> = {
  dark: '深黑',
  grey: '深灰',
  amber: '琥珀',
  light: '浅白',
};

const SHORTCUT_LABELS_ZH: Record<ShortcutActionId, string> = {
  playPause: '播放 / 暂停',
  shuttleReverse: '倒放倍速',
  shuttlePause: '穿梭暂停',
  shuttleForward: '快进倍速',
  stepBack: '上一帧',
  stepForward: '下一帧',
  previousEdit: '上一剪辑点',
  nextEdit: '下一剪辑点',
  split: '在播放头处分割',
  addDissolve: '在播放头添加叠化',
  deleteClip: '删除所选片段',
  rippleDelete: '波纹删除',
  rippleTrimStart: '波纹裁剪起点至播放头',
  rippleTrimEnd: '波纹裁剪终点至播放头',
  closeAllGaps: '清除所有空隙',
  markIn: '设置入点',
  markOut: '设置出点',
  clearInOut: '清除入/出点',
  addMarker: '添加标记',
  selectTool: '选择工具',
  cutTool: '剃刀工具',
  toggleSnap: '切换吸附',
  toggleSticky: '切换磁吸边沿',
  toggleStrip: '切换胶片条',
  toggleSkim: '切换浏览',
  toggleAudioScrub: '切换音频擦洗',
  toggleLoop: '切换循环播放',
  fullscreen: '全屏检视器',
  zoomIn: '时间轴放大',
  zoomOut: '时间轴缩小',
  zoomToFit: '缩放至适配',
  selectAll: '全选片段',
  copyClips: '复制片段',
  cutClips: '剪切片段',
  pasteClips: '粘贴片段',
  undo: '撤销',
  redo: '重做',
  copyGrade: '复制调色参数',
  pasteGrade: '粘贴调色参数',
  importMedia: '导入媒体',
  saveProject: '保存工程',
  exportVideo: '导出视频',
  magic: '打开魔法栏',
};

export const ExportModal: React.FC<{
  project: Project;
  title: string;
  transcripts?: Record<string, Transcript>;
  scrubStrips?: Record<string, ScrubStripInfo>;
  onClose: () => void;
  onStart: (s: ExportSettings) => void;
}> = ({ project, title, transcripts = {}, scrubStrips = {}, onClose, onStart }) => {
  const { L } = useI18n();
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
    previewCompRef.current?.setScrubStrips(scrubStrips);
    const draw = () => {
      const canvas = previewCanvasRef.current;
      if (!canvas || !previewCompRef.current) return;
      const previewProj: Project = { ...project };
      previewCompRef.current.syncMediaElements(previewProj, previewTime, false);
      previewCompRef.current.renderFrame(canvas, previewProj, previewTime, transcripts);
    };
    previewCompRef.current?.setOnReady(draw);
    draw();
    return () => {
      previewCompRef.current?.setOnReady(undefined);
    };
  }, [format, project, previewTime, transcripts, scrubStrips]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div
        className="w-[460px] rounded-xl p-4 space-y-3 shadow-2xl"
        style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold">{L('导出', 'Export')}</span>
          <button onClick={onClose} className="vt-hover p-1 rounded" style={{ color: 'var(--text-dim)' }}>
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
                title={isReframed ? L('拖动以调整导出裁剪区域', 'Drag to reframe export crop') : undefined}
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
                  style={{ background: 'rgba(0,0,0,0.68)', color: '#D4D4D0' }}
                >
                  {L('拖动裁剪框', 'Drag to reframe')}
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
          {L('文件名', 'File Name')}
          <input
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            className="mt-1 w-full px-2 py-1.5 rounded outline-none"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)', color: 'var(--text)' }}
          />
        </label>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <label>
            {L('格式', 'Format')}
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as 'video' | 'audio')}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)', color: 'var(--text)' }}
            >
              <option value="video" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('视频 (MP4)', 'Video (MP4)')}</option>
              <option value="audio" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('音频 (WAV)', 'Audio (WAV)')}</option>
            </select>
          </label>
          <label>
            {L('画面比例', 'Shape')}
            <select
              value={shape}
              disabled={format === 'audio'}
              onChange={(e) => setShape(e.target.value as typeof shape)}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)', color: 'var(--text)' }}
            >
              <option value="original" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L(`序列 (${project.width}x${project.height})`, `Sequence (${project.width}x${project.height})`)}</option>
              <option value="vertical" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('竖屏 9:16', 'Vertical 9:16')}</option>
              <option value="square" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('方形 1:1', 'Square 1:1')}</option>
              <option value="portrait" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('人像 4:5', 'Portrait 4:5')}</option>
            </select>
          </label>
          <label>
            {L('分辨率', 'Resolution')}
            <select
              value={height}
              disabled={format === 'audio'}
              onChange={(e) => setHeight(Number(e.target.value))}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)', color: 'var(--text)' }}
            >
              <option value={720} style={{ background: 'var(--panel)', color: 'var(--text)' }}>720p</option>
              <option value={1080} style={{ background: 'var(--panel)', color: 'var(--text)' }}>1080p</option>
              <option value={2160} style={{ background: 'var(--panel)', color: 'var(--text)' }}>4K (2160p)</option>
            </select>
          </label>
          <label>
            {L('编码与画质', 'Codec & Quality')}
            <select
              value={`${codec}-${quality}`}
              disabled={format === 'audio'}
              onChange={(e) => {
                const [c, q] = e.target.value.split('-');
                setCodec(c as 'h264' | 'hevc');
                setQuality(q as 'high' | 'web');
              }}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)', color: 'var(--text)' }}
            >
              <option value="h264-high" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('H.264 高画质', 'H.264 High')}</option>
              <option value="h264-web" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('H.264 网页', 'H.264 Web')}</option>
              <option value="hevc-high" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('HEVC 高画质', 'HEVC High')}</option>
            </select>
          </label>
        </div>

        <div className="flex items-center justify-between text-[11px]">
          <span>{L('响度目标', 'Loudness Target')}</span>
          <select
            value={loudness}
            onChange={(e) => setLoudness(e.target.value)}
            className="px-2 py-1 rounded outline-none"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)', color: 'var(--text)' }}
          >
            <option value="" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('原始音量', 'Original levels')}</option>
            <option value="-14" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('-14 LUFS (网络视频 / 社交平台)', '-14 LUFS (YouTube / Social)')}</option>
            <option value="-16" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('-16 LUFS (播客)', '-16 LUFS (Podcast)')}</option>
            <option value="-23" style={{ background: 'var(--panel)', color: 'var(--text)' }}>{L('-23 LUFS (广播标准)', '-23 LUFS (Broadcast)')}</option>
          </select>
        </div>

        {project.playRange && (
          <label className="flex items-center gap-2 text-[11px]">
            <input type="checkbox" checked={rangeOnly} onChange={(e) => setRangeOnly(e.target.checked)} />
            {L('仅导出入/出点范围', 'Export In/Out range only')}
          </label>
        )}
        {format === 'video' && (
          <label className="flex items-center gap-2 text-[11px]">
            <input type="checkbox" checked={includeAudio} onChange={(e) => setIncludeAudio(e.target.checked)} />
            {L('包含音轨混音', 'Include audio track mix')}
          </label>
        )}
        <label className="flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={enhanceDetail || isUpscaling}
            onChange={(e) => setEnhanceDetail(e.target.checked)}
          />
          <span>{L(`增强细节 (Lanczos + CAS 锐化${isUpscaling ? ' · 放大时自动启用' : ''})`, `Enhance detail (Lanczos + CAS sharpen${isUpscaling ? ' · auto on upscale' : ''})`)}</span>
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
            {L('开始导出...', 'Export...')}
          </button>
        </div>
      </div>
    </div>
  );
};

interface MagicIdea {
  name: string;
  nameZh: string;
  prompt: string;
  promptZh: string;
}

const IDEAS_IMPROVE: MagicIdea[] = [
  {
    name: 'Tighten it',
    nameZh: '紧凑剪辑',
    prompt: 'Make this shorter so people keep watching: trim slow starts and ends of shots.',
    promptZh: '让整体节奏更紧凑以留住观众：裁剪镜头拖沓的开头和结尾。',
  },
  {
    name: 'Cut to the beat',
    nameZh: '踩点快剪',
    prompt: 'Recut this to the beat of the music with energetic pacing.',
    promptZh: '跟随背景音乐节拍重新剪辑，打造富有活力的节奏感。',
  },
  {
    name: 'Smooth it out',
    nameZh: '丝滑过渡',
    prompt: 'Smooth this out with clean dissolve transitions and balanced levels.',
    promptZh: '使用自然的叠化转场和均衡音量，让整条成片更流畅顺滑。',
  },
  {
    name: 'One look',
    nameZh: '统一影调',
    prompt: 'Give every shot the Warm film look so it feels like one cohesive film.',
    promptZh: '为所有镜头统一应用「暖色胶片」滤镜，呈现电影级统一视觉风格。',
  },
];

const IDEAS_CREATE: MagicIdea[] = [
  {
    name: 'Highlight reel',
    nameZh: '精彩集锦',
    prompt: 'Make a 30 second highlight cut of the best moments to the beat of the music.',
    promptZh: '挑选最佳画面结合音乐节拍剪出一段 30 秒高光集锦。',
  },
  {
    name: 'Vertical reel',
    nameZh: '9:16 竖屏短片',
    prompt: 'Make a fast 20 second vertical 9:16 video for Reels and TikTok, cut to the beat.',
    promptZh: '制作一段 20 秒 9:16 竖屏短视频，配合音乐节拍快剪。',
  },
  {
    name: 'Timelapse',
    nameZh: '延时混剪',
    prompt: 'Make a timelapse over the music: speed every shot up 8x.',
    promptZh: '配合背景音乐制作延时视频：将每个镜头加速至 8 倍。',
  },
  {
    name: 'Calm cut',
    nameZh: '舒缓叙事',
    prompt: 'Make a calm 45 second story cut with Film print look and gentle dissolves.',
    promptZh: '剪一段 45 秒舒缓叙事短片，应用「胶片冲印」影调与柔和叠化转场。',
  },
];

const IDEAS_SOUND: MagicIdea[] = [
  {
    name: 'Even out levels',
    nameZh: '均衡音量',
    prompt: 'Make all audio clips the same output level.',
    promptZh: '将所有音频片段的响度均衡至同一输出水准。',
  },
];

const MAGIC_TAB_STORAGE_KEY = 'vectrail.magicTab.v1';

export function loadSavedMagicTab(): MagicBackend {
  try {
    const v = localStorage.getItem(MAGIC_TAB_STORAGE_KEY);
    if (v === 'claude' || v === 'codex' || v === 'cloud' || v === 'local') return v;
  } catch {
    // ignore storage errors
  }
  return 'local';
}

export function saveMagicTab(next: MagicBackend): void {
  try {
    localStorage.setItem(MAGIC_TAB_STORAGE_KEY, next);
  } catch {
    // ignore storage errors
  }
}

function formatClockTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

const MAGIC_AGENT_MODELS: Record<'claude' | 'codex', Array<{ id: string; label: string; labelZh?: string }>> = {
  claude: [
    { id: '', label: 'CLI Default', labelZh: 'CLI 默认' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  codex: [
    { id: '', label: 'CLI Default', labelZh: 'CLI 默认' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  ],
};

const MAGIC_EFFORTS = [
  { id: '', label: 'Default', labelZh: '默认思考' },
  { id: 'low', label: 'Low', labelZh: '低' },
  { id: 'medium', label: 'Medium', labelZh: '中' },
  { id: 'high', label: 'High', labelZh: '高' },
  { id: 'xhigh', label: 'Extra high', labelZh: '极高' },
];

export const MagicPopover: React.FC<{
  project: Project;
  assets: MediaAsset[];
  selectedIds: string[];
  hasEdit: boolean;
  backend: MagicBackend;
  panelTab: 'run' | 'templates' | 'activity';
  width?: number;
  isRunning: boolean;
  activeStatus?: { worker: string; stage: MagicStage; status?: string } | null;
  completionNote?: { worker: string; detail?: string; summary: string; changed: boolean } | null;
  records: MagicRunRecord[];
  prompt: string;
  history: MagicHistoryEntry[];
  onChangeBackend: (b: MagicBackend) => void;
  onChangePanelTab: (t: 'run' | 'templates' | 'activity') => void;
  onChangePrompt: (p: string) => void;
  onSubmit: (prompt: string, backend: MagicBackend, options?: { model?: string; effort?: string }) => void;
  onStop: () => void;
  onUndo: () => void;
  onDismissNote?: () => void;
  onClearRecords: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}> = ({
  project,
  assets,
  selectedIds,
  hasEdit,
  backend,
  panelTab,
  width = 376,
  isRunning,
  activeStatus,
  completionNote,
  records,
  prompt,
  history,
  onChangeBackend,
  onChangePanelTab,
  onChangePrompt,
  onSubmit,
  onStop,
  onUndo,
  onDismissNote,
  onClearRecords,
  onOpenSettings,
  onClose,
}) => {
  const { locale, L } = useI18n();
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudModel, setCloudModel] = useState('gpt-4o-mini');
  const [cliModels, setCliModels] = useState<Record<'claude' | 'codex', string>>(() => {
    try {
      const raw = localStorage.getItem('vectrail.magicCliModels.v2');
      if (raw) return JSON.parse(raw) as Record<'claude' | 'codex', string>;
    } catch {
      // ignore
    }
    return { claude: '', codex: '' };
  });
  const [cliEffort, setCliEffort] = useState<string>(() => {
    try {
      return localStorage.getItem('vectrail.magicCliEffort.v2') ?? '';
    } catch {
      return '';
    }
  });
  const [agents, setAgents] = useState<AgentTargetStatus[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [ideasOpen, setIdeasOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [recordFilter, setRecordFilter] = useState<'all' | MagicBackend | 'external'>('all');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(() => records[0]?.id ?? null);
  const [showSkillMatrix, setShowSkillMatrix] = useState(false);
  const [skillTierFilter, setSkillTierFilter] = useState<'core16' | 'all32'>('core16');

  useEffect(() => {
    void window.vectrail.getCloudAiConfig().then((cfg) => {
      const ready = Boolean(cfg.apiKey.trim());
      setCloudReady(ready);
      setCloudModel(cfg.model || 'gpt-4o-mini');
    });
    void window.vectrail.getAgentStatuses().then(setAgents);
  }, []);

  useEffect(() => {
    if (records[0]?.id && (isRunning || !expandedRunId)) {
      setExpandedRunId(records[0].id);
    }
  }, [records, isRunning, expandedRunId]);

  const selectTab = (next: MagicBackend) => {
    onChangeBackend(next);
    saveMagicTab(next);
    setIdeasOpen(false);
    setHistoryOpen(false);
  };

  const mentionQuery = useMemo(() => {
    const m = prompt.match(/@([^\s]*)$/);
    return m ? m[1].toLowerCase() : null;
  }, [prompt]);

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) return [];
    const clipLabels = buildClipLabels(project);
    const markerLabels = buildMarkerLabels(project);
    const all = [
      { id: 'playhead', label: 'playhead', sub: L('当前播放头位置', 'Current playhead time') },
      ...(selectedIds.length ? [{ id: 'selected', label: 'selected', sub: L(`${selectedIds.length} 个已选片段`, `${selectedIds.length} selected clip(s)`) }] : []),
      ...(project.playRange
        ? [{
            id: 'in-out',
            label: 'in-out',
            sub: `${formatClock(project.playRange.in)}–${formatClock(project.playRange.out)}`,
          }]
        : []),
      ...markerLabels.map((m) => ({ id: `m-${m.id}`, label: `marker:${m.name}`, sub: formatClock(m.time) })),
      ...clipLabels.map((c) => ({ id: `c-${c.id}`, label: `clip:${c.name}`, sub: `${c.track} · ${formatClock(c.start)}` })),
      ...assets.map((a) => ({ id: a.id, label: a.name.replace(/\s+/g, '_'), sub: a.kind })),
    ];
    return all.filter((o) => o.label.toLowerCase().includes(mentionQuery)).slice(0, 8);
  }, [mentionQuery, project, assets, selectedIds.length, L]);

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
    { id: 'cloud', label: L('云端 AI', 'Cloud AI'), dot: '#FF6B35' },
    { id: 'local', label: L('本地引擎', 'Local'), dot: 'var(--text)' },
  ];

  const placeholder = (() => {
    const name = backends.find((b) => b.id === backend)?.label ?? L('魔法', 'Magic');
    if (backend === 'local') {
      return hasEdit
        ? L(
            '描述你想调整的内容（时长、节奏、影调、配乐、竖屏），或留空由系统自动润色剪辑。',
            'Describe what to change (length, pace, look, music, vertical), or leave empty to polish the cut.'
          )
        : L(
            '描述你想要的成片（时长、节奏、影调、配乐、竖屏），或留空自动生成最佳剪辑。',
            'Describe the video you want (length, pace, look, music, vertical), or leave empty for the best cut.'
          );
    }
    return hasEdit
      ? L(
          `描述你想修改的内容，或留空由 ${name} 为你优化当前时间轴。`,
          `Describe what to change, or leave empty and ${name} will make the best edit it can.`
        )
      : L(
          `描述你想要的成片效果，或留空由 ${name} 根据媒体库素材自动粗剪。`,
          `Describe the video you want, or leave empty and ${name} will cut from your Media.`
        );
  })();

  const submitWithOptions = () => {
    if (isRunning) return;
    if (backend === 'claude' || backend === 'codex') {
      onSubmit(prompt, backend, { model: cliModels[backend], effort: cliEffort });
    } else {
      onSubmit(prompt, backend);
    }
  };

  const filteredRecords = useMemo(() => {
    if (recordFilter === 'all') return records;
    return records.filter((r) => r.backend === recordFilter);
  }, [records, recordFilter]);

  const modeDotFor = (b: MagicBackend | 'external') => {
    if (b === 'external') return '#60A5FA';
    return backends.find((item) => item.id === b)?.dot ?? 'var(--text)';
  };

  const modeLabelFor = (b: MagicBackend | 'external', worker?: string) => {
    if (b === 'external') return worker ? `MCP · ${worker}` : L('外部 MCP', 'External MCP');
    return backends.find((item) => item.id === b)?.label ?? worker ?? b;
  };

  const latestRecord = records[0];
  const visibleSkills = useMemo(
    () => (skillTierFilter === 'core16' ? EDITING_SKILLS_32.filter((s) => s.tier === 'core16') : EDITING_SKILLS_32),
    [skillTierFilter]
  );

  return (
    <div
      data-magic-anchor="magic-panel"
      className="flex flex-col h-full shrink-0 min-w-0 overflow-hidden relative z-[47]"
      style={{ width, background: 'var(--panel)' }}
    >
      <div
        className="flex flex-col h-full min-h-0"
      >
        <div
          className="flex items-center justify-between gap-2 px-3 h-9 shrink-0"
          style={{ borderBottom: '1px solid var(--stroke)' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles size={13} style={{ color: 'var(--accent)' }} className="shrink-0" />
            <span className="text-[11px] font-semibold tracking-[0.04em] truncate">
              {L('MAGIC 工作台', 'MAGIC STUDIO')}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <div
              className="inline-flex items-center gap-0.5 p-0.5 rounded-lg"
              style={{ background: 'var(--bg)', border: '1px solid var(--stroke)' }}
            >
              <button
                onClick={() => onChangePanelTab('run')}
                className="px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors"
                style={{
                  background: panelTab === 'run' ? 'var(--raised)' : 'transparent',
                  color: panelTab === 'run' ? 'var(--text)' : 'var(--text-dim)',
                }}
              >
                {L('操作台', 'Run')}
              </button>
              <button
                onClick={() => onChangePanelTab('templates')}
                className="px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors"
                style={{
                  background: panelTab === 'templates' ? 'var(--raised)' : 'transparent',
                  color: panelTab === 'templates' ? 'var(--text)' : 'var(--text-dim)',
                }}
              >
                {L('模板', 'Templates')}
              </button>
              <button
                onClick={() => onChangePanelTab('activity')}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors"
                style={{
                  background: panelTab === 'activity' ? 'var(--raised)' : 'transparent',
                  color: panelTab === 'activity' ? 'var(--text)' : 'var(--text-dim)',
                }}
              >
                {isRunning && (
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--accent)' }} />
                )}
                <span>{L('记录', 'Logs')}</span>
                {records.length > 0 && (
                  <span
                    className="px-1 rounded text-[9px] mono-num"
                    style={{ background: 'var(--button)', color: 'var(--text-dim)' }}
                  >
                    {records.length}
                  </span>
                )}
              </button>
            </div>
            <button
              onClick={onClose}
              className="vt-hover p-1 rounded"
              style={{ color: 'var(--text-dim)' }}
              title={L('关闭面板 (Esc)', 'Close panel (Esc)')}
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {completionNote && !isRunning && (
          <div
            className="mx-3 mt-2.5 p-2.5 rounded-lg space-y-1.5 shrink-0"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                <Sparkles size={11} style={{ color: 'var(--accent)' }} />
                <span>{completionNote.worker}</span>
                {completionNote.detail && (
                  <span className="text-[10px] font-normal" style={{ color: 'var(--text-faint)' }}>
                    {completionNote.detail}
                  </span>
                )}
              </div>
              <button onClick={onDismissNote} className="vt-hover p-0.5 rounded" style={{ color: 'var(--text-dim)' }}>
                <X size={11} />
              </button>
            </div>
            <div className="text-[11px] leading-relaxed select-text max-h-24 overflow-y-auto whitespace-pre-wrap break-words" style={{ color: 'var(--text)' }}>
              {completionNote.summary || L('已完成。', 'Done.')}
            </div>
            {completionNote.changed && (
              <div className="flex justify-end">
                <button
                  onClick={onUndo}
                  className="vt-btn inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px]"
                  style={{ background: 'var(--button)', color: 'var(--text)' }}
                >
                  <RotateCcw size={10} /> {L('撤销', 'Undo')}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 flex flex-col p-3 gap-2.5 overflow-hidden">
        {panelTab === 'run' ? (
          <div className="flex-1 min-h-0 flex flex-col gap-2.5 overflow-y-auto pr-0.5">
            <div className="space-y-1 shrink-0">
              <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--text-faint)' }}>
                <span>{L('常选执行方式（自动记住）', 'Default execution mode (pinned)')}</span>
                <span>{L('切换后自动作为下次默认', 'Remembers your pick')}</span>
              </div>
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
                  border: active ? '1px solid var(--stroke)' : '1px solid transparent',
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: b.dot }} />
                {b.label}
              </button>
            );
          })}
        </div>
            </div>

        {missingExternalCli ? (
          <div className="py-4 px-3 text-center space-y-2.5">
            <div className="text-[13px] font-semibold">
              {backend === 'claude' ? L('安装 Claude Code', 'Install Claude Code') : L('安装 Codex CLI', 'Install Codex CLI')}
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
              {backend === 'claude'
                ? L('未在 PATH 中检测到 Claude Code CLI。安装后即可一键连接 Vectrail。', 'Claude Code CLI was not detected on PATH. Install it, then connect Vectrail in one click.')
                : L('未在 PATH 中检测到 Codex CLI。安装后即可一键连接 Vectrail。', 'Codex CLI was not detected on PATH. Install it, then connect Vectrail in one click.')}
            </div>
            <div className="flex justify-center gap-2 pt-1">
              <button
                onClick={onOpenSettings}
                className="px-3.5 py-1.5 rounded-full text-[11px] font-semibold"
                style={{ background: 'var(--text)', color: 'var(--on-text)' }}
              >
                {L('打开 AI 智能体设置', 'Open AI Agents')}
              </button>
            </div>
          </div>
        ) : needsExternalConnect ? (
          <div className="py-4 px-3 text-center space-y-2.5">
            <div className="text-[13px] font-semibold">
              {backend === 'claude' ? L('连接 Claude', 'Connect Claude') : L('连接 Codex', 'Connect Codex')}
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
              {L(
                `让 ${backend === 'claude' ? 'Claude' : 'Codex'} 使用你自己的订阅通过 Vectrail MCP 服务直接剪辑时间轴。`,
                `Let ${backend === 'claude' ? 'Claude' : 'Codex'} edit directly through Vectrail's MCP server using your own plan.`
              )}
            </div>
            <div className="flex flex-col items-center gap-1.5 pt-1">
              <button
                disabled={connecting}
                onClick={() => void handleConnectExternal()}
                className="px-4 py-1.5 rounded-full text-[11px] font-semibold"
                style={{ background: 'var(--text)', color: 'var(--on-text)' }}
              >
                {connecting
                  ? L('正在连接...', 'Connecting...')
                  : backend === 'claude'
                  ? L('连接 Claude', 'Connect Claude')
                  : L('连接 Codex', 'Connect Codex')}
              </button>
              <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                {L('无需额外 API Key', 'No extra API key needed')}
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between pt-0.5">
              <span className="text-[12.5px] font-semibold">
                {hasEdit ? L('你想如何修改？', 'What should change?') : L('你想生成什么视频？', 'What should it make?')}
              </span>
              <div className="flex items-center gap-1 relative">
                <button
                  onClick={() => {
                    setIdeasOpen((v) => !v);
                    setHistoryOpen(false);
                  }}
                  className="vt-btn inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px]"
                  style={{ background: 'var(--button)', color: 'var(--text-dim)' }}
                >
                  <Lightbulb size={11} /> {L('灵感', 'Ideas')} <ChevronDown size={10} />
                </button>
                {history.length > 0 && (
                  <button
                    onClick={() => {
                      setHistoryOpen((v) => !v);
                      setIdeasOpen(false);
                    }}
                    className="vt-btn inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px]"
                    style={{ background: 'var(--button)', color: 'var(--text-dim)' }}
                    title={L('历史提示词', 'Prompt history')}
                  >
                    <History size={11} />
                  </button>
                )}
                {ideasOpen && (
                  <div
                    className="absolute right-0 top-7 z-50 w-64 rounded-lg p-1.5 shadow-2xl space-y-0.5 max-h-[420px] overflow-y-auto"
                    style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
                  >
                    {hasEdit && (
                      <>
                        <div className="px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                          {L('优化', 'Improve')}
                        </div>
                        {IDEAS_IMPROVE.map((idea) => (
                          <button
                            key={idea.name}
                            onClick={() => {
                              onChangePrompt(locale === 'zh' ? idea.promptZh : idea.prompt);
                              setIdeasOpen(false);
                            }}
                            className="vt-hover w-full text-left px-2 py-1 rounded text-[11px]"
                            style={{ color: 'var(--text)' }}
                          >
                            {locale === 'zh' ? idea.nameZh : idea.name}
                          </button>
                        ))}
                      </>
                    )}
                    <div className="px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                      {L('创作', 'Create')}
                    </div>
                    {IDEAS_CREATE.map((idea) => (
                      <button
                        key={idea.name}
                        onClick={() => {
                          onChangePrompt(locale === 'zh' ? idea.promptZh : idea.prompt);
                          setIdeasOpen(false);
                        }}
                        className="vt-hover w-full text-left px-2 py-1 rounded text-[11px]"
                        style={{ color: 'var(--text)' }}
                      >
                        {locale === 'zh' ? idea.nameZh : idea.name}
                      </button>
                    ))}
                    <div className="px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                      {L('声音', 'Sound')}
                    </div>
                    {IDEAS_SOUND.map((idea) => (
                      <button
                        key={idea.name}
                        onClick={() => {
                          onChangePrompt(locale === 'zh' ? idea.promptZh : idea.prompt);
                          setIdeasOpen(false);
                        }}
                        className="vt-hover w-full text-left px-2 py-1 rounded text-[11px]"
                        style={{ color: 'var(--text)' }}
                      >
                        {locale === 'zh' ? idea.nameZh : idea.name}
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
                        className="vt-hover w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left text-[11px]"
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
              rows={4}
              value={prompt}
              onChange={(e) => onChangePrompt(e.target.value)}
              placeholder={placeholder}
              className="w-full p-2.5 rounded-lg text-[12px] outline-none resize-none shrink-0"
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
                    <span>{L(`模型: ${cloudModel}`, `Model: ${cloudModel}`)}</span>
                  ) : (
                    <button onClick={onOpenSettings} className="underline" style={{ color: 'var(--accent)' }}>
                      {L('前往设置配置 API Key', 'Configure API Key in Settings')}
                    </button>
                  )
                ) : backend === 'local' ? (
                  <span>{L('本地节拍与规则规划器 · 本机运行', 'Instant beat & rule planner · On this PC')}</span>
                ) : (
                  <>
                    <select
                      value={cliModels[backend]}
                      onChange={(e) => {
                        const next = { ...cliModels, [backend]: e.target.value };
                        setCliModels(next);
                        try {
                          localStorage.setItem('vectrail.magicCliModels.v2', JSON.stringify(next));
                        } catch {
                          // ignore
                        }
                      }}
                      className="px-2 py-0.5 rounded-full text-[10px] outline-none"
                      style={{ background: 'var(--button)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                      title={L('模型', 'Model')}
                    >
                      {MAGIC_AGENT_MODELS[backend].map((m) => (
                        <option key={m.id || 'default'} value={m.id} style={{ background: 'var(--panel)', color: 'var(--text)' }}>
                          {locale === 'zh' && m.labelZh ? m.labelZh : m.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={cliEffort}
                      onChange={(e) => {
                        setCliEffort(e.target.value);
                        try {
                          localStorage.setItem('vectrail.magicCliEffort.v2', e.target.value);
                        } catch {
                          // ignore
                        }
                      }}
                      className="px-2 py-0.5 rounded-full text-[10px] outline-none"
                      style={{ background: 'var(--button)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                      title={L('思考深度', 'Reasoning effort')}
                    >
                      {MAGIC_EFFORTS.map((ef) => (
                        <option key={ef.id || 'default'} value={ef.id} style={{ background: 'var(--panel)', color: 'var(--text)' }}>
                          {locale === 'zh' ? ef.labelZh : ef.label}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              {isRunning ? (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => onChangePanelTab('activity')}
                    className="px-3 py-1.5 rounded-full text-[11px] font-semibold"
                    style={{ background: 'var(--button)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                  >
                    {L('查看实时过程', 'View live steps')}
                  </button>
                  <button
                    onClick={onStop}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-semibold"
                    style={{ background: 'var(--accent)', color: '#FFFFFF' }}
                  >
                    <Square size={9} fill="#FFFFFF" stroke="#FFFFFF" />
                    {L('停止', 'Stop')}
                  </button>
                </div>
              ) : (
                <button
                  disabled={backend === 'cloud' && !cloudReady}
                  onClick={submitWithOptions}
                  className="px-4 py-1.5 rounded-full text-[11px] font-semibold disabled:opacity-40"
                  style={{ background: 'var(--text)', color: 'var(--on-text)' }}
                >
                  {L('开始执行', 'Make it')}
                </button>
              )}
            </div>

            {latestRecord && (
              <button
                onClick={() => {
                  setExpandedRunId(latestRecord.id);
                  onChangePanelTab('activity');
                }}
                className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors vt-hover mt-auto shrink-0"
                style={{ background: 'var(--bg)', border: '1px solid var(--stroke)' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: modeDotFor(latestRecord.backend) }}
                  />
                  <span className="text-[10.5px] font-semibold shrink-0">
                    {modeLabelFor(latestRecord.backend, latestRecord.worker)}
                  </span>
                  <span className="text-[10.5px] truncate" style={{ color: 'var(--text-dim)' }}>
                    {latestRecord.status === 'running'
                      ? activeStatus?.status || L('正在执行...', 'Running...')
                      : latestRecord.summary || latestRecord.prompt || L('已完成', 'Done')}
                  </span>
                </div>
                <span className="text-[10px] shrink-0" style={{ color: 'var(--accent)' }}>
                  {L('过程与记录 →', 'Steps →')}
                </span>
              </button>
            )}
          </>
        )}
          </div>
        ) : panelTab === 'templates' ? (
          <div className="flex flex-col min-h-0 flex-1 space-y-2">
            <div className="flex items-center justify-between gap-2 shrink-0">
              <span className="text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
                {L('模块化技能拼接模板（点击即用）', 'Composable skill-chain templates')}
              </span>
              <button
                onClick={() => setShowSkillMatrix((v) => !v)}
                className="vt-btn px-2 py-0.5 rounded-full text-[10px]"
                style={{ background: 'var(--button)', color: showSkillMatrix ? 'var(--accent)' : 'var(--text-dim)' }}
              >
                {showSkillMatrix ? L('返回模板', 'Templates') : L('16/32 技能库', '16/32 Skills')}
              </button>
            </div>

            {showSkillMatrix ? (
              <div className="flex-1 min-h-0 flex flex-col gap-2">
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setSkillTierFilter('core16')}
                    className="px-2 py-0.5 rounded-full text-[10px]"
                    style={{
                      background: skillTierFilter === 'core16' ? 'var(--accent)' : 'var(--button)',
                      color: skillTierFilter === 'core16' ? '#FFF' : 'var(--text-dim)',
                    }}
                  >
                    {L('核心 16 技能', 'Core 16 Skills')}
                  </button>
                  <button
                    onClick={() => setSkillTierFilter('all32')}
                    className="px-2 py-0.5 rounded-full text-[10px]"
                    style={{
                      background: skillTierFilter === 'all32' ? 'var(--accent)' : 'var(--button)',
                      color: skillTierFilter === 'all32' ? '#FFF' : 'var(--text-dim)',
                    }}
                  >
                    {L('全量 32 技能', 'Full 32 Skills')}
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-0.5">
                  {visibleSkills.map((sk) => (
                    <div
                      key={sk.id}
                      className="p-2 rounded-lg space-y-0.5"
                      style={{ background: 'var(--bg)', border: '1px solid var(--stroke)' }}
                    >
                      <div className="flex items-center justify-between gap-2 text-[10.5px]">
                        <span className="font-semibold">
                          #{sk.index} {locale === 'zh' ? sk.nameZh : sk.name}
                        </span>
                        <span
                          className="px-1.5 py-0.2 rounded text-[9px] shrink-0"
                          style={{
                            background:
                              sk.vectrailSupport === 'native'
                                ? 'rgba(48,209,88,0.14)'
                                : sk.vectrailSupport === 'mcp'
                                ? 'rgba(255,107,53,0.14)'
                                : 'var(--button)',
                            color:
                              sk.vectrailSupport === 'native'
                                ? '#30D158'
                                : sk.vectrailSupport === 'mcp'
                                ? 'var(--accent)'
                                : 'var(--text-faint)',
                          }}
                        >
                          {sk.vectrailSupport === 'native'
                            ? L('内置', 'Native')
                            : sk.vectrailSupport === 'mcp'
                            ? 'MCP'
                            : L('扩展规划', 'Planned')}
                        </span>
                      </div>
                      <div className="text-[10px] leading-snug" style={{ color: 'var(--text-dim)' }}>
                        {locale === 'zh' ? sk.summaryZh : sk.summary}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5">
                {EDITING_TEMPLATES.map((tpl) => (
                  <div
                    key={tpl.id}
                    className="p-2.5 rounded-lg space-y-1.5"
                    style={{ background: 'var(--bg)', border: '1px solid var(--stroke)' }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11.5px] font-semibold">
                        {locale === 'zh' ? tpl.nameZh : tpl.name}
                      </span>
                      <span
                        className="px-1.5 py-0.5 rounded text-[9.5px] shrink-0"
                        style={{ background: 'var(--raised)', color: 'var(--accent)' }}
                      >
                        {locale === 'zh' ? tpl.badgeZh : tpl.badge}
                      </span>
                    </div>
                    <div className="text-[10px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                      {locale === 'zh' ? tpl.descriptionZh : tpl.description}
                    </div>
                    <div className="flex items-center justify-end gap-1.5 pt-1">
                      <button
                        onClick={() => {
                          onChangePrompt(locale === 'zh' ? tpl.promptZh : tpl.prompt);
                          onChangePanelTab('run');
                        }}
                        className="vt-btn px-2.5 py-1 rounded-full text-[10px]"
                        style={{ background: 'var(--button)', color: 'var(--text)' }}
                      >
                        {L('编辑指令', 'Customize')}
                      </button>
                      <button
                        disabled={isRunning}
                        onClick={() =>
                          onSubmit(locale === 'zh' ? tpl.promptZh : tpl.prompt, backend, {
                            model: backend === 'claude' || backend === 'codex' ? cliModels[backend] || undefined : undefined,
                            effort: backend === 'claude' || backend === 'codex' ? cliEffort || undefined : undefined,
                          })
                        }
                        className="px-2.5 py-1 rounded-full text-[10px] font-semibold disabled:opacity-40"
                        style={{ background: 'var(--accent)', color: '#FFF' }}
                      >
                        {L('一键套用', 'Apply Now')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col min-h-0 flex-1 space-y-2">
            <div className="flex items-center justify-between gap-1.5 shrink-0">
              <div className="flex items-center gap-1 flex-wrap">
                {(
                  [
                    { id: 'all', label: L('全部', 'All') },
                    { id: 'claude', label: 'Claude' },
                    { id: 'codex', label: 'Codex' },
                    { id: 'cloud', label: L('云端', 'Cloud') },
                    { id: 'local', label: L('本地', 'Local') },
                    { id: 'external', label: 'MCP' },
                  ] as const
                ).map((f) => {
                  const active = recordFilter === f.id;
                  return (
                    <button
                      key={f.id}
                      onClick={() => setRecordFilter(f.id)}
                      className="px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors"
                      style={{
                        background: active ? 'var(--raised)' : 'var(--bg)',
                        color: active ? 'var(--text)' : 'var(--text-dim)',
                        border: `1px solid ${active ? 'var(--stroke)' : 'transparent'}`,
                      }}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
              {records.length > 0 && (
                <button
                  onClick={onClearRecords}
                  disabled={isRunning}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] disabled:opacity-40 vt-hover"
                  style={{ color: 'var(--text-dim)' }}
                  title={L('清空历史记录', 'Clear records')}
                >
                  <Trash2 size={10} />
                  {L('清空', 'Clear')}
                </button>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5">
              {filteredRecords.length === 0 ? (
                <div
                  className="py-10 px-4 text-center rounded-lg text-[11.5px] space-y-1.5"
                  style={{ background: 'var(--bg)', color: 'var(--text-dim)', border: '1px solid var(--stroke)' }}
                >
                  <div>{L('暂无操作过程与记录。', 'No operation logs yet.')}</div>
                  <div className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                    {L(
                      '无论使用 Claude、Codex、云端 AI、本地引擎，还是外部 MCP 客户端，所有执行步骤与历史都会记录在这里。',
                      'Runs from Claude, Codex, Cloud AI, Local, or external MCP clients appear here with step-by-step details.'
                    )}
                  </div>
                </div>
              ) : (
                filteredRecords.map((rec, recIdx) => {
                  const expanded = expandedRunId === rec.id;
                  const statusBadge = (() => {
                    if (rec.status === 'running') {
                      return {
                        label: activeStatus?.status || L('执行中', 'Running'),
                        bg: 'rgba(255, 107, 53, 0.14)',
                        color: 'var(--accent)',
                      };
                    }
                    if (rec.status === 'error') {
                      return {
                        label: L('失败', 'Failed'),
                        bg: 'rgba(239, 68, 68, 0.14)',
                        color: '#EF4444',
                      };
                    }
                    if (rec.status === 'cancelled') {
                      return {
                        label: L('已停止', 'Stopped'),
                        bg: 'var(--button)',
                        color: 'var(--text-dim)',
                      };
                    }
                    return {
                      label: rec.changed ? L('已应用', 'Applied') : L('已完成', 'Done'),
                      bg: 'rgba(16, 185, 129, 0.14)',
                      color: '#10B981',
                    };
                  })();

                  return (
                    <div
                      key={rec.id}
                      className="rounded-lg overflow-hidden"
                      style={{ background: 'var(--bg)', border: '1px solid var(--stroke)' }}
                    >
                      <button
                        onClick={() => setExpandedRunId(expanded ? null : rec.id)}
                        className="w-full px-2.5 py-2 flex items-start justify-between gap-2 text-left vt-hover"
                      >
                        <div className="flex items-start gap-2 min-w-0">
                          <span className="mt-1 shrink-0" style={{ color: 'var(--text-faint)' }}>
                            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </span>
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span
                                className="w-1.5 h-1.5 rounded-full shrink-0"
                                style={{ background: modeDotFor(rec.backend) }}
                              />
                              <span className="text-[11px] font-semibold">
                                {modeLabelFor(rec.backend, rec.worker)}
                              </span>
                              <span
                                className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded-full text-[9.5px] font-semibold max-w-[160px] truncate"
                                style={{ background: statusBadge.bg, color: statusBadge.color }}
                              >
                                {rec.status === 'running' && <Loader2 size={9} className="animate-spin shrink-0" />}
                                <span className="truncate">{statusBadge.label}</span>
                              </span>
                              <span className="text-[9.5px]" style={{ color: 'var(--text-faint)' }}>
                                {formatClockTime(rec.startedAt)}
                              </span>
                            </div>
                            <div className="text-[11px] truncate" style={{ color: 'var(--text)' }}>
                              {rec.prompt || L('自动智能剪辑', 'Auto Magic edit')}
                            </div>
                          </div>
                        </div>
                        <span className="text-[9.5px] shrink-0 mt-0.5" style={{ color: 'var(--text-faint)' }}>
                          {rec.steps.length} {L('步', 'steps')}
                        </span>
                      </button>

                      {expanded && (
                        <div
                          className="px-2.5 pb-2.5 pt-1.5 space-y-2 border-t"
                          style={{ borderColor: 'var(--stroke)' }}
                        >
                          {rec.detail && (
                            <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                              {rec.detail}
                            </div>
                          )}

                          {rec.steps.length > 0 && (
                            <div className="space-y-1 max-h-[210px] overflow-y-auto pr-0.5">
                              {rec.steps.map((step) => (
                                <div
                                  key={step.id}
                                  className="flex items-start gap-2 px-2 py-1.5 rounded text-[10.5px]"
                                  style={{ background: 'var(--panel)' }}
                                >
                                  <span className="mt-0.5 shrink-0">
                                    {step.status === 'running' ? (
                                      <Loader2 size={11} className="animate-spin" style={{ color: 'var(--accent)' }} />
                                    ) : step.status === 'error' ? (
                                      <AlertTriangle size={11} style={{ color: '#EF4444' }} />
                                    ) : (
                                      <Check size={11} style={{ color: '#10B981' }} />
                                    )}
                                  </span>
                                  <div className="min-w-0 flex-1 space-y-0.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-medium truncate" style={{ color: 'var(--text)' }}>
                                        {step.title}
                                      </span>
                                      <span className="text-[9.5px] shrink-0" style={{ color: 'var(--text-faint)' }}>
                                        {formatClockTime(step.timestamp)}
                                      </span>
                                    </div>
                                    {step.detail && (
                                      <div
                                        className="text-[10px] leading-snug break-words select-text"
                                        style={{ color: 'var(--text-dim)' }}
                                      >
                                        {step.detail}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          {rec.summary && (
                            <div
                              className="px-2 py-1.5 rounded text-[11px] leading-relaxed whitespace-pre-wrap break-words select-text"
                              style={{ background: 'var(--raised)', color: 'var(--text)' }}
                            >
                              {rec.summary}
                            </div>
                          )}

                          <div className="flex items-center justify-between gap-2 pt-0.5">
                            <div className="flex items-center gap-1.5">
                              {rec.status === 'running' && (
                                <button
                                  onClick={onStop}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold"
                                  style={{ background: 'var(--accent)', color: '#FFFFFF' }}
                                >
                                  <Square size={8} fill="#FFFFFF" stroke="#FFFFFF" />
                                  {L('停止执行', 'Stop')}
                                </button>
                              )}
                              {rec.status !== 'running' && rec.changed && recIdx === 0 && (
                                <button
                                  onClick={onUndo}
                                  className="vt-btn inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium"
                                  style={{ background: 'var(--button)', color: 'var(--text)' }}
                                >
                                  <RotateCcw size={10} />
                                  {L('撤销此次剪辑', 'Undo edit')}
                                </button>
                              )}
                            </div>
                            {rec.backend !== 'external' && rec.status !== 'running' && (
                              <button
                                onClick={() => {
                                  selectTab(rec.backend as MagicBackend);
                                  if (rec.prompt) onChangePrompt(rec.prompt);
                                  onChangePanelTab('run');
                                }}
                                className="vt-btn px-2.5 py-1 rounded-full text-[10px] font-medium"
                                style={{ background: 'var(--button)', color: 'var(--text)' }}
                              >
                                {L('回到操作台复用', 'Reuse in Run')}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
        </div>
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
  const { L } = useI18n();
  return (
    <div className="fixed bottom-5 right-5 z-50 w-[340px] max-w-[calc(100vw-32px)]">
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
        <div
          className="text-[12px] leading-relaxed select-text max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words pr-1"
          style={{ color: 'var(--text)' }}
        >
          {summary || L('已完成。', 'Done.')}
        </div>
        <div className="flex items-center justify-between pt-0.5">
          {changed ? (
            <button
              onClick={() => {
                onClose();
                onUndo();
              }}
              className="vt-btn inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-medium"
              style={{ background: 'var(--button)', color: 'var(--text)' }}
            >
              <RotateCcw size={11} /> {L('撤销', 'Undo')}
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={onClose}
            className="px-3.5 py-1 rounded-full text-[11px] font-semibold"
            style={{ background: 'var(--text)', color: 'var(--on-text)' }}
          >
            {L('完成', 'Done')}
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
  onPluginsChange?: (plugins: PluginSummary[]) => void;
  onOpenMarketplace?: () => void;
  onUpdateShortcuts: (next: Record<string, string>) => void;
  onChangeTheme: (t: AppThemeName) => void;
  onFfmpegChange?: (status: FfmpegStatus) => void;
  onClose: () => void;
}> = ({ theme, shortcutMap, magicAnimated = true, onChangeMagicAnimated, onPluginsChange, onOpenMarketplace, onUpdateShortcuts, onChangeTheme, onFfmpegChange, onClose }) => {
  const { locale, setLocale, L } = useI18n();
  const [tab, setTab] = useState<'general' | 'shortcuts'>('general');
  const [mcp, setMcp] = useState<MCPStatusInfo | null>(null);
  const [agents, setAgents] = useState<AgentTargetStatus[]>([]);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [whisper, setWhisper] = useState<WhisperStatus | null>(null);
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [ffmpegBusy, setFfmpegBusy] = useState(false);
  const [ffmpegMsg, setFfmpegMsg] = useState('');
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
    void window.vectrail.listPlugins().then(setPlugins);
    void window.vectrail.getWhisperStatus().then(setWhisper);
    void window.vectrail.getFfmpegStatus().then(setFfmpeg);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div
        className="w-[520px] max-h-[82vh] flex flex-col rounded-xl p-4 space-y-3 shadow-2xl"
        style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold mr-2">{L('设置', 'Settings')}</span>
            {(['general', 'shortcuts'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="vt-hover px-2.5 py-0.5 rounded text-[11px]"
                style={{
                  background: tab === t ? 'var(--raised)' : 'transparent',
                  color: tab === t ? 'var(--text)' : 'var(--text-dim)',
                }}
              >
                {t === 'general' ? L('通用', 'General') : L('快捷键', 'Shortcuts')}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="vt-hover p-1 rounded" style={{ color: 'var(--text-dim)' }}>
            <X size={15} />
          </button>
        </div>

        {tab === 'general' ? (
          <div className="space-y-4 overflow-y-auto pr-1">
            <div>
          <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
            {L('外观主题', 'APPEARANCE')}
          </div>
          <div className="flex gap-2">
            {(Object.keys(THEMES) as AppThemeName[]).map((name) => (
              <button
                key={name}
                onClick={() => onChangeTheme(name)}
                className="vt-btn flex-1 py-1.5 rounded text-[11px] capitalize"
                style={{
                  background: theme === name ? 'var(--accent)' : 'var(--sheet-field)',
                  color: theme === name ? '#FFF' : 'var(--text)',
                  border: theme === name ? '1px solid var(--accent)' : '1px solid var(--sheet-field-stroke)',
                }}
              >
                {locale === 'zh' ? THEME_LABELS_ZH[name] : name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
            {L('界面语言', 'INTERFACE LANGUAGE')}
          </div>
          <div className="flex gap-2">
            {(
              [
                { id: 'zh', label: '简体中文' },
                { id: 'en', label: 'English' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                onClick={() => setLocale(opt.id)}
                className="vt-btn flex-1 py-1.5 rounded text-[11px] font-medium"
                style={{
                  background: locale === opt.id ? 'var(--accent)' : 'var(--sheet-field)',
                  color: locale === opt.id ? '#FFF' : 'var(--text)',
                  border: locale === opt.id ? '1px solid var(--accent)' : '1px solid var(--sheet-field-stroke)',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
            {L('云端 AI（OpenAI 兼容接口）', 'CLOUD AI (OPENAI-COMPATIBLE API)')}
          </div>
          <div
            className="p-2.5 rounded space-y-2"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
          >
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <label>
                {L('接口地址 (Base URL)', 'Base URL')}
                <input
                  value={cloudAi.baseUrl}
                  onChange={(e) => setCloudAi({ ...cloudAi, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="mono-num mt-1 w-full px-2 py-1 rounded outline-none"
                  style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
                />
              </label>
              <label>
                {L('模型 (Model)', 'Model')}
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
              {L('API 密钥 (API Key)', 'API Key')}
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
                {cloudStatus || L('用于「魔法 -> 云端 AI」', 'Used by Magic -> Cloud AI')}
              </span>
              <div className="flex gap-1.5">
                <button
                  disabled={cloudBusy}
                  onClick={async () => {
                    setCloudBusy(true);
                    setCloudStatus(L('测试中...', 'Testing...'));
                    const saved = await window.vectrail.saveCloudAiConfig(cloudAi);
                    setCloudAi(saved);
                    const res = await window.vectrail.testCloudAiConnection(saved);
                    setCloudStatus(res.message);
                    setCloudBusy(false);
                  }}
                  className="vt-btn px-2.5 py-1 rounded text-[11px]"
                  style={{ background: 'var(--button)', color: 'var(--text)' }}
                >
                  {L('测试', 'Test')}
                </button>
                <button
                  onClick={async () => {
                    const saved = await window.vectrail.saveCloudAiConfig(cloudAi);
                    setCloudAi(saved);
                    setCloudStatus(L('已保存', 'Saved'));
                  }}
                  className="px-2.5 py-1 rounded text-[11px] font-medium"
                  style={{ background: 'var(--accent)', color: '#FFF' }}
                >
                  {L('保存', 'Save')}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-dim)' }}>
              {L('AI 智能体与 MCP 服务', 'AI AGENTS & MCP SERVER')}
            </span>
            {mcp && (
              <label className="flex items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={mcp.enabled}
                  onChange={async (e) => setMcp(await window.vectrail.setMcpEnabled(e.target.checked))}
                />
                {L('启用', 'Enabled')}
              </label>
            )}
          </div>
          {mcp && (
            <div
              className="mono-num px-2.5 py-1.5 rounded text-[11px] mb-2.5 flex items-center justify-between"
              style={{ background: 'var(--sheet-field)', color: 'var(--text-dim)', border: '1px solid var(--sheet-field-stroke)' }}
            >
              <span>{mcp.endpoint}</span>
              <span style={{ color: mcp.running ? '#30D158' : 'var(--text-faint)' }}>
                {mcp.running ? L('监听中', 'LISTENING') : L('已关闭', 'OFF')}
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
                  className="vt-btn inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px]"
                  style={{
                    background: a.connected ? 'rgba(48, 209, 88, 0.16)' : 'var(--button)',
                    color: a.connected ? '#30D158' : 'var(--text)',
                  }}
                >
                  {a.connected ? <Check size={12} /> : <Plug size={12} />}
                  {a.connected ? L('已连接', 'Connected') : L('连接', 'Connect')}
                </button>
              </div>
            ))}
          </div>
          <div
            className="flex items-center justify-between px-2.5 py-2 rounded mt-2"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
          >
            <div>
              <div className="text-[11px] font-medium">{L('连接其他 AI 客户端', 'Connect another AI app')}</div>
              <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                {L('复制适用于 Cursor、Windsurf 或自定义客户端的 MCP 配置说明', 'Copy MCP setup prompt for Cursor, Windsurf, or custom clients')}
              </div>
            </div>
            <button
              onClick={() => {
                const endpoint = mcp?.endpoint ?? 'http://127.0.0.1:47920/mcp';
                const text = [
                  'Connect to the running Vectrail Windows video editor via MCP:',
                  `- Streamable/HTTP JSON-RPC 2.0 POST: ${endpoint} (active port is written to %APPDATA%\\Vectrail\\Runtime\\mcp-port.json)`,
                  '- Or stdio MCP config (for Cursor / Windsurf / Claude / Codex):',
                  '  command: "node"',
                  '  args: ["%APPDATA%\\\\Vectrail\\\\Runtime\\\\vectrail-mcp-bridge.js"]',
                  'Once connected, call get_project and list_media first, then edit the timeline and verify with get_frame.',
                ].join('\n');
                void navigator.clipboard.writeText(text);
                setCopiedPrompt(true);
                setTimeout(() => setCopiedPrompt(false), 1600);
              }}
              className="vt-btn inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px]"
              style={{ background: 'var(--button)', color: 'var(--text)' }}
            >
              {copiedPrompt ? <Check size={11} /> : <Copy size={11} />}
              {copiedPrompt ? L('已复制', 'Copied') : L('复制配置', 'Copy Prompt')}
            </button>
          </div>
        </div>

            <div>
              <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
                {L('FFmpeg 媒体引擎', 'FFMPEG MEDIA ENGINE')}
              </div>
              <div
                className="flex items-center justify-between gap-2 px-2.5 py-2 rounded"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div className="min-w-0">
                  <div className="text-[11px] font-medium">
                    {ffmpeg?.available ? L('FFmpeg 与 FFprobe 已就绪', 'FFmpeg & FFprobe ready') : L('未检测到 FFmpeg', 'FFmpeg not detected')}
                  </div>
                  <div className="mono-num text-[10px] truncate" style={{ color: 'var(--text-faint)' }}>
                    {ffmpeg?.available
                      ? ffmpeg.version || ffmpeg.ffmpegPath
                      : L('用于缩略图提取、MKV/MOV 代理、Whisper 字幕与 MP4 导出', 'Required for thumbnails, MKV/MOV proxies, Whisper, and MP4 export')}
                  </div>
                  {ffmpegMsg && (
                    <div className="text-[10px] mt-0.5" style={{ color: ffmpeg?.available ? '#22A849' : '#DC2626' }}>
                      {ffmpegMsg}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!ffmpeg?.available && ffmpeg?.canWinget && (
                    <button
                      disabled={ffmpegBusy}
                      onClick={async () => {
                        setFfmpegBusy(true);
                        setFfmpegMsg(L('正在通过 WinGet 安装 Gyan.FFmpeg...', 'Installing Gyan.FFmpeg via WinGet...'));
                        try {
                          const res = await window.vectrail.installFfmpeg();
                          setFfmpeg(res.status);
                          onFfmpegChange?.(res.status);
                          setFfmpegMsg(res.message);
                          if (res.status.available) {
                            setWhisper(await window.vectrail.getWhisperStatus());
                          }
                        } finally {
                          setFfmpegBusy(false);
                        }
                      }}
                      className="px-2.5 py-1 rounded text-[11px] font-medium"
                      style={{ background: 'var(--accent)', color: '#FFFFFF' }}
                    >
                      {ffmpegBusy ? L('安装中...', 'Installing...') : L('通过 WinGet 安装', 'Install via WinGet')}
                    </button>
                  )}
                  {!ffmpeg?.available && (
                    <button
                      onClick={() => void window.vectrail.openExternalUrl('https://www.gyan.dev/ffmpeg/builds/')}
                      className="vt-btn px-2 py-1 rounded text-[11px]"
                      style={{ background: 'var(--button)', color: 'var(--text)' }}
                    >
                      {L('指南', 'Guide')}
                    </button>
                  )}
                  <button
                    disabled={ffmpegBusy}
                    onClick={async () => {
                      const st = await window.vectrail.getFfmpegStatus();
                      setFfmpeg(st);
                      onFfmpegChange?.(st);
                      setWhisper(await window.vectrail.getWhisperStatus());
                      setFfmpegMsg(st.available ? L('已验证可用。', 'Verified.') : L('仍未在 PATH 或 WinGet 中找到。', 'Still not found on PATH or WinGet.'));
                    }}
                    className="vt-btn px-2 py-1 rounded text-[11px]"
                    style={{ background: 'var(--button)', color: 'var(--text)' }}
                    title={L('重新检测 FFmpeg', 'Recheck FFmpeg')}
                  >
                    <RefreshCw size={11} />
                  </button>
                </div>
              </div>
            </div>

            <div>
              <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
                {L('Whisper 语音转写', 'WHISPER SPEECH TRANSCRIPTION')}
              </div>
              <div
                className="flex items-center justify-between px-2.5 py-2 rounded"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div>
                  <div className="text-[11px] font-medium">
                    {whisper?.modelName ? L(`模型已就绪: ${whisper.modelName}`, `Model ready: ${whisper.modelName}`) : L('尚未下载 Whisper GGML 模型', 'No Whisper GGML model downloaded')}
                  </div>
                  <div className="mono-num text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {whisper?.supported ? L('FFmpeg whisper.cpp 滤镜可用', 'FFmpeg whisper.cpp filter available') : L('Whisper 滤镜不可用', 'Whisper filter unavailable')}
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
                  className="vt-btn px-2.5 py-1 rounded text-[11px]"
                  style={{ background: 'var(--button)', color: 'var(--text)' }}
                >
                  {dlBusy ? L('下载中...', 'Downloading...') : whisper?.modelPath ? L('已就绪', 'Ready') : L('下载 Tiny 模型 (75 MB)', 'Download Tiny (75 MB)')}
                </button>
              </div>
            </div>

            <div>
              <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
                {L('工程与更新', 'PROJECT & UPDATES')}
              </div>
              <label
                className="flex items-center justify-between px-2.5 py-2 rounded mb-2 cursor-pointer"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div>
                  <div className="text-[11px] font-medium">{L('自动保存已保存的工程', 'Auto-save saved projects')}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {L('自动将编辑写入已打开的 .vectrail 工程文件', 'Automatically writes edits to the opened .vectrail file')}
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
                  <div className="text-[11px] font-medium">{L('显示 AI 动画与光标', 'Show AI animations & cursors')}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {L('扫描框、闪烁光点、幽灵预览与实时 AI 协作光标', 'Scan brackets, shimmer dots, ghost previews, and live AI cursors')}
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
                  <div className="text-[11px] font-medium">Vectrail v{__VECTRAIL_VERSION__} · Built by Makur</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {updateInfo
                      ? updateInfo.error
                        ? updateInfo.error
                        : updateInfo.hasUpdate
                        ? L(`发现新版本 v${updateInfo.latestVersion}`, `New version v${updateInfo.latestVersion} available`)
                        : L(`已是最新版本 (v${updateInfo.currentVersion})`, `Up to date (v${updateInfo.currentVersion})`)
                      : L('灵感源自 macOS 版 Editroom', 'Inspired by Editroom for macOS')}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  {updateInfo?.hasUpdate && updateInfo.releaseUrl && (
                    <button
                      onClick={() => void window.vectrail.openExternalUrl(updateInfo.releaseUrl!)}
                      className="px-2.5 py-1 rounded text-[11px] font-medium"
                      style={{ background: 'var(--accent)', color: '#FFF' }}
                    >
                      {L('下载更新', 'Download')}
                    </button>
                  )}
                  <button
                    disabled={updateBusy}
                    onClick={async () => {
                      setUpdateBusy(true);
                      setUpdateInfo(await window.vectrail.checkForUpdates());
                      setUpdateBusy(false);
                    }}
                    className="vt-btn inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px]"
                    style={{ background: 'var(--button)', color: 'var(--text)' }}
                  >
                    <RefreshCw size={11} className={updateBusy ? 'animate-spin' : ''} />
                    {L('检查更新', 'Check')}
                  </button>
                </div>
              </div>

              {plugins.length > 0 && (
                <div className="pt-2">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-dim)' }}>
                      {L('扩展插件', 'PLUGINS')}
                    </div>
                    {onOpenMarketplace && (
                      <button
                        onClick={() => {
                          onClose();
                          onOpenMarketplace();
                        }}
                        className="vt-btn px-2 py-0.5 rounded text-[10px] font-medium"
                        style={{ background: 'var(--button)', color: 'var(--accent)' }}
                      >
                        {L('打开插件市场', 'Open Marketplace')}
                      </button>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {plugins.map((plg) => (
                      <label
                        key={plg.id}
                        className="flex items-center justify-between gap-3 px-2.5 py-2 rounded cursor-pointer"
                        style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-[11px] font-medium">
                            <span>{locale === 'zh' ? plg.nameZh : plg.name}</span>
                            <span className="text-[9.5px] mono-num" style={{ color: 'var(--text-faint)' }}>
                              v{plg.version}
                            </span>
                            {!plg.healthy && (
                              <span className="text-[9.5px]" style={{ color: '#FF453A' }}>
                                {plg.error || L('异常', 'Error')}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                            {locale === 'zh' ? plg.descriptionZh : plg.description}
                          </div>
                        </div>
                        <input
                          type="checkbox"
                          checked={plg.enabled}
                          onChange={async (e) => {
                            const next = await window.vectrail.setPluginEnabled(plg.id, e.target.checked);
                            setPlugins(next);
                            onPluginsChange?.(next);
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {L('点击任意快捷键条目并按下新的组合键。', 'Click any binding and press a new key combination.')}
              </span>
              <button
                onClick={() => {
                  const defaults: Record<string, string> = {};
                  DEFAULT_SHORTCUTS.forEach((b) => (defaults[b.id] = b.combo));
                  onUpdateShortcuts(defaults);
                }}
                className="vt-btn px-2 py-0.5 rounded text-[10px]"
                style={{ background: 'var(--button)', color: 'var(--chip)' }}
              >
                {L('恢复默认', 'Reset Defaults')}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {bindings.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between px-2.5 py-1.5 rounded"
                  style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
                >
                  <span className="text-[11px]">{locale === 'zh' ? SHORTCUT_LABELS_ZH[b.id] : b.label}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setRecordingId(b.id)}
                      className="mono-num px-2 py-0.5 rounded text-[10px]"
                      style={{
                        background: recordingId === b.id ? 'var(--accent)' : 'var(--button)',
                        color: recordingId === b.id ? '#FFF' : b.combo ? 'var(--text)' : 'var(--text-faint)',
                      }}
                    >
                      {recordingId === b.id ? L('请按键...', 'Press key...') : b.combo || L('未设置', 'None')}
                    </button>
                    {b.combo && (
                      <button
                        onClick={() => onUpdateShortcuts({ ...shortcutMap, [b.id]: '' })}
                        className="p-1 rounded hover:opacity-80"
                        style={{ color: 'var(--text-faint)' }}
                        title={L('清除快捷键', 'Clear shortcut')}
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
                        title={L('恢复默认', 'Restore default')}
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
