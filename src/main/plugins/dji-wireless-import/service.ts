import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type {
  DjiCameraDevice,
  DjiCameraStatus,
  DjiEnvironmentStatus,
  DjiLiveConnectionStatus,
  DjiPluginSettings,
  DjiPluginStateSnapshot,
  DjiRemoteMediaItem,
} from '../../../shared/djiTypes';
import { DjiDownloadQueue } from './downloadQueue';
import { getDjiPluginSettings, getPluginEnabledState, saveDjiPluginSettings } from '../../settings';
import type { ProjectStore } from '../../state';
import type { VectrailPlugin } from '../types';
import { isCameraHttpReachable, queryCameraMediaOverWifi } from './datalinkWifi';
import { findAlreadyImportedPath } from './integrity';
import { DjiLibraryImporter } from './libraryImporter';
import { MockDjiCameraServer } from './mockCamera';
import { resolveDjiModel } from './models';
import { probeWindowsNetworkAndRadios } from './wifiManager';
import { DjiUsbImporter } from './usbImport';
import { getWindowsWifiProfile } from './wifiManager';

function resolveSidecarScript(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'plugins', 'dji-wireless-import', 'dji_sidecar.py'),
    path.resolve(__dirname, '../../../../plugins/dji-wireless-import/dji_sidecar.py'),
    path.resolve(process.resourcesPath ?? '', 'plugins', 'dji-wireless-import', 'dji_sidecar.py'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

function buildRemoteCandidatePaths(mediaPath: string): string[] {
  const raw = mediaPath.replace(/\\/g, '/');
  const candidates = new Set<string>([
    raw,
    raw.replace(/^\/+/, ''),
    `${raw}.JPG`,
    `${raw}.jpg`,
    `${raw}.THM`,
    `${raw}.thm`,
    `${raw}.MP4`,
    `${raw}.mp4`,
  ]);
  const slashIdx = raw.lastIndexOf('/');
  if (slashIdx >= 0) {
    const base = raw.slice(slashIdx + 1);
    const folder = raw.slice(0, slashIdx);
    candidates.add(`${folder}/thumbnails/${base}.JPG`);
    candidates.add(`${folder}/thumbnails/${base}.JPG`);
    candidates.add(`${folder}/thumbnails/${base}.JPG`);
  }
  return [...candidates];
}

export class DjiWirelessImportService implements VectrailPlugin {
  readonly id = 'dji-wireless-import';
  readonly name = 'DJI Wireless Import';
  readonly nameZh = 'DJI 无线素材导入';
  readonly version = '1.1.0';
  readonly description = 'Discover DJI Osmo cameras over BLE, join camera Wi-Fi, and offload original footage directly into Vectrail.';
  readonly descriptionZh = '通过蓝牙发现并唤醒大疆 Osmo 相机，直连相机高速 Wi-Fi 批量下载原片并自动导入媒体库。';
  readonly defaultEnabled = true;

  private enabled = true;
  private healthy = true;
  private healthError?: string;
  private env: DjiEnvironmentStatus | null = null;
  private discovered: DjiCameraDevice[] = [];
  private rawMedia: Array<Omit<DjiRemoteMediaItem, 'alreadyImported' | 'localPath'>> = [];
  private cameraBaseUrl = 'http://192.168.2.1';
  private activeDirectWifi: { ip: string; port: 9004 | 10004 } | null = null;
  private liveMonitorTimer: NodeJS.Timeout | null = null;
  private liveChecking = false;
  private status: DjiCameraStatus = {
    connected: false,
    phase: 'idle',
    phaseMessage: 'Ready to scan for nearby DJI Osmo cameras.',
  };
  private mockServer: MockDjiCameraServer | null = null;
  private readonly listeners = new Set<(snap: DjiPluginStateSnapshot) => void>();
  private readonly queue: DjiDownloadQueue;
  private readonly usb = new DjiUsbImporter();

  constructor(private readonly store: ProjectStore) {
    this.enabled = getPluginEnabledState(this.id, this.defaultEnabled);
    const importer = new DjiLibraryImporter(store);
    this.queue = new DjiDownloadQueue({
      getBaseUrl: () => this.cameraBaseUrl,
      getDownloadDir: () => getDjiPluginSettings().downloadDir,
      getConcurrency: () => getDjiPluginSettings().concurrency,
      getAutoImport: () => getDjiPluginSettings().autoImportToProject,
      importer,
      onUpdate: () => this.emit(),
    });
  }

  onStateChange(fn: (snap: DjiPluginStateSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  getHealth(): { healthy: boolean; error?: string } {
    return { healthy: this.healthy, error: this.healthError };
  }

  async init(): Promise<void> {
    this.enabled = true;
    this.healthy = true;
    this.healthError = undefined;
    this.env = await probeWindowsNetworkAndRadios().catch((err) => {
      this.healthy = false;
      this.healthError = err instanceof Error ? err.message : String(err);
      return null;
    });
    this.emit();
    this.startLiveMonitor();
  }

  async dispose(): Promise<void> {
    this.enabled = false;
    this.stopLiveMonitor();
    this.queue.cancelAll();
    await this.disconnectCamera();
    this.emit();
  }

  snapshot(): DjiPluginStateSnapshot {
    const settings = getDjiPluginSettings();
    const media: DjiRemoteMediaItem[] = this.rawMedia.map((m) => {
      const existingPath = findAlreadyImportedPath(m.mediaPath, m.storage, m.size, settings.downloadDir, m.name);
      const inProject = existingPath
        ? this.store.project.assets.some((a) => path.resolve(a.path) === path.resolve(existingPath))
        : false;
      return {
        ...m,
        alreadyImported: Boolean(existingPath) || inProject,
        localPath: existingPath,
      };
    });
    return {
      enabled: this.enabled,
      env: this.env,
      status: { ...this.status },
      discovered: [...this.discovered],
      media,
      tasks: this.queue.list(),
      settings,
      usbVolumes: this.usb.listVolumesSync(),
      usbTasks: this.usb.listTasks(),
    };
  }

  private startLiveMonitor(): void {
    this.stopLiveMonitor();
    this.liveMonitorTimer = setInterval(() => {
      void this.refreshLiveConnection();
    }, 5000);
  }

  private stopLiveMonitor(): void {
    if (this.liveMonitorTimer) {
      clearInterval(this.liveMonitorTimer);
      this.liveMonitorTimer = null;
    }
  }

  private async refreshLiveConnection(): Promise<void> {
    if (!this.enabled || this.liveChecking) return;
    this.liveChecking = true;
    try {
      const activeTasks = this.queue.list().filter((task) => task.status === 'downloading');
      const expectedIp = this.cameraBaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const expectedHost = expectedIp.split(':')[0] ?? '192.168.2.1';
      const connectedSsid = await getWindowsWifiProfile();
      this.env = { ...(this.env ?? await probeWindowsNetworkAndRadios()), wifiConnectedProfile: connectedSsid };
      const isSimulated = Boolean(this.status.camera?.isSimulated || this.mockServer);
      const wifiMatchesCamera = isSimulated || Boolean(connectedSsid && connectedSsid.includes('Osmo'));
      const startedAt = Date.now();
      const cameraIpReachable = activeTasks.length > 0 || !isSimulated ? await isCameraHttpReachable(expectedHost) : true;
      const latencyMs = cameraIpReachable ? Date.now() - startedAt : null;
      const previous = this.status.live;
      const state: DjiLiveConnectionStatus['state'] = !this.status.connected
        ? 'disconnected'
        : activeTasks.length > 0
        ? 'transferring'
        : !wifiMatchesCamera
        ? 'wifi_mismatch'
        : !cameraIpReachable
        ? 'unreachable'
        : this.rawMedia.length === 0
        ? 'stale'
        : 'connected';
      const message = state === 'connected'
        ? `Live: camera reachable${latencyMs !== null ? ` (${latencyMs} ms)` : ''}, ${this.rawMedia.length} files cached.`
        : state === 'transferring'
        ? `Live: transferring ${activeTasks.length} file(s); link is active. ${activeTasks[0]?.downloadedBytes ?? 0} / ${activeTasks[0]?.size ?? 0} bytes.`
        : state === 'stale'
        ? 'Live: Wi-Fi is connected, but media list is empty. Refresh the list.'
        : state === 'wifi_mismatch'
        ? `Live: Windows is on "${connectedSsid ?? 'unknown network'}", not the camera Wi-Fi.`
        : state === 'unreachable'
        ? `Live: camera ${expectedHost} is unreachable. Check Wi-Fi or disable VPN/TUN.`
        : 'Live: disconnected.';
      this.status.live = {
        checkedAt: Date.now(),
        wifiMatchesCamera,
        connectedSsid,
        cameraIpReachable,
        latencyMs,
        cameraSessionValid: state === 'connected',
        state,
        message,
      };
      if (state === 'unreachable' && this.status.connected && previous?.state === 'connected') {
        this.status.phaseMessage = message;
        this.status.error = message;
      }
      this.emit();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.status.connected) {
        this.status.live = {
          checkedAt: Date.now(),
          wifiMatchesCamera: false,
          connectedSsid: null,
          cameraIpReachable: false,
          latencyMs: null,
          cameraSessionValid: false,
          state: 'unreachable',
          message: `Live check failed: ${message}`,
        };
        this.emit();
      }
    } finally {
      this.liveChecking = false;
    }
  }

  async refreshEnvironment(): Promise<DjiPluginStateSnapshot> {
    this.env = await probeWindowsNetworkAndRadios();
    this.emit();
    return this.snapshot();
  }

  updateSettings(patch: Partial<DjiPluginSettings>): DjiPluginStateSnapshot {
    saveDjiPluginSettings(patch);
    this.emit();
    return this.snapshot();
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error('DJI Wireless Import plugin is disabled.');
  }

  private async runSidecarCommand(args: string[], timeoutMs = 20000): Promise<Record<string, unknown>> {
    const script = resolveSidecarScript();
    if (!script) throw new Error('DJI sidecar script was not found.');
    const env = this.env ?? (await probeWindowsNetworkAndRadios());
    this.env = env;
    if (!env.pythonPath || !env.pythonAvailable) {
      throw new Error('Python 3.10+ is required for live DJI BLE discovery.');
    }
    if (!env.bleakAvailable) {
      throw new Error('Python package "bleak" is not installed (run: pip install bleak).');
    }
    return new Promise((resolve, reject) => {
      const child = spawn(env.pythonPath!, [script, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('DJI sidecar command timed out.'));
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1];
        if (last) {
          try {
            const parsed = JSON.parse(last) as Record<string, unknown>;
            if (parsed.ok === false) {
              reject(new Error(String(parsed.error || stderr || `Sidecar exited with ${code}`)));
              return;
            }
            resolve(parsed);
            return;
          } catch {
            // fall through
          }
        }
        reject(new Error(stderr.trim() || `Sidecar exited with code ${code}`));
      });
    });
  }

  async scanCameras(includeSimulated = false): Promise<DjiPluginStateSnapshot> {
    this.assertEnabled();
    this.status = {
      connected: false,
      phase: 'scanning',
      phaseMessage: 'Scanning Bluetooth LE for nearby DJI Osmo cameras...',
    };
    this.emit();

    const found: DjiCameraDevice[] = [];
    if (includeSimulated) {
      if (!this.mockServer) this.mockServer = new MockDjiCameraServer();
      found.push({ ...this.mockServer.device, lastSeenAt: Date.now() });
    }

    try {
      const env = includeSimulated && this.env ? this.env : await probeWindowsNetworkAndRadios();
      this.env = env;
      if (!includeSimulated) {
        if (!env.pythonAvailable) {
          throw new Error('Python 3.10+ not found. Use Direct Wi-Fi (192.168.2.1) or install Python 3.10+ with bleak.');
        }
        if (!env.bleakAvailable) {
          throw new Error('Python BLE package "bleak" is not installed yet. Click "Install bleak" or use Direct Wi-Fi.');
        }
        if (!env.bluetoothReady) {
          throw new Error('Windows Bluetooth adapter is disabled or unavailable. Enable Bluetooth or use Direct Wi-Fi.');
        }
      }
      if (!includeSimulated && env.pythonAvailable && env.bleakAvailable && env.bluetoothReady) {
        const res = await this.runSidecarCommand(['scan', '--timeout', '6'], 15000);
        const cams = Array.isArray(res.cameras) ? (res.cameras as Array<Record<string, unknown>>) : [];
        for (const c of cams) {
          const name = String(c.name ?? '');
          const resolved = resolveDjiModel({}, name);
          found.push({
            id: String(c.address),
            address: String(c.address),
            name,
            modelId: typeof c.model_id === 'number' ? c.model_id : resolved.modelId,
            modelName: String(c.model_name || resolved.modelName),
            rssi: typeof c.rssi === 'number' ? c.rssi : -70,
            datalinkPort: resolved.spec?.datalinkPort ?? 9004,
            tcpPoke: resolved.spec?.tcpPoke ?? true,
            wifiSecurity: resolved.spec?.wifiSecurity ?? 'WPA2',
            lastSeenAt: Date.now(),
          });
        }
      }
      this.discovered = found;
      this.status = {
        connected: false,
        phase: 'idle',
        phaseMessage: found.length
          ? `Found ${found.length} DJI camera(s). Select one to connect.`
          : 'No DJI camera found. Power on the camera with Bluetooth enabled.',
      };
    } catch (err) {
      this.discovered = found;
      this.status = {
        connected: false,
        phase: found.length ? 'idle' : 'error',
        phaseMessage: err instanceof Error ? err.message : String(err),
        error: found.length ? undefined : err instanceof Error ? err.message : String(err),
      };
    }
    this.emit();
    return this.snapshot();
  }

  async installBleakDependency(): Promise<DjiPluginStateSnapshot> {
    this.assertEnabled();
    const env = this.env ?? (await probeWindowsNetworkAndRadios());
    this.env = env;
    if (!env.pythonPath || !env.pythonAvailable) {
      this.status = {
        connected: false,
        phase: 'error',
        phaseMessage: 'Python 3.10+ was not found on PATH. Install Python first or use Direct Wi-Fi.',
        error: 'Python not found',
      };
      this.emit();
      return this.snapshot();
    }

    this.status = {
      connected: false,
      phase: 'scanning',
      phaseMessage: 'Installing Python "bleak" BLE package via pip...',
    };
    this.emit();

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(env.pythonPath!, ['-m', 'pip', 'install', '--upgrade', 'bleak'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        let stdout = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('pip install bleak timed out after 90s.'));
        }, 90000);
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error((stderr || stdout || `pip exited with code ${code}`).trim().slice(-400)));
        });
      });
      this.env = await probeWindowsNetworkAndRadios();
      this.status = {
        connected: false,
        phase: this.env.bleakAvailable ? 'idle' : 'error',
        phaseMessage: this.env.bleakAvailable
          ? 'bleak installed successfully. Ready to scan nearby DJI cameras.'
          : 'pip finished, but bleak was still not detected.',
        error: this.env.bleakAvailable ? undefined : 'bleak not detected after pip install',
      };
    } catch (err) {
      this.env = await probeWindowsNetworkAndRadios();
      const msg = err instanceof Error ? err.message : String(err);
      this.status = {
        connected: false,
        phase: 'error',
        phaseMessage: `Failed to install bleak: ${msg}`,
        error: msg,
      };
    }
    this.emit();
    return this.snapshot();
  }

  async connectDirectWifi(port = 9004, cameraIp = '192.168.2.1'): Promise<DjiPluginStateSnapshot> {
    this.assertEnabled();
    const cleanIp = cameraIp.trim() || '192.168.2.1';
    const datalinkPort = port === 10004 ? 10004 : 9004;
    const poke = datalinkPort === 9004;
    this.status = {
      connected: false,
      phase: 'datalink_connecting',
      phaseMessage: `Querying DJI camera over Wi-Fi at ${cleanIp}:${datalinkPort}...`,
    };
    this.emit();

    try {
      const media = await queryCameraMediaOverWifi(cleanIp, datalinkPort, poke);
      this.activeDirectWifi = { ip: cleanIp, port: datalinkPort };
      const device: DjiCameraDevice = {
        id: `wifi:${cleanIp}:${datalinkPort}`,
        address: cleanIp,
        name: `DJI Wi-Fi (${cleanIp})`,
        modelId: null,
        modelName: datalinkPort === 10004 ? 'Xtra / Direct Wi-Fi Camera' : 'DJI Osmo (Direct Wi-Fi)',
        rssi: -40,
        datalinkPort,
        tcpPoke: poke,
        wifiSecurity: 'WPA2',
        lastSeenAt: Date.now(),
      };
      this.cameraBaseUrl = `http://${cleanIp}`;
      this.rawMedia = media;
      this.status = {
        connected: true,
        phase: 'ready',
        phaseMessage: `Connected directly to ${cleanIp} over Wi-Fi (${media.length} files).`,
        camera: device,
        wifiSsid: this.env?.wifiConnectedProfile ?? undefined,
        cameraIp: this.cameraBaseUrl,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.status = {
        connected: false,
        phase: 'error',
        phaseMessage: msg,
        error: msg,
      };
    }
    this.emit();
    return this.snapshot();
  }

  async connectCamera(cameraId: string): Promise<DjiPluginStateSnapshot> {
    this.assertEnabled();
    const device = this.discovered.find((d) => d.id === cameraId);
    if (!device) throw new Error('Selected DJI camera is no longer in discovery list.');

    if (device.isSimulated) {
      this.activeDirectWifi = null;
      if (!this.mockServer) this.mockServer = new MockDjiCameraServer();
      this.cameraBaseUrl = await this.mockServer.start();
      this.rawMedia = this.mockServer.listMedia();
      this.status = {
        connected: true,
        phase: 'ready',
        phaseMessage: 'Connected to Simulated DJI Osmo Pocket 4 Pro (Mock transport).',
        camera: device,
        batteryPct: 86,
        sdFreeMb: 48200,
        sdTotalMb: 64000,
        internalFreeMb: 19400,
        internalTotalMb: 24000,
        wifiSsid: 'OsmoPocket4P-SIM',
        cameraIp: this.cameraBaseUrl,
      };
      this.rememberCamera(device);
      this.emit();
      return this.snapshot();
    }

    try {
      this.status = {
        connected: false,
        phase: 'ble_connecting',
        phaseMessage: `Pairing over Bluetooth LE with ${device.name} (confirm on camera screen if prompted)...`,
        camera: device,
      };
      this.emit();

      const res = await this.runSidecarCommand(
        [
          'connect-and-list',
          '--address',
          device.address,
          '--port',
          String(device.datalinkPort),
          '--poke',
          device.tcpPoke ? '1' : '0',
        ],
        65000
      );
      this.activeDirectWifi = null;
      this.cameraBaseUrl = String(res.base_url || 'http://192.168.2.1');
      const items = Array.isArray(res.media) ? (res.media as Array<Record<string, unknown>>) : [];
      this.rawMedia = this.mapSidecarMedia(items);
      this.status = {
        connected: true,
        phase: 'ready',
        phaseMessage: `Connected to ${device.modelName} over Wi-Fi (${this.rawMedia.length} files).`,
        camera: device,
        batteryPct: typeof res.battery_pct === 'number' ? res.battery_pct : undefined,
        sdFreeMb: typeof res.sd_free_mb === 'number' ? res.sd_free_mb : undefined,
        sdTotalMb: typeof res.sd_total_mb === 'number' ? res.sd_total_mb : undefined,
        internalFreeMb: typeof res.internal_free_mb === 'number' ? res.internal_free_mb : undefined,
        internalTotalMb: typeof res.internal_total_mb === 'number' ? res.internal_total_mb : undefined,
        wifiSsid: typeof res.ssid === 'string' ? res.ssid : undefined,
        cameraIp: this.cameraBaseUrl,
        previousWifiProfile: typeof res.previous_wifi === 'string' ? res.previous_wifi : null,
      };
      this.rememberCamera(device);
    } catch (err) {
      this.status = {
        connected: false,
        phase: 'error',
        phaseMessage: err instanceof Error ? err.message : String(err),
        camera: device,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.emit();
    return this.snapshot();
  }

  private rememberCamera(device: DjiCameraDevice): void {
    const cur = getDjiPluginSettings();
    const next = [
      { address: device.address, name: device.name, modelName: device.modelName, lastConnectedAt: Date.now() },
      ...cur.rememberedCameras.filter((c) => c.address !== device.address),
    ].slice(0, 8);
    saveDjiPluginSettings({ rememberedCameras: next });
  }

  async disconnectCamera(): Promise<DjiPluginStateSnapshot> {
    this.queue.cancelAll();
    if (this.mockServer) {
      await this.mockServer.stop();
    }
    this.activeDirectWifi = null;
    const prevWifi = this.status.previousWifiProfile;
    if (prevWifi && getDjiPluginSettings().restoreWifiOnDisconnect && this.env?.pythonPath) {
      void this.runSidecarCommand(['restore-wifi', '--profile', prevWifi], 12000).catch(() => {});
    }
    this.rawMedia = [];
    this.status = {
      connected: false,
      phase: 'idle',
      phaseMessage: 'Disconnected from DJI camera.',
    };
    this.emit();
    return this.snapshot();
  }

  async refreshMedia(): Promise<DjiPluginStateSnapshot> {
    this.assertEnabled();
    if (!this.status.connected || !this.status.camera) {
      throw new Error('No DJI camera is currently connected.');
    }
    const camera = this.status.camera;
    if (camera.isSimulated && this.mockServer) {
      this.rawMedia = this.mockServer.listMedia();
      this.status = {
        ...this.status,
        phaseMessage: `Refreshed simulated camera media (${this.rawMedia.length} files).`,
      };
      this.emit();
      return this.snapshot();
    }
    if (this.activeDirectWifi) {
      const { ip, port } = this.activeDirectWifi;
      const refreshed = await queryCameraMediaOverWifi(ip, port, port === 9004);
      if (refreshed.length === 0 && this.rawMedia.length > 0) {
        this.status = {
          ...this.status,
          phaseMessage: `Refresh returned no files from ${ip}; keeping the previous ${this.rawMedia.length} cached files.`,
        };
        this.emit();
        return this.snapshot();
      }
      this.rawMedia = refreshed;
      this.status = {
        ...this.status,
        phaseMessage: `Refreshed media list from ${ip} (${this.rawMedia.length} files).`,
      };
      this.emit();
      return this.snapshot();
    }
    const res = await this.runSidecarCommand(
      [
        'connect-and-list',
        '--address',
        camera.address,
        '--port',
        String(camera.datalinkPort),
        '--poke',
        camera.tcpPoke ? '1' : '0',
      ],
      65000
    );
    const items = Array.isArray(res.media) ? (res.media as Array<Record<string, unknown>>) : [];
    const refreshed = this.mapSidecarMedia(items);
    if (refreshed.length === 0 && this.rawMedia.length > 0) {
      this.status = {
        ...this.status,
        phaseMessage: `Refresh returned no files from ${camera.modelName}; keeping the previous ${this.rawMedia.length} cached files.`,
      };
      this.emit();
      return this.snapshot();
    }
    this.rawMedia = refreshed;
    this.status = {
      ...this.status,
      phaseMessage: `Refreshed media list from ${camera.modelName} (${this.rawMedia.length} files).`,
    };
    this.emit();
    return this.snapshot();
  }

  private mapSidecarMedia(
    items: Array<Record<string, unknown>>
  ): Array<Omit<DjiRemoteMediaItem, 'alreadyImported' | 'localPath'>> {
    return items.map((m) => ({
      id: `${Number(m.storage ?? 0)}:${String(m.media_path)}:${Number(m.handle ?? 0)}`,
      handle: Number(m.handle ?? 0),
      name: String(m.name ?? ''),
      folder: String(m.folder ?? ''),
      mediaPath: String(m.media_path ?? ''),
      thumbPath: typeof m.thumb_path === 'string' ? m.thumb_path : undefined,
      ext: String(m.ext ?? ''),
      kind: m.ext === 'MP4' || m.ext === 'MOV' ? 'video' : 'photo',
      size: Number(m.size ?? 0),
      storage: Number(m.storage) === 1 ? 1 : 0,
      star: Boolean(m.star),
      capturedAt: typeof m.captured_at === 'string' ? m.captured_at : undefined,
    }));
  }

  enqueueDownloads(mediaIds: string[]): DjiPluginStateSnapshot {
    this.assertEnabled();
    const snap = this.snapshot();
    const selected = snap.media.filter((m) => mediaIds.includes(m.id));
    if (selected.length > 0) this.queue.enqueue(selected);
    return this.snapshot();
  }

  cancelDownload(taskId: string): DjiPluginStateSnapshot {
    this.queue.cancel(taskId);
    return this.snapshot();
  }

  retryDownload(taskId: string): DjiPluginStateSnapshot {
    this.queue.retry(taskId);
    return this.snapshot();
  }

  clearFinishedDownloads(): DjiPluginStateSnapshot {
    this.queue.clearFinished();
    return this.snapshot();
  }

  async fetchRemoteBuffer(
    storage: 0 | 1,
    mediaPath: string,
    range?: string,
    maxBytes = 24 * 1024 * 1024
  ): Promise<{ body: Buffer; contentType: string; rangeStatus: number }> {
    for (const candidate of buildRemoteCandidatePaths(mediaPath)) {
      const target = new URL(DjiDownloadQueue.buildRelativeMediaUrl(storage, candidate), this.cameraBaseUrl);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await new Promise((resolve, reject) => {
            const request = http.request(
              target,
              { method: 'GET', timeout: 8000, headers: range ? { Range: range } : {} },
              (res: IncomingMessage) => {
                const status = res.statusCode ?? 0;
                if (status !== 200 && status !== 206) {
                  res.resume();
                  reject(new Error(`HTTP ${status}`));
                  return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > maxBytes) {
                    request.destroy();
                    reject(new Error('Remote media exceeds preview limit'));
                    return;
                  }
                  chunks.push(chunk);
                });
                res.on('end', () => {
                  resolve({
                    body: Buffer.concat(chunks),
                    contentType: String(res.headers['content-type'] || 'application/octet-stream'),
                    rangeStatus: status,
                  });
                });
                res.on('error', reject);
              }
            );
            request.on('timeout', () => request.destroy(new Error('Remote media timed out')));
            request.on('error', reject);
            request.end();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt === 1) {
            if (message.includes('preview limit')) throw error;
            break;
          }
        }
      }
    }
    throw new Error(`Camera media not found at remote path: ${mediaPath}`);
  }

  async serveRemoteMedia(req: string): Promise<{ status: number; body: Uint8Array; contentType: string }> {
    const url = new URL(req);
    const storage = Number(url.searchParams.get('storage') ?? '0');
    const mediaPath = url.searchParams.get('path') ?? '';
    const range = undefined;
    if (Number.isFinite(storage) && (storage === 0 || storage === 1) && mediaPath) {
      const result = await this.fetchRemoteBuffer(storage as 0 | 1, mediaPath, range);
      return { status: 200, body: new Uint8Array(result.body), contentType: result.contentType };
    }
    return { status: 400, body: new Uint8Array(), contentType: 'text/plain' };
  }

  async listUsbVolumes() {
    return this.usb.listVolumes();
  }

  async importUsbFiles(fileIds: string[]) {
    return this.usb.importFiles(fileIds);
  }

  cancelUsbImport(taskId: string): void {
    this.usb.cancel(taskId);
    this.emit();
  }

  clearFinishedUsbImports(): void {
    this.usb.clearFinished();
    this.emit();
  }
}
