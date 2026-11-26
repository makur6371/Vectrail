import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudAiConfig, ExportSettings, Project } from '../shared/types';
import { computeExportRenderSize } from '../shared/project';
import { loadSavedShortcuts, ProjectStore, saveShortcutsConfig } from './state';
import { checkForAppUpdates, getAutoSaveEnabled, getCloudAiConfig, saveCloudAiConfig, setAutoSaveEnabled } from './settings';
import { downloadWhisperModel, getWhisperStatus, WhisperStatus } from './engine/analyzer';
import { MCP_DEFAULT_PORT, MCPServer } from './mcp/server';
import { runStdioMcpBridge } from './mcp/bridge';
import { callMCPTool } from './mcp/tools';
import {
  connectAgent,
  disconnectAgent,
  getAgentStatuses,
  MagicBackend,
  runMagicPrompt,
  testCloudAiConnection,
} from './magic/agentConnect';

if (process.argv.includes('--mcp')) {
  const port = Number.parseInt(process.env.VECTRAIL_MCP_PORT || process.env.EDITROOM_MCP_PORT || '', 10) || MCP_DEFAULT_PORT;
  runStdioMcpBridge(port);
} else {
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity');
  }
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'vectrail-media',
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
      const openArg = argv.find(
        (a) => (a.toLowerCase().endsWith('.vectrail') || a.toLowerCase().endsWith('.editroom')) && fs.existsSync(a)
      );
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
      mainWindow.webContents.send('vectrail:snapshot', store.snapshot());
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

const MEDIA_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function openMediaRangeStream(filePath: string, start: number, end: number): ReadableStream<Uint8Array> {
  let handle: fs.promises.FileHandle | null = null;
  let offset = start;
  const chunkSize = 256 * 1024;
  const closeHandle = async () => {
    const current = handle;
    handle = null;
    if (current) await current.close().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async start() {
      handle = await fs.promises.open(filePath, 'r');
    },
    async pull(controller) {
      if (!handle || offset > end) {
        await closeHandle();
        controller.close();
        return;
      }
      const remaining = end - offset + 1;
      const toRead = Math.min(chunkSize, remaining);
      const buffer = Buffer.allocUnsafe(toRead);
      try {
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        if (bytesRead <= 0) {
          await closeHandle();
          controller.close();
          return;
        }
        offset += bytesRead;
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
        if (offset > end) {
          await closeHandle();
          controller.close();
        }
      } catch (err) {
        await closeHandle();
        controller.error(err);
      }
    },
    async cancel() {
      await closeHandle();
    },
  });
}

async function serveMediaRequest(req: Request, filePath: string): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
      },
    });
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  if (!stat.isFile()) return new Response('Not Found', { status: 404 });

  const size = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const mime = MEDIA_MIME_TYPES[ext] ?? 'application/octet-stream';
  const baseHeaders: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  };

  const rangeHeader = req.headers.get('range');
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (!match || (!match[1] && !match[2]) || size === 0) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
      });
    }
    let start: number;
    let end: number;
    if (!match[1]) {
      const suffix = Number.parseInt(match[2], 10);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
        });
      }
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number.parseInt(match[1], 10);
      end = match[2] ? Math.min(size - 1, Number.parseInt(match[2], 10)) : size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
      });
    }
    const headers = {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    };
    if (req.method === 'HEAD') return new Response(null, { status: 206, headers });
    return new Response(openMediaRangeStream(filePath, start, end), { status: 206, headers });
  }

  const headers = { ...baseHeaders, 'Content-Length': String(size) };
  if (req.method === 'HEAD' || size === 0) return new Response(null, { status: 200, headers });
  return new Response(openMediaRangeStream(filePath, 0, size - 1), { status: 200, headers });
}

  app.whenReady().then(() => {
    protocol.handle('vectrail-media', async (req) => {
      const u = new URL(req.url);
      const filePath = u.searchParams.get('path') ?? '';
      if (!filePath || !fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 });
      }
      return serveMediaRequest(req, filePath);
    });

    mcpServer.start(MCP_DEFAULT_PORT);
    createWindow();

    const openArg = process.argv.find(
      (a) => (a.toLowerCase().endsWith('.vectrail') || a.toLowerCase().endsWith('.editroom')) && fs.existsSync(a)
    );
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

  ipcMain.handle('vectrail:get-snapshot', () => store.snapshot());
  ipcMain.handle('vectrail:mutate-project', (_e, nextProject: Project, recordHistory = true) => {
    store.replaceProject(nextProject, recordHistory);
    return store.snapshot();
  });
  ipcMain.handle('vectrail:undo', () => {
    store.undo();
    return store.snapshot();
  });
  ipcMain.handle('vectrail:redo', () => {
    store.redo();
    return store.snapshot();
  });
  ipcMain.handle('vectrail:set-playhead', (_e, t: number) => {
    store.setPlayhead(t);
  });
  ipcMain.handle('vectrail:set-playing', (_e, playing: boolean) => {
    store.setPlaying(playing);
  });
  ipcMain.handle('vectrail:import-dialog', async () => {
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
  ipcMain.handle('vectrail:import-paths', async (_e, paths: string[]) => {
    await store.importFiles(paths);
    return store.snapshot();
  });
  ipcMain.handle('vectrail:import-folder-dialog', async () => {
    if (!mainWindow) return store.snapshot();
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Folder',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (!res.canceled && res.filePaths.length) {
      await store.importFiles(res.filePaths);
    }
    return store.snapshot();
  });
  ipcMain.handle('vectrail:show-in-explorer', (_e, filePath: string) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  });
  ipcMain.handle('vectrail:reload-asset', async (_e, assetID: string) => {
    await store.reloadAsset(assetID);
    return store.snapshot();
  });
  ipcMain.handle('vectrail:delete-asset', (_e, assetID: string) => {
    store.deleteAsset(assetID);
    return store.snapshot();
  });
  ipcMain.handle('vectrail:open-dialog', async () => {
    if (!mainWindow) return store.snapshot();
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Vectrail Project',
      filters: [{ name: 'Vectrail Project', extensions: ['vectrail', 'editroom', 'json'] }],
      properties: ['openFile'],
    });
    if (!res.canceled && res.filePaths[0]) {
      store.openFromFile(res.filePaths[0]);
    }
    return store.snapshot();
  });
  ipcMain.handle('vectrail:save-dialog', async (_e, saveAs = false) => {
    if (!mainWindow) return store.snapshot();
    if (!saveAs && store.filePath) {
      store.saveToFile();
      return store.snapshot();
    }
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Vectrail Project',
      defaultPath: `${store.title}.vectrail`,
      filters: [{ name: 'Vectrail Project', extensions: ['vectrail'] }],
    });
    if (!res.canceled && res.filePath) {
      store.saveToFile(res.filePath);
    }
    return store.snapshot();
  });
  ipcMain.handle('vectrail:new-project', () => {
    store.newProject();
    return store.snapshot();
  });
  ipcMain.handle('vectrail:pick-cube', async () => {
    if (!mainWindow) return undefined;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose 3D LUT (.cube)',
      filters: [{ name: '3D LUT', extensions: ['cube'] }],
      properties: ['openFile'],
    });
    return res.canceled ? undefined : res.filePaths[0];
  });
  ipcMain.handle('vectrail:read-text', (_e, filePath: string) => {
    try {
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  });
  ipcMain.handle('vectrail:start-export', async (_e, settings: ExportSettings) => {
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
  ipcMain.handle('vectrail:cancel-export', (_e, id: string) => {
    store.exports.cancel(id);
  });
  ipcMain.handle('vectrail:mcp-status', () => getMcpStatus());
  ipcMain.handle('vectrail:mcp-enabled', (_e, enabled: boolean) => {
    mcpServer.setEnabled(enabled);
    return getMcpStatus();
  });
  ipcMain.handle('vectrail:agent-statuses', () => getAgentStatuses());
  ipcMain.handle('vectrail:connect-agent', (_e, target) => connectAgent(target));
  ipcMain.handle('vectrail:disconnect-agent', (_e, target) => disconnectAgent(target));
  ipcMain.handle('vectrail:run-magic', (_e, prompt: string, backend: MagicBackend, selectedClipIds: string[]) =>
    runMagicPrompt(prompt, backend, store, selectedClipIds)
  );
  ipcMain.handle('vectrail:auto-edit', async () => {
    await callMCPTool('auto_edit', {}, store, 'Vectrail');
  });
  ipcMain.handle('vectrail:transcribe-asset', async (_e, assetID: string, language?: string) => {
    return store.transcribeAsset(assetID, language);
  });
  ipcMain.handle('vectrail:whisper-status', async (): Promise<WhisperStatus> => {
    return getWhisperStatus();
  });
  ipcMain.handle('vectrail:download-whisper', async (_e, size: 'tiny' | 'base' = 'tiny') => {
    return downloadWhisperModel(size);
  });
  ipcMain.handle('vectrail:get-shortcuts', () => loadSavedShortcuts());
  ipcMain.handle('vectrail:save-shortcuts', (_e, map: Record<string, string>) => {
    saveShortcutsConfig(map);
    return loadSavedShortcuts();
  });
  ipcMain.handle('vectrail:get-cloud-ai', () => getCloudAiConfig());
  ipcMain.handle('vectrail:save-cloud-ai', (_e, cfg: Partial<CloudAiConfig>) => saveCloudAiConfig(cfg));
  ipcMain.handle('vectrail:test-cloud-ai', (_e, cfg: CloudAiConfig) => testCloudAiConnection(cfg));
  ipcMain.handle('vectrail:get-auto-save', () => getAutoSaveEnabled());
  ipcMain.handle('vectrail:set-auto-save', (_e, enabled: boolean) => setAutoSaveEnabled(enabled));
  ipcMain.handle('vectrail:check-updates', () => checkForAppUpdates(app.getVersion()));
  ipcMain.handle('vectrail:open-external', (_e, url: string) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
  });
  ipcMain.on('vectrail:win-minimize', () => mainWindow?.minimize());
  ipcMain.on('vectrail:win-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('vectrail:win-close', () => mainWindow?.close());
}
