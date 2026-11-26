import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExportSettings, Project } from '../shared/types';
import { computeExportRenderSize } from '../shared/project';
import { loadSavedShortcuts, ProjectStore, saveShortcutsConfig } from './state';
import { downloadWhisperModel, getWhisperStatus, WhisperStatus } from './engine/analyzer';
import { MCP_DEFAULT_PORT, MCPServer } from './mcp/server';
import { runStdioMcpBridge } from './mcp/bridge';
import { callMCPTool } from './mcp/tools';
import { connectAgent, disconnectAgent, getAgentStatuses, MagicBackend, runMagicPrompt } from './magic/agentConnect';

if (process.argv.includes('--mcp')) {
  const port = Number.parseInt(process.env.EDITROOM_MCP_PORT || '', 10) || MCP_DEFAULT_PORT;
  runStdioMcpBridge(port);
} else {
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity');
  }
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'editroom-media',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ]);

  const store = new ProjectStore();
  const mcpServer = new MCPServer(store);
  let mainWindow: BrowserWindow | null = null;

  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', (_e, argv) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
      const openArg = argv.find((a) => a.toLowerCase().endsWith('.editroom') && fs.existsSync(a));
      if (openArg) {
        try {
          store.openFromFile(openArg);
        } catch {
          // ignore invalid project arg
        }
      }
    });
  }

  const broadcastSnapshot = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('editroom:snapshot', store.snapshot());
    }
  };

  store.onChange(broadcastSnapshot);

  const getMcpStatus = () => ({
    running: mcpServer.running,
    enabled: mcpServer.enabled,
    endpoint: mcpServer.endpoint,
    problem: mcpServer.problem,
    clients: [...mcpServer.clients.values()],
  });

  const createWindow = () => {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.resolve(__dirname, '../../build/icon.png');
    mainWindow = new BrowserWindow({
      width: 1460,
      height: 920,
      minWidth: 1080,
      minHeight: 680,
      backgroundColor: '#0A0A0A',
      titleBarStyle: 'hidden',
      frame: false,
      show: false,
      icon: iconPath,
      webPreferences: {
        preload: path.resolve(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const showTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    }, 2500);
    mainWindow.once('ready-to-show', () => {
      clearTimeout(showTimer);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    });

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      void mainWindow.loadURL(devUrl);
    } else {
      void mainWindow.loadFile(path.resolve(__dirname, '../../dist/index.html'));
    }
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.error('[Renderer]', message);
    });
  };

  app.whenReady().then(() => {
    protocol.handle('editroom-media', async (req) => {
      const u = new URL(req.url);
      const filePath = u.searchParams.get('path') ?? '';
      if (!filePath || !fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 });
      }
      const resp = await net.fetch(pathToFileURL(filePath).toString(), { headers: req.headers });
      const headers = new Headers(resp.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Accept-Ranges', 'bytes');
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    });

    mcpServer.start(MCP_DEFAULT_PORT);
    createWindow();

    const openArg = process.argv.find((a) => a.toLowerCase().endsWith('.editroom') && fs.existsSync(a));
    if (openArg) {
      try {
        store.openFromFile(openArg);
      } catch {
        // ignore invalid project arg
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    mcpServer.stop();
    if (process.platform !== 'darwin') app.quit();
  });

  ipcMain.handle('editroom:get-snapshot', () => store.snapshot());
  ipcMain.handle('editroom:mutate-project', (_e, nextProject: Project, recordHistory = true) => {
    store.replaceProject(nextProject, recordHistory);
    return store.snapshot();
  });
  ipcMain.handle('editroom:undo', () => {
    store.undo();
    return store.snapshot();
  });
  ipcMain.handle('editroom:redo', () => {
    store.redo();
    return store.snapshot();
  });
  ipcMain.handle('editroom:set-playhead', (_e, t: number) => {
    store.setPlayhead(t);
  });
  ipcMain.handle('editroom:set-playing', (_e, playing: boolean) => {
    store.setPlaying(playing);
  });
  ipcMain.handle('editroom:import-dialog', async () => {
    if (!mainWindow) return store.snapshot();
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Media Files',
          extensions: ['mp4', 'mov', 'mkv', 'webm', 'mxf', 'avi', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'png', 'jpg', 'jpeg', 'webp'],
        },
      ],
    });
    if (!res.canceled && res.filePaths.length) {
      await store.importFiles(res.filePaths);
    }
    return store.snapshot();
  });
  ipcMain.handle('editroom:import-paths', async (_e, paths: string[]) => {
    await store.importFiles(paths);
    return store.snapshot();
  });
  ipcMain.handle('editroom:open-dialog', async () => {
    if (!mainWindow) return store.snapshot();
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Editroom Project',
      filters: [{ name: 'Editroom Project', extensions: ['editroom', 'json'] }],
      properties: ['openFile'],
    });
    if (!res.canceled && res.filePaths[0]) {
      store.openFromFile(res.filePaths[0]);
    }
    return store.snapshot();
  });
  ipcMain.handle('editroom:save-dialog', async (_e, saveAs = false) => {
    if (!mainWindow) return store.snapshot();
    if (!saveAs && store.filePath) {
      store.saveToFile();
      return store.snapshot();
    }
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Editroom Project',
      defaultPath: `${store.title}.editroom`,
      filters: [{ name: 'Editroom Project', extensions: ['editroom'] }],
    });
    if (!res.canceled && res.filePath) {
      store.saveToFile(res.filePath);
    }
    return store.snapshot();
  });
  ipcMain.handle('editroom:new-project', () => {
    store.newProject();
    return store.snapshot();
  });
  ipcMain.handle('editroom:pick-cube', async () => {
    if (!mainWindow) return undefined;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose 3D LUT (.cube)',
      filters: [{ name: '3D LUT', extensions: ['cube'] }],
      properties: ['openFile'],
    });
    return res.canceled ? undefined : res.filePaths[0];
  });
  ipcMain.handle('editroom:read-text', (_e, filePath: string) => {
    try {
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  });
  ipcMain.handle('editroom:start-export', async (_e, settings: ExportSettings) => {
    if (!mainWindow) return;
    const ext = settings.format === 'audio' ? 'wav' : 'mp4';
    const size = computeExportRenderSize(store.project, settings.shape, settings.height);
    void size;
    const defaultDir = settings.outputDir ?? (store.filePath ? path.dirname(store.filePath) : path.join(os.homedir(), 'Videos'));
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Video',
      defaultPath: path.join(defaultDir, `${settings.name || store.title}.${ext}`),
      filters: [{ name: settings.format === 'audio' ? 'WAV Audio' : 'MP4 Video', extensions: [ext] }],
    });
    if (res.canceled || !res.filePath) return;
    void store.exports.startExport(store.project, settings, res.filePath, store.transcripts);
  });
  ipcMain.handle('editroom:cancel-export', (_e, id: string) => {
    store.exports.cancel(id);
  });
  ipcMain.handle('editroom:mcp-status', () => getMcpStatus());
  ipcMain.handle('editroom:mcp-enabled', (_e, enabled: boolean) => {
    mcpServer.setEnabled(enabled);
    return getMcpStatus();
  });
  ipcMain.handle('editroom:agent-statuses', () => getAgentStatuses());
  ipcMain.handle('editroom:connect-agent', (_e, target) => connectAgent(target));
  ipcMain.handle('editroom:disconnect-agent', (_e, target) => disconnectAgent(target));
  ipcMain.handle('editroom:run-magic', (_e, prompt: string, backend: MagicBackend, selectedClipIds: string[]) =>
    runMagicPrompt(prompt, backend, store, selectedClipIds)
  );
  ipcMain.handle('editroom:auto-edit', async () => {
    await callMCPTool('auto_edit', {}, store, 'Editroom');
  });
  ipcMain.handle('editroom:transcribe-asset', async (_e, assetID: string, language?: string) => {
    return store.transcribeAsset(assetID, language);
  });
  ipcMain.handle('editroom:whisper-status', async (): Promise<WhisperStatus> => {
    return getWhisperStatus();
  });
  ipcMain.handle('editroom:download-whisper', async (_e, size: 'tiny' | 'base' = 'tiny') => {
    return downloadWhisperModel(size);
  });
  ipcMain.handle('editroom:get-shortcuts', () => loadSavedShortcuts());
  ipcMain.handle('editroom:save-shortcuts', (_e, map: Record<string, string>) => {
    saveShortcutsConfig(map);
    return loadSavedShortcuts();
  });
  ipcMain.on('editroom:win-minimize', () => mainWindow?.minimize());
  ipcMain.on('editroom:win-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('editroom:win-close', () => mainWindow?.close());
}
