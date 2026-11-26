import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FolderOpen,
  Loader2,
  Minus,
  Plus,
  Redo2,
  Save,
  Settings,
  Sparkles,
  Square,
  Undo2,
  X,
} from 'lucide-react';
import { ExportJobInfo, MagicStage } from '../../shared/types';

interface TitleBarProps {
  title: string;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  exportsList: ExportJobInfo[];
  mcpRunning: boolean;
  magicOpen?: boolean;
  magicStatus?: { worker: string; stage: MagicStage; status?: string } | null;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onImport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenMagic: () => void;
  onStopMagic?: () => void;
  onOpenExport: () => void;
  onOpenSettings: () => void;
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
  magicOpen = false,
  magicStatus = null,
  onNew,
  onOpen,
  onSave,
  onImport,
  onUndo,
  onRedo,
  onOpenMagic,
  onStopMagic,
  onOpenExport,
  onOpenSettings,
  onCancelExport,
  onShowExportInExplorer,
}) => {
  const [magicHover, setMagicHover] = useState(false);
  const [exportsOpen, setExportsOpen] = useState(false);
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
        ? 'Editing'
        : magicStatus.status?.trim() ||
          magicStatus.stage.charAt(0).toUpperCase() + magicStatus.stage.slice(1);
    return raw.length > 38 ? `${raw.slice(0, 37)}…` : raw;
  })();
  const btnClass =
    'titlebar-nodrag inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors';

  return (
    <div
      className="titlebar-drag flex items-center justify-between px-3 h-10 shrink-0"
      style={{
        background: 'var(--panel)',
        borderBottom: '1px solid var(--stroke)',
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="text-[12px] font-semibold tracking-tight mr-2 flex items-center gap-1.5"
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
          title="New Project"
        >
          New
        </button>
        <button
          className={btnClass}
          style={{ background: 'transparent', color: 'var(--text-dim)' }}
          onClick={onOpen}
          title="Open Project"
        >
          <FolderOpen size={13} strokeWidth={1.5} /> Open
        </button>
        <button
          className={btnClass}
          style={{ background: 'transparent', color: 'var(--text-dim)' }}
          onClick={onSave}
          title="Save Project (Ctrl+S)"
        >
          <Save size={13} strokeWidth={1.5} /> Save
        </button>
        <button
          className={btnClass}
          style={{ background: 'var(--button)', color: 'var(--text)' }}
          onClick={onImport}
          title="Import Media (Ctrl+I)"
        >
          <Plus size={13} strokeWidth={1.6} /> Import
        </button>
        <div className="h-3.5 w-px mx-1" style={{ background: 'var(--stroke)' }} />
        <button
          className={btnClass}
          style={{ color: canUndo ? 'var(--text)' : 'var(--text-faint)' }}
          disabled={!canUndo}
          onClick={onUndo}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={13} strokeWidth={1.5} />
        </button>
        <button
          className={btnClass}
          style={{ color: canRedo ? 'var(--text)' : 'var(--text-faint)' }}
          disabled={!canRedo}
          onClick={onRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={13} strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
        <span>{title}</span>
        {isDirty && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: 'var(--text-faint)' }}
          />
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {visibleExports && (
          <div className="relative titlebar-nodrag">
            <button
              onClick={() => setExportsOpen((v) => !v)}
              className="flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] transition-colors"
              style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
              title="Exports"
            >
              {activeExport ? (
                <>
                  <span className="w-16 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.12)' }}>
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
                  <span>Export failed</span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={12} style={{ color: '#3DDC97' }} />
                  <span>Exported</span>
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
                            ? item.error || 'Failed'
                            : `${item.sizeLabel} · ${item.status}`}
                        </div>
                      </div>
                      {(item.status === 'running' || item.status === 'waiting') && (
                        <button
                          onClick={() => onCancelExport(item.id)}
                          className="p-1 rounded hover:opacity-80"
                          style={{ color: 'var(--text-dim)' }}
                          title="Cancel"
                        >
                          <X size={12} />
                        </button>
                      )}
                      {item.status === 'done' && onShowExportInExplorer && (
                        <button
                          onClick={() => onShowExportInExplorer(item.file)}
                          className="p-1 rounded hover:opacity-80"
                          style={{ color: 'var(--text-dim)' }}
                          title="Show in Explorer"
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
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {magicStatus && magicActivityText && (
          <span
            className="titlebar-nodrag text-[11px] font-medium px-1.5 truncate max-w-[200px]"
            style={{ color: 'var(--text-dim)' }}
          >
            {magicActivityText}
          </span>
        )}

        <button
          data-magic-anchor="magicButton"
          className="titlebar-nodrag inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors"
          style={{
            background: magicStatus
              ? 'rgba(255, 255, 255, 0.12)'
              : magicOpen
              ? 'var(--accent)'
              : 'var(--button)',
            color: magicOpen && !magicStatus ? '#FFFFFF' : 'var(--text)',
            border: `1px solid ${magicOpen && !magicStatus ? 'var(--accent)' : 'var(--stroke)'}`,
          }}
          onMouseEnter={() => setMagicHover(true)}
          onMouseLeave={() => setMagicHover(false)}
          onClick={() => {
            if (magicStatus) onStopMagic?.();
            else onOpenMagic();
          }}
          title={magicStatus ? 'Stop Magic (Esc)' : 'Magic AI Edit'}
        >
          {magicStatus ? (
            magicHover ? (
              <>
                <Square size={9} fill="var(--accent)" stroke="var(--accent)" />
                <span>Stop</span>
              </>
            ) : (
              <>
                <Loader2 size={12} className="animate-spin" style={{ color: 'var(--accent)' }} />
                <span>{magicStatus.worker}</span>
              </>
            )
          ) : (
            <>
              <Sparkles size={12} strokeWidth={1.6} style={{ color: magicOpen ? '#FFFFFF' : 'var(--accent)' }} />
              <span>Magic</span>
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
          title="Export (Ctrl+E)"
        >
          <Download size={12} strokeWidth={1.8} />
          Export
        </button>

        <button
          className={btnClass}
          style={{ color: mcpRunning ? 'var(--text)' : 'var(--text-dim)' }}
          onClick={onOpenSettings}
          title="Settings & MCP"
        >
          <Settings size={14} strokeWidth={1.5} />
          {mcpRunning && (
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: '#30D158' }} />
          )}
        </button>

        <div className="titlebar-nodrag flex items-center ml-1">
          <button
            className="p-1.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-dim)' }}
            onClick={() => window.vectrail.minimizeWindow()}
            title="Minimize"
          >
            <Minus size={13} />
          </button>
          <button
            className="p-1.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-dim)' }}
            onClick={() => window.vectrail.maximizeWindow()}
            title="Maximize"
          >
            <Square size={11} />
          </button>
          <button
            className="p-1.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-dim)' }}
            onClick={() => window.vectrail.closeWindow()}
            title="Close"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};
