import fs from 'node:fs';
import path from 'node:path';
import {
  AgentCursorState,
  ClipAnalysis,
  ExportJobInfo,
  MediaAsset,
  MusicAnalysis,
  Project,
  Transcript,
} from '../shared/types';
import { cloneProject, createEmptyProject, sanitizeProject } from '../shared/project';
import {
  ensurePlayableProxy,
  extractThumbnailStrip,
  extractWaveform,
  getCacheDir,
  probeMediaAsset,
  WaveformData,
} from './engine/ffmpeg';
import {
  analyzeMusicAsset,
  analyzeVisualAsset,
  computeClipSceneTags,
  getCachedTranscript,
  transcribeMediaAsset,
} from './engine/analyzer';
import { ExportManager } from './engine/exporter';

export interface EditorSnapshot {
  project: Project;
  filePath?: string;
  title: string;
  isDirty: boolean;
  playhead: number;
  playing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  agentCursor?: AgentCursorState;
  waveforms: Record<string, WaveformData>;
  thumbs: Record<string, string[]>;
  transcripts: Record<string, Transcript>;
  sceneTags: Record<string, string[]>;
  exports: ExportJobInfo[];
}

export class ProjectStore {
  project: Project;
  filePath?: string;
  isDirty = false;
  playhead = 0;
  playing = false;
  agentCursor?: AgentCursorState;
  waveforms: Record<string, WaveformData> = {};
  thumbs: Record<string, string[]> = {};
  clipAnalyses: Record<string, ClipAnalysis> = {};
  musicAnalyses: Record<string, MusicAnalysis> = {};
  transcripts: Record<string, Transcript> = {};
  sceneTags: Record<string, string[]> = {};
  undoStack: Project[] = [];
  redoStack: Project[] = [];
  readonly exports: ExportManager;
  private listeners = new Set<(snap: EditorSnapshot) => void>();
  private agentClearTimer?: NodeJS.Timeout;
  private pendingWarmups = new Set<Promise<void>>();

  constructor() {
    this.project = createEmptyProject();
    this.exports = new ExportManager(() => this.emit());
  }

  get title(): string {
    if (this.filePath) return path.basename(this.filePath, path.extname(this.filePath));
    return 'Untitled';
  }

  onChange(fn: (snap: EditorSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): EditorSnapshot {
    return {
      project: this.project,
      filePath: this.filePath,
      title: this.title,
      isDirty: this.isDirty,
      playhead: this.playhead,
      playing: this.playing,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      agentCursor: this.agentCursor,
      waveforms: this.waveforms,
      thumbs: this.thumbs,
      transcripts: this.transcripts,
      sceneTags: this.sceneTags,
      exports: this.exports.list(),
    };
  }

  emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  mutate(mutator: (draft: Project) => void, recordHistory = true): void {
    if (recordHistory) {
      this.undoStack.push(cloneProject(this.project));
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
    mutator(this.project);
    sanitizeProject(this.project);
    this.isDirty = true;
    this.emit();
  }

  replaceProject(nextProject: Project, recordHistory = true): void {
    if (recordHistory) {
      this.undoStack.push(cloneProject(this.project));
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
    this.project = cloneProject(nextProject);
    sanitizeProject(this.project);
    this.isDirty = true;
    this.emit();
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(cloneProject(this.project));
    this.project = prev;
    this.isDirty = true;
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(cloneProject(this.project));
    this.project = next;
    this.isDirty = true;
    this.emit();
    return true;
  }

  setPlayhead(t: number): void {
    this.playhead = Math.max(0, t);
    this.emit();
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.emit();
  }

  setAgentCursor(cursor?: Partial<AgentCursorState> & { name: string }): void {
    if (!cursor) {
      this.agentCursor = undefined;
      this.emit();
      return;
    }
    this.agentCursor = {
      name: cursor.name,
      activity: cursor.activity,
      clipID: cursor.clipID,
      time: cursor.time,
      updatedAt: Date.now(),
    };
    if (this.agentClearTimer) clearTimeout(this.agentClearTimer);
    this.agentClearTimer = setTimeout(() => {
      this.agentCursor = undefined;
      this.emit();
    }, 5000);
    this.emit();
  }

  newProject(): void {
    this.project = createEmptyProject();
    this.filePath = undefined;
    this.isDirty = false;
    this.playhead = 0;
    this.playing = false;
    this.undoStack = [];
    this.redoStack = [];
    this.waveforms = {};
    this.thumbs = {};
    this.transcripts = {};
    this.sceneTags = {};
    this.emit();
  }

  saveToFile(targetPath?: string): string {
    const outPath = targetPath ?? this.filePath;
    if (!outPath) throw new Error('No file path specified for saving project.');
    const projDir = path.dirname(path.resolve(outPath));
    for (const a of this.project.assets) {
      a.relativePath = path.relative(projDir, a.path).replace(/\\/g, '/');
    }
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(this.project, null, 2), 'utf8');
    this.filePath = path.resolve(outPath);
    this.isDirty = false;
    this.emit();
    return this.filePath;
  }

  openFromFile(filePath: string): void {
    const resolved = path.resolve(filePath);
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as Project;
    const projDir = path.dirname(resolved);
    for (const a of raw.assets) {
      if (!fs.existsSync(a.path) && a.relativePath) {
        const candidate = path.resolve(projDir, a.relativePath);
        if (fs.existsSync(candidate)) a.path = candidate;
      }
    }
    sanitizeProject(raw);
    this.project = raw;
    this.filePath = resolved;
    this.isDirty = false;
    this.playhead = 0;
    this.playing = false;
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
    for (const a of raw.assets) {
      void this.warmAsset(a);
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingWarmups.size > 0) {
      await Promise.allSettled([...this.pendingWarmups]);
    }
  }

  async importFiles(paths: string[]): Promise<MediaAsset[]> {
    const added: MediaAsset[] = [];
    for (const rawPath of paths) {
      const resolved = path.resolve(rawPath);
      if (!fs.existsSync(resolved)) continue;
      const existing = this.project.assets.find((a) => path.resolve(a.path) === resolved);
      if (existing) {
        added.push(existing);
        continue;
      }
      const asset = await probeMediaAsset(resolved);
      this.mutate((p) => {
        p.assets.push(asset);
        if (!p.settingsLocked && p.clips.length === 0 && asset.kind === 'video' && asset.width > 0 && asset.height > 0) {
          p.width = asset.width;
          p.height = asset.height;
          p.fps = asset.fps;
        }
      });
      added.push(asset);
      void this.warmAsset(asset);
    }
    return added;
  }

  async warmAsset(asset: MediaAsset): Promise<void> {
    if (!fs.existsSync(asset.path)) return;
    const task = (async () => {
      await this.runWarmAsset(asset);
    })();
    this.pendingWarmups.add(task);
    try {
      await task;
    } finally {
      this.pendingWarmups.delete(task);
    }
  }

  private async runWarmAsset(asset: MediaAsset): Promise<void> {
    try {
      if (asset.kind !== 'audio') {
        if (asset.kind === 'video' && !asset.playablePath) {
          const proxy = await ensurePlayableProxy(asset);
          if (proxy) {
            const target = this.project.assets.find((a) => a.id === asset.id);
            if (target) target.playablePath = proxy;
            asset.playablePath = proxy;
            this.emit();
          }
        }
        const strip = await extractThumbnailStrip(asset, asset.kind === 'image' ? 1 : 8);
        this.thumbs[asset.id] = strip;
        this.emit();
      }
      if (asset.kind === 'audio' || asset.hasAudio) {
        const wf = await extractWaveform(asset.path, 120);
        this.waveforms[asset.id] = wf;
        this.emit();
      }
      const cachedTr = getCachedTranscript(asset.path);
      if (cachedTr) {
        this.transcripts[asset.id] = cachedTr;
        this.emit();
      }
      if (asset.kind === 'audio') {
        const ma = await analyzeMusicAsset(asset);
        if (ma) this.musicAnalyses[asset.id] = ma;
      } else {
        const va = await analyzeVisualAsset(asset);
        if (va) {
          this.clipAnalyses[asset.id] = va;
          this.sceneTags[asset.id] = computeClipSceneTags(va);
          this.emit();
        }
      }
    } catch {
      // background warm failures are non-fatal
    }
  }

  async transcribeAsset(assetID: string, language = 'auto'): Promise<Transcript> {
    const asset = this.project.assets.find((a) => a.id === assetID);
    if (!asset) throw new Error(`Unknown asset: ${assetID}`);
    const tr = await transcribeMediaAsset(asset, language);
    this.transcripts[asset.id] = tr;
    this.emit();
    return tr;
  }
}

export function loadSavedShortcuts(): Record<string, string> {
  try {
    const p = path.join(getCacheDir('Config'), 'shortcuts.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveShortcutsConfig(map: Record<string, string>): void {
  try {
    const p = path.join(getCacheDir('Config'), 'shortcuts.json');
    fs.writeFileSync(p, JSON.stringify(map, null, 2), 'utf8');
  } catch {
    // ignore
  }
}
