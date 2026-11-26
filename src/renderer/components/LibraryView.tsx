import React, { useMemo, useState } from 'react';
import { Captions, Film, FolderOpen, Image as ImageIcon, Music, Plus, Search, Sparkles, Square, Type } from 'lucide-react';
import { MediaAsset, Transcript } from '../../shared/types';
import { formatTimecode } from '../../shared/project';

interface LibraryViewProps {
  assets: MediaAsset[];
  thumbs: Record<string, string[]>;
  sceneTags: Record<string, string[]>;
  transcripts: Record<string, Transcript>;
  fps: number;
  width?: number;
  activeSourceId?: string;
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
  const [query, setQuery] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [hoverScrub, setHoverScrub] = useState<{ id: string; idx: number; rel: number; time: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; asset: MediaAsset } | null>(null);

  const folders = useMemo(() => {
    const set = new Set<string>();
    assets.forEach((a) => {
      if (a.folder) set.add(a.folder);
    });
    return [...set].sort();
  }, [assets]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((a) => {
      if (activeFolder && a.folder !== activeFolder) return false;
      if (!q) return true;
      const tags = (sceneTags[a.id] ?? []).join(' ').toLowerCase();
      const speech = (transcripts[a.id]?.words.map((w) => w.text).join(' ') ?? '').toLowerCase();
      const folder = (a.folder ?? '').toLowerCase();
      return a.name.toLowerCase().includes(q) || a.kind.includes(q) || tags.includes(q) || speech.includes(q) || folder.includes(q);
    });
  }, [assets, query, activeFolder, sceneTags, transcripts]);

  return (
    <div
      data-magic-anchor="library"
      className="flex flex-col h-full shrink-0"
      style={{ width, background: 'var(--panel)' }}
    >
      <div
        className="flex items-center justify-between px-3 h-9 shrink-0"
        style={{ borderBottom: '1px solid var(--stroke)' }}
      >
        <span className="text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-dim)' }}>
          MEDIA
        </span>
        <div className="flex items-center gap-1">
          {onAddText && (
            <button
              onClick={onAddText}
              className="p-1 rounded hover:opacity-80"
              style={{ color: 'var(--text-dim)' }}
              title="Add Text at Playhead"
            >
              <Type size={13} strokeWidth={1.6} />
            </button>
          )}
          {onAddSolid && (
            <button
              onClick={onAddSolid}
              className="p-1 rounded hover:opacity-80"
              style={{ color: 'var(--text-dim)' }}
              title="Add Solid Color at Playhead"
            >
              <Square size={12} strokeWidth={1.6} />
            </button>
          )}
          {assets.length > 0 && (
            <button
              onClick={onAutoEdit}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px]"
              style={{ background: 'var(--button)', color: 'var(--text)' }}
              title="Auto Edit Montage"
            >
              <Sparkles size={10} style={{ color: 'var(--accent)' }} /> Auto
            </button>
          )}
          {onImportFolder && (
            <button
              onClick={onImportFolder}
              className="p-1 rounded hover:opacity-80"
              style={{ color: 'var(--text-dim)' }}
              title="Import Folder"
            >
              <FolderOpen size={13} strokeWidth={1.6} />
            </button>
          )}
          <button
            onClick={onImport}
            className="p-1 rounded"
            style={{ color: 'var(--text-dim)' }}
            title="Import Media (Ctrl+I)"
          >
            <Plus size={14} strokeWidth={1.6} />
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
            placeholder="Search media..."
            className="w-full bg-transparent outline-none text-[11px]"
            style={{ color: 'var(--text)' }}
          />
        </div>
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
              All
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
              No media imported
            </div>
            <div className="text-[10px] mt-1">Drop video, audio or images anywhere</div>
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
              </div>
            );
          })
        )}
      </div>

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
            { label: 'Add to Timeline', action: () => onAddAsset(contextMenu.asset) },
            ...(contextMenu.asset.width > 0 && contextMenu.asset.height > 0 && onMatchSequence
              ? [{ label: 'Match Sequence to Clip', action: () => onMatchSequence(contextMenu.asset) }]
              : []),
            ...((contextMenu.asset.kind === 'audio' || contextMenu.asset.hasAudio) && onTranscribeAsset
              ? [{ label: 'Transcribe Speech', action: () => onTranscribeAsset(contextMenu.asset.id) }]
              : []),
            ...(onShowInExplorer
              ? [{ label: 'Show in Explorer', action: () => onShowInExplorer(contextMenu.asset) }]
              : []),
            ...(onReloadAsset
              ? [{ label: 'Reload from Disk', action: () => onReloadAsset(contextMenu.asset.id) }]
              : []),
            ...(onDeleteAsset
              ? [{ label: 'Delete Item', danger: true, action: () => onDeleteAsset(contextMenu.asset.id) }]
              : []),
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => {
                item.action();
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:opacity-90"
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
