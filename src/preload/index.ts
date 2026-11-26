import { contextBridge, ipcRenderer } from 'electron';
import type { ExportSettings, Project, Transcript } from '../shared/types';
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

export interface EditroomBridgeAPI {
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
  runMagic: (prompt: string, backend: MagicBackend, selectedClipIds: string[]) => Promise<{ ok: boolean; summary: string }>;
  autoEdit: () => Promise<void>;
  transcribeAsset: (assetID: string, language?: string) => Promise<Transcript>;
  getWhisperStatus: () => Promise<WhisperStatus>;
  downloadWhisperModel: (size?: 'tiny' | 'base') => Promise<string>;
  getShortcuts: () => Promise<Record<string, string>>;
  saveShortcuts: (map: Record<string, string>) => Promise<Record<string, string>>;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
}

const api: EditroomBridgeAPI = {
  getSnapshot: () => ipcRenderer.invoke('editroom:get-snapshot'),
  onSnapshot: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, snap: EditorSnapshot) => cb(snap);
    ipcRenderer.on('editroom:snapshot', listener);
    return () => ipcRenderer.removeListener('editroom:snapshot', listener);
  },
  mutateProject: (nextProject, recordHistory = true) =>
    ipcRenderer.invoke('editroom:mutate-project', nextProject, recordHistory),
  undo: () => ipcRenderer.invoke('editroom:undo'),
  redo: () => ipcRenderer.invoke('editroom:redo'),
  setPlayhead: (t) => ipcRenderer.invoke('editroom:set-playhead', t),
  setPlaying: (playing) => ipcRenderer.invoke('editroom:set-playing', playing),
  importFilesDialog: () => ipcRenderer.invoke('editroom:import-dialog'),
  importPaths: (paths) => ipcRenderer.invoke('editroom:import-paths', paths),
  openProjectDialog: () => ipcRenderer.invoke('editroom:open-dialog'),
  saveProjectDialog: (saveAs = false) => ipcRenderer.invoke('editroom:save-dialog', saveAs),
  newProject: () => ipcRenderer.invoke('editroom:new-project'),
  pickCubeFile: () => ipcRenderer.invoke('editroom:pick-cube'),
  readTextFile: (filePath) => ipcRenderer.invoke('editroom:read-text', filePath),
  startExport: (settings) => ipcRenderer.invoke('editroom:start-export', settings),
  cancelExport: (id) => ipcRenderer.invoke('editroom:cancel-export', id),
  getMcpStatus: () => ipcRenderer.invoke('editroom:mcp-status'),
  setMcpEnabled: (enabled) => ipcRenderer.invoke('editroom:mcp-enabled', enabled),
  getAgentStatuses: () => ipcRenderer.invoke('editroom:agent-statuses'),
  connectAgent: (target) => ipcRenderer.invoke('editroom:connect-agent', target),
  disconnectAgent: (target) => ipcRenderer.invoke('editroom:disconnect-agent', target),
  runMagic: (prompt, backend, selectedClipIds) =>
    ipcRenderer.invoke('editroom:run-magic', prompt, backend, selectedClipIds),
  autoEdit: () => ipcRenderer.invoke('editroom:auto-edit'),
  transcribeAsset: (assetID, language) => ipcRenderer.invoke('editroom:transcribe-asset', assetID, language),
  getWhisperStatus: () => ipcRenderer.invoke('editroom:whisper-status'),
  downloadWhisperModel: (size) => ipcRenderer.invoke('editroom:download-whisper', size),
  getShortcuts: () => ipcRenderer.invoke('editroom:get-shortcuts'),
  saveShortcuts: (map) => ipcRenderer.invoke('editroom:save-shortcuts', map),
  minimizeWindow: () => ipcRenderer.send('editroom:win-minimize'),
  maximizeWindow: () => ipcRenderer.send('editroom:win-maximize'),
  closeWindow: () => ipcRenderer.send('editroom:win-close'),
};

contextBridge.exposeInMainWorld('editroom', api);
