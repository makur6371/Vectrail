import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Globe,
  Loader2,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import type { VideoImportEngineStatus, VideoImportMedia, VideoImportTask } from '../../shared/mediaImportTypes';
import { useI18n } from '../i18n';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

interface Props {
  onClose: () => void;
}

export const MediaLinkImportModal: React.FC<Props> = ({ onClose }) => {
  const { L } = useI18n();
  const [input, setInput] = useState('');
  const [health, setHealth] = useState<VideoImportEngineStatus | null>(null);
  const [preview, setPreview] = useState<VideoImportMedia | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<string>('');
  const [tasks, setTasks] = useState<VideoImportTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vectrail.mediaImportHealth().then(setHealth).catch((err) => setError(String(err)));
    void window.vectrail.getMediaImportTasks().then(setTasks);
    return window.vectrail.onMediaImportTasks(setTasks);
  }, []);

  const activeTasks = useMemo(
    () => tasks.filter((task) => ['resolving', 'downloading', 'merging'].includes(task.status)),
    [tasks]
  );

  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      const media = await window.vectrail.mediaImportResolve(input);
      setPreview(media);
      setSelectedFormat(media.formats.find((format) => format.hasVideo)?.id ?? media.formats[0]?.id ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.vectrail.mediaImportLinks(input, selectedFormat || undefined);
      setInput('');
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div
        className="w-[760px] max-w-[calc(100vw-32px)] h-[78vh] max-h-[700px] flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div className="flex items-center justify-between px-4 h-12 shrink-0" style={{ background: 'var(--panel)', borderBottom: '1px solid var(--stroke)' }}>
          <div className="flex items-center gap-2">
            <Globe size={16} style={{ color: 'var(--accent)' }} />
            <span className="text-[13px] font-semibold">{L('万能视频链接解析', 'Universal Video Link Import')}</span>
            <span className="px-1.5 py-0.5 rounded text-[9.5px] mono-num" style={{ background: 'var(--button)', color: 'var(--text-dim)' }}>
              media-link-import
            </span>
          </div>
          <button onClick={onClose} className="vt-hover p-1 rounded" style={{ color: 'var(--text-dim)' }}>
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
              <span>{L('粘贴分享文本或视频链接，可批量换行输入。', 'Paste share text or video links; batch links supported.')}</span>
              {health && (
                <span style={{ color: health.available ? '#30D158' : '#FF453A' }}>
                  yt-dlp {health.available ? `v${health.version}` : L('不可用', 'unavailable')}
                </span>
              )}
            </div>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              rows={4}
              placeholder={L('https://... 或 “7.47 复制打开抖音... https://v.douyin.com/xxx”', 'https://... or share text containing links')}
              className="w-full p-2.5 rounded-lg bg-transparent text-[12px] outline-none resize-none"
              style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void resolve()}
                disabled={busy || !input.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] font-semibold disabled:opacity-40"
                style={{ background: 'var(--button)', color: 'var(--text)' }}
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
                {L('解析预览', 'Resolve')}
              </button>
              <button
                onClick={() => void download()}
                disabled={busy || !input.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] font-semibold disabled:opacity-40"
                style={{ background: 'var(--accent)', color: '#FFF' }}
              >
                <Download size={13} />
                {L('直接下载导入', 'Download & Import')}
              </button>
            </div>
            {error && (
              <div className="flex items-start gap-2 px-2.5 py-2 rounded text-[11px]" style={{ background: 'rgba(255,69,58,.12)', border: '1px solid rgba(255,69,58,.35)', color: '#FF6961' }}>
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            )}
          </div>

          {preview && (
            <div className="p-3 rounded-lg space-y-3" style={{ background: 'var(--sheet-field)', border: '1px solid var(--stroke)' }}>
              <div className="flex gap-3">
                {preview.thumbnailUrl && <img src={preview.thumbnailUrl} alt="" className="w-32 h-20 object-cover rounded-md" />}
                <div className="min-w-0">
                  <div className="text-[12.5px] font-semibold truncate">{preview.title}</div>
                  <div className="text-[10.5px] truncate" style={{ color: 'var(--text-dim)' }}>
                    {preview.author || preview.platform} · {preview.duration ? `${preview.duration.toFixed(0)}s` : 'unknown'} · {preview.engine}
                  </div>
                </div>
              </div>
              <div className="space-y-1 max-h-52 overflow-y-auto">
                {preview.formats.map((format) => (
                  <button
                    key={format.id}
                    onClick={() => setSelectedFormat(format.id)}
                    className="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[11px]"
                    style={{ background: selectedFormat === format.id ? 'rgba(255,74,28,.14)' : 'var(--raised)', border: `1px solid ${selectedFormat === format.id ? 'var(--accent)' : 'var(--stroke)'}` }}
                  >
                    <span className="truncate">{format.label} · {format.extension}</span>
                    <span className="mono-num" style={{ color: 'var(--text-dim)' }}>
                      {format.hasVideo ? `${format.height || '?'}p` : 'audio'} · {format.filesize ? formatBytes(format.filesize) : format.filesizeApprox ? `~${formatBytes(format.filesizeApprox)}` : '--'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11.5px] font-semibold">{L(`任务队列 (${activeTasks.length})`, `Tasks (${activeTasks.length})`)}</span>
              {tasks.some((task) => task.status !== 'downloading' && task.status !== 'resolving') && (
                <button onClick={() => void window.vectrail.clearMediaImportTasks().then(setTasks)} className="vt-hover text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
                  {L('清理已完成', 'Clear finished')}
                </button>
              )}
            </div>
            {tasks.length === 0 ? (
              <div className="py-8 text-center text-[11px]" style={{ color: 'var(--text-faint)' }}>
                {L('下载完成后会自动通过 FFprobe 校验并导入素材库。', 'Completed downloads are verified with FFprobe and imported automatically.')}
              </div>
            ) : (
              tasks.map((task) => {
                const percentage = task.totalBytes ? Math.min(100, Math.round((task.downloadedBytes / task.totalBytes) * 100)) : task.status === 'done' ? 100 : 0;
                return (
                  <div key={task.id} className="p-2.5 rounded-lg space-y-1.5" style={{ background: 'var(--raised)', border: '1px solid var(--stroke)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11.5px] font-medium truncate">{task.title}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {['resolving', 'downloading', 'merging'].includes(task.status) && (
                          <button onClick={() => void window.vectrail.cancelMediaImportTask(task.id).then(setTasks)} className="vt-hover p-0.5 rounded" style={{ color: 'var(--text-dim)' }}>
                            <Square size={11} />
                          </button>
                        )}
                        {['failed', 'cancelled'].includes(task.status) && (
                          <button onClick={() => void window.vectrail.retryMediaImportTask(task.id).then(setTasks)} className="vt-hover p-0.5 rounded" style={{ color: 'var(--accent)' }}>
                            <RotateCcw size={12} />
                          </button>
                        )}
                        {task.status === 'done' && <CheckCircle2 size={13} style={{ color: '#30D158' }} />}
                        {task.status === 'failed' && <AlertCircle size={13} style={{ color: '#FF453A' }} />}
                      </div>
                    </div>
                    <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--well)' }}>
                      <div className="h-full transition-all" style={{ width: `${percentage}%`, background: task.status === 'failed' ? '#FF453A' : task.status === 'done' ? '#30D158' : 'var(--accent)' }} />
                    </div>
                    <div className="flex items-center justify-between text-[10px] mono-num" style={{ color: 'var(--text-faint)' }}>
                      <span>{formatBytes(task.downloadedBytes)} / {task.totalBytes ? formatBytes(task.totalBytes) : '--'} · {percentage}%</span>
                      <span>{task.status === 'downloading' ? `${formatBytes(task.speedBytesPerSec)}/s · ETA ${formatEta(task.etaSeconds)}` : task.status}</span>
                    </div>
                    {task.error && <div className="text-[10px]" style={{ color: '#FF453A' }}>{task.error}</div>}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
