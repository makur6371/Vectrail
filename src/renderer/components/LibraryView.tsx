import React, { useMemo, useState } from 'react';
import {
  Captions,
  Film,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Music,
  Plus,
  Search,
  Sparkles,
  Square,
  Type,
  Wifi,
} from 'lucide-react';
import { MediaAsset, Transcript } from '../../shared/types';
import { formatTimecode } from '../../shared/project';
import { useI18n } from '../i18n';

interface LibraryViewProps {
  assets: MediaAsset[];
  thumbs: Record<string, string[]>;
  sceneTags: Record<string, string[]>;
  transcripts: Record<string, Transcript>;
  fps: number;
  width?: number;
  activeSourceId?: string;
  djiEnabled?: boolean;
  djiActiveDownloads?: number;
  onOpenDjiImport?: () => void;
  onImport: () => void;
  onImportFolder?: () => void;
  onAddAsset: (asset: MediaAsset) => void;
  onAddText?: () => void;
  onAddSolid?: () => void;
  onMatchSequence?: (asset: MediaAsset) => void;
  onShowInExplorer?: (asset: MediaAsset) => void;
  onReloadAsset?: (assetID: string) => void;
  onDeleteAsset?: (assetID: string) => void;
  onHoverPreview?: (preview: { asset: MediaAsset; time: number } | null) => void;
  onSelectSource?: (asset: MediaAsset) => void;
  onAutoEdit: () => void;
  onTranscribeAsset?: (assetID: string) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  assets,
  thumbs,
  sceneTags,
  transcripts,
  fps,
  width = 268,
  activeSourceId,
  djiEnabled = false,
  djiActiveDownloads = 0,
  onOpenDjiImport,
  onImport,
  onImportFolder,
  onAddAsset,
  onAddText,
  onAddSolid,
  onMatchSequence,
  onShowInExplorer,
  onReloadAsset,
  onDeleteAsset,
  onHoverPreview,
  onSelectSource,
  onAutoEdit,
  onTranscribeAsset,
}) => {
  const { L } = useI18n();
  const [query, setQuery] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem('vectrail.mediaLayout.v1') === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const [hoverScrub, setHoverScrub] = useState<{ id: string; idx: number; rel: number; time: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; asset: MediaAsset } | null>(null);
  const [panelMenu, setPanelMenu] = useState<{ x: number; y: number } | null>(null);

  const toggleViewMode = (mode: 'grid' | 'list') => {
    setViewMode(mode);
    try {
      localStorage.setItem('vectrail.mediaLayout.v1', mode);
    } catch {
      // ignore
    }
  };

  const folders = useMemo(() => {
    const set = new Set<string>();
    assets.forEach((a) => {
      if (a.folder) set.add(a.folder);
    });
    return [...set].sort();
  }, [assets]);

  const parsedQuery = useMemo(() => {
    const raw = query.trim();
    const phrases: string[] = [];
    const rest = raw
      .replace(/["“”]([^"“”]*)["“”]?/g, (_m, inner: string) => {
        const clean = inner.trim().toLowerCase();
        if (clean) phrases.push(clean);
        return ' ';
      })
      .trim()
      .toLowerCase();
    return { phrases, rest };
  }, [query]);

  const speechSnippetFor = (asset: MediaAsset): { before: string; match: string; after: string } | null => {
    const phrase = parsedQuery.phrases[0];
    if (!phrase) return null;
    const full = transcripts[asset.id]?.words.map((w) => w.text).join(' ') ?? '';
    if (!full) return null;
    const idx = full.toLowerCase().indexOf(phrase);
    if (idx === -1) return null;
    const start = Math.max(0, idx - 18);
    const end = Math.min(full.length, idx + phrase.length + 22);
    return {
      before: (start > 0 ? '…' : '') + full.slice(start, idx),
      match: full.slice(idx, idx + phrase.length),
      after: full.slice(idx + phrase.length, end) + (end < full.length ? '…' : ''),
    };
  };

  const filtered = useMemo(() => {
    const { phrases, rest } = parsedQuery;
    return assets.filter((a) => {
      if (activeFolder && a.folder !== activeFolder) return false;
      const speech = (transcripts[a.id]?.words.map((w) => w.text).join(' ') ?? '').toLowerCase();
      if (phrases.length && !phrases.every((ph) => speech.includes(ph))) return false;
      if (!rest) return true;
      const tags = (sceneTags[a.id] ?? []).join(' ').toLowerCase();
      const folder = (a.folder ?? '').toLowerCase();
      return a.name.toLowerCase().includes(rest) || a.kind.includes(rest) || tags.includes(rest) || speech.includes(rest) || folder.includes(rest);
    });
  }, [assets, parsedQuery, activeFolder, sceneTags, transcripts]);

  return (
    <div
      data-magic-anchor="library"
      className="flex flex-col h-full shrink-0 min-w-0 overflow-hidden"
      style={{ width, background: 'var(--panel)' }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('[data-magic-asset]')) return;
        e.preventDefault();
        setPanelMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div
        className="flex items-center justify-between px-3 h-9 shrink-0"
        style={{ borderBottom: '1px solid var(--stroke)' }}
      >
        <span className="text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-dim)' }}>
          {L('媒体库', 'MEDIA')}
        </span>
        <div className="flex items-center gap-1">
          {onAddText && (
            <button
              onClick={onAddText}
              className="p-1 rounded vt-hover transition-colors"
              style={{ color: 'var(--text-dim)' }}
              title={L('在播放头插入文字', 'Add Text at Playhead')}
            >
              <Type size={13} strokeWidth={1.6} />
            </button>
          )}
          {onAddSolid && (
            <button
              onClick={onAddSolid}
              className="p-1 rounded vt-hover transition-colors"
              style={{ color: 'var(--text-dim)' }}
              title={L('在播放头插入纯色', 'Add Solid Color at Playhead')}
            >
              <Square size={12} strokeWidth={1.6} />
            </button>
          )}
          {assets.length > 0 && (
            <button
              onClick={onAutoEdit}
              className="vt-btn inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors"
              style={{ background: 'var(--button)', color: 'var(--text)' }}
              title={L('智能一键剪辑', 'Auto Edit Montage')}
            >
              <Sparkles size={10} style={{ color: 'var(--accent)' }} /> {L('智能', 'Auto')}
            </button>
          )}
          {onImportFolder && (
            <button
              onClick={onImportFolder}
              className="p-1 rounded vt-hover transition-colors"
              style={{ color: 'var(--text-dim)' }}
              title={L('导入文件夹', 'Import Folder')}
            >
              <FolderOpen size={13} strokeWidth={1.6} />
            </button>
          )}
          {djiEnabled && onOpenDjiImport && (
            <button
              onClick={onOpenDjiImport}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium vt-hover transition-colors relative"
              style={{
                background: djiActiveDownloads > 0 ? 'rgba(255,74,28,0.14)' : 'var(--button)',
                color: djiActiveDownloads > 0 ? 'var(--accent)' : 'var(--text)',
              }}
              title={L('从 DJI 相机无线导入', 'Wireless Import from DJI Camera')}
            >
              <Wifi size={11} strokeWidth={1.7} style={{ color: 'var(--accent)' }} />
              <span>DJI</span>
              {djiActiveDownloads > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full animate-pulse"
                  style={{ background: 'var(--accent)' }}
                />
              )}
            </button>
          )}
          <button
            onClick={onImport}
            className="p-1 rounded vt-hover transition-colors"
            style={{ color: 'var(--text-dim)' }}
            title={L('导入媒体 (Ctrl+I)', 'Import Media (Ctrl+I)')}
          >
            <Plus size={14} strokeWidth={1.6} />
          </button>
          <button
            onClick={() => toggleViewMode(viewMode === 'grid' ? 'list' : 'grid')}
            className="p-1 rounded vt-hover transition-colors"
            style={{ color: 'var(--text-dim)' }}
            title={viewMode === 'grid' ? L('切换为列表视图', 'Switch to List view') : L('切换为网格视图', 'Switch to Grid view')}
          >
            {viewMode === 'grid' ? <List size={13} strokeWidth={1.6} /> : <LayoutGrid size={13} strokeWidth={1.6} />}
          </button>
        </div>
      </div>

      <div className="px-2.5 py-2 shrink-0 space-y-1.5">
        <div
          className="flex items-center gap-1.5 px-2 h-7 rounded"
          style={{ background: 'var(--field)', border: '1px solid var(--stroke)' }}
        >
          <Search size={12} style={{ color: 'var(--text-faint)' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={L('搜索素材、画面标签或台词...', 'Search media...')}
            className="w-full bg-transparent outline-none text-[11px]"
            style={{ color: 'var(--text)' }}
          />
        </div>
        {djiEnabled && djiActiveDownloads > 0 && onOpenDjiImport && (
          <button
            onClick={onOpenDjiImport}
            className="w-full flex items-center justify-between px-2 py-1 rounded text-[10px] font-medium"
            style={{ background: 'rgba(255,74,28,0.12)', color: 'var(--accent)', border: '1px solid rgba(255,74,28,0.35)' }}
          >
            <span>{L(`DJI 后台传输中 (${djiActiveDownloads})`, `DJI Downloading (${djiActiveDownloads})`)}</span>
            <span>{L('查看', 'View')}</span>
          </button>
        )}
        {folders.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setActiveFolder(null)}
              className="px-1.5 py-0.5 rounded text-[9px]"
              style={{
                background: activeFolder === null ? 'var(--accent)' : 'var(--button)',
                color: activeFolder === null ? '#FFF' : 'var(--text-dim)',
              }}
            >
              {L('全部', 'All')}
            </button>
            {folders.map((f) => (
              <button
                key={f}
                onClick={() => setActiveFolder(activeFolder === f ? null : f)}
                className="px-1.5 py-0.5 rounded text-[9px] truncate max-w-[110px]"
                style={{
                  background: activeFolder === f ? 'var(--accent)' : 'var(--button)',
                  color: activeFolder === f ? '#FFF' : 'var(--text-dim)',
                }}
                title={f}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-3 space-y-2">
        {filtered.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center text-center py-10 px-3 rounded-lg"
            style={{ border: '1px dashed var(--outline)', color: 'var(--text-faint)' }}
          >
            <Film size={20} strokeWidth={1.3} className="mb-2" />
            <div className="text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>
              {assets.length > 0 ? L('未找到匹配素材', 'No matching media') : L('尚未导入媒体', 'No media imported')}
            </div>
            <div className="text-[10px] mt-1">
              {assets.length > 0
                ? L('换个关键词或清除搜索框试试', 'Try another keyword or clear search')
                : L('将视频、音频或图片拖到此处导入', 'Drop video, audio or images anywhere')}
            </div>
            {assets.length === 0 && djiEnabled && onOpenDjiImport && (
              <button
                onClick={onOpenDjiImport}
                className="vt-btn mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10.5px] font-medium"
                style={{ background: 'var(--button)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
              >
                <Wifi size={11} style={{ color: 'var(--accent)' }} />
                {L('从 DJI 相机导入', 'Import from DJI')}
              </button>
            )}
          </div>
        ) : (
          filtered.map((asset) => {
            const strip = thumbs[asset.id] ?? [];
            const isHovered = hoverScrub?.id === asset.id;
            const isSourceSelected = activeSourceId === asset.id;
            const activeThumb =
              isHovered && strip.length > 0
                ? strip[Math.min(strip.length - 1, hoverScrub.idx)]
                : strip[0];
            const snippet = speechSnippetFor(asset);
            if (viewMode === 'list') {
              return (
                <div
                  key={asset.id}
                  data-magic-asset={asset.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-vectrail-asset', asset.id);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  className="group flex items-center gap-2 p-1.5 rounded-md cursor-pointer transition-colors"
                  style={{
                    background: 'var(--raised)',
                    border: `1px solid ${isSourceSelected ? 'var(--accent)' : 'var(--stroke)'}`,
                  }}
                  onClick={() => {
                    setContextMenu(null);
                    setPanelMenu(null);
                    if (asset.kind === 'video' || asset.kind === 'image') onSelectSource?.(asset);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setPanelMenu(null);
                    setContextMenu({ x: e.clientX, y: e.clientY, asset });
                  }}
                  onDoubleClick={() => onAddAsset(asset)}
                >
                  <div
                    className="w-16 h-10 rounded overflow-hidden shrink-0 flex items-center justify-center relative"
                    style={{ background: '#0B0B0B' }}
                  >
                    {activeThumb ? (
                      <img src={activeThumb} alt={asset.name} className="w-full h-full object-cover" />
                    ) : asset.kind === 'audio' ? (
                      <Music size={16} style={{ color: 'var(--text-faint)' }} />
                    ) : (
                      <ImageIcon size={16} style={{ color: 'var(--text-faint)' }} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium" style={{ color: 'var(--text)' }}>
                      {asset.name}
                    </div>
                    <div className="mono-num text-[9.5px] truncate" style={{ color: 'var(--text-faint)' }}>
                      {formatTimecode(asset.duration, fps, true)} · {asset.kind === 'video' ? `${asset.width}x${asset.height}` : asset.kind.toUpperCase()}
                    </div>
                    {snippet && (
                      <div className="truncate text-[9.5px] mt-0.5" style={{ color: 'var(--text-dim)' }}>
                        {snippet.before}
                        <span className="font-semibold" style={{ color: 'var(--accent)' }}>
                          {snippet.match}
                        </span>
                        {snippet.after}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddAsset(asset);
                    }}
                    className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                    style={{ background: 'var(--accent)', color: '#FFFFFF' }}
                    title={L('添加到时间线', 'Add to timeline')}
                  >
                    +
                  </button>
                </div>
              );
            }
            return (
              <div
                key={asset.id}
                data-magic-asset={asset.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-vectrail-asset', asset.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="group rounded-md overflow-hidden cursor-pointer transition-colors"
                style={{
                  background: 'var(--raised)',
                  border: `1px solid ${isSourceSelected ? 'var(--accent)' : 'var(--stroke)'}`,
                }}
                onClick={() => {
                  setContextMenu(null);
                  if (asset.kind === 'video' || asset.kind === 'image') onSelectSource?.(asset);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, asset });
                }}
                onDoubleClick={() => onAddAsset(asset)}
                onMouseMove={(e) => {
                  if (asset.kind !== 'video') {
                    if (asset.kind === 'image') onHoverPreview?.({ asset, time: 0 });
                    return;
                  }
                  const rect = e.currentTarget.getBoundingClientRect();
                  const rel = Math.min(0.999, Math.max(0, (e.clientX - rect.left) / rect.width));
                  const time = rel * Math.max(0.05, asset.duration);
                  const idx = strip.length > 0 ? Math.floor(rel * strip.length) : 0;
                  setHoverScrub({ id: asset.id, idx, rel, time });
                  onHoverPreview?.({ asset, time });
                }}
                onMouseLeave={() => {
                  setHoverScrub(null);
                  onHoverPreview?.(null);
                }}
              >
                <div
                  className="relative h-20 flex items-center justify-center overflow-hidden"
                  style={{ background: '#0B0B0B' }}
                >
                  {activeThumb ? (
                    <img src={activeThumb} alt={asset.name} className="w-full h-full object-cover" />
                  ) : asset.kind === 'audio' ? (
                    <Music size={22} strokeWidth={1.3} style={{ color: 'var(--text-faint)' }} />
                  ) : (
                    <ImageIcon size={22} strokeWidth={1.3} style={{ color: 'var(--text-faint)' }} />
                  )}
                  {isHovered && asset.kind === 'video' && (
                    <>
                      <div
                        className="absolute top-0 bottom-0 w-0.5 pointer-events-none"
                        style={{ left: `${hoverScrub.rel * 100}%`, background: 'var(--accent)' }}
                      />
                      <div
                        className="absolute bottom-0 left-0 right-0 h-0.5 pointer-events-none"
                        style={{ background: 'rgba(255,255,255,0.18)' }}
                      >
                        <div
                          className="h-full"
                          style={{ width: `${hoverScrub.rel * 100}%`, background: 'var(--accent)' }}
                        />
                      </div>
                    </>
                  )}
                  <span
                    className="mono-num absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px]"
                    style={{ background: 'rgba(0,0,0,0.75)', color: '#F2F2F0' }}
                  >
                    {isHovered && asset.kind === 'video'
                      ? formatTimecode(hoverScrub.time, fps, true)
                      : formatTimecode(asset.duration, fps, true)}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddAsset(asset);
                    }}
                    className="opacity-0 group-hover:opacity-100 absolute top-1.5 right-1.5 px-2 py-0.5 rounded text-[10px] font-medium transition-opacity"
                    style={{ background: 'var(--accent)', color: '#FFFFFF' }}
                    title="Add to timeline"
                  >
                    + Add
                  </button>
                  {(asset.kind === 'audio' || asset.hasAudio) && onTranscribeAsset && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onTranscribeAsset(asset.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 absolute top-1.5 left-1.5 p-1 rounded transition-opacity"
                      style={{
                        background: transcripts[asset.id] ? 'rgba(48, 209, 88, 0.85)' : 'rgba(0,0,0,0.75)',
                        color: '#FFFFFF',
                      }}
                      title={transcripts[asset.id] ? 'Transcribed' : 'Transcribe speech (Whisper)'}
                    >
                      <Captions size={11} />
                    </button>
                  )}
                </div>
                <div className="px-2 py-1.5 flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-medium" style={{ color: 'var(--text)' }}>
                    {asset.name}
                  </span>
                  <span className="text-[10px] shrink-0 uppercase" style={{ color: 'var(--text-faint)' }}>
                    {asset.kind === 'video' ? `${asset.width}x${asset.height}` : asset.kind}
                  </span>
                </div>
                {(asset.folder || (sceneTags[asset.id]?.length ?? 0) > 0) && (
                  <div className="px-2 pb-1.5 flex flex-wrap gap-1">
                    {asset.folder && (
                      <span
                        className="px-1.5 py-0.2 rounded text-[9px]"
                        style={{ background: 'var(--button)', color: 'var(--accent)' }}
                      >
                        {asset.folder}
                      </span>
                    )}
                    {(sceneTags[asset.id] ?? []).slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="px-1.5 py-0.2 rounded text-[9px]"
                        style={{ background: 'var(--field)', color: 'var(--text-dim)' }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {snippet && (
                  <div
                    className="px-2 pb-1.5 text-[10px] truncate"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    {snippet.before}
                    <span className="font-semibold" style={{ color: 'var(--accent)' }}>
                      {snippet.match}
                    </span>
                    {snippet.after}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {panelMenu && (
        <div
          className="fixed z-50 w-44 rounded-lg py-1 shadow-2xl text-[11px]"
          style={{
            left: Math.min(window.innerWidth - 190, panelMenu.x),
            top: Math.min(window.innerHeight - 200, panelMenu.y),
            background: 'var(--sheet)',
            border: '1px solid var(--sheet-field-stroke)',
          }}
          onMouseLeave={() => setPanelMenu(null)}
        >
          {[
            ...(onAddText ? [{ label: L('在播放头插入文字', 'Add Text at Playhead'), action: onAddText }] : []),
            ...(onAddSolid ? [{ label: L('在播放头插入纯色', 'Add Solid at Playhead'), action: onAddSolid }] : []),
            { label: L('导入媒体...', 'Import Media...'), action: onImport },
            ...(onImportFolder ? [{ label: L('导入文件夹...', 'Import Folder...'), action: onImportFolder }] : []),
            {
              label: viewMode === 'grid' ? L('切换列表视图', 'View as List') : L('切换缩略图视图', 'View as Thumbnails'),
              action: () => toggleViewMode(viewMode === 'grid' ? 'list' : 'grid'),
            },
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => {
                setPanelMenu(null);
                item.action();
              }}
              className="w-full text-left px-3 py-1.5 vt-hover"
              style={{ color: 'var(--text)' }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {contextMenu && (
        <div
          className="fixed z-50 w-44 rounded-lg py-1 shadow-2xl text-[11px]"
          style={{
            left: Math.min(window.innerWidth - 190, contextMenu.x),
            top: Math.min(window.innerHeight - 240, contextMenu.y),
            background: 'var(--sheet)',
            border: '1px solid var(--sheet-field-stroke)',
          }}
          onMouseLeave={() => setContextMenu(null)}
        >
          {[
            { label: L('添加到时间线', 'Add to Timeline'), action: () => onAddAsset(contextMenu.asset) },
            ...(contextMenu.asset.width > 0 && contextMenu.asset.height > 0 && onMatchSequence
              ? [{ label: L('按此素材匹配序列参数', 'Match Sequence to Clip'), action: () => onMatchSequence(contextMenu.asset) }]
              : []),
            ...((contextMenu.asset.kind === 'audio' || contextMenu.asset.hasAudio) && onTranscribeAsset
              ? [{ label: L('语音转写字幕', 'Transcribe Speech'), action: () => onTranscribeAsset(contextMenu.asset.id) }]
              : []),
            ...(onShowInExplorer
              ? [{ label: L('在资源管理器中显示', 'Show in Explorer'), action: () => onShowInExplorer(contextMenu.asset) }]
              : []),
            ...(onReloadAsset
              ? [{ label: L('从磁盘重新加载', 'Reload from Disk'), action: () => onReloadAsset(contextMenu.asset.id) }]
              : []),
            ...(onDeleteAsset
              ? [{ label: L('移除素材', 'Delete Item'), danger: true, action: () => onDeleteAsset(contextMenu.asset.id) }]
              : []),
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => {
                item.action();
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 vt-hover"
              style={{ color: item.danger ? '#FF453A' : 'var(--text)' }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
