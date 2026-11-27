export interface PluginSummary {
  id: string;
  name: string;
  nameZh: string;
  version: string;
  description: string;
  descriptionZh: string;
  enabled: boolean;
  healthy: boolean;
  error?: string;
}

export type DjiConnectionPhase =
  | 'idle'
  | 'scanning'
  | 'ble_connecting'
  | 'awaiting_approval'
  | 'wifi_joining'
  | 'datalink_connecting'
  | 'ready'
  | 'error';

export interface DjiCameraDevice {
  id: string;
  address: string;
  name: string;
  modelId: number | null;
  modelName: string;
  rssi: number;
  datalinkPort: number;
  tcpPoke: boolean;
  wifiSecurity: 'WPA2' | 'WPA3';
  isSimulated?: boolean;
  lastSeenAt: number;
}

export interface DjiEnvironmentStatus {
  platform: string;
  pythonPath: string | null;
  pythonAvailable: boolean;
  bleakAvailable: boolean;
  bluetoothReady: boolean;
  wifiReady: boolean;
  wifiConnectedProfile?: string | null;
  ethernetActive?: boolean;
  notes: string[];
}

export interface DjiLiveConnectionStatus {
  checkedAt: number;
  wifiMatchesCamera: boolean;
  connectedSsid: string | null;
  cameraIpReachable: boolean;
  latencyMs: number | null;
  cameraSessionValid: boolean;
  state: 'connected' | 'transferring' | 'wifi_mismatch' | 'unreachable' | 'stale' | 'disconnected';
  message: string;
}

export interface DjiCameraStatus {
  connected: boolean;
  phase: DjiConnectionPhase;
  phaseMessage: string;
  camera?: DjiCameraDevice;
  batteryPct?: number;
  sdFreeMb?: number;
  sdTotalMb?: number;
  internalFreeMb?: number;
  internalTotalMb?: number;
  wifiSsid?: string;
  cameraIp?: string;
  previousWifiProfile?: string | null;
  error?: string;
  live?: DjiLiveConnectionStatus;
}

export type DjiMediaKind = 'video' | 'photo';

export interface DjiRemoteMediaItem {
  id: string;
  handle: number;
  name: string;
  folder: string;
  mediaPath: string;
  thumbPath?: string;
  ext: string;
  kind: DjiMediaKind;
  size: number;
  storage: 0 | 1;
  star: boolean;
  capturedAt?: string;
  alreadyImported: boolean;
  localPath?: string;
}

export type DjiDownloadStatus =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'importing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface DjiDownloadTask {
  id: string;
  mediaId: string;
  name: string;
  mediaPath: string;
  ext: string;
  storage: 0 | 1;
  size: number;
  downloadedBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  status: DjiDownloadStatus;
  destPath: string;
  hashHex?: string;
  resumedFrom?: number;
  importedAssetIds?: string[];
  error?: string;
}

export interface DjiUsbFile {
  id: string;
  name: string;
  folder: string;
  relativePath: string;
  ext: string;
  kind: DjiMediaKind;
  size: number;
  sourcePath: string;
}

export interface DjiUsbVolume {
  id: string;
  letter: string;
  label: string;
  files: DjiUsbFile[];
}

export type DjiUsbImportStatus = 'copying' | 'done' | 'failed';

export interface DjiUsbImportTask {
  id: string;
  fileId: string;
  name: string;
  sourcePath: string;
  size: number;
  copiedBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  status: DjiUsbImportStatus;
  destPath?: string;
  importedAssetIds?: string[];
  error?: string;
}

export interface DjiPluginSettings {
  downloadDir: string;
  autoImportToProject: boolean;
  concurrency: 1 | 2;
  restoreWifiOnDisconnect: boolean;
  rememberedCameras: Array<{
    address: string;
    name: string;
    modelName: string;
    lastConnectedAt: number;
  }>;
}

export interface DjiPluginStateSnapshot {
  enabled: boolean;
  env: DjiEnvironmentStatus | null;
  status: DjiCameraStatus;
  discovered: DjiCameraDevice[];
  media: DjiRemoteMediaItem[];
  tasks: DjiDownloadTask[];
  settings: DjiPluginSettings;
  usbVolumes: DjiUsbVolume[];
  usbTasks: DjiUsbImportTask[];
}
