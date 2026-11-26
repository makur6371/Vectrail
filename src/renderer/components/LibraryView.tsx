import React, { useMemo, useState } from 'react';
import { Captions, Film, Image as ImageIcon, Music, Plus, Search, Sparkles } from 'lucide-react';
import { MediaAsset, Transcript } from '../../shared/types';
import { formatTimecode } from '../../shared/project';

interface LibraryViewProps {
  assets: MediaAsset[];
  thumbs: Record<string, string[]>;
  sceneTags: Record<string, string[]>;
  transcripts: Record<string, Transcript>;
  fps: number;
  onImport: () => void;
  onAddAsset: (asset: MediaAsset) => void;
  onAutoEdit: () => void;
  onTranscribeAsset?: (assetID: string) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  assets,
  thumbs,
  sceneTags,
  transcripts,
  fps,
  onImport,
  onAddAsset,
  onAutoEdit,
  onTranscribeAsset,
}) => {
  const [query, setQuery] = useState('');
  const [hoverIdx, setHoverIdx] = useState<{ id: string; idx: number } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((a) => {
      const tags = (sceneTags[a.id] ?? []).join(' ').toLowerCase();
      const speech = (transcripts[a.id]?.words.map((w) => w.text).join(' ') ?? '').toLowerCase();
      return a.name.toLowerCase().includes(q) || a.kind.includes(q) || tags.includes(q) || speech.includes(q);
    });
  }, [assets, query, sceneTags, transcripts]);

  return (
    <div
      className="flex flex-col h-full shrink-0"
      style={{ width: 256, background: 'var(--panel)', borderRight: '1px solid var(--stroke)' }}
    >
      <div
        className="flex items-center justify-between px-3 h-9 shrink-0"
        style={{ borderBottom: '1px solid var(--stroke)' }}
      >
        <span className="text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-dim)' }}>
          MEDIA
        </span>
        <div className="flex items-center gap-1">
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

      <div className="px-2.5 py-2 shrink-0">
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
            const activeThumb =
              hoverIdx?.id === asset.id && strip.length > 0
                ? strip[Math.min(strip.length - 1, hoverIdx.idx)]
                : strip[0];
            return (
              <div
                key={asset.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-editroom-asset', asset.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="group rounded-md overflow-hidden cursor-pointer transition-colors"
                style={{
                  background: 'var(--raised)',
                  border: '1px solid var(--stroke)',
                }}
                onDoubleClick={() => onAddAsset(asset)}
                onMouseMove={(e) => {
                  if (strip.length <= 1) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const rel = Math.min(0.999, Math.max(0, (e.clientX - rect.left) / rect.width));
                  setHoverIdx({ id: asset.id, idx: Math.floor(rel * strip.length) });
                }}
                onMouseLeave={() => setHoverIdx(null)}
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
                  <span
                    className="mono-num absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px]"
                    style={{ background: 'rgba(0,0,0,0.75)', color: '#F2F2F0' }}
                  >
                    {formatTimecode(asset.duration, fps, true)}
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
                {(sceneTags[asset.id]?.length ?? 0) > 0 && (
                  <div className="px-2 pb-1.5 flex flex-wrap gap-1">
                    {sceneTags[asset.id].slice(0, 3).map((tag) => (
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
    </div>
  );
};
