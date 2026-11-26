import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppUpdateInfo,
  CloudAiConfig,
  ExportSettings,
  MagicProgressEvent,
  MagicRunResult,
  Project,
  Transcript,
} from '../shared/types';
import type { EditorSnapshot } from '../main/state';
import type { WhisperStatus } from '../main/engine/analyzer';
import type { AgentTarget, AgentTargetStatus, MagicBackend } from '../main/magic/agentConnect';

export interface MCPStatusInfo {
  running: boolean;
  enabled: boolean;
  endpoint: string;
  problem?: string;
  clients: Array<{ id: string; name: string; lastSeen: number }>;
}

export interface VectrailBridgeAPI {
  getSnapshot: () => Promise<EditorSnapshot>;
  onSnapshot: (cb: (snap: EditorSnapshot) => void) => () => void;
  mutateProject: (nextProject: Project, recordHistory?: boolean) => Promise<EditorSnapshot>;
  undo: () => Promise<EditorSnapshot>;
  redo: () => Promise<EditorSnapshot>;
  setPlayhead: (t: number) => Promise<void>;
  setPlaying: (playing: boolean) => Promise<void>;
  importFilesDialog: () => Promise<EditorSnapshot>;
  importFolderDialog: () => Promise<EditorSnapshot>;
  importPaths: (paths: string[]) => Promise<EditorSnapshot>;
  showInExplorer: (filePath: string) => Promise<void>;
  reloadAsset: (assetID: string) => Promise<EditorSnapshot>;
  deleteAsset: (assetID: string) => Promise<EditorSnapshot>;
  openProjectDialog: () => Promise<EditorSnapshot>;
  openProjectPath: (filePath: string) => Promise<EditorSnapshot>;
  getRecentProjects: () => Promise<string[]>;
  clearRecentProjects: () => Promise<string[]>;
  saveProjectDialog: (saveAs?: boolean) => Promise<EditorSnapshot>;
  newProject: () => Promise<EditorSnapshot>;
  pickCubeFile: () => Promise<string | undefined>;
  readTextFile: (filePath: string) => Promise<string | undefined>;
  startExport: (settings: ExportSettings) => Promise<void>;
  cancelExport: (id: string) => Promise<void>;
  getMcpStatus: () => Promise<MCPStatusInfo>;
  setMcpEnabled: (enabled: boolean) => Promise<MCPStatusInfo>;
  getAgentStatuses: () => Promise<AgentTargetStatus[]>;
  connectAgent: (target: AgentTarget) => Promise<AgentTargetStatus[]>;
  disconnectAgent: (target: AgentTarget) => Promise<AgentTargetStatus[]>;
  runMagic: (
    prompt: string,
    backend: MagicBackend,
    selectedClipIds: string[],
    runId?: string,
    options?: { model?: string; effort?: string }
  ) => Promise<MagicRunResult>;
  cancelMagic: (runId?: string) => Promise<boolean>;
  commitMagic: (nextProject: Project, prompt?: string, tab?: string) => Promise<EditorSnapshot>;
  onMagicProgress: (cb: (ev: MagicProgressEvent) => void) => () => void;
  getMagicAnimated: () => Promise<boolean>;
  setMagicAnimated: (enabled: boolean) => Promise<boolean>;
  autoEdit: () => Promise<void>;
  transcribeAsset: (assetID: string, language?: string) => Promise<Transcript>;
  getWhisperStatus: () => Promise<WhisperStatus>;
  downloadWhisperModel: (size?: 'tiny' | 'base') => Promise<string>;
  getShortcuts: () => Promise<Record<string, string>>;
  saveShortcuts: (map: Record<string, string>) => Promise<Record<string, string>>;
  getCloudAiConfig: () => Promise<CloudAiConfig>;
  saveCloudAiConfig: (cfg: Partial<CloudAiConfig>) => Promise<CloudAiConfig>;
  testCloudAiConnection: (cfg: CloudAiConfig) => Promise<{ ok: boolean; message: string }>;
  getAutoSave: () => Promise<boolean>;
  setAutoSave: (enabled: boolean) => Promise<boolean>;
  checkForUpdates: () => Promise<AppUpdateInfo>;
  openExternalUrl: (url: string) => Promise<void>;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
}

const api: VectrailBridgeAPI = {
  getSnapshot: () => ipcRenderer.invoke('vectrail:get-snapshot'),
  onSnapshot: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, snap: EditorSnapshot) => cb(snap);
    ipcRenderer.on('vectrail:snapshot', listener);
    return () => ipcRenderer.removeListener('vectrail:snapshot', listener);
  },
  mutateProject: (nextProject, recordHistory = true) =>
    ipcRenderer.invoke('vectrail:mutate-project', nextProject, recordHistory),
  undo: () => ipcRenderer.invoke('vectrail:undo'),
  redo: () => ipcRenderer.invoke('vectrail:redo'),
  setPlayhead: (t) => ipcRenderer.invoke('vectrail:set-playhead', t),
  setPlaying: (playing) => ipcRenderer.invoke('vectrail:set-playing', playing),
  importFilesDialog: () => ipcRenderer.invoke('vectrail:import-dialog'),
  importFolderDialog: () => ipcRenderer.invoke('vectrail:import-folder-dialog'),
  importPaths: (paths) => ipcRenderer.invoke('vectrail:import-paths', paths),
  showInExplorer: (filePath) => ipcRenderer.invoke('vectrail:show-in-explorer', filePath),
  reloadAsset: (assetID) => ipcRenderer.invoke('vectrail:reload-asset', assetID),
  deleteAsset: (assetID) => ipcRenderer.invoke('vectrail:delete-asset', assetID),
  openProjectDialog: () => ipcRenderer.invoke('vectrail:open-dialog'),
  openProjectPath: (filePath) => ipcRenderer.invoke('vectrail:open-path', filePath),
  getRecentProjects: () => ipcRenderer.invoke('vectrail:get-recents'),
  clearRecentProjects: () => ipcRenderer.invoke('vectrail:clear-recents'),
  saveProjectDialog: (saveAs = false) => ipcRenderer.invoke('vectrail:save-dialog', saveAs),
  newProject: () => ipcRenderer.invoke('vectrail:new-project'),
  pickCubeFile: () => ipcRenderer.invoke('vectrail:pick-cube'),
  readTextFile: (filePath) => ipcRenderer.invoke('vectrail:read-text', filePath),
  startExport: (settings) => ipcRenderer.invoke('vectrail:start-export', settings),
  cancelExport: (id) => ipcRenderer.invoke('vectrail:cancel-export', id),
  getMcpStatus: () => ipcRenderer.invoke('vectrail:mcp-status'),
  setMcpEnabled: (enabled) => ipcRenderer.invoke('vectrail:mcp-enabled', enabled),
  getAgentStatuses: () => ipcRenderer.invoke('vectrail:agent-statuses'),
  connectAgent: (target) => ipcRenderer.invoke('vectrail:connect-agent', target),
  disconnectAgent: (target) => ipcRenderer.invoke('vectrail:disconnect-agent', target),
  runMagic: (prompt, backend, selectedClipIds, runId, options) =>
    ipcRenderer.invoke('vectrail:run-magic', prompt, backend, selectedClipIds, runId, options),
  cancelMagic: (runId) => ipcRenderer.invoke('vectrail:cancel-magic', runId),
  commitMagic: (nextProject, prompt, tab) => ipcRenderer.invoke('vectrail:commit-magic', nextProject, prompt, tab),
  onMagicProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: MagicProgressEvent) => cb(ev);
    ipcRenderer.on('vectrail:magic-progress', listener);
    return () => ipcRenderer.removeListener('vectrail:magic-progress', listener);
  },
  getMagicAnimated: () => ipcRenderer.invoke('vectrail:get-magic-animated'),
  setMagicAnimated: (enabled) => ipcRenderer.invoke('vectrail:set-magic-animated', enabled),
  autoEdit: () => ipcRenderer.invoke('vectrail:auto-edit'),
  transcribeAsset: (assetID, language) => ipcRenderer.invoke('vectrail:transcribe-asset', assetID, language),
  getWhisperStatus: () => ipcRenderer.invoke('vectrail:whisper-status'),
  downloadWhisperModel: (size) => ipcRenderer.invoke('vectrail:download-whisper', size),
  getShortcuts: () => ipcRenderer.invoke('vectrail:get-shortcuts'),
  saveShortcuts: (map) => ipcRenderer.invoke('vectrail:save-shortcuts', map),
  getCloudAiConfig: () => ipcRenderer.invoke('vectrail:get-cloud-ai'),
  saveCloudAiConfig: (cfg) => ipcRenderer.invoke('vectrail:save-cloud-ai', cfg),
  testCloudAiConnection: (cfg) => ipcRenderer.invoke('vectrail:test-cloud-ai', cfg),
  getAutoSave: () => ipcRenderer.invoke('vectrail:get-auto-save'),
  setAutoSave: (enabled) => ipcRenderer.invoke('vectrail:set-auto-save', enabled),
  checkForUpdates: () => ipcRenderer.invoke('vectrail:check-updates'),
  openExternalUrl: (url) => ipcRenderer.invoke('vectrail:open-external', url),
  minimizeWindow: () => ipcRenderer.send('vectrail:win-minimize'),
  maximizeWindow: () => ipcRenderer.send('vectrail:win-maximize'),
  closeWindow: () => ipcRenderer.send('vectrail:win-close'),
};

contextBridge.exposeInMainWorld('vectrail', api);
