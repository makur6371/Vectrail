import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Clip,
  ColorGrade,
  ExportSettings,
  MagicProcessStep,
  MagicProgressEvent,
  MagicRunRecord,
  MediaAsset,
  Project,
} from '../shared/types';
import { buildMagicPlan } from '../shared/magicPlan';
import { MagicBackend } from '../main/magic/agentConnect';
import { AppThemeName, THEMES } from '../shared/themes';
import {
  addTrack,
  clipEnd,
  closeAllGaps,
  createSolidClip,
  detachAudioLinks,
  duplicateClips,
  evenOutAudioLevels,
  freeTrack,
  freezeFrameClip,
  linkedIds,
  makeClipsForAsset,
  nearestEditPoint,
  newId,
  pasteClipGroup,
  projectDuration,
  removeClips,
  resolveOverlaps,
  reverseClipGroup,
  rippleTrimEdge,
  snapFrame,
  splitClipsAt,
} from '../shared/project';
import { EditorSnapshot } from '../main/state';
import type { FfmpegStatus } from '../main/engine/ffmpeg';
import type { DjiPluginStateSnapshot, PluginSummary } from '../shared/djiTypes';
import { formatEventCombo, mergeShortcutBindings, ShortcutActionId } from '../shared/shortcuts';
import { AudioMixer } from './engine/audioMixer';
import { useI18n } from './i18n';
import { TitleBar } from './components/TitleBar';
import { LibraryView } from './components/LibraryView';
import { PinnedSourceState, ViewerScreen } from './components/ViewerScreen';
import { InspectorView } from './components/InspectorView';
import { TimelinePanel } from './components/TimelinePanel';
import {
  ExportModal,
  loadSavedMagicTab,
  MagicNotePopover,
  MagicPopover,
  saveMagicTab,
  SettingsModal,
} from './components/Modals';
import { DjiImportModal } from './components/DjiImportModal';
import { MediaLinkImportModal } from './components/MediaLinkImportModal';
import { PluginMarketplaceModal } from './components/PluginMarketplaceModal';
import { MagicOverlay, MagicShowSession } from './components/MagicOverlay';

const MAGIC_RECORDS_KEY = 'vectrail.magicRecords.v1';

function loadMagicRecords(): MagicRunRecord[] {
  try {
    const raw = localStorage.getItem(MAGIC_RECORDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MagicRunRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 40).map((r) =>
      r.status === 'running'
        ? {
            ...r,
            status: 'cancelled',
            finishedAt: r.finishedAt ?? Date.now(),
            steps: Array.isArray(r.steps)
              ? r.steps.map((s) => (s.status === 'running' ? { ...s, status: 'error' } : s))
              : [],
          }
        : { ...r, steps: Array.isArray(r.steps) ? r.steps : [] }
    );
  } catch {
    return [];
  }
}

function upsertProcessStep(steps: MagicProcessStep[], step: MagicProcessStep): MagicProcessStep[] {
  const idx = steps.findIndex((s) => s.id === step.id);
  if (idx >= 0) {
    const next = [...steps];
    next[idx] = step;
    return next;
  }
  return [...steps, step];
}

const DEFAULT_LAYOUT = { libraryW: 268, inspectorW: 300, magicW: 376, timelineH: 310 };

function clampLayout(
  raw: Partial<typeof DEFAULT_LAYOUT>,
  winW = typeof window !== 'undefined' ? window.innerWidth : 1460,
  winH = typeof window !== 'undefined' ? window.innerHeight : 920,
  magicOpen = false
) {
  const minViewerW = 360;
  let libraryW = Math.min(440, Math.max(200, raw.libraryW ?? DEFAULT_LAYOUT.libraryW));
  let inspectorW = Math.min(420, Math.max(250, raw.inspectorW ?? DEFAULT_LAYOUT.inspectorW));
  let magicW = Math.min(460, Math.max(320, raw.magicW ?? DEFAULT_LAYOUT.magicW));
  const sideOverhead = magicOpen ? magicW : 0;
  const maxSides = Math.max(480, winW - minViewerW - 12);
  const totalSides = libraryW + inspectorW + sideOverhead;
  if (totalSides > maxSides && totalSides > 0) {
    const ratio = maxSides / totalSides;
    libraryW = Math.max(190, Math.floor(libraryW * ratio));
    inspectorW = Math.max(230, Math.floor(inspectorW * ratio));
    if (magicOpen) magicW = Math.max(300, Math.floor(magicW * ratio));
  }
  const maxTimelineH = Math.max(190, winH - 280);
  const timelineH = Math.min(Math.min(520, maxTimelineH), Math.max(190, raw.timelineH ?? DEFAULT_LAYOUT.timelineH));
  return { libraryW, inspectorW, magicW, timelineH };
}

function loadLayout() {
  try {
    const raw = localStorage.getItem('vectrail.layout.v1');
    if (!raw) return clampLayout(DEFAULT_LAYOUT);
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_LAYOUT>;
    return clampLayout(parsed);
  } catch {
    return clampLayout(DEFAULT_LAYOUT);
  }
}

const THEME_STORAGE_KEY = 'vectrail.theme.v1';
const DARK_THEME_STORAGE_KEY = 'vectrail.lastDarkTheme.v1';

function loadSavedTheme(): AppThemeName {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'dark' || v === 'grey' || v === 'amber' || v === 'light') return v;
  } catch {
    // ignore storage errors
  }
  return 'dark';
}

function loadLastDarkTheme(): AppThemeName {
  try {
    const v = localStorage.getItem(DARK_THEME_STORAGE_KEY);
    if (v === 'dark' || v === 'grey' || v === 'amber') return v;
  } catch {
    // ignore storage errors
  }
  return 'dark';
}

export const App: React.FC = () => {
  const { L } = useI18n();
  const [snap, setSnap] = useState<EditorSnapshot | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tool, setTool] = useState<'select' | 'cut'>('select');
  const [snapping, setSnapping] = useState(true);
  const [sticky, setSticky] = useState(false);
  const [showStrip, setShowStrip] = useState(true);
  const [skim, setSkim] = useState(false);
  const [audioScrub, setAudioScrub] = useState(false);
  const [skimTime, setSkimTime] = useState<number | null>(null);
  const [zoomPx, setZoomPx] = useState(48);
  const [loop, setLoop] = useState(false);
  const [theme, setTheme] = useState<AppThemeName>(loadSavedTheme);
  const [lastDarkTheme, setLastDarkTheme] = useState<AppThemeName>(loadLastDarkTheme);
  const [copiedGrade, setCopiedGrade] = useState<ColorGrade | undefined>();
  const [clipClipboard, setClipClipboard] = useState<Clip[]>([]);
  const [modal, setModal] = useState<'export' | 'settings' | 'dji' | 'media' | 'marketplace' | null>(null);
  const [magicOpen, setMagicOpen] = useState(false);
  const [mcpRunning, setMcpRunning] = useState(false);
  const [meter, setMeter] = useState({ left: 0, right: 0 });
  const [dropActive, setDropActive] = useState(false);
  const [shuttleRate, setShuttleRate] = useState(1);
  const [shortcutMap, setShortcutMap] = useState<Record<string, string>>({});
  const [layout, setLayout] = useState(loadLayout);
  const [sourcePreview, setSourcePreview] = useState<{ asset: MediaAsset; time: number } | null>(null);
  const [pinnedSource, setPinnedSource] = useState<PinnedSourceState | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [magicPrompt, setMagicPrompt] = useState('');
  const [magicBackend, setMagicBackend] = useState<MagicBackend>(loadSavedMagicTab);
  const [magicPanelTab, setMagicPanelTab] = useState<'run' | 'templates' | 'activity'>('run');
  const [magicRecords, setMagicRecords] = useState<MagicRunRecord[]>(loadMagicRecords);
  const [magicThinking, setMagicThinking] = useState<MagicProgressEvent | null>(null);
  const [magicShow, setMagicShow] = useState<MagicShowSession | null>(null);
  const [magicPreviewProj, setMagicPreviewProj] = useState<Project | null>(null);
  const [magicNote, setMagicNote] = useState<{
    worker: string;
    detail?: string;
    summary: string;
    changed: boolean;
  } | null>(null);
  const [magicAnimated, setMagicAnimated] = useState(true);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegStatus | null>(null);
  const [ffmpegBannerDismissed, setFfmpegBannerDismissed] = useState(false);
  const [ffmpegInstalling, setFfmpegInstalling] = useState(false);
  const [djiState, setDjiState] = useState<DjiPluginStateSnapshot | null>(null);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const activeMagicRunIdRef = useRef<string | null>(null);
  const magicPhaseRef = useRef<'idle' | 'thinking' | 'showing'>('idle');

  const mixerRef = useRef<AudioMixer | null>(null);
  if (!mixerRef.current) mixerRef.current = new AudioMixer();
  const snapRef = useRef<EditorSnapshot | null>(null);
  snapRef.current = snap;
  const toastTimerRef = useRef<number | null>(null);
  const showToast = (text: string, kind: 'info' | 'error' = 'info') => {
    setToast({ text, kind });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), kind === 'error' ? 5000 : 2600);
  };

  useEffect(() => {
    void window.vectrail.getSnapshot().then(setSnap);
    void window.vectrail.getMcpStatus().then((m) => setMcpRunning(m.running));
    void window.vectrail.getShortcuts().then(setShortcutMap);
    void window.vectrail.getMagicAnimated().then(setMagicAnimated);
    void window.vectrail.getRecentProjects().then(setRecentProjects);
    void window.vectrail.getFfmpegStatus().then(setFfmpegStatus);
    void window.vectrail.getDjiState().then(setDjiState);
    void window.vectrail.listPlugins().then(setPlugins);
    const unsub = window.vectrail.onSnapshot(setSnap);
    const unsubDji = window.vectrail.onDjiState(setDjiState);
    const unsubMagic = window.vectrail.onMagicProgress((ev) => {
      if (ev.runId === activeMagicRunIdRef.current && magicPhaseRef.current === 'thinking') {
        setMagicThinking(ev);
      }
      const evStep = ev.step;
      if (evStep) {
        setMagicRecords((prev) =>
          prev.map((rec) =>
            rec.id === ev.runId
              ? { ...rec, steps: upsertProcessStep(rec.steps, evStep) }
              : rec
          )
        );
      }
    });
    const unsubMcpActivity = window.vectrail.onMcpActivity((ev) => {
      setMagicRecords((prev) => {
        const latest = prev[0];
        const step: MagicProcessStep = {
          id: ev.id,
          timestamp: ev.timestamp,
          stage: 'editing',
          title: ev.toolName,
          detail: ev.detail,
          toolName: ev.toolName,
          status: ev.status,
        };
        if (
          latest &&
          latest.backend === 'external' &&
          latest.worker === ev.clientName &&
          ev.timestamp - (latest.finishedAt ?? latest.startedAt) < 60_000
        ) {
          const updated: MagicRunRecord = {
            ...latest,
            finishedAt: ev.timestamp,
            summary: `${latest.steps.length + 1} external MCP tool call(s)`,
            steps: [...latest.steps, step].slice(-40),
          };
          return [updated, ...prev.slice(1)];
        }
        const created: MagicRunRecord = {
          id: `ext-${ev.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
          backend: 'external',
          worker: ev.clientName,
          detail: 'MCP Server',
          prompt: `${ev.clientName} MCP session`,
          startedAt: ev.timestamp,
          finishedAt: ev.timestamp,
          status: ev.status === 'error' ? 'error' : 'done',
          summary: `1 external MCP tool call (${ev.toolName})`,
          steps: [step],
        };
        return [created, ...prev].slice(0, 40);
      });
    });
    return () => {
      unsub();
      unsubDji();
      unsubMagic();
      unsubMcpActivity();
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      setLayout((prev) => clampLayout(prev, window.innerWidth, window.innerHeight, magicOpen));
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [magicOpen]);

  useEffect(() => {
    try {
      const compact = magicRecords.slice(0, 40).map((r) => ({
        ...r,
        steps: r.steps.slice(-40),
      }));
      localStorage.setItem(MAGIC_RECORDS_KEY, JSON.stringify(compact));
    } catch {
      // ignore storage errors
    }
  }, [magicRecords]);

  useEffect(() => {
    try {
      localStorage.setItem('vectrail.layout.v1', JSON.stringify(layout));
    } catch {
      // ignore storage errors
    }
  }, [layout]);

  useLayoutEffect(() => {
    const pal = THEMES[theme];
    const root = document.documentElement.style;
    root.colorScheme = pal.isLight ? 'light' : 'dark';
    root.setProperty('--bg', pal.bg);
    root.setProperty('--panel', pal.panel);
    root.setProperty('--lane', pal.lane);
    root.setProperty('--lane-alt', pal.laneAlt);
    root.setProperty('--raised', pal.raised);
    root.setProperty('--field', pal.field);
    root.setProperty('--stroke', pal.stroke);
    root.setProperty('--hover', pal.hover);
    root.setProperty('--text', pal.text);
    root.setProperty('--text-dim', pal.textDim);
    root.setProperty('--text-faint', pal.textFaint);
    root.setProperty('--on-text', pal.onText);
    root.setProperty('--accent', pal.accent);
    root.setProperty('--video', pal.video);
    root.setProperty('--audio', pal.audio);
    root.setProperty('--text-clip', pal.textClip);
    root.setProperty('--clip-stroke', pal.clipStroke);
    root.setProperty('--hint', pal.hint);
    root.setProperty('--well', pal.well);
    root.setProperty('--control', pal.control);
    root.setProperty('--button', pal.button);
    root.setProperty('--button-hover', pal.buttonHover);
    root.setProperty('--transport', pal.transport);
    root.setProperty('--outline', pal.outline);
    root.setProperty('--meter-low', pal.meterLow);
    root.setProperty('--chip', pal.chip);
    root.setProperty('--sheet', pal.sheet);
    root.setProperty('--sheet-field', pal.sheetField);
    root.setProperty('--sheet-field-hover', pal.sheetFieldHover);
    root.setProperty('--sheet-field-stroke', pal.sheetFieldStroke);
    root.setProperty('--sheet-label', pal.sheetLabel);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      if (!pal.isLight) {
        localStorage.setItem(DARK_THEME_STORAGE_KEY, theme);
        setLastDarkTheme(theme);
      }
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  const toggleLightDark = () => {
    setTheme((cur) => (THEMES[cur].isLight ? lastDarkTheme : 'light'));
  };

  useEffect(() => {
    if (!snap?.playing) {
      mixerRef.current?.pauseAll();
      setMeter({ left: 0, right: 0 });
      setShuttleRate(1);
      return;
    }
    let last = performance.now();
    let curTime = snapRef.current?.playhead ?? 0;
    let raf = 0;

    const tick = (now: number) => {
      const latestSnap = snapRef.current;
      if (!latestSnap) return;
      const dt = (now - last) / 1000;
      last = now;
      const dur = Math.max(0.1, projectDuration(latestSnap.project));
      curTime += dt * shuttleRate;
      if (curTime <= 0 && shuttleRate < 0) {
        curTime = 0;
        void window.vectrail.setPlaying(false);
        void window.vectrail.setPlayhead(0);
        return;
      }
      if (curTime >= dur) {
        if (loop) {
          curTime = latestSnap.project.playRange?.in ?? 0;
        } else {
          void window.vectrail.setPlaying(false);
          void window.vectrail.setPlayhead(dur);
          return;
        }
      }
      const m =
        mixerRef.current?.sync(latestSnap.project, curTime, true, latestSnap.waveforms) ?? {
          left: 0,
          right: 0,
        };
      setMeter(m);
      setSnap((prev) => (prev ? { ...prev, playhead: curTime } : prev));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      void window.vectrail.setPlayhead(curTime);
    };
  }, [snap?.playing, loop, shuttleRate]);

  const mutate = (fn: (p: Project) => void, recordHistory = true) => {
    const cur = snapRef.current;
    if (!cur) return;
    const draft = JSON.parse(JSON.stringify(cur.project)) as Project;
    fn(draft);
    void window.vectrail.mutateProject(draft, recordHistory);
  };

  const handleAddAsset = (asset: MediaAsset, inTime?: number, outTime?: number) => {
    mutate((p) => {
      const vTrack = p.videoTracks[0].id;
      const trackMax = p.clips
        .filter((c) => c.trackID === (asset.kind === 'audio' ? p.audioTracks[0].id : vTrack))
        .reduce((mx, c) => Math.max(mx, clipEnd(c)), 0);
      const s0 = Math.max(0, inTime ?? 0);
      const rawDur = outTime !== undefined && outTime > s0 + 0.05 ? outTime - s0 : Math.max(0.1, asset.duration - s0);
      const aTrack =
        asset.kind === 'audio'
          ? p.audioTracks[0].id
          : freeTrack(p, 'audio', trackMax, rawDur) ?? p.audioTracks[0]?.id ?? addTrack(p, 'audio').id;
      const made = makeClipsForAsset(p, asset, trackMax, vTrack, aTrack, s0, rawDur);
      p.clips.push(...made);
      resolveOverlaps(p, new Set(made.map((c) => c.id)));
    });
  };

  const handleDropAssetOnTimeline = (assetID: string, time: number, trackID?: string) => {
    if (!snap) return;
    const asset = snap.project.assets.find((a) => a.id === assetID);
    if (!asset) return;
    mutate((p) => {
      const targetV =
        trackID && p.videoTracks.some((t) => t.id === trackID) ? trackID : p.videoTracks[0].id;
      const targetA =
        trackID && p.audioTracks.some((t) => t.id === trackID)
          ? trackID
          : freeTrack(p, 'audio', time, asset.duration) ?? p.audioTracks[0].id;
      const made = makeClipsForAsset(p, asset, time, targetV, targetA);
      p.clips.push(...made);
      resolveOverlaps(p, new Set(made.map((c) => c.id)));
    });
  };

  const handleTranscribeAsset = async (assetID: string) => {
    if (!snap) return;
    const asset = snap.project.assets.find((a) => a.id === assetID);
    showToast(`Transcribing ${asset?.name ?? 'clip'}...`);
    try {
      await window.vectrail.transcribeAsset(assetID);
      showToast(`Transcribed ${asset?.name ?? 'clip'}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleTranscribeAll = async () => {
    if (!snap) return;
    const targets = snap.project.assets.filter((a) => a.kind === 'audio' || a.hasAudio);
    if (targets.length === 0) {
      showToast('No audio clips found to transcribe', 'error');
      return;
    }
    showToast(`Transcribing ${targets.length} clip(s)...`);
    let okCount = 0;
    let lastErr = '';
    for (const a of targets) {
      try {
        await window.vectrail.transcribeAsset(a.id);
        okCount++;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    if (okCount > 0) showToast(`Transcribed ${okCount}/${targets.length} clip(s)`);
    else if (lastErr) showToast(lastErr, 'error');
  };

  const handleSplitAtPlayhead = () => {
    if (!snap) return;
    const t = snapFrame(snap.playhead, snap.project.fps);
    mutate((p) => {
      const targets =
        selectedIds.length > 0
          ? [...linkedIds(p, selectedIds)]
          : p.clips.filter((c) => t > c.start + 0.05 && t < clipEnd(c) - 0.05).map((c) => c.id);
      splitClipsAt(p, targets, t);
    });
  };

  const handleDeleteSelected = (ripple: boolean) => {
    if (!snap || selectedIds.length === 0) return;
    mutate((p) => {
      const group = linkedIds(p, selectedIds);
      removeClips(p, group, ripple);
    });
    setSelectedIds([]);
  };

  const handleAddText = () => {
    if (!snap) return;
    mutate((p) => {
      const start = snapFrame(snap.playhead, p.fps);
      const dur = 3;
      const upper = p.videoTracks.slice(1).find((tr) => !p.clips.some((c) => c.trackID === tr.id && c.start < start + dur && clipEnd(c) > start));
      const trackID = upper?.id ?? addTrack(p, 'video').id;
      p.clips.push({
        id: newId(),
        trackID,
        kind: 'text',
        start,
        duration: dur,
        text: { string: 'Title', fontName: '', bold: true, size: 110, color: { r: 1, g: 1, b: 1, a: 1 }, x: 0.5, y: 0.5 },
      });
    });
  };

  const handleAddSolid = () => {
    if (!snap) return;
    mutate((p) => {
      const clip = createSolidClip(p, '#111216', snap.playhead, 3);
      setSelectedIds([clip.id]);
    });
  };

  const handleZoomToFit = () => {
    if (!snap) return;
    const dur = Math.max(4, projectDuration(snap.project) + 1);
    const avail = Math.max(320, window.innerWidth - 130);
    setZoomPx(Math.min(240, Math.max(12, Math.floor(avail / dur))));
  };

  const handleCopyClips = () => {
    if (!snap || selectedIds.length === 0) return;
    const ids = linkedIds(snap.project, selectedIds);
    const group = snap.project.clips.filter((c) => ids.has(c.id));
    if (group.length > 0) {
      setClipClipboard(JSON.parse(JSON.stringify(group)) as Clip[]);
      showToast(`Copied ${group.length} clip(s)`);
    }
  };

  const handleCutClips = () => {
    if (!snap || selectedIds.length === 0) return;
    handleCopyClips();
    handleDeleteSelected(false);
  };

  const handlePasteClips = () => {
    if (!snap || clipClipboard.length === 0) return;
    mutate((p) => {
      const created = pasteClipGroup(p, clipClipboard, snap.playhead);
      if (created.length) setSelectedIds(created.map((c) => c.id));
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!snap) return;
      if (e.key === 'Escape') {
        if (modal) {
          e.preventDefault();
          setModal(null);
          return;
        }
        if (magicNote) {
          e.preventDefault();
          setMagicNote(null);
          return;
        }
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (modal) {
        return;
      }
      const combo = formatEventCombo(e);
      if (!combo) return;
      const bindings = mergeShortcutBindings(shortcutMap);
      const match = bindings.find((b) => b.combo.toLowerCase() === combo.toLowerCase());
      const action: ShortcutActionId | undefined = match?.id;

      if (action === 'undo') {
        e.preventDefault();
        void window.vectrail.undo();
      } else if (action === 'redo') {
        e.preventDefault();
        void window.vectrail.redo();
      } else if (action === 'saveProject') {
        e.preventDefault();
        void window.vectrail.saveProjectDialog(e.shiftKey);
      } else if (action === 'importMedia') {
        e.preventDefault();
        void window.vectrail.importFilesDialog();
      } else if (action === 'exportVideo') {
        e.preventDefault();
        setMagicNote(null);
        setModal('export');
      } else if (action === 'magic') {
        e.preventDefault();
        setMagicNote(null);
        setMagicOpen((v) => !v);
      } else if (action === 'split') {
        e.preventDefault();
        handleSplitAtPlayhead();
      } else if (action === 'playPause') {
        e.preventDefault();
        void window.vectrail.setPlaying(!snap.playing);
      } else if (action === 'shuttleReverse') {
        e.preventDefault();
        setShuttleRate((r) => (snap.playing && r < 0 ? Math.max(-4, r * 2) : -1));
        if (!snap.playing) void window.vectrail.setPlaying(true);
      } else if (action === 'shuttlePause') {
        e.preventDefault();
        setShuttleRate(1);
        void window.vectrail.setPlaying(false);
      } else if (action === 'shuttleForward') {
        e.preventDefault();
        setShuttleRate((r) => (snap.playing && r > 0 ? Math.min(4, r * 2) : 1));
        if (!snap.playing) void window.vectrail.setPlaying(true);
      } else if (action === 'stepBack') {
        e.preventDefault();
        void window.vectrail.setPlayhead(Math.max(0, snap.playhead - 1 / snap.project.fps));
      } else if (action === 'stepForward') {
        e.preventDefault();
        void window.vectrail.setPlayhead(snap.playhead + 1 / snap.project.fps);
      } else if (action === 'previousEdit') {
        e.preventDefault();
        const prev = nearestEditPoint(snap.project, snap.playhead, false);
        if (prev !== undefined) void window.vectrail.setPlayhead(prev);
      } else if (action === 'nextEdit') {
        e.preventDefault();
        const next = nearestEditPoint(snap.project, snap.playhead, true);
        if (next !== undefined) void window.vectrail.setPlayhead(next);
      } else if (action === 'addDissolve') {
        e.preventDefault();
        mutate((p) => {
          const target =
            (selectedIds.length ? p.clips.find((c) => selectedIds.includes(c.id) && c.kind !== 'audio') : undefined) ??
            p.clips.find((c) => c.kind !== 'audio' && snap.playhead >= c.start && snap.playhead <= clipEnd(c));
          if (target) target.transitionIn = { kind: 'dissolve', duration: Math.min(0.5, target.duration) };
        });
      } else if (action === 'rippleTrimStart') {
        e.preventDefault();
        mutate((p) => rippleTrimEdge(p, selectedIds, snap.playhead, true));
      } else if (action === 'rippleTrimEnd') {
        e.preventDefault();
        mutate((p) => rippleTrimEdge(p, selectedIds, snap.playhead, false));
      } else if (action === 'closeAllGaps') {
        e.preventDefault();
        mutate((p) => closeAllGaps(p));
      } else if (action === 'markIn') {
        e.preventDefault();
        mutate((p) => {
          const t = snapFrame(snap.playhead, p.fps);
          const out = Math.max(t + 0.1, p.playRange?.out ?? Math.max(t + 1, projectDuration(p)));
          p.playRange = { in: t, out };
        });
      } else if (action === 'markOut') {
        e.preventDefault();
        mutate((p) => {
          const t = snapFrame(snap.playhead, p.fps);
          const inn = Math.min(t - 0.1, p.playRange?.in ?? 0);
          p.playRange = { in: Math.max(0, inn), out: Math.max(0.1, t) };
        });
      } else if (action === 'clearInOut') {
        e.preventDefault();
        mutate((p) => {
          delete p.playRange;
        });
      } else if (action === 'addMarker') {
        e.preventDefault();
        mutate((p) => {
          if (!p.markers) p.markers = [];
          p.markers.push({ id: newId(), time: snap.playhead, name: 'Marker', color: 'orange' });
        });
      } else if (action === 'selectTool') setTool('select');
      else if (action === 'cutTool') setTool('cut');
      else if (action === 'toggleSnap') setSnapping((s) => !s);
      else if (action === 'toggleSticky') setSticky((s) => !s);
      else if (action === 'toggleStrip') setShowStrip((s) => !s);
      else if (action === 'toggleSkim') setSkim((s) => !s);
      else if (action === 'toggleAudioScrub') setAudioScrub((s) => !s);
      else if (action === 'toggleLoop') setLoop((l) => !l);
      else if (action === 'zoomIn') setZoomPx((z) => Math.min(240, z * 1.25));
      else if (action === 'zoomOut') setZoomPx((z) => Math.max(12, z * 0.8));
      else if (action === 'zoomToFit') {
        e.preventDefault();
        handleZoomToFit();
      } else if (action === 'selectAll') {
        e.preventDefault();
        setSelectedIds(snap.project.clips.map((c) => c.id));
      } else if (action === 'copyClips') {
        e.preventDefault();
        handleCopyClips();
      } else if (action === 'cutClips') {
        e.preventDefault();
        handleCutClips();
      } else if (action === 'pasteClips') {
        e.preventDefault();
        handlePasteClips();
      }
      else if (action === 'copyGrade' && selectedClip?.grade) {
        setCopiedGrade(JSON.parse(JSON.stringify(selectedClip.grade)));
      } else if (action === 'pasteGrade' && copiedGrade && selectedClip) {
        mutate((p) => {
          const c = p.clips.find((x) => x.id === selectedClip.id);
          if (c) c.grade = JSON.parse(JSON.stringify(copiedGrade));
        });
      } else if (action === 'deleteClip') {
        handleDeleteSelected(false);
      } else if (action === 'rippleDelete') {
        handleDeleteSelected(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!snap) {
    return (
      <div
        className="w-full h-full flex items-center justify-center text-[12px]"
        style={{ background: 'var(--bg)', color: 'var(--text-dim)' }}
      >
        {L('正在启动 Vectrail...', 'Loading Vectrail...')}
      </div>
    );
  }

  const selectedClip = snap.project.clips.find((c) => c.id === selectedIds[0]);
  const displayProject = magicPreviewProj ?? snap.project;

  const workerNameFor = (b: MagicBackend): string =>
    b === 'claude' ? 'Claude' : b === 'codex' ? 'Codex' : b === 'cloud' ? 'Cloud AI' : 'Local';

  const handleStopMagic = () => {
    const rid = activeMagicRunIdRef.current;
    activeMagicRunIdRef.current = null;
    magicPhaseRef.current = 'idle';
    if (rid) void window.vectrail.cancelMagic(rid);
    if (rid) {
      setMagicRecords((prev) =>
        prev.map((rec) =>
          rec.id === rid && rec.status === 'running'
            ? {
                ...rec,
                status: 'cancelled',
                finishedAt: Date.now(),
                summary: rec.summary || 'Stopped.',
                steps: rec.steps.map((s) => (s.status === 'running' ? { ...s, status: 'error' } : s)),
              }
            : rec
        )
      );
    }
    setMagicThinking(null);
    setMagicShow(null);
    setMagicPreviewProj(null);
  };

  const handleRunMagic = async (
    promptText: string,
    backend: MagicBackend,
    options?: { model?: string; effort?: string }
  ) => {
    const runId = `magic-${Date.now()}`;
    const startedAt = Date.now();
    activeMagicRunIdRef.current = runId;
    magicPhaseRef.current = 'thinking';
    const worker = workerNameFor(backend);
    setMagicBackend(backend);
    saveMagicTab(backend);
    setMagicOpen(true);
    setMagicPanelTab('activity');
    setMagicNote(null);
    setMagicPrompt('');
    setMagicRecords((prev) =>
      [
        {
          id: runId,
          backend,
          worker,
          detail: [options?.model, options?.effort].filter(Boolean).join(' · ') || undefined,
          prompt: promptText.trim(),
          startedAt,
          status: 'running' as const,
          steps: [],
        },
        ...prev,
      ].slice(0, 40)
    );
    setMagicThinking({ runId, stage: 'looking', worker, status: 'Looking at media' });

    try {
      const res = await window.vectrail.runMagic(promptText, backend, selectedIds, runId, options);
      if (activeMagicRunIdRef.current !== runId || res.cancelled) {
        magicPhaseRef.current = 'idle';
        setMagicThinking(null);
        setMagicRecords((prev) =>
          prev.map((rec) =>
            rec.id === runId
              ? {
                  ...rec,
                  status: 'cancelled',
                  finishedAt: Date.now(),
                  durationMs: res.durationMs ?? Date.now() - startedAt,
                  detail: res.detail ?? rec.detail,
                  summary: res.summary || 'Stopped.',
                  steps: res.processSteps?.length ? res.processSteps : rec.steps,
                }
              : rec
          )
        );
        return;
      }
      magicPhaseRef.current = res.changed && res.beforeProject && res.afterProject ? 'showing' : 'idle';
      setMagicThinking(null);
      if (res.changed && res.beforeProject && res.afterProject) {
        setMagicRecords((prev) =>
          prev.map((rec) =>
            rec.id === runId
              ? {
                  ...rec,
                  detail: res.detail ?? rec.detail,
                  durationMs: res.durationMs,
                  summary: res.summary,
                  changed: true,
                  steps: res.processSteps?.length ? res.processSteps : rec.steps,
                }
              : rec
          )
        );
        const dur = Math.max(4, projectDuration(res.afterProject));
        const avail = Math.max(400, window.innerWidth - 110);
        setZoomPx(Math.min(200, Math.max(14, avail / dur)));
        const choreography = buildMagicPlan(res.beforeProject, res.afterProject, res.worker ?? worker);
        setMagicPreviewProj(res.beforeProject);
        setMagicShow({
          runId,
          choreography,
          summary: res.summary,
          detail: res.detail ?? '',
          worker: res.worker ?? worker,
          prompt: promptText,
          tab: backend,
          changed: true,
        });
      } else {
        activeMagicRunIdRef.current = null;
        setMagicRecords((prev) =>
          prev.map((rec) =>
            rec.id === runId
              ? {
                  ...rec,
                  status: res.ok ? 'done' : 'error',
                  finishedAt: Date.now(),
                  durationMs: res.durationMs ?? Date.now() - startedAt,
                  detail: res.detail ?? rec.detail,
                  summary: res.summary,
                  changed: Boolean(res.changed),
                  steps: res.processSteps?.length ? res.processSteps : rec.steps,
                }
              : rec
          )
        );
        setMagicNote({
          worker: res.worker ?? worker,
          detail: res.detail,
          summary: res.summary,
          changed: Boolean(res.changed),
        });
      }
    } catch (err) {
      if (activeMagicRunIdRef.current === runId) {
        activeMagicRunIdRef.current = null;
        magicPhaseRef.current = 'idle';
        setMagicThinking(null);
        setMagicShow(null);
        setMagicPreviewProj(null);
        const rawErr = err instanceof Error ? err.message : String(err);
        const cleanErr = rawErr.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim();
        setMagicRecords((prev) =>
          prev.map((rec) =>
            rec.id === runId
              ? {
                  ...rec,
                  status: 'error',
                  finishedAt: Date.now(),
                  durationMs: Date.now() - startedAt,
                  summary: cleanErr || 'Magic edit failed.',
                  steps: rec.steps.map((s) => (s.status === 'running' ? { ...s, status: 'error' } : s)),
                }
              : rec
          )
        );
        setMagicNote({
          worker,
          summary: cleanErr || 'Magic edit failed.',
          changed: false,
        });
      }
    }
  };

  const handleMagicShowComplete = (session: MagicShowSession) => {
    activeMagicRunIdRef.current = null;
    magicPhaseRef.current = 'idle';
    setMagicThinking(null);
    setMagicShow(null);
    setMagicPreviewProj(null);
    if (session.runId) {
      setMagicRecords((prev) =>
        prev.map((rec) =>
          rec.id === session.runId
            ? {
                ...rec,
                status: 'done',
                finishedAt: Date.now(),
                detail: session.detail || rec.detail,
                summary: session.summary,
                changed: session.changed,
              }
            : rec
        )
      );
    }
    void window.vectrail.commitMagic(session.choreography.after, session.prompt, session.tab).then((nextSnap) => {
      setSnap(nextSnap);
      void window.vectrail.setPlayhead(0);
      setMagicNote({
        worker: session.worker,
        detail: session.detail,
        summary: session.summary,
        changed: session.changed,
      });
    });
  };

  const activeMagicStatus = magicShow
    ? { worker: magicShow.worker, stage: 'editing' as const, status: 'Editing' }
    : magicThinking
    ? { worker: magicThinking.worker, stage: magicThinking.stage, status: magicThinking.status }
    : null;

  const startSplitDrag = (axis: 'library' | 'inspector' | 'magic' | 'timeline', e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const init = { ...layout };
    const onMove = (ev: MouseEvent) => {
      if (axis === 'library') {
        setLayout((prev) =>
          clampLayout({ ...prev, libraryW: init.libraryW + (ev.clientX - startX) }, window.innerWidth, window.innerHeight, magicOpen)
        );
      } else if (axis === 'inspector') {
        setLayout((prev) =>
          clampLayout({ ...prev, inspectorW: init.inspectorW - (ev.clientX - startX) }, window.innerWidth, window.innerHeight, magicOpen)
        );
      } else if (axis === 'magic') {
        setLayout((prev) =>
          clampLayout({ ...prev, magicW: init.magicW - (ev.clientX - startX) }, window.innerWidth, window.innerHeight, true)
        );
      } else {
        setLayout((prev) =>
          clampLayout({ ...prev, timelineH: init.timelineH - (ev.clientY - startY) }, window.innerWidth, window.innerHeight, magicOpen)
        );
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className="w-full h-full flex flex-col relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        const paths: string[] = [];
        for (const f of Array.from(e.dataTransfer.files)) {
          const p = (f as File & { path?: string }).path;
          if (p) paths.push(p);
        }
        const projFile = paths.find((fp) => /\.(vectrail|editroom)$/i.test(fp));
        if (projFile) {
          void window.vectrail.openProjectPath(projFile).then(() => {
            void window.vectrail.getRecentProjects().then(setRecentProjects);
          });
        } else if (paths.length) {
          void window.vectrail.importPaths(paths);
        }
      }}
    >
      <TitleBar
        title={snap.title}
        isDirty={snap.isDirty}
        canUndo={snap.canUndo}
        canRedo={snap.canRedo}
        exportsList={snap.exports}
        mcpRunning={mcpRunning}
        isLightTheme={THEMES[theme].isLight}
        magicOpen={magicOpen}
        magicBackend={magicBackend}
        magicStatus={activeMagicStatus}
        recentProjects={recentProjects}
        onNew={() => void window.vectrail.newProject()}
        onOpen={() =>
          void window.vectrail.openProjectDialog().then(() => {
            void window.vectrail.getRecentProjects().then(setRecentProjects);
          })
        }
        onOpenRecent={(fp) =>
          void window.vectrail.openProjectPath(fp).then(() => {
            void window.vectrail.getRecentProjects().then(setRecentProjects);
          })
        }
        onClearRecents={() => void window.vectrail.clearRecentProjects().then(setRecentProjects)}
        onSave={() =>
          void window.vectrail.saveProjectDialog(false).then(() => {
            void window.vectrail.getRecentProjects().then(setRecentProjects);
          })
        }
        onImport={() => void window.vectrail.importFilesDialog()}
        onUndo={() => void window.vectrail.undo()}
        onRedo={() => void window.vectrail.redo()}
        onOpenMagic={() => {
          setMagicNote(null);
          if (activeMagicStatus && !magicOpen) {
            setMagicPanelTab('activity');
          }
          setMagicOpen((v) => !v);
        }}
        onStopMagic={handleStopMagic}
        onOpenExport={() => {
          setMagicNote(null);
          setModal('export');
        }}
        onOpenSettings={() => {
          setMagicNote(null);
          setModal('settings');
        }}
        onOpenMarketplace={() => {
          setMagicNote(null);
          void window.vectrail.listPlugins().then(setPlugins);
          setModal('marketplace');
        }}
        onToggleLightDark={toggleLightDark}
        onCancelExport={(id) => void window.vectrail.cancelExport(id)}
        onShowExportInExplorer={(file) => void window.vectrail.showInExplorer(file)}
      />

      {ffmpegStatus && !ffmpegStatus.available && !ffmpegBannerDismissed && (
        <div
          className="px-3 py-1.5 flex items-center justify-between gap-3 text-[11px] shrink-0"
          style={{
            background: THEMES[theme].isLight ? '#FFF1EC' : '#2A1812',
            borderBottom: '1px solid rgba(255, 74, 28, 0.35)',
            color: THEMES[theme].isLight ? '#7A2714' : '#FFD8CC',
          }}
        >
          <span>
            {L(
              '未检测到 FFmpeg：缩略图、代理播放、Whisper 字幕与 MP4 导出均依赖 FFmpeg。',
              'FFmpeg was not detected on PATH. Thumbnails, proxy playback, Whisper captions, and MP4 export require FFmpeg.'
            )}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {ffmpegStatus.canWinget && (
              <button
                disabled={ffmpegInstalling}
                onClick={async () => {
                  setFfmpegInstalling(true);
                  try {
                    const res = await window.vectrail.installFfmpeg();
                    setFfmpegStatus(res.status);
                    showToast(res.message, res.ok ? 'info' : 'error');
                  } finally {
                    setFfmpegInstalling(false);
                  }
                }}
                className="px-2.5 py-0.5 rounded font-semibold"
                style={{ background: 'var(--accent)', color: '#FFFFFF' }}
              >
                {ffmpegInstalling
                  ? L('正在安装 FFmpeg...', 'Installing FFmpeg...')
                  : L('WinGet 一键安装', 'Install via WinGet')}
              </button>
            )}
            <button
              onClick={() => setModal('settings')}
              className="px-2 py-0.5 rounded"
              style={{
                background: THEMES[theme].isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.1)',
                color: THEMES[theme].isLight ? '#7A2714' : '#FFFFFF',
              }}
            >
              {L('设置', 'Settings')}
            </button>
            <button
              onClick={() => setFfmpegBannerDismissed(true)}
              className="px-1.5 py-0.5 rounded opacity-75 hover:opacity-100"
            >
              {L('忽略', 'Dismiss')}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <LibraryView
          assets={snap.project.assets}
          thumbs={snap.thumbs}
          sceneTags={snap.sceneTags ?? {}}
          transcripts={snap.transcripts ?? {}}
          fps={snap.project.fps}
          width={layout.libraryW}
          activeSourceId={pinnedSource?.asset.id}
          djiEnabled={Boolean(djiState?.enabled)}
          djiActiveDownloads={
            djiState?.tasks.filter((t) => t.status === 'queued' || t.status === 'downloading' || t.status === 'verifying' || t.status === 'importing').length ?? 0
          }
          onOpenDjiImport={() => setModal('dji')}
          onImport={() => void window.vectrail.importFilesDialog()}
          onImportFolder={() => void window.vectrail.importFolderDialog()}
          onAddAsset={handleAddAsset}
          onAddText={handleAddText}
          onAddSolid={handleAddSolid}
          onMatchSequence={(asset) => {
            mutate((p) => {
              p.width = asset.width;
              p.height = asset.height;
              if (asset.fps > 0) p.fps = asset.fps;
              p.settingsLocked = true;
            });
            showToast(L(`已匹配序列为 ${asset.width}x${asset.height} @ ${asset.fps}fps`, `Matched sequence to ${asset.width}x${asset.height} @ ${asset.fps}fps`));
          }}
          onShowInExplorer={(asset) => void window.vectrail.showInExplorer(asset.path)}
          onReloadAsset={(id) => {
            void window.vectrail.reloadAsset(id);
            showToast(L('已从磁盘重新加载素材', 'Reloaded asset from disk'));
          }}
          onDeleteAsset={(id) => {
            void window.vectrail.deleteAsset(id);
            showToast(L('已从素材库移除', 'Removed asset from library'));
          }}
          onHoverPreview={setSourcePreview}
          onSelectSource={(asset) => setPinnedSource({ asset, time: 0 })}
          onAutoEdit={() => void handleRunMagic('Make a beat-synced highlight cut.', 'local')}
          onTranscribeAsset={(id) => void handleTranscribeAsset(id)}
        />
        <div
          onMouseDown={(e) => startSplitDrag('library', e)}
          onDoubleClick={() => setLayout((prev) => ({ ...prev, libraryW: DEFAULT_LAYOUT.libraryW }))}
          className="w-1 shrink-0 cursor-col-resize hover:bg-[var(--accent)]/50 transition-colors"
          style={{ background: 'var(--stroke)' }}
          title={L('拖拽调整素材库宽度（双击重置）', 'Drag to resize Library (double-click to reset)')}
        />
        <ViewerScreen
          project={displayProject}
          playhead={snap.playhead}
          playing={snap.playing}
          loop={loop}
          meter={meter}
          transcripts={snap.transcripts ?? {}}
          scrubStrips={snap.scrubStrips}
          selectedClip={selectedClip}
          shuttleRate={shuttleRate}
          skimTime={skim ? skimTime : null}
          sourcePreview={sourcePreview}
          pinnedSource={pinnedSource}
          onChangePinnedSource={setPinnedSource}
          onInsertSourceRange={(asset, inT, outT) => handleAddAsset(asset, inT, outT)}
          onMutate={mutate}
          onTogglePlay={() => void window.vectrail.setPlaying(!snap.playing)}
          onSeek={(t) => void window.vectrail.setPlayhead(t)}
          onStep={(frames) =>
            void window.vectrail.setPlayhead(Math.max(0, snap.playhead + frames / snap.project.fps))
          }
          onJumpEdit={(forward) => {
            const target = nearestEditPoint(snap.project, snap.playhead, forward);
            if (target !== undefined) void window.vectrail.setPlayhead(target);
          }}
          onToggleLoop={() => setLoop((l) => !l)}
          onImport={() => void window.vectrail.importFilesDialog()}
        />
        <div
          onMouseDown={(e) => startSplitDrag('inspector', e)}
          onDoubleClick={() => setLayout((prev) => ({ ...prev, inspectorW: DEFAULT_LAYOUT.inspectorW }))}
          className="w-1 shrink-0 cursor-col-resize hover:bg-[var(--accent)]/50 transition-colors"
          style={{ background: 'var(--stroke)' }}
          title={L('拖拽调整检查器宽度（双击重置）', 'Drag to resize Inspector (double-click to reset)')}
        />
        <InspectorView
          project={displayProject}
          selectedClip={selectedClip}
          copiedGrade={copiedGrade}
          width={layout.inspectorW}
          onUpdateClip={(id, fn) =>
            mutate((p) => {
              const c = p.clips.find((x) => x.id === id);
              if (c) fn(c);
            })
          }
          onUpdateSequence={(fn) => mutate(fn)}
          onCopyGrade={(grade) => {
            setCopiedGrade(grade);
            showToast(L('已复制调色参数', 'Color grade copied'));
          }}
          onFreezeFrame={(id) =>
            mutate((p) => {
              freezeFrameClip(p, id, snap.playhead, 2);
            })
          }
          onReverseClip={(id) =>
            mutate((p) => {
              reverseClipGroup(p, id);
            })
          }
          onDetachAudio={(id) =>
            mutate((p) => {
              detachAudioLinks(p, [id]);
            })
          }
          onTranscribeAll={() => void handleTranscribeAll()}
        />
        {magicOpen && (
          <>
            <div
              onMouseDown={(e) => startSplitDrag('magic', e)}
              onDoubleClick={() => setLayout((prev) => clampLayout({ ...prev, magicW: DEFAULT_LAYOUT.magicW }, window.innerWidth, window.innerHeight, true))}
              className="w-1 shrink-0 cursor-col-resize hover:bg-[var(--accent)]/50 transition-colors z-[47]"
              style={{ background: 'var(--stroke)' }}
              title={L('拖拽调整 Magic 工作台宽度（双击重置）', 'Drag to resize Magic Studio (double-click to reset)')}
            />
            <MagicPopover
              project={snap.project}
              assets={snap.project.assets}
              selectedIds={selectedIds}
              hasEdit={snap.project.clips.some((c) => c.kind !== 'audio')}
              backend={magicBackend}
              panelTab={magicPanelTab}
              width={layout.magicW}
              isRunning={Boolean(activeMagicStatus)}
              activeStatus={activeMagicStatus}
              completionNote={magicNote}
              records={magicRecords}
              prompt={magicPrompt}
              history={snap.project.magicHistory ?? []}
              onChangeBackend={(b) => {
                setMagicBackend(b);
                saveMagicTab(b);
              }}
              onChangePanelTab={setMagicPanelTab}
              onChangePrompt={setMagicPrompt}
              onSubmit={(p, b, opts) => void handleRunMagic(p, b, opts)}
              onStop={handleStopMagic}
              onUndo={() => void window.vectrail.undo()}
              onDismissNote={() => setMagicNote(null)}
              onClearRecords={() => setMagicRecords((prev) => prev.filter((r) => r.status === 'running'))}
              onOpenSettings={() => {
                setMagicNote(null);
                setModal('settings');
              }}
              onClose={() => setMagicOpen(false)}
            />
          </>
        )}
      </div>

      <div
        onMouseDown={(e) => startSplitDrag('timeline', e)}
        onDoubleClick={() => setLayout((prev) => ({ ...prev, timelineH: DEFAULT_LAYOUT.timelineH }))}
        className="h-1 shrink-0 cursor-row-resize hover:bg-[var(--accent)]/50 transition-colors"
        style={{ background: 'var(--stroke)' }}
        title={L('拖拽调整时间线高度（双击重置）', 'Drag to resize Timeline (double-click to reset)')}
      />

      <TimelinePanel
        project={displayProject}
        playhead={snap.playhead}
        selectedIds={selectedIds}
        theme={theme}
        tool={tool}
        snapping={snapping}
        sticky={sticky}
        showStrip={showStrip}
        skim={skim}
        audioScrub={audioScrub}
        zoomPx={zoomPx}
        height={layout.timelineH}
        copiedGrade={copiedGrade}
        thumbs={snap.thumbs}
        waveforms={snap.waveforms}
        agentCursor={snap.agentCursor}
        onSetTool={setTool}
        onToggleSnap={() => setSnapping((s) => !s)}
        onToggleSticky={() => setSticky((s) => !s)}
        onToggleStrip={() => setShowStrip((s) => !s)}
        onToggleSkim={() => setSkim((s) => !s)}
        onToggleAudioScrub={() => setAudioScrub((s) => !s)}
        onSetZoom={setZoomPx}
        onZoomToFit={handleZoomToFit}
        onSeek={(t) => void window.vectrail.setPlayhead(t)}
        onSkimTime={setSkimTime}
        onScrubAudio={(t) => mixerRef.current?.scrubAt(displayProject, t)}
        onSelectClips={setSelectedIds}
        onMutate={mutate}
        onSplitAtPlayhead={handleSplitAtPlayhead}
        onDeleteSelected={handleDeleteSelected}
        onAddText={handleAddText}
        onAddMarker={() =>
          mutate((p) => {
            if (!p.markers) p.markers = [];
            p.markers.push({ id: newId(), time: snap.playhead, name: 'Marker', color: 'orange' });
          })
        }
        onAutoEdit={() => void handleRunMagic('Make a beat-synced highlight cut.', 'local')}
        onCloseAllGaps={() => mutate((p) => closeAllGaps(p))}
        onEvenLevels={() => mutate((p) => evenOutAudioLevels(p))}
        onDropAsset={handleDropAssetOnTimeline}
        onCopyGrade={setCopiedGrade}
        onDuplicateClip={(clipID) =>
          mutate((p) => {
            duplicateClips(p, [clipID]);
          })
        }
        onFreezeFrame={(clipID) =>
          mutate((p) => {
            freezeFrameClip(p, clipID, snap.playhead, 2);
          })
        }
        onReverseClip={(clipID) =>
          mutate((p) => {
            reverseClipGroup(p, clipID);
          })
        }
        onDetachAudio={(clipID) =>
          mutate((p) => {
            detachAudioLinks(p, [clipID]);
          })
        }
      />

      {dropActive && (
        <div
          className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center"
          style={{ background: 'rgba(255, 74, 28, 0.08)', border: '2px solid var(--accent)' }}
        >
          <div className="px-4 py-2 rounded-full text-[13px] font-semibold" style={{ background: 'var(--raised)' }}>
            {L('松开以导入素材', 'Drop to import')}
          </div>
        </div>
      )}

      {toast && (
        <div
          className="fixed bottom-4 right-4 z-50 px-3 py-1.5 rounded-lg shadow-xl text-[11px] font-medium"
          style={{
            background:
              toast.kind === 'error'
                ? THEMES[theme].isLight
                  ? '#FFF0EE'
                  : '#3A1515'
                : 'var(--sheet)',
            color:
              toast.kind === 'error'
                ? THEMES[theme].isLight
                  ? '#B42318'
                  : '#FFB4AB'
                : 'var(--text)',
            border: `1px solid ${toast.kind === 'error' ? '#FF453A' : 'var(--sheet-field-stroke)'}`,
          }}
        >
          {toast.text}
        </div>
      )}

      {modal === 'export' && (
        <ExportModal
          project={snap.project}
          title={snap.title}
          transcripts={snap.transcripts ?? {}}
          scrubStrips={snap.scrubStrips ?? {}}
          onClose={() => setModal(null)}
          onStart={(s: ExportSettings) => void window.vectrail.startExport(s)}
        />
      )}
      {magicNote && !magicOpen && !activeMagicStatus && (
        <MagicNotePopover
          worker={magicNote.worker}
          detail={magicNote.detail}
          summary={magicNote.summary}
          changed={magicNote.changed}
          onUndo={() => void window.vectrail.undo()}
          onClose={() => setMagicNote(null)}
        />
      )}
      {modal === 'dji' && djiState && (
        <DjiImportModal state={djiState} onClose={() => setModal(null)} />
      )}
      {modal === 'media' && <MediaLinkImportModal onClose={() => setModal(null)} />}
      {modal === 'marketplace' && (
        <PluginMarketplaceModal
          plugins={plugins}
          onTogglePlugin={async (pluginId, enabled) => {
            const next = await window.vectrail.setPluginEnabled(pluginId, enabled);
            setPlugins(next);
            void window.vectrail.getDjiState().then(setDjiState);
          }}
          onOpenDjiImport={() => setModal('dji')}
          onOpenMediaImport={() => setModal('media')}
          onOpenTemplates={() => {
            setMagicPanelTab('templates');
            setMagicOpen(true);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'settings' && (
        <SettingsModal
          theme={theme}
          shortcutMap={shortcutMap}
          magicAnimated={magicAnimated}
          onChangeMagicAnimated={setMagicAnimated}
          onPluginsChange={(next) => {
            setPlugins(next);
            void window.vectrail.getDjiState().then(setDjiState);
          }}
          onOpenMarketplace={() => {
            void window.vectrail.listPlugins().then(setPlugins);
            setModal('marketplace');
          }}
          onUpdateShortcuts={(next) => {
            setShortcutMap(next);
            void window.vectrail.saveShortcuts(next);
          }}
          onChangeTheme={setTheme}
          onFfmpegChange={setFfmpegStatus}
          onClose={() => setModal(null)}
        />
      )}
      <MagicOverlay
        project={displayProject}
        zoomPx={zoomPx}
        thinking={magicThinking}
        show={magicShow}
        agentCursor={snap.agentCursor}
        animationsEnabled={magicAnimated}
        rightInset={magicOpen ? layout.magicW : 0}
        onStopMagic={handleStopMagic}
        onTogglePlay={() => void window.vectrail.setPlaying(!snap.playing)}
        onShowProjectUpdate={setMagicPreviewProj}
        onShowComplete={handleMagicShowComplete}
      />
    </div>
  );
};
