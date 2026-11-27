import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  Battery,
  Camera,
  Check,
  CheckCircle2,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  Star,
  Video,
  Image as ImageIcon,
  Wifi,
  WifiOff,
  X,
  Download,
} from 'lucide-react';
import type { DjiPluginStateSnapshot, DjiRemoteMediaItem } from '../../shared/djiTypes';
import { useI18n } from '../i18n';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

function formatEta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '--';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

interface DjiImportModalProps {
  state: DjiPluginStateSnapshot;
  onClose: () => void;
}

export const DjiImportModal: React.FC<DjiImportModalProps> = ({ state, onClose }) => {
  const { L } = useI18n();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedUsbIds, setSelectedUsbIds] = useState<Set<string>>(new Set());
  const [filterKind, setFilterKind] = useState<'all' | 'video' | 'photo' | 'new' | 'starred'>('all');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [directPort, setDirectPort] = useState<9004 | 10004>(9004);
  const [directIp, setDirectIp] = useState<string>('192.168.2.1');
  const [previews, setPreviews] = useState<Record<string, string>>({});

  React.useEffect(() => {
    const next: Record<string, string> = {};
    for (const item of state.media.slice(0, 120)) {
      if (state.status.connected) {
        next[item.id] = `vectrail-dji://camera/v2?storage=${item.storage}&path=${encodeURIComponent(item.mediaPath)}`;
      }
    }
    setPreviews(next);
  }, [state.status.connected, state.status.cameraIp, state.media]);

  const filteredMedia = useMemo(() => {
    return state.media.filter((item) => {
      if (filterKind === 'video') return item.kind === 'video';
      if (filterKind === 'photo') return item.kind === 'photo';
      if (filterKind === 'new') return !item.alreadyImported;
      if (filterKind === 'starred') return item.star;
      return true;
    });
  }, [state.media, filterKind]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds(new Set(filteredMedia.map((m) => m.id)));
  };

  const selectAllNew = () => {
    setSelectedIds(new Set(state.media.filter((m) => !m.alreadyImported).map((m) => m.id)));
  };

  const runAction = async (key: string, fn: () => Promise<unknown>) => {
    setActionError(null);
    setBusyAction(key);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const selectedItems = state.media.filter((m) => selectedIds.has(m.id));
  const selectedUsbItems = state.usbVolumes.flatMap((volume) => volume.files).filter((f) => selectedUsbIds.has(f.id));
  const selectedTotalBytes = selectedItems.reduce((sum, item) => sum + (item.size || 0), 0);
  const activeTasks = state.tasks.filter(
    (t) => t.status === 'queued' || t.status === 'downloading' || t.status === 'verifying' || t.status === 'importing'
  );
  const activeUsbTasks = state.usbTasks.filter((task) => task.status === 'copying');

  const statusText = (item: DjiRemoteMediaItem) => {
    if (item.alreadyImported) return L('已导入', 'Imported');
    return item.storage === 1 ? L('机身存储', 'Internal') : 'SD';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div
        className="w-[820px] max-w-[calc(100vw-32px)] h-[82vh] max-h-[720px] flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div
          className="flex items-center justify-between px-4 h-11 shrink-0"
          style={{ background: 'var(--panel)', borderBottom: '1px solid var(--stroke)' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Camera size={15} style={{ color: 'var(--accent)' }} />
            <span className="text-[13px] font-semibold truncate">
              {L('DJI 相机无线素材导入', 'DJI Wireless Camera Import')}
            </span>
            <span
              className="px-1.5 py-0.5 rounded text-[9.5px] font-medium"
              style={{ background: 'var(--button)', color: 'var(--text-dim)' }}
            >
              dji-wireless-import
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => void runAction('env', () => window.vectrail.refreshDjiEnv())}
              className="vt-hover inline-flex items-center gap-1 px-2 py-1 rounded text-[10.5px]"
              style={{ color: 'var(--text-dim)' }}
              title={L('重新检测蓝牙与无线网卡环境', 'Re-check Bluetooth & Wi-Fi environment')}
            >
              <RefreshCw size={11} className={busyAction === 'env' ? 'animate-spin' : ''} />
              {L('检测环境', 'Check Env')}
            </button>
            <button
              onClick={onClose}
              className="vt-hover p-1 rounded"
              style={{ color: 'var(--text-dim)' }}
              title={L('关闭窗口（后台传输继续进行）', 'Close (background transfers keep running)')}
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col p-4 gap-3 overflow-y-auto">
          {!state.enabled ? (
            <div
              className="p-4 rounded-lg text-[12px] flex items-center justify-between"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
            >
              <span>{L('当前「DJI 无线素材导入」插件已禁用，可在「设置 → 插件」中启用。', 'The DJI Wireless Import plugin is currently disabled. Enable it in Settings → Plugins.')}</span>
            </div>
          ) : (
            <>
              <div
                className="p-3 rounded-lg space-y-2.5 shrink-0"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        background: state.status.connected
                          ? '#30D158'
                          : state.status.phase === 'error'
                          ? '#FF453A'
                          : state.status.phase === 'scanning' || state.status.phase === 'ble_connecting'
                          ? 'var(--accent)'
                          : 'var(--text-faint)',
                      }}
                    />
                    <span className="font-medium" style={{ color: 'var(--text)' }}>
                      {state.status.phaseMessage}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {state.status.connected ? (
                      <>
                        <button
                          disabled={busyAction !== null}
                          onClick={() => void runAction('refresh-media', () => window.vectrail.refreshDjiMedia())}
                          className="vt-btn inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium"
                          style={{ background: 'var(--button)', color: 'var(--text)' }}
                        >
                          <RefreshCw size={11} className={busyAction === 'refresh-media' ? 'animate-spin' : ''} />
                          {L('刷新列表', 'Refresh')}
                        </button>
                        <button
                          disabled={busyAction !== null}
                          onClick={() => void runAction('disconnect', () => window.vectrail.disconnectDjiCamera())}
                          className="vt-btn px-2.5 py-1 rounded text-[11px] font-medium"
                          style={{ background: 'var(--button)', color: 'var(--text)' }}
                        >
                          {L('断开相机', 'Disconnect')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          disabled={busyAction !== null}
                          onClick={() => void runAction('scan', () => window.vectrail.scanDjiCameras(false))}
                          className="inline-flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-semibold"
                          style={{ background: 'var(--accent)', color: '#FFF' }}
                        >
                          {busyAction === 'scan' ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />}
                          {L('扫描附近 DJI 相机', 'Scan DJI Cameras')}
                        </button>
                        <div
                          className="inline-flex items-center rounded overflow-hidden"
                          style={{ border: '1px solid var(--stroke)', background: 'var(--button)' }}
                        >
                          <button
                            disabled={busyAction !== null}
                            onClick={() =>
                              void runAction('direct-wifi', () => window.vectrail.connectDjiDirectWifi(directPort, directIp))
                            }
                            className="vt-btn inline-flex items-center gap-1 px-2.5 py-1 text-[11px]"
                            style={{ color: 'var(--text)' }}
                            title={L('电脑已在系统 Wi-Fi 中连上相机热点时，可直接连接 192.168.2.1（无需蓝牙/bleak）', 'Connect directly to 192.168.2.1 if Windows is already joined to the camera Wi-Fi')}
                          >
                            {busyAction === 'direct-wifi' && <Loader2 size={11} className="animate-spin" />}
                            {L('直连 Wi-Fi', 'Direct Wi-Fi')}
                          </button>
                          <input
                            type="text"
                            value={directIp}
                            onChange={(e) => setDirectIp(e.target.value)}
                            className="w-[92px] bg-transparent px-1.5 py-1 text-[10px] mono-num outline-none"
                            style={{ color: 'var(--text-dim)', borderLeft: '1px solid var(--stroke)' }}
                            title={L('相机热点 IP（默认 192.168.2.1）', 'Camera AP IP (default 192.168.2.1)')}
                          />
                          <select
                            value={directPort}
                            onChange={(e) => setDirectPort(Number(e.target.value) === 10004 ? 10004 : 9004)}
                            className="bg-transparent px-1 py-1 text-[10px] outline-none"
                            style={{ color: 'var(--text-dim)', borderLeft: '1px solid var(--stroke)' }}
                            title={L('Datalink 端口：Osmo 默认 9004，Xtra Edge Pro 为 10004', 'Datalink port: 9004 for Osmo, 10004 for Xtra Edge Pro')}
                          >
                            <option value={9004}>9004</option>
                            <option value={10004}>10004</option>
                          </select>
                        </div>
                        <button
                          disabled={busyAction !== null}
                          onClick={() => void runAction('scan-sim', () => window.vectrail.scanDjiCameras(true))}
                          className="vt-btn px-2.5 py-1 rounded text-[11px]"
                          style={{ background: 'var(--button)', color: 'var(--text-dim)' }}
                          title={L('在无实机时加载内置模拟相机测试传输与导入流程', 'Load built-in simulated camera when no physical DJI camera is nearby')}
                        >
                          {L('模拟相机测试', 'Simulate Camera')}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {(actionError || state.status.error) && (
                  <div
                    className="flex items-start gap-2 px-2.5 py-2 rounded text-[11px]"
                    style={{ background: 'rgba(255,69,58,0.12)', border: '1px solid rgba(255,69,58,0.35)', color: '#FF6961' }}
                  >
                    <AlertCircle size={13} className="shrink-0 mt-0.5" />
                    <span className="break-words">{actionError || state.status.error}</span>
                  </div>
                )}

                {state.status.live && (
                  <div
                    className="flex items-start gap-2 px-2.5 py-2 rounded text-[11px]"
                    style={{
                      background:
                        state.status.live.state === 'connected'
                          ? 'rgba(48,209,88,0.10)'
                          : state.status.live.state === 'stale'
                          ? 'rgba(255,159,10,0.10)'
                          : 'rgba(255,69,58,0.10)',
                      border:
                        state.status.live.state === 'connected'
                          ? '1px solid rgba(48,209,88,0.30)'
                          : state.status.live.state === 'stale'
                          ? '1px solid rgba(255,159,10,0.30)'
                          : '1px solid rgba(255,69,58,0.30)',
                      color:
                        state.status.live.state === 'connected'
                          ? '#30D158'
                          : state.status.live.state === 'stale'
                          ? '#FF9F0A'
                          : '#FF6961',
                    }}
                  >
                    <span className="font-medium shrink-0">实时状态</span>
                    <span className="break-words">{state.status.live.message}</span>
                  </div>
                )}

                {state.env && (
                  <div className="flex flex-wrap items-center gap-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>
                    <span className="px-2 py-0.5 rounded" style={{ background: 'var(--field)', border: '1px solid var(--stroke)' }}>
                      {L('蓝牙', 'Bluetooth')}: {state.env.bluetoothReady ? L('就绪', 'Ready') : L('未就绪', 'Unavailable')}
                    </span>
                    <span className="px-2 py-0.5 rounded" style={{ background: 'var(--field)', border: '1px solid var(--stroke)' }}>
                      Wi-Fi: {state.env.wifiReady ? L('就绪', 'Ready') : L('不可用', 'Unavailable')}
                    </span>
                    <span className="px-2 py-0.5 rounded" style={{ background: 'var(--field)', border: '1px solid var(--stroke)' }}>
                      BLE Sidecar (bleak): {state.env.bleakAvailable ? L('已就绪', 'Installed') : L('需 pip install bleak', 'Missing bleak')}
                    </span>
                    {state.env.pythonAvailable && !state.env.bleakAvailable && (
                      <button
                        disabled={busyAction !== null}
                        onClick={() => void runAction('install-bleak', () => window.vectrail.installDjiBleak())}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-semibold"
                        style={{ background: 'var(--accent)', color: '#FFF' }}
                      >
                        {busyAction === 'install-bleak' && <Loader2 size={10} className="animate-spin" />}
                        {L('一键安装 bleak 蓝牙依赖', 'Install bleak')}
                      </button>
                    )}
                    <span className="px-2 py-0.5 rounded" style={{ background: 'var(--field)', border: '1px solid var(--stroke)' }}>
                      {state.env.ethernetActive
                        ? L('双网卡在线：传输时不断外网', 'Ethernet active: Internet stays online')
                        : L('单 Wi-Fi 模式：连相机热点时将暂断外网', 'Single Wi-Fi: Internet pauses while on camera AP')}
                    </span>
                  </div>
                )}

                {!state.status.connected && state.discovered.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    {state.discovered.map((cam) => (
                      <div
                        key={cam.id}
                        className="flex items-center justify-between gap-2 p-2 rounded"
                        style={{ background: 'var(--panel)', border: '1px solid var(--stroke)' }}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-[11px] font-medium truncate">
                            <span>{cam.modelName}</span>
                            {cam.isSimulated && (
                              <span
                                className="px-1 py-0.2 rounded text-[9px]"
                                style={{ background: 'rgba(255,74,28,0.16)', color: 'var(--accent)' }}
                              >
                                MOCK
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] truncate mono-num" style={{ color: 'var(--text-faint)' }}>
                            {cam.name} · {cam.rssi} dBm · UDP/{cam.datalinkPort}
                          </div>
                        </div>
                        <button
                          disabled={busyAction !== null}
                          onClick={() => void runAction(`conn-${cam.id}`, () => window.vectrail.connectDjiCamera(cam.id))}
                          className="px-2.5 py-1 rounded text-[10.5px] font-semibold shrink-0"
                          style={{ background: 'var(--text)', color: 'var(--on-text)' }}
                        >
                          {busyAction === `conn-${cam.id}` ? L('连接中...', 'Connecting...') : L('连接', 'Connect')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {!state.status.connected &&
                  state.discovered.length === 0 &&
                  state.settings.rememberedCameras.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[10px]" style={{ color: 'var(--text-faint)' }}>
                      <span>{L('历史相机:', 'Recent:')}</span>
                      {state.settings.rememberedCameras.slice(0, 4).map((cam) => (
                        <span
                          key={cam.address}
                          className="px-2 py-0.5 rounded mono-num"
                          style={{ background: 'var(--panel)', border: '1px solid var(--stroke)', color: 'var(--text-dim)' }}
                          title={cam.address}
                        >
                          {cam.modelName} ({cam.name})
                        </span>
                      ))}
                    </div>
                  )}

                {state.status.connected && state.status.camera && (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded text-[10.5px]"
                    style={{ background: 'var(--panel)', border: '1px solid var(--stroke)' }}
                  >
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-semibold">{state.status.camera.modelName}</span>
                      {state.status.camera.isSimulated && (
                        <span className="px-1.5 py-0.2 rounded text-[9px]" style={{ background: 'rgba(255,74,28,0.16)', color: 'var(--accent)' }}>
                          {L('模拟设备（非实机）', 'Simulated (Not Real Hardware)')}
                        </span>
                      )}
                      {state.status.batteryPct !== undefined && (
                        <span className="inline-flex items-center gap-1" style={{ color: 'var(--text-dim)' }}>
                          <Battery size={11} /> {state.status.batteryPct}%
                        </span>
                      )}
                      {state.status.sdFreeMb !== undefined && (
                        <span className="inline-flex items-center gap-1" style={{ color: 'var(--text-dim)' }}>
                          <HardDrive size={11} /> SD {Math.round(state.status.sdFreeMb / 1024)} GB {L('可用', 'free')}
                        </span>
                      )}
                      {state.status.wifiSsid && (
                        <span className="mono-num" style={{ color: 'var(--text-faint)' }}>
                          SSID: {state.status.wifiSsid}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px]" style={{ color: '#30D158' }}>
                      {L('已连接 · 原片直传（不压缩）', 'Connected · Lossless Original Transfer')}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex-1 min-h-0 grid grid-cols-12 gap-3">
                <div
                  className="col-span-7 flex flex-col min-h-0 rounded-lg overflow-hidden"
                  style={{ background: 'var(--panel)', border: '1px solid var(--stroke)' }}
                >
                  <div
                    className="flex items-center justify-between px-3 h-9 shrink-0"
                    style={{ borderBottom: '1px solid var(--stroke)' }}
                  >
                    <div className="flex items-center gap-1">
                      {(
                        [
                          { id: 'all', label: L('全部', 'All') },
                          { id: 'video', label: L('视频', 'Video') },
                          { id: 'photo', label: L('照片', 'Photo') },
                          { id: 'new', label: L('未导入', 'New') },
                          { id: 'starred', label: L('收藏 ★', 'Starred') },
                        ] as const
                      ).map((tab) => (
                        <button
                          key={tab.id}
                          onClick={() => setFilterKind(tab.id)}
                          className="px-2 py-0.5 rounded text-[10.5px]"
                          style={{
                            background: filterKind === tab.id ? 'var(--raised)' : 'transparent',
                            color: filterKind === tab.id ? 'var(--text)' : 'var(--text-dim)',
                          }}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <button onClick={selectAllNew} className="vt-hover px-1.5 py-0.5 rounded" style={{ color: 'var(--text-dim)' }}>
                        {L('选未导入', 'Select New')}
                      </button>
                      <button onClick={selectAllVisible} className="vt-hover px-1.5 py-0.5 rounded" style={{ color: 'var(--text-dim)' }}>
                        {L('全选', 'All')}
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
                    {filteredMedia.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center p-6" style={{ color: 'var(--text-faint)' }}>
                        <WifiOff size={20} className="mb-2" />
                        <div className="text-[11px]">
                          {state.status.connected
                            ? L('当前筛选下没有可显示素材', 'No media matches the current filter')
                            : L('请先扫描并连接 DJI 相机（或点击「模拟相机测试」）', 'Scan and connect a DJI camera (or try Simulate Camera)')}
                        </div>
                      </div>
                    ) : (
                      filteredMedia.map((item) => {
                        const checked = selectedIds.has(item.id);
                        return (
                          <div
                            key={item.id}
                            onClick={() => toggleSelect(item.id)}
                            className="flex items-center justify-between gap-2 px-2.5 py-2 rounded cursor-pointer transition-colors"
                            style={{
                              background: checked ? 'rgba(255,74,28,0.12)' : 'var(--raised)',
                              border: `1px solid ${checked ? 'var(--accent)' : 'var(--stroke)'}`,
                            }}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <div
                                className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                                style={{
                                  background: checked ? 'var(--accent)' : 'var(--field)',
                                  border: `1px solid ${checked ? 'var(--accent)' : 'var(--stroke)'}`,
                                }}
                              >
                                {checked && <Check size={10} color="#FFF" />}
                              </div>
                              {previews[item.id] ? (
                                <img
                                  src={previews[item.id]}
                                  alt=""
                                  className="w-14 h-8 object-cover rounded-sm shrink-0"
                                  style={{ background: 'var(--well)' }}
                                  onError={(event) => {
                                    event.currentTarget.style.display = 'none';
                                  }}
                                />
                              ) : item.kind === 'video' ? (
                                <Video size={13} style={{ color: 'var(--text-dim)' }} className="shrink-0" />
                              ) : (
                                <ImageIcon size={13} style={{ color: 'var(--text-dim)' }} className="shrink-0" />
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-1 text-[11px] font-medium truncate">
                                  <span className="truncate">{item.name}</span>
                                  {item.star && <Star size={10} fill="#FF9F0A" color="#FF9F0A" className="shrink-0" />}
                                </div>
                                <div className="text-[9.5px] mono-num truncate" style={{ color: 'var(--text-faint)' }}>
                                  {item.folder} · {formatBytes(item.size)} {item.capturedAt ? `· ${item.capturedAt}` : ''}
                                </div>
                              </div>
                            </div>
                            <span
                              className="px-1.5 py-0.5 rounded text-[9.5px] shrink-0"
                              style={{
                                background: item.alreadyImported ? 'rgba(48,209,88,0.15)' : 'var(--button)',
                                color: item.alreadyImported ? '#30D158' : 'var(--text-dim)',
                              }}
                            >
                              {statusText(item)}
                            </span>
                          </div>
                        );
                      })
                    )}
                    {state.usbTasks.map((task) => {
                      const pct = task.size > 0 ? Math.min(100, Math.round((task.copiedBytes / task.size) * 100)) : task.status === 'done' ? 100 : 0;
                      return (
                        <div
                          key={task.id}
                          className="p-2 rounded space-y-1"
                          style={{ background: 'var(--raised)', border: '1px solid var(--stroke)' }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium truncate">USB · {task.name}</span>
                            {task.status === 'copying' && (
                              <button
                                onClick={() => void window.vectrail.cancelDjiUsbImport(task.id)}
                                className="p-0.5 rounded vt-hover"
                                style={{ color: 'var(--text-dim)' }}
                                title={L('取消', 'Cancel')}
                              >
                                <Square size={10} />
                              </button>
                            )}
                            {task.status === 'done' && <CheckCircle2 size={12} style={{ color: '#30D158' }} />}
                            {task.status === 'failed' && <AlertCircle size={12} style={{ color: '#FF453A' }} />}
                          </div>
                          <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: 'var(--well)' }}>
                            <div
                              className="h-full transition-all"
                              style={{ width: `${pct}%`, background: task.status === 'failed' ? '#FF453A' : task.status === 'done' ? '#30D158' : 'var(--accent)' }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[9.5px] mono-num" style={{ color: 'var(--text-faint)' }}>
                            <span>{formatBytes(task.copiedBytes)} / {formatBytes(task.size)} ({pct}%)</span>
                            <span>{task.status === 'copying' ? `${formatBytes(task.speedBytesPerSec)}/s · ETA ${formatEta(task.etaSeconds)}` : task.status}</span>
                          </div>
                          {task.error && <div className="text-[10px]" style={{ color: '#FF453A' }}>{task.error}</div>}
                        </div>
                      );
                    })}
                  </div>

                  <div
                    className="flex items-center justify-between px-3 py-2 shrink-0"
                    style={{ borderTop: '1px solid var(--stroke)', background: 'var(--sheet-field)' }}
                  >
                    <span className="text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
                      {L(
                        `已选 ${selectedItems.length} 个文件${selectedTotalBytes > 0 ? ` · ${formatBytes(selectedTotalBytes)}` : ''}`,
                        `${selectedItems.length} selected${selectedTotalBytes > 0 ? ` · ${formatBytes(selectedTotalBytes)}` : ''}`
                      )}
                    </span>
                    <button
                      disabled={selectedItems.length === 0}
                      onClick={() => {
                        void window.vectrail.enqueueDjiDownloads(selectedItems.map((m) => m.id));
                        setSelectedIds(new Set());
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-semibold disabled:opacity-40"
                      style={{ background: 'var(--accent)', color: '#FFF' }}
                    >
                      <Download size={12} />
                      {L('下载并导入媒体库', 'Download & Import')}
                    </button>
                    <button
                      disabled={selectedUsbItems.length === 0}
                      onClick={() => {
                        void window.vectrail.importDjiUsbFiles(selectedUsbItems.map((f) => f.id));
                        setSelectedUsbIds(new Set());
                      }}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10.5px] font-semibold disabled:opacity-40"
                      style={{ background: 'var(--button)', color: 'var(--text)' }}
                      title={L('从 USB 连接的大疆相机复制并导入', 'Copy and import from a USB-connected DJI camera')}
                    >
                      <FolderOpen size={12} />
                      {L(`USB 导入 (${selectedUsbItems.length})`, `USB Import (${selectedUsbItems.length})`)}
                    </button>
                  </div>
                </div>

                <div
                  className="col-span-5 flex flex-col min-h-0 rounded-lg overflow-hidden"
                  style={{ background: 'var(--panel)', border: '1px solid var(--stroke)' }}
                >
                  <div
                    className="flex items-center justify-between px-3 h-9 shrink-0"
                    style={{ borderBottom: '1px solid var(--stroke)' }}
                  >
                    <span className="text-[10.5px] font-semibold">
                      {L(
                        `传输队列 (${activeTasks.length + activeUsbTasks.length} 进行中)`,
                        `Transfer Queue (${activeTasks.length + activeUsbTasks.length} active)`
                      )}
                    </span>
                    {state.tasks.some((t) => t.status === 'done' || t.status === 'cancelled' || t.status === 'failed') && (
                      <button
                        onClick={() => void window.vectrail.clearDjiDownloads()}
                        className="vt-hover px-1.5 py-0.5 rounded text-[10px]"
                        style={{ color: 'var(--text-dim)' }}
                      >
                        {L('清理已完成', 'Clear Done')}
                      </button>
                    )}
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
                    {state.tasks.length === 0 ? (
                      <div className="h-full flex items-center justify-center text-[10.5px] text-center p-4" style={{ color: 'var(--text-faint)' }}>
                        {L('选择左侧相机素材后点击下载，传输任务将在后台流式写盘并校验导入。', 'Select camera files and download; tasks stream to disk, verify integrity, and import in background.')}
                      </div>
                    ) : (
                      state.tasks.map((task) => {
                        const pct = task.size > 0 ? Math.min(100, Math.round((task.downloadedBytes / task.size) * 100)) : task.status === 'done' ? 100 : 0;
                        return (
                          <div
                            key={task.id}
                            className="p-2 rounded space-y-1"
                            style={{ background: 'var(--raised)', border: '1px solid var(--stroke)' }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] font-medium truncate">{task.name}</span>
                              <div className="flex items-center gap-1 shrink-0">
                                {(task.status === 'queued' || task.status === 'downloading') && (
                                  <button
                                    onClick={() => void window.vectrail.cancelDjiDownload(task.id)}
                                    className="p-0.5 rounded vt-hover"
                                    style={{ color: 'var(--text-dim)' }}
                                    title={L('取消', 'Cancel')}
                                  >
                                    <Square size={10} />
                                  </button>
                                )}
                                {(task.status === 'failed' || task.status === 'cancelled') && (
                                  <button
                                    onClick={() => void window.vectrail.retryDjiDownload(task.id)}
                                    className="p-0.5 rounded vt-hover"
                                    style={{ color: 'var(--accent)' }}
                                    title={L('重试（支持断点续传）', 'Retry (resumable)')}
                                  >
                                    <RotateCcw size={11} />
                                  </button>
                                )}
                                {task.status === 'done' && <CheckCircle2 size={12} style={{ color: '#30D158' }} />}
                                {task.status === 'failed' && <AlertCircle size={12} style={{ color: '#FF453A' }} />}
                              </div>
                            </div>
                            <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: 'var(--well)' }}>
                              <div
                                className="h-full transition-all"
                                style={{
                                  width: `${pct}%`,
                                  background: task.status === 'failed' ? '#FF453A' : task.status === 'done' ? '#30D158' : 'var(--accent)',
                                }}
                              />
                            </div>
                            <div className="flex items-center justify-between text-[9.5px] mono-num" style={{ color: 'var(--text-faint)' }}>
                              <span>
                                {formatBytes(task.downloadedBytes)} / {formatBytes(task.size)} ({pct}%)
                              </span>
                              <span>
                                {task.status === 'downloading'
                                  ? `${formatBytes(task.speedBytesPerSec)}/s · ETA ${formatEta(task.etaSeconds)}`
                                  : task.status}
                              </span>
                            </div>
                            {task.error && (
                              <div className="text-[10px]" style={{ color: '#FF453A' }}>
                                {task.error}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div
                    className="p-2.5 space-y-2 shrink-0 text-[10.5px]"
                    style={{ borderTop: '1px solid var(--stroke)', background: 'var(--sheet-field)' }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate" style={{ color: 'var(--text-dim)' }} title={state.settings.downloadDir}>
                        {L('保存目录', 'Dir')}: <span className="mono-num">{state.settings.downloadDir}</span>
                      </span>
                      <button
                        onClick={() => void window.vectrail.pickDjiDownloadDir()}
                        className="vt-btn inline-flex items-center gap-1 px-2 py-0.5 rounded shrink-0"
                        style={{ background: 'var(--button)', color: 'var(--text)' }}
                      >
                        <FolderOpen size={11} />
                        {L('更改', 'Browse')}
                      </button>
                    </div>
                    <label className="flex items-center justify-between cursor-pointer">
                      <span style={{ color: 'var(--text-dim)' }}>{L('下载校验完成后自动导入当前工程', 'Auto-import into project after checksum')}</span>
                      <input
                        type="checkbox"
                        checked={state.settings.autoImportToProject}
                        onChange={(e) => void window.vectrail.updateDjiSettings({ autoImportToProject: e.target.checked })}
                      />
                    </label>
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--text-dim)' }}>
                        <input
                          type="checkbox"
                          checked={state.settings.restoreWifiOnDisconnect}
                          onChange={(e) => void window.vectrail.updateDjiSettings({ restoreWifiOnDisconnect: e.target.checked })}
                        />
                        <span>{L('断开相机后恢复原 Wi-Fi', 'Restore Wi-Fi on disconnect')}</span>
                      </label>
                      <div className="flex items-center gap-1 shrink-0" style={{ color: 'var(--text-dim)' }}>
                        <span>{L('并发', 'Threads')}:</span>
                        {([1, 2] as const).map((n) => (
                          <button
                            key={n}
                            onClick={() => void window.vectrail.updateDjiSettings({ concurrency: n })}
                            className="px-1.5 py-0.5 rounded mono-num"
                            style={{
                              background: state.settings.concurrency === n ? 'var(--accent)' : 'var(--button)',
                              color: state.settings.concurrency === n ? '#FFF' : 'var(--text-dim)',
                            }}
                          >
                            {n}x
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
