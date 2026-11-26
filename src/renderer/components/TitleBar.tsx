import React from 'react';
import {
  Download,
  FolderOpen,
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
import { ExportJobInfo } from '../../shared/types';

interface TitleBarProps {
  title: string;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  exportsList: ExportJobInfo[];
  mcpRunning: boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onImport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenMagic: () => void;
  onOpenExport: () => void;
  onOpenSettings: () => void;
  onCancelExport: (id: string) => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  title,
  isDirty,
  canUndo,
  canRedo,
  exportsList,
  mcpRunning,
  onNew,
  onOpen,
  onSave,
  onImport,
  onUndo,
  onRedo,
  onOpenMagic,
  onOpenExport,
  onOpenSettings,
  onCancelExport,
}) => {
  const activeExport = exportsList.find((j) => j.status === 'running');
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
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: 'var(--accent)' }}
          />
          Editroom
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
        {activeExport && (
          <div
            className="titlebar-nodrag flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px]"
            style={{ background: 'var(--raised)', border: '1px solid var(--stroke)' }}
          >
            <span className="mono-num">{Math.round(activeExport.progress * 100)}%</span>
            <button
              onClick={() => onCancelExport(activeExport.id)}
              style={{ color: 'var(--text-dim)' }}
              title="Cancel export"
            >
              <X size={11} />
            </button>
          </div>
        )}

        <button
          className="titlebar-nodrag inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
          style={{
            background: 'var(--button)',
            color: 'var(--text)',
            border: '1px solid var(--stroke)',
          }}
          onClick={onOpenMagic}
          title="Magic AI Edit"
        >
          <Sparkles size={12} strokeWidth={1.6} style={{ color: 'var(--accent)' }} />
          Magic
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
            onClick={() => window.editroom.minimizeWindow()}
            title="Minimize"
          >
            <Minus size={13} />
          </button>
          <button
            className="p-1.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-dim)' }}
            onClick={() => window.editroom.maximizeWindow()}
            title="Maximize"
          >
            <Square size={11} />
          </button>
          <button
            className="p-1.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-dim)' }}
            onClick={() => window.editroom.closeWindow()}
            title="Close"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};
