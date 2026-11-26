import { contextBridge, ipcRenderer } from 'electron';
import type { AppUpdateInfo, CloudAiConfig, ExportSettings, Project, Transcript } from '../shared/types';
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
  importPaths: (paths: string[]) => Promise<EditorSnapshot>;
  openProjectDialog: () => Promise<EditorSnapshot>;
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
    selectedClipIds: string[]
  ) => Promise<{ ok: boolean; summary: string; steps?: string[] }>;
  autoEdit: () => Promise<void>;
  transcribeAsset: (assetID: string, language?: string) => Promise<Transcript>;
  getWhisperStatus: () => Promise<WhisperStatus>;
  downloadWhisperModel: (size?: 'tiny' | 'base') => Promise<string>;
  getShortcuts: () => Promise<Record<string, string>>;
  saveShortcuts: (map: Record<string, string>) => Promise<Record<string, string>>;
  getCloudAiConfig: () => Promise<CloudAiConfig>;
  saveCloudAiConfig: (cfg: Partial<CloudAiConfig>) => Promise<CloudAiConfig>;
  testCloudAiConnection: (cfg: CloudAiConfig) => Promise<{ ok: boolean; message: string }>;
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
  importPaths: (paths) => ipcRenderer.invoke('vectrail:import-paths', paths),
  openProjectDialog: () => ipcRenderer.invoke('vectrail:open-dialog'),
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
  runMagic: (prompt, backend, selectedClipIds) =>
    ipcRenderer.invoke('vectrail:run-magic', prompt, backend, selectedClipIds),
  autoEdit: () => ipcRenderer.invoke('vectrail:auto-edit'),
  transcribeAsset: (assetID, language) => ipcRenderer.invoke('vectrail:transcribe-asset', assetID, language),
  getWhisperStatus: () => ipcRenderer.invoke('vectrail:whisper-status'),
  downloadWhisperModel: (size) => ipcRenderer.invoke('vectrail:download-whisper', size),
  getShortcuts: () => ipcRenderer.invoke('vectrail:get-shortcuts'),
  saveShortcuts: (map) => ipcRenderer.invoke('vectrail:save-shortcuts', map),
  getCloudAiConfig: () => ipcRenderer.invoke('vectrail:get-cloud-ai'),
  saveCloudAiConfig: (cfg) => ipcRenderer.invoke('vectrail:save-cloud-ai', cfg),
  testCloudAiConnection: (cfg) => ipcRenderer.invoke('vectrail:test-cloud-ai', cfg),
  checkForUpdates: () => ipcRenderer.invoke('vectrail:check-updates'),
  openExternalUrl: (url) => ipcRenderer.invoke('vectrail:open-external', url),
  minimizeWindow: () => ipcRenderer.send('vectrail:win-minimize'),
  maximizeWindow: () => ipcRenderer.send('vectrail:win-maximize'),
  closeWindow: () => ipcRenderer.send('vectrail:win-close'),
};

contextBridge.exposeInMainWorld('vectrail', api);
