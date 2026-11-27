import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Blocks,
  Bookmark,
  CheckCircle2,
  Mic,
  Search,
  Smartphone,
  Sparkles,
  User,
  Wifi,
  Workflow,
  X,
} from 'lucide-react';
import type { PluginSummary } from '../../shared/djiTypes';
import {
  MARKETPLACE_CATEGORIES,
  MarketplacePluginEntry,
  PLUGIN_MARKETPLACE_CATALOG,
  PluginMarketplaceCategory,
  filterMarketplacePlugins,
} from '../../shared/pluginMarketplace';
import { useI18n } from '../i18n';

const WISHLIST_STORAGE_KEY = 'vectrail.marketplace.wishlist.v1';

function loadWishlist(): string[] {
  try {
    const raw = localStorage.getItem(WISHLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveWishlist(ids: string[]): void {
  try {
    localStorage.setItem(WISHLIST_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // ignore localStorage write errors
  }
}

function iconForEntry(entry: MarketplacePluginEntry): React.ReactNode {
  if (entry.id === 'dji-wireless-import') return <Wifi size={16} style={{ color: 'var(--accent)' }} />;
  if (entry.category === 'device_import') return <Smartphone size={16} style={{ color: 'var(--text-dim)' }} />;
  if (entry.category === 'editing_templates') return <Sparkles size={16} style={{ color: 'var(--accent)' }} />;
  if (entry.category === 'ai_avatar') return <User size={16} style={{ color: 'var(--text-dim)' }} />;
  if (entry.category === 'audio_voice') return <Mic size={16} style={{ color: 'var(--text-dim)' }} />;
  return <Workflow size={16} style={{ color: 'var(--text-dim)' }} />;
}

interface PluginMarketplaceModalProps {
  plugins: PluginSummary[];
  onTogglePlugin: (pluginId: string, enabled: boolean) => Promise<void>;
  onOpenDjiImport: () => void;
  onOpenTemplates: () => void;
  onClose: () => void;
}

export const PluginMarketplaceModal: React.FC<PluginMarketplaceModalProps> = ({
  plugins,
  onTogglePlugin,
  onOpenDjiImport,
  onOpenTemplates,
  onClose,
}) => {
  const { locale, L } = useI18n();
  const [category, setCategory] = useState<PluginMarketplaceCategory>('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [wishlist, setWishlist] = useState<string[]>(loadWishlist);

  const runtimeMap = useMemo(() => {
    const map = new Map<string, PluginSummary>();
    for (const p of plugins) map.set(p.id, p);
    return map;
  }, [plugins]);

  const filtered = useMemo(
    () => filterMarketplacePlugins(PLUGIN_MARKETPLACE_CATALOG, category, query),
    [category, query]
  );

  const installedCount = PLUGIN_MARKETPLACE_CATALOG.filter((p) => p.status !== 'coming_soon').length;
  const roadmapCount = PLUGIN_MARKETPLACE_CATALOG.filter((p) => p.status === 'coming_soon').length;

  const toggleWishlist = (id: string) => {
    setWishlist((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      saveWishlist(next);
      return next;
    });
  };

  const handleToggleRuntime = async (runtimeId: string, nextEnabled: boolean) => {
    setBusyId(runtimeId);
    try {
      await onTogglePlugin(runtimeId, nextEnabled);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div
        className="w-[860px] max-w-[calc(100vw-32px)] h-[84vh] max-h-[740px] flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div
          className="flex items-center justify-between px-4 h-12 shrink-0"
          style={{ background: 'var(--panel)', borderBottom: '1px solid var(--stroke)' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Blocks size={16} style={{ color: 'var(--accent)' }} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold truncate">
                  {L('Vectrail 插件市场', 'Vectrail Extension Marketplace')}
                </span>
                <span
                  className="px-1.5 py-0.5 rounded text-[9.5px] mono-num"
                  style={{ background: 'var(--button)', color: 'var(--text-dim)' }}
                >
                  v{__VECTRAIL_VERSION__}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
              {L(`已就绪 ${installedCount} · 规划中 ${roadmapCount}`, `${installedCount} Ready · ${roadmapCount} Roadmap`)}
            </span>
            <button
              onClick={onClose}
              className="vt-hover p-1 rounded"
              style={{ color: 'var(--text-dim)' }}
              title={L('关闭 (Esc)', 'Close (Esc)')}
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div
          className="px-4 py-2.5 space-y-2.5 shrink-0"
          style={{ background: 'var(--panel)', borderBottom: '1px solid var(--stroke)' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              {MARKETPLACE_CATEGORIES.map((cat) => {
                const active = category === cat.id;
                return (
                  <button
                    key={cat.id}
                    onClick={() => setCategory(cat.id)}
                    className="px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors"
                    style={{
                      background: active ? 'var(--accent)' : 'var(--button)',
                      color: active ? '#FFF' : 'var(--text-dim)',
                    }}
                  >
                    {locale === 'zh' ? cat.labelZh : cat.label}
                  </button>
                );
              })}
            </div>
            <div
              className="flex items-center gap-1.5 px-2.5 h-7 rounded-md w-60 max-w-full"
              style={{ background: 'var(--field)', border: '1px solid var(--stroke)' }}
            >
              <Search size={12} style={{ color: 'var(--text-faint)' }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={L('搜索插件：DJI、iPhone、数字人...', 'Search plugins: DJI, iPhone, avatar...')}
                className="w-full bg-transparent outline-none text-[11px]"
                style={{ color: 'var(--text)' }}
              />
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {filtered.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-14 rounded-lg text-center"
              style={{ border: '1px dashed var(--outline)', color: 'var(--text-faint)' }}
            >
              <Blocks size={22} className="mb-2 opacity-60" />
              <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {L('没有匹配的插件', 'No matching extensions')}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filtered.map((item) => {
                const runtime = item.runtimePluginId ? runtimeMap.get(item.runtimePluginId) : undefined;
                const isEnabled = runtime ? runtime.enabled : item.status !== 'coming_soon';
                const isHealthy = runtime ? runtime.healthy : true;
                const isComingSoon = item.status === 'coming_soon';
                const wished = wishlist.includes(item.id);

                return (
                  <div
                    key={item.id}
                    className="flex flex-col justify-between gap-3 p-3.5 rounded-xl"
                    style={{
                      background: 'var(--sheet-field)',
                      border: `1px solid ${isComingSoon ? 'var(--stroke)' : 'var(--sheet-field-stroke)'}`,
                    }}
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                            style={{ background: 'var(--panel)', border: '1px solid var(--stroke)' }}
                          >
                            {iconForEntry(item)}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[12.5px] font-semibold truncate">
                                {locale === 'zh' ? item.nameZh : item.name}
                              </span>
                              <span
                                className="px-1.5 py-0.2 rounded text-[9.5px] mono-num"
                                style={{ background: 'var(--button)', color: 'var(--text-dim)' }}
                              >
                                {isComingSoon ? L('规划中', 'Roadmap') : `v${runtime?.version ?? item.version}`}
                              </span>
                            </div>
                            <div className="text-[10px] truncate" style={{ color: 'var(--text-faint)' }}>
                              {item.author}
                            </div>
                          </div>
                        </div>

                        {runtime ? (
                          <label className="inline-flex items-center gap-1.5 text-[10.5px] cursor-pointer shrink-0">
                            <input
                              type="checkbox"
                              checked={runtime.enabled}
                              disabled={busyId === runtime.id}
                              onChange={(e) => void handleToggleRuntime(runtime.id, e.target.checked)}
                            />
                            <span style={{ color: runtime.enabled ? '#30D158' : 'var(--text-faint)' }}>
                              {runtime.enabled ? L('已启用', 'On') : L('已停用', 'Off')}
                            </span>
                          </label>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9.5px] font-medium shrink-0"
                            style={{
                              background: isComingSoon ? 'var(--field)' : 'rgba(48,209,88,0.14)',
                              color: isComingSoon ? 'var(--text-dim)' : '#30D158',
                            }}
                          >
                            {!isComingSoon && <CheckCircle2 size={10} />}
                            {isComingSoon ? L('即将推出', 'Coming Soon') : L('内置可用', 'Built-in')}
                          </span>
                        )}
                      </div>

                      <div className="text-[11px] font-medium" style={{ color: 'var(--text)' }}>
                        {locale === 'zh' ? item.taglineZh : item.tagline}
                      </div>
                      <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                        {locale === 'zh' ? item.descriptionZh : item.description}
                      </div>

                      <ul className="space-y-1 pt-0.5">
                        {(locale === 'zh' ? item.capabilitiesZh : item.capabilities).map((cap) => (
                          <li key={cap} className="flex items-start gap-1.5 text-[10px]" style={{ color: 'var(--text-faint)' }}>
                            <span style={{ color: 'var(--accent)' }}>•</span>
                            <span>{cap}</span>
                          </li>
                        ))}
                      </ul>

                      {runtime && !isHealthy && runtime.error && (
                        <div
                          className="flex items-start gap-1.5 px-2 py-1.5 rounded text-[10px]"
                          style={{ background: 'rgba(255,69,58,0.12)', color: '#FF6961' }}
                        >
                          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                          <span>{runtime.error}</span>
                        </div>
                      )}
                    </div>

                    <div
                      className="flex items-center justify-between gap-2 pt-2"
                      style={{ borderTop: '1px solid var(--stroke)' }}
                    >
                      <div className="flex flex-wrap gap-1">
                        {item.tags.map((tag) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 rounded text-[9px]"
                            style={{ background: 'var(--panel)', color: 'var(--text-faint)' }}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>

                      {item.actionType === 'open_dji' && (
                        <button
                          disabled={!isEnabled}
                          onClick={() => {
                            onClose();
                            onOpenDjiImport();
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10.5px] font-semibold shrink-0 disabled:opacity-45"
                          style={{ background: 'var(--accent)', color: '#FFF' }}
                        >
                          <span>{L('打开导入', 'Open DJI')}</span>
                          <ArrowUpRight size={11} />
                        </button>
                      )}
                      {item.actionType === 'open_templates' && (
                        <button
                          onClick={() => {
                            onClose();
                            onOpenTemplates();
                          }}
                          className="vt-btn inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10.5px] font-semibold shrink-0"
                          style={{ background: 'var(--text)', color: 'var(--on-text)' }}
                        >
                          <span>{L('打开模板库', 'Open Templates')}</span>
                          <ArrowUpRight size={11} />
                        </button>
                      )}
                      {item.actionType === 'roadmap' && (
                        <button
                          onClick={() => toggleWishlist(item.id)}
                          className="vt-btn inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10px] shrink-0"
                          style={{
                            background: wished ? 'rgba(255,74,28,0.14)' : 'var(--button)',
                            color: wished ? 'var(--accent)' : 'var(--text-dim)',
                            border: `1px solid ${wished ? 'rgba(255,74,28,0.35)' : 'var(--stroke)'}`,
                          }}
                        >
                          <Bookmark size={10} fill={wished ? 'var(--accent)' : 'none'} />
                          <span>{wished ? L('已关注', 'Saved') : L('加入关注', 'Track')}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
