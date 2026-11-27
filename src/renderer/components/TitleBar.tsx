import React, { useState } from 'react';
import {
  AlertTriangle,
  Blocks,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  FolderOpen,
  Languages,
  Loader2,
  Minus,
  Moon,
  Plus,
  Redo2,
  Save,
  Settings,
  Sparkles,
  Square,
  Sun,
  Undo2,
  X,
} from 'lucide-react';
import { ExportJobInfo, MagicBackend, MagicStage } from '../../shared/types';
import { useI18n } from '../i18n';

interface TitleBarProps {
  title: string;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  exportsList: ExportJobInfo[];
  mcpRunning: boolean;
  isLightTheme?: boolean;
  magicOpen?: boolean;
  magicBackend?: MagicBackend;
  magicStatus?: { worker: string; stage: MagicStage; status?: string } | null;
  recentProjects?: string[];
  onNew: () => void;
  onOpen: () => void;
  onOpenRecent?: (filePath: string) => void;
  onClearRecents?: () => void;
  onSave: () => void;
  onImport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenMagic: () => void;
  onStopMagic?: () => void;
  onOpenExport: () => void;
  onOpenSettings: () => void;
  onOpenMarketplace?: () => void;
  onToggleLightDark?: () => void;
  onCancelExport: (id: string) => void;
  onShowExportInExplorer?: (file: string) => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  title,
  isDirty,
  canUndo,
  canRedo,
  exportsList,
  mcpRunning,
  isLightTheme = false,
  magicOpen = false,
  magicBackend = 'local',
  magicStatus = null,
  recentProjects = [],
  onNew,
  onOpen,
  onOpenRecent,
  onClearRecents,
  onSave,
  onImport,
  onUndo,
  onRedo,
  onOpenMagic,
  onStopMagic,
  onOpenExport,
  onOpenSettings,
  onOpenMarketplace,
  onToggleLightDark,
  onCancelExport,
  onShowExportInExplorer,
}) => {
  const { locale, toggleLocale, L } = useI18n();
  const [exportsOpen, setExportsOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [dismissedFinished, setDismissedFinished] = useState(false);
  const activeExport = exportsList.find((j) => j.status === 'running');
  const waitingCount = exportsList.filter((j) => j.status === 'waiting').length;
  const hasFailed = exportsList.some((j) => j.status === 'failed');
  const hasDone = exportsList.some((j) => j.status === 'done');
  const visibleExports = activeExport || (!dismissedFinished && (hasFailed || hasDone));

  const magicActivityText = (() => {
    if (!magicStatus) return '';
    const raw =
      magicStatus.stage === 'editing'
        ? L('正在剪辑', 'Editing')
        : magicStatus.status?.trim() ||
          magicStatus.stage.charAt(0).toUpperCase() + magicStatus.stage.slice(1);
    return raw.length > 38 ? `${raw.slice(0, 37)}…` : raw;
  })();
  const magicModeMeta = (() => {
    switch (magicBackend) {
      case 'claude':
        return { label: 'Claude', dot: '#D97757' };
      case 'codex':
        return { label: 'Codex', dot: '#10A37F' };
      case 'cloud':
        return { label: L('云端 AI', 'Cloud AI'), dot: '#FF6B35' };
      default:
        return { label: L('本地', 'Local'), dot: 'var(--text)' };
    }
  })();
  const btnClass =
    'titlebar-nodrag vt-hover inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors';

  return (
    <div
      className="titlebar-drag grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 h-10 shrink-0"
      style={{
        background: 'var(--panel)',
        borderBottom: '1px solid var(--stroke)',
      }}
    >
      <div className="flex items-center gap-1.5 min-w-0 justify-self-start whitespace-nowrap">
        <span
          className="text-[12px] font-semibold tracking-tight mr-1.5 flex items-center gap-1.5 shrink-0"
          style={{ color: 'var(--text)' }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 1024 1024"
            fill="none"
            aria-label="Vectrail"
            className="shrink-0"
          >
            <path
              d="M 154 308 L 368 308 Q 390 308 403 330 L 488 477 Q 498 494 498 512 L 498 742 Q 498 764 476 764 L 446 764 Q 426 764 411 748 L 149 479 Q 128 458 128 432 L 128 335 Q 128 308 154 308 Z"
              fill="var(--accent)"
            />
            <path
              transform="translate(1024 0) scale(-1 1)"
              d="M 154 308 L 368 308 Q 390 308 403 330 L 488 477 Q 498 494 498 512 L 498 742 Q 498 764 476 764 L 446 764 Q 426 764 411 748 L 149 479 Q 128 458 128 432 L 128 335 Q 128 308 154 308 Z"
              fill="var(--accent)"
            />
          </svg>
          Vectrail
        </span>
        <button
          className={btnClass}
          style={{ background: 'transparent', color: 'var(--text-dim)' }}
          onClick={onNew}
          title={L('新建项目', 'New Project')}
        >
          {L('新建', 'New')}
        </button>
        <div className="relative titlebar-nodrag flex items-center">
          <button
            className={btnClass}
            style={{ background: 'transparent', color: 'var(--text-dim)' }}
            onClick={onOpen}
            title={L('打开项目', 'Open Project')}
          >
            <FolderOpen size={13} strokeWidth={1.5} /> {L('打开', 'Open')}
          </button>
          {recentProjects.length > 0 && onOpenRecent && (
            <button
              className="p-1 rounded vt-hover"
              style={{ color: 'var(--text-faint)' }}
              onClick={() => setRecentsOpen((v) => !v)}
              title={L('最近项目', 'Recent Projects')}
            >
              <ChevronDown size={11} />
            </button>
          )}
          {recentsOpen && recentProjects.length > 0 && (
            <div
              className="absolute left-0 top-8 z-50 w-60 rounded-lg py-1 shadow-2xl text-[11px]"
              style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
              onMouseLeave={() => setRecentsOpen(false)}
            >
              <div className="px-3 py-1 text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                {L('最近打开', 'Open Recent')}
              </div>
              {recentProjects.map((fp) => {
                const name = fp.split(/[\\/]/).pop() || fp;
                return (
                  <button
                    key={fp}
                    onClick={() => {
                      setRecentsOpen(false);
                      onOpenRecent?.(fp);
                    }}
                    className="w-full text-left px-3 py-1.5 truncate vt-hover"
                    style={{ color: 'var(--text)' }}
                    title={fp}
                  >
                    {name}
                  </button>
                );
              })}
              {onClearRecents && (
                <button
                  onClick={() => {
                    setRecentsOpen(false);
                    onClearRecents();
                  }}
                  className="w-full text-left px-3 py-1.5 text-[10.5px] vt-hover"
                  style={{ color: 'var(--text-dim)', borderTop: '1px solid var(--stroke)' }}
                >
                  {L('清空历史', 'Clear Menu')}
                </button>
              )}
            </div>
          )}
        </div>
        <button
          className={btnClass}
          style={{ background: 'transparent', color: 'var(--text-dim)' }}
          onClick={onSave}
          title={L('保存项目 (Ctrl+S)', 'Save Project (Ctrl+S)')}
        >
          <Save size={13} strokeWidth={1.5} /> {L('保存', 'Save')}
        </button>
        <button
          className="titlebar-nodrag vt-btn inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors"
          style={{ background: 'var(--button)', color: 'var(--text)' }}
          onClick={onImport}
          title={L('导入媒体 (Ctrl+I)', 'Import Media (Ctrl+I)')}
        >
          <Plus size={13} strokeWidth={1.6} /> {L('导入', 'Import')}
        </button>
        <div className="h-3.5 w-px mx-1" style={{ background: 'var(--stroke)' }} />
        <button
          className={btnClass}
          style={{ color: canUndo ? 'var(--text)' : 'var(--text-faint)' }}
          disabled={!canUndo}
          onClick={onUndo}
          title={L('撤销 (Ctrl+Z)', 'Undo (Ctrl+Z)')}
        >
          <Undo2 size={13} strokeWidth={1.5} />
        </button>
        <button
          className={btnClass}
          style={{ color: canRedo ? 'var(--text)' : 'var(--text-faint)' }}
          disabled={!canRedo}
          onClick={onRedo}
          title={L('重做 (Ctrl+Shift+Z)', 'Redo (Ctrl+Shift+Z)')}
        >
          <Redo2 size={13} strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex items-center justify-center gap-1.5 text-[12px] font-medium justify-self-center min-w-0 max-w-[260px]" style={{ color: 'var(--text-dim)' }}>
        <span className="truncate">{title}</span>
        {isDirty && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: 'var(--text-faint)' }}
          />
        )}
      </div>

      <div className="flex items-center gap-1.5 justify-self-end whitespace-nowrap shrink-0">
        {visibleExports && (
          <div className="relative titlebar-nodrag">
            <button
              onClick={() => setExportsOpen((v) => !v)}
              className="flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] transition-colors"
              style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
              title={L('导出任务', 'Exports')}
            >
              {activeExport ? (
                <>
                  <span className="w-16 h-1 rounded-full overflow-hidden" style={{ background: 'var(--well)' }}>
                    <span
                      className="block h-full rounded-full transition-all"
                      style={{ width: `${Math.max(6, Math.round(activeExport.progress * 100))}%`, background: 'var(--accent)' }}
                    />
                  </span>
                  <span className="mono-num text-[10px]">{Math.round(activeExport.progress * 100)}%</span>
                </>
              ) : hasFailed ? (
                <>
                  <AlertTriangle size={12} style={{ color: '#FF7A6B' }} />
                  <span>{L('导出失败', 'Export failed')}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={12} style={{ color: '#3DDC97' }} />
                  <span>{L('已导出', 'Exported')}</span>
                </>
              )}
              {waitingCount > 0 && (
                <span className="mono-num text-[10px]" style={{ color: 'var(--text-dim)' }}>
                  +{waitingCount}
                </span>
              )}
            </button>

            {exportsOpen && (
              <div
                className="absolute right-0 top-9 z-50 w-72 rounded-xl shadow-2xl overflow-hidden"
                style={{ background: 'var(--panel)', border: '1px solid var(--stroke)' }}
              >
                <div className="max-h-60 overflow-y-auto divide-y" style={{ borderColor: 'var(--stroke)' }}>
                  {exportsList.map((item) => (
                    <div key={item.id} className="flex items-center gap-2.5 px-3 py-2 text-[11px]">
                      {item.status === 'running' ? (
                        <Loader2 size={13} className="animate-spin shrink-0" style={{ color: 'var(--accent)' }} />
                      ) : item.status === 'waiting' ? (
                        <Clock size={13} className="shrink-0" style={{ color: 'var(--text-dim)' }} />
                      ) : item.status === 'done' ? (
                        <CheckCircle2 size={13} className="shrink-0" style={{ color: '#3DDC97' }} />
                      ) : (
                        <AlertTriangle size={13} className="shrink-0" style={{ color: '#FF7A6B' }} />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium" style={{ color: 'var(--text)' }}>
                          {item.file.split(/[\\/]/).pop() || item.file}
                        </div>
                        <div className="text-[10px] truncate" style={{ color: 'var(--text-faint)' }}>
                          {item.status === 'running'
                            ? `${item.sizeLabel} · ${Math.round(item.progress * 100)}%`
                            : item.status === 'failed'
                            ? item.error || L('失败', 'Failed')
                            : `${item.sizeLabel} · ${item.status}`}
                        </div>
                      </div>
                      {(item.status === 'running' || item.status === 'waiting') && (
                        <button
                          onClick={() => onCancelExport(item.id)}
                          className="p-1 rounded hover:opacity-80"
                          style={{ color: 'var(--text-dim)' }}
                          title={L('取消', 'Cancel')}
                        >
                          <X size={12} />
                        </button>
                      )}
                      {item.status === 'done' && onShowExportInExplorer && (
                        <button
                          onClick={() => onShowExportInExplorer(item.file)}
                          className="p-1 rounded hover:opacity-80"
                          style={{ color: 'var(--text-dim)' }}
                          title={L('在资源管理器中显示', 'Show in Explorer')}
                        >
                          <FolderOpen size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {!activeExport && (
                  <div className="px-3 py-1.5 flex justify-end" style={{ borderTop: '1px solid var(--stroke)' }}>
                    <button
                      onClick={() => {
                        setDismissedFinished(true);
                        setExportsOpen(false);
                      }}
                      className="text-[10px] hover:underline"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      {L('清除', 'Dismiss')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {magicStatus && (
          <div className="titlebar-nodrag inline-flex items-center gap-1">
            {magicActivityText && (
              <button
                onClick={onOpenMagic}
                className="text-[11px] font-medium px-1.5 truncate max-w-[180px] hover:underline"
                style={{ color: 'var(--text-dim)' }}
                title={L('打开操作面板查看实时过程', 'Open Magic operation panel')}
              >
                {magicActivityText}
              </button>
            )}
            <button
              onClick={() => onStopMagic?.()}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10.5px] font-semibold transition-colors"
              style={{
                background: 'var(--button)',
                color: 'var(--text)',
                border: '1px solid var(--stroke)',
              }}
              title={L('停止 AI 剪辑 (Esc)', 'Stop Magic (Esc)')}
            >
              <Square size={8} fill="var(--accent)" stroke="var(--accent)" />
              <span>{L('停止', 'Stop')}</span>
            </button>
          </div>
        )}

        <button
          data-magic-anchor="magicButton"
          className="titlebar-nodrag inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors"
          style={{
            background: magicOpen
              ? 'var(--accent)'
              : 'var(--button)',
            color: magicOpen ? '#FFFFFF' : 'var(--text)',
            border: `1px solid ${magicOpen ? 'var(--accent)' : 'var(--stroke)'}`,
          }}
          onClick={onOpenMagic}
          title={magicOpen ? L('收起 Magic 侧边面板', 'Collapse Magic Side Panel') : L('打开 Magic 侧边面板', 'Open Magic Side Panel')}
        >
          {magicStatus ? (
            <>
              <Loader2 size={12} className="animate-spin" style={{ color: magicOpen ? '#FFFFFF' : 'var(--accent)' }} />
              <span className="max-w-[72px] truncate">{magicStatus.worker}</span>
            </>
          ) : (
            <>
              <Sparkles size={12} strokeWidth={1.6} style={{ color: magicOpen ? '#FFFFFF' : 'var(--accent)' }} />
              <span>Magic</span>
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded-full text-[10px] font-medium"
                style={{
                  background: magicOpen ? 'rgba(255,255,255,0.18)' : 'var(--raised)',
                  color: magicOpen ? '#FFFFFF' : 'var(--text-dim)',
                }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: magicOpen ? '#FFFFFF' : magicModeMeta.dot }}
                />
                <span className="min-w-[28px] text-center">{magicModeMeta.label}</span>
              </span>
            </>
          )}
        </button>

        <button
          className="titlebar-nodrag inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold"
          style={{
            background: 'var(--text)',
            color: 'var(--on-text)',
          }}
          onClick={onOpenExport}
          title={L('导出视频 (Ctrl+E)', 'Export (Ctrl+E)')}
        >
          <Download size={12} strokeWidth={1.8} />
          {L('导出', 'Export')}
        </button>

        <button
          className="titlebar-nodrag vt-hover inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10.5px] font-medium transition-colors"
          style={{ background: 'var(--field)', color: 'var(--text-dim)', border: '1px solid var(--stroke)' }}
          onClick={toggleLocale}
          title={L('Switch to English', '切换为中文')}
        >
          <Languages size={12} strokeWidth={1.6} />
          <span>{locale === 'zh' ? '中文' : 'EN'}</span>
        </button>

        {onToggleLightDark && (
          <button
            className={btnClass}
            style={{ color: 'var(--text-dim)' }}
            onClick={onToggleLightDark}
            title={isLightTheme ? L('切换深色主题', 'Switch to Dark Theme') : L('切换浅色主题', 'Switch to Light Theme')}
          >
            {isLightTheme ? <Moon size={13} strokeWidth={1.6} /> : <Sun size={13} strokeWidth={1.6} />}
          </button>
        )}

        {onOpenMarketplace && (
          <button
            className={btnClass}
            style={{ color: 'var(--text-dim)' }}
            onClick={onOpenMarketplace}
            title={L('插件市场（DJI / iPhone / 模板 / 数字人）', 'Plugin Marketplace (DJI / iPhone / Templates / Avatar)')}
          >
            <Blocks size={13} strokeWidth={1.6} />
          </button>
        )}

        <button
          className={btnClass}
          style={{ color: mcpRunning ? 'var(--text)' : 'var(--text-dim)' }}
          onClick={onOpenSettings}
          title={L('设置与 MCP', 'Settings & MCP')}
        >
          <Settings size={14} strokeWidth={1.5} />
          {mcpRunning && (
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: '#30D158' }} />
          )}
        </button>

        <div className="titlebar-nodrag flex items-center ml-1">
          <button
            className="p-1.5 rounded vt-hover transition-colors"
            style={{ color: 'var(--text-dim)' }}
            onClick={() => window.vectrail.minimizeWindow()}
            title={L('最小化', 'Minimize')}
          >
            <Minus size={13} />
          </button>
          <button
            className="p-1.5 rounded vt-hover transition-colors"
            style={{ color: 'var(--text-dim)' }}
            onClick={() => window.vectrail.maximizeWindow()}
            title={L('最大化', 'Maximize')}
          >
            <Square size={11} />
          </button>
          <button
            className="p-1.5 rounded vt-win-close transition-colors"
            style={{ color: 'var(--text-dim)' }}
            onClick={() => window.vectrail.closeWindow()}
            title={L('关闭', 'Close')}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};
