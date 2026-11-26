import React, { useEffect, useRef, useState } from 'react';
import { Clip, ColorGrade, ExportSettings, MediaAsset, Project } from '../shared/types';
import { AppThemeName, THEMES } from '../shared/themes';
import {
  addTrack,
  clipEnd,
  createSolidClip,
  detachAudioLinks,
  duplicateClips,
  freeTrack,
  freezeFrameClip,
  linkedIds,
  makeClipsForAsset,
  newId,
  pasteClipGroup,
  projectDuration,
  removeClips,
  resolveOverlaps,
  reverseClipGroup,
  snapFrame,
  splitClipsAt,
} from '../shared/project';
import { EditorSnapshot } from '../main/state';
import { formatEventCombo, mergeShortcutBindings, ShortcutActionId } from '../shared/shortcuts';
import { AudioMixer } from './engine/audioMixer';
import { TitleBar } from './components/TitleBar';
import { LibraryView } from './components/LibraryView';
import { PinnedSourceState, ViewerScreen } from './components/ViewerScreen';
import { InspectorView } from './components/InspectorView';
import { TimelinePanel } from './components/TimelinePanel';
import { ExportModal, MagicPopover, SettingsModal } from './components/Modals';

const DEFAULT_LAYOUT = { libraryW: 268, inspectorW: 300, timelineH: 320 };

function loadLayout() {
  try {
    const raw = localStorage.getItem('vectrail.layout.v1');
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_LAYOUT>;
    return {
      libraryW: Math.min(460, Math.max(190, parsed.libraryW ?? DEFAULT_LAYOUT.libraryW)),
      inspectorW: Math.min(440, Math.max(250, parsed.inspectorW ?? DEFAULT_LAYOUT.inspectorW)),
      timelineH: Math.min(520, Math.max(190, parsed.timelineH ?? DEFAULT_LAYOUT.timelineH)),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export const App: React.FC = () => {
  const [snap, setSnap] = useState<EditorSnapshot | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tool, setTool] = useState<'select' | 'cut'>('select');
  const [snapping, setSnapping] = useState(true);
  const [sticky, setSticky] = useState(false);
  const [showStrip, setShowStrip] = useState(true);
  const [skim, setSkim] = useState(false);
  const [skimTime, setSkimTime] = useState<number | null>(null);
  const [zoomPx, setZoomPx] = useState(48);
  const [loop, setLoop] = useState(false);
  const [theme, setTheme] = useState<AppThemeName>('dark');
  const [copiedGrade, setCopiedGrade] = useState<ColorGrade | undefined>();
  const [clipClipboard, setClipClipboard] = useState<Clip[]>([]);
  const [modal, setModal] = useState<'export' | 'magic' | 'settings' | null>(null);
  const [mcpRunning, setMcpRunning] = useState(false);
  const [meter, setMeter] = useState({ left: 0, right: 0 });
  const [dropActive, setDropActive] = useState(false);
  const [shuttleRate, setShuttleRate] = useState(1);
  const [shortcutMap, setShortcutMap] = useState<Record<string, string>>({});
  const [layout, setLayout] = useState(loadLayout);
  const [sourcePreview, setSourcePreview] = useState<{ asset: MediaAsset; time: number } | null>(null);
  const [pinnedSource, setPinnedSource] = useState<PinnedSourceState | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);

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
    const unsub = window.vectrail.onSnapshot(setSnap);
    return unsub;
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('vectrail.layout.v1', JSON.stringify(layout));
    } catch {
      // ignore storage errors
    }
  }, [layout]);

  useEffect(() => {
    const pal = THEMES[theme];
    const root = document.documentElement.style;
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
  }, [theme]);

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
      const m = mixerRef.current?.sync(latestSnap.project, curTime, true) ?? { left: 0, right: 0 };
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
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (modal) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setModal(null);
        }
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
        setModal('export');
      } else if (action === 'magic') {
        e.preventDefault();
        setModal((m) => (m === 'magic' ? null : 'magic'));
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
      <div className="w-full h-full flex items-center justify-center" style={{ background: '#0A0A0A', color: '#9A9A96' }}>
        Loading Vectrail...
      </div>
    );
  }

  const selectedClip = snap.project.clips.find((c) => c.id === selectedIds[0]);

  const startSplitDrag = (axis: 'library' | 'inspector' | 'timeline', e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const init = { ...layout };
    const onMove = (ev: MouseEvent) => {
      if (axis === 'library') {
        setLayout((prev) => ({ ...prev, libraryW: Math.min(460, Math.max(190, init.libraryW + (ev.clientX - startX))) }));
      } else if (axis === 'inspector') {
        setLayout((prev) => ({ ...prev, inspectorW: Math.min(440, Math.max(250, init.inspectorW - (ev.clientX - startX))) }));
      } else {
        setLayout((prev) => ({ ...prev, timelineH: Math.min(520, Math.max(190, init.timelineH - (ev.clientY - startY))) }));
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
        if (paths.length) void window.vectrail.importPaths(paths);
      }}
    >
      <TitleBar
        title={snap.title}
        isDirty={snap.isDirty}
        canUndo={snap.canUndo}
        canRedo={snap.canRedo}
        exportsList={snap.exports}
        mcpRunning={mcpRunning}
        magicOpen={modal === 'magic'}
        onNew={() => void window.vectrail.newProject()}
        onOpen={() => void window.vectrail.openProjectDialog()}
        onSave={() => void window.vectrail.saveProjectDialog(false)}
        onImport={() => void window.vectrail.importFilesDialog()}
        onUndo={() => void window.vectrail.undo()}
        onRedo={() => void window.vectrail.redo()}
        onOpenMagic={() => setModal((m) => (m === 'magic' ? null : 'magic'))}
        onOpenExport={() => setModal('export')}
        onOpenSettings={() => setModal('settings')}
        onCancelExport={(id) => void window.vectrail.cancelExport(id)}
      />

      <div className="flex-1 flex min-h-0">
        <LibraryView
          assets={snap.project.assets}
          thumbs={snap.thumbs}
          sceneTags={snap.sceneTags ?? {}}
          transcripts={snap.transcripts ?? {}}
          fps={snap.project.fps}
          width={layout.libraryW}
          activeSourceId={pinnedSource?.asset.id}
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
            showToast(`Matched sequence to ${asset.width}x${asset.height} @ ${asset.fps}fps`);
          }}
          onShowInExplorer={(asset) => void window.vectrail.showInExplorer(asset.path)}
          onReloadAsset={(id) => {
            void window.vectrail.reloadAsset(id);
            showToast('Reloaded asset from disk');
          }}
          onDeleteAsset={(id) => {
            void window.vectrail.deleteAsset(id);
            showToast('Removed asset from library');
          }}
          onHoverPreview={setSourcePreview}
          onSelectSource={(asset) => setPinnedSource({ asset, time: 0 })}
          onAutoEdit={() => void window.vectrail.autoEdit()}
          onTranscribeAsset={(id) => void handleTranscribeAsset(id)}
        />
        <div
          onMouseDown={(e) => startSplitDrag('library', e)}
          onDoubleClick={() => setLayout((prev) => ({ ...prev, libraryW: DEFAULT_LAYOUT.libraryW }))}
          className="w-1 shrink-0 cursor-col-resize hover:opacity-100 transition-colors"
          style={{ background: 'var(--stroke)' }}
          title="Drag to resize Library (double-click to reset)"
        />
        <ViewerScreen
          project={snap.project}
          playhead={snap.playhead}
          playing={snap.playing}
          loop={loop}
          meter={meter}
          transcripts={snap.transcripts ?? {}}
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
          onToggleLoop={() => setLoop((l) => !l)}
          onImport={() => void window.vectrail.importFilesDialog()}
        />
        <div
          onMouseDown={(e) => startSplitDrag('inspector', e)}
          onDoubleClick={() => setLayout((prev) => ({ ...prev, inspectorW: DEFAULT_LAYOUT.inspectorW }))}
          className="w-1 shrink-0 cursor-col-resize hover:opacity-100 transition-colors"
          style={{ background: 'var(--stroke)' }}
          title="Drag to resize Inspector (double-click to reset)"
        />
        <InspectorView
          project={snap.project}
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
            showToast('Color grade copied');
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
      </div>

      <div
        onMouseDown={(e) => startSplitDrag('timeline', e)}
        onDoubleClick={() => setLayout((prev) => ({ ...prev, timelineH: DEFAULT_LAYOUT.timelineH }))}
        className="h-1 shrink-0 cursor-row-resize hover:opacity-100 transition-colors"
        style={{ background: 'var(--stroke)' }}
        title="Drag to resize Timeline (double-click to reset)"
      />

      <TimelinePanel
        project={snap.project}
        playhead={snap.playhead}
        selectedIds={selectedIds}
        tool={tool}
        snapping={snapping}
        sticky={sticky}
        showStrip={showStrip}
        skim={skim}
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
        onSetZoom={setZoomPx}
        onZoomToFit={handleZoomToFit}
        onSeek={(t) => void window.vectrail.setPlayhead(t)}
        onSkimTime={setSkimTime}
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
        onAutoEdit={() => void window.vectrail.autoEdit()}
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
            Drop to import
          </div>
        </div>
      )}

      {toast && (
        <div
          className="fixed bottom-4 right-4 z-50 px-3 py-1.5 rounded-lg shadow-xl text-[11px] font-medium"
          style={{
            background: toast.kind === 'error' ? '#3A1515' : 'var(--sheet)',
            color: toast.kind === 'error' ? '#FFB4AB' : 'var(--text)',
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
          onClose={() => setModal(null)}
          onStart={(s: ExportSettings) => void window.vectrail.startExport(s)}
        />
      )}
      {modal === 'magic' && (
        <MagicPopover
          assets={snap.project.assets}
          selectedIds={selectedIds}
          canUndo={snap.canUndo}
          onUndo={() => void window.vectrail.undo()}
          onOpenSettings={() => setModal('settings')}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'settings' && (
        <SettingsModal
          theme={theme}
          shortcutMap={shortcutMap}
          onUpdateShortcuts={(next) => {
            setShortcutMap(next);
            void window.vectrail.saveShortcuts(next);
          }}
          onChangeTheme={setTheme}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
};
