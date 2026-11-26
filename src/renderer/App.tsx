import React, { useEffect, useRef, useState } from 'react';
import { ColorGrade, ExportSettings, MediaAsset, Project } from '../shared/types';
import { AppThemeName, THEMES } from '../shared/themes';
import {
  addTrack,
  clipEnd,
  detachAudioLinks,
  freeTrack,
  freezeFrameClip,
  linkedIds,
  makeClipsForAsset,
  newId,
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
import { ViewerScreen } from './components/ViewerScreen';
import { InspectorView } from './components/InspectorView';
import { TimelinePanel } from './components/TimelinePanel';
import { ExportModal, MagicModal, SettingsModal } from './components/Modals';

export const App: React.FC = () => {
  const [snap, setSnap] = useState<EditorSnapshot | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tool, setTool] = useState<'select' | 'cut'>('select');
  const [snapping, setSnapping] = useState(true);
  const [zoomPx, setZoomPx] = useState(48);
  const [loop, setLoop] = useState(false);
  const [theme, setTheme] = useState<AppThemeName>('dark');
  const [copiedGrade, setCopiedGrade] = useState<ColorGrade | undefined>();
  const [modal, setModal] = useState<'export' | 'magic' | 'settings' | null>(null);
  const [mcpRunning, setMcpRunning] = useState(false);
  const [meter, setMeter] = useState({ left: 0, right: 0 });
  const [dropActive, setDropActive] = useState(false);
  const [shuttleRate, setShuttleRate] = useState(1);
  const [shortcutMap, setShortcutMap] = useState<Record<string, string>>({});

  const mixerRef = useRef<AudioMixer | null>(null);
  if (!mixerRef.current) mixerRef.current = new AudioMixer();

  useEffect(() => {
    void window.editroom.getSnapshot().then(setSnap);
    void window.editroom.getMcpStatus().then((m) => setMcpRunning(m.running));
    void window.editroom.getShortcuts().then(setShortcutMap);
    const unsub = window.editroom.onSnapshot(setSnap);
    return unsub;
  }, []);

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
    let curTime = snap.playhead;
    const dur = Math.max(0.1, projectDuration(snap.project));
    let raf = 0;

    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      curTime += dt * shuttleRate;
      if (curTime < 0) {
        curTime = 0;
        void window.editroom.setPlaying(false);
        void window.editroom.setPlayhead(0);
        return;
      }
      if (curTime >= dur) {
        if (loop) {
          curTime = snap.project.playRange?.in ?? 0;
        } else {
          void window.editroom.setPlaying(false);
          void window.editroom.setPlayhead(dur);
          return;
        }
      }
      const m = mixerRef.current?.sync(snap.project, curTime, true) ?? { left: 0, right: 0 };
      setMeter(m);
      setSnap((prev) => (prev ? { ...prev, playhead: curTime } : prev));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      void window.editroom.setPlayhead(curTime);
    };
  }, [snap?.playing, loop, shuttleRate]);

  const mutate = (fn: (p: Project) => void, recordHistory = true) => {
    if (!snap) return;
    const draft = JSON.parse(JSON.stringify(snap.project)) as Project;
    fn(draft);
    void window.editroom.mutateProject(draft, recordHistory);
  };

  const handleAddAsset = (asset: MediaAsset) => {
    mutate((p) => {
      const vTrack = p.videoTracks[0].id;
      const trackMax = p.clips
        .filter((c) => c.trackID === (asset.kind === 'audio' ? p.audioTracks[0].id : vTrack))
        .reduce((mx, c) => Math.max(mx, clipEnd(c)), 0);
      const aTrack =
        asset.kind === 'audio'
          ? p.audioTracks[0].id
          : freeTrack(p, 'audio', trackMax, asset.duration) ?? p.audioTracks[0]?.id ?? addTrack(p, 'audio').id;
      const made = makeClipsForAsset(p, asset, trackMax, vTrack, aTrack);
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

  const handleTranscribeAll = async () => {
    if (!snap) return;
    for (const a of snap.project.assets) {
      if (a.kind === 'audio' || a.hasAudio) {
        try {
          await window.editroom.transcribeAsset(a.id);
        } catch {
          // skip asset on error
        }
      }
    }
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!snap) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const combo = formatEventCombo(e);
      if (!combo) return;
      const bindings = mergeShortcutBindings(shortcutMap);
      const match = bindings.find((b) => b.combo.toLowerCase() === combo.toLowerCase());
      const action: ShortcutActionId | undefined = match?.id;

      if (action === 'undo') {
        e.preventDefault();
        void window.editroom.undo();
      } else if (action === 'redo') {
        e.preventDefault();
        void window.editroom.redo();
      } else if (action === 'saveProject') {
        e.preventDefault();
        void window.editroom.saveProjectDialog(e.shiftKey);
      } else if (action === 'importMedia') {
        e.preventDefault();
        void window.editroom.importFilesDialog();
      } else if (action === 'exportVideo') {
        e.preventDefault();
        setModal('export');
      } else if (action === 'magic') {
        e.preventDefault();
        setModal('magic');
      } else if (action === 'split') {
        e.preventDefault();
        handleSplitAtPlayhead();
      } else if (action === 'playPause') {
        e.preventDefault();
        void window.editroom.setPlaying(!snap.playing);
      } else if (action === 'shuttleReverse') {
        e.preventDefault();
        setShuttleRate((r) => (snap.playing && r < 0 ? Math.max(-4, r * 2) : -1));
        if (!snap.playing) void window.editroom.setPlaying(true);
      } else if (action === 'shuttlePause') {
        e.preventDefault();
        setShuttleRate(1);
        void window.editroom.setPlaying(false);
      } else if (action === 'shuttleForward') {
        e.preventDefault();
        setShuttleRate((r) => (snap.playing && r > 0 ? Math.min(4, r * 2) : 1));
        if (!snap.playing) void window.editroom.setPlaying(true);
      } else if (action === 'stepBack') {
        e.preventDefault();
        void window.editroom.setPlayhead(Math.max(0, snap.playhead - 1 / snap.project.fps));
      } else if (action === 'stepForward') {
        e.preventDefault();
        void window.editroom.setPlayhead(snap.playhead + 1 / snap.project.fps);
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
      else if (action === 'toggleLoop') setLoop((l) => !l);
      else if (action === 'zoomIn') setZoomPx((z) => Math.min(240, z * 1.25));
      else if (action === 'zoomOut') setZoomPx((z) => Math.max(12, z * 0.8));
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
        Loading Editroom...
      </div>
    );
  }

  const selectedClip = snap.project.clips.find((c) => c.id === selectedIds[0]);

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
        if (paths.length) void window.editroom.importPaths(paths);
      }}
    >
      <TitleBar
        title={snap.title}
        isDirty={snap.isDirty}
        canUndo={snap.canUndo}
        canRedo={snap.canRedo}
        exportsList={snap.exports}
        mcpRunning={mcpRunning}
        onNew={() => void window.editroom.newProject()}
        onOpen={() => void window.editroom.openProjectDialog()}
        onSave={() => void window.editroom.saveProjectDialog(false)}
        onImport={() => void window.editroom.importFilesDialog()}
        onUndo={() => void window.editroom.undo()}
        onRedo={() => void window.editroom.redo()}
        onOpenMagic={() => setModal('magic')}
        onOpenExport={() => setModal('export')}
        onOpenSettings={() => setModal('settings')}
        onCancelExport={(id) => void window.editroom.cancelExport(id)}
      />

      <div className="flex-1 flex min-h-0">
        <LibraryView
          assets={snap.project.assets}
          thumbs={snap.thumbs}
          sceneTags={snap.sceneTags ?? {}}
          transcripts={snap.transcripts ?? {}}
          fps={snap.project.fps}
          onImport={() => void window.editroom.importFilesDialog()}
          onAddAsset={handleAddAsset}
          onAutoEdit={() => void window.editroom.autoEdit()}
          onTranscribeAsset={(id) => void window.editroom.transcribeAsset(id)}
        />
        <ViewerScreen
          project={snap.project}
          playhead={snap.playhead}
          playing={snap.playing}
          loop={loop}
          meter={meter}
          transcripts={snap.transcripts ?? {}}
          onTogglePlay={() => void window.editroom.setPlaying(!snap.playing)}
          onSeek={(t) => void window.editroom.setPlayhead(t)}
          onStep={(frames) =>
            void window.editroom.setPlayhead(Math.max(0, snap.playhead + frames / snap.project.fps))
          }
          onToggleLoop={() => setLoop((l) => !l)}
          onImport={() => void window.editroom.importFilesDialog()}
        />
        <InspectorView
          project={snap.project}
          selectedClip={selectedClip}
          copiedGrade={copiedGrade}
          onUpdateClip={(id, fn) =>
            mutate((p) => {
              const c = p.clips.find((x) => x.id === id);
              if (c) fn(c);
            })
          }
          onUpdateSequence={(fn) => mutate(fn)}
          onCopyGrade={setCopiedGrade}
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

      <TimelinePanel
        project={snap.project}
        playhead={snap.playhead}
        selectedIds={selectedIds}
        tool={tool}
        snapping={snapping}
        zoomPx={zoomPx}
        thumbs={snap.thumbs}
        waveforms={snap.waveforms}
        agentCursor={snap.agentCursor}
        onSetTool={setTool}
        onToggleSnap={() => setSnapping((s) => !s)}
        onSetZoom={setZoomPx}
        onSeek={(t) => void window.editroom.setPlayhead(t)}
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
        onAutoEdit={() => void window.editroom.autoEdit()}
        onDropAsset={handleDropAssetOnTimeline}
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

      {modal === 'export' && (
        <ExportModal
          project={snap.project}
          title={snap.title}
          onClose={() => setModal(null)}
          onStart={(s: ExportSettings) => void window.editroom.startExport(s)}
        />
      )}
      {modal === 'magic' && (
        <MagicModal assets={snap.project.assets} selectedIds={selectedIds} onClose={() => setModal(null)} />
      )}
      {modal === 'settings' && (
        <SettingsModal
          theme={theme}
          shortcutMap={shortcutMap}
          onUpdateShortcuts={(next) => {
            setShortcutMap(next);
            void window.editroom.saveShortcuts(next);
          }}
          onChangeTheme={setTheme}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
};
