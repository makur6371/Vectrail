import React, { useEffect, useMemo, useState } from 'react';
import { Check, Plug, RefreshCw, RotateCcw, Sparkles, X } from 'lucide-react';
import { AppUpdateInfo, CloudAiConfig, ExportSettings, MediaAsset, Project } from '../../shared/types';
import { AppThemeName, THEMES } from '../../shared/themes';
import { AgentTarget, AgentTargetStatus, MagicBackend } from '../../main/magic/agentConnect';
import { MCPStatusInfo } from '../../preload';
import { computeExportRenderSize } from '../../shared/project';
import { DEFAULT_SHORTCUTS, formatEventCombo, mergeShortcutBindings, ShortcutActionId } from '../../shared/shortcuts';
import type { WhisperStatus } from '../../main/engine/analyzer';

export const ExportModal: React.FC<{
  project: Project;
  title: string;
  onClose: () => void;
  onStart: (s: ExportSettings) => void;
}> = ({ project, title, onClose, onStart }) => {
  const [format, setFormat] = useState<'video' | 'audio'>('video');
  const [shape, setShape] = useState<'original' | 'vertical' | 'square' | 'portrait'>('original');
  const [height, setHeight] = useState<number>(project.height);
  const [codec, setCodec] = useState<'h264' | 'hevc'>('h264');
  const [quality, setQuality] = useState<'high' | 'web'>('high');
  const [loudness, setLoudness] = useState<string>('-14');
  const [rangeOnly, setRangeOnly] = useState(false);
  const [enhanceDetail, setEnhanceDetail] = useState(false);

  const size = computeExportRenderSize(project, shape, height);
  const isUpscaling = size.height > project.height;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div
        className="w-[420px] rounded-xl p-4 space-y-3"
        style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold">Export</span>
          <button onClick={onClose} style={{ color: 'var(--text-dim)' }}>
            <X size={15} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <label>
            Format
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as 'video' | 'audio')}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
            >
              <option value="video">Video (MP4)</option>
              <option value="audio">Audio (WAV)</option>
            </select>
          </label>
          <label>
            Shape
            <select
              value={shape}
              disabled={format === 'audio'}
              onChange={(e) => setShape(e.target.value as typeof shape)}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
            >
              <option value="original">Sequence ({project.width}x{project.height})</option>
              <option value="vertical">Vertical 9:16</option>
              <option value="square">Square 1:1</option>
              <option value="portrait">Portrait 4:5</option>
            </select>
          </label>
          <label>
            Resolution
            <select
              value={height}
              disabled={format === 'audio'}
              onChange={(e) => setHeight(Number(e.target.value))}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
            >
              <option value={720}>720p</option>
              <option value={1080}>1080p</option>
              <option value={2160}>4K (2160p)</option>
            </select>
          </label>
          <label>
            Codec & Quality
            <select
              value={`${codec}-${quality}`}
              disabled={format === 'audio'}
              onChange={(e) => {
                const [c, q] = e.target.value.split('-');
                setCodec(c as 'h264' | 'hevc');
                setQuality(q as 'high' | 'web');
              }}
              className="mt-1 w-full px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
            >
              <option value="h264-high">H.264 High</option>
              <option value="h264-web">H.264 Web</option>
              <option value="hevc-high">HEVC High</option>
            </select>
          </label>
        </div>

        <div className="flex items-center justify-between text-[11px]">
          <span>Loudness Target</span>
          <select
            value={loudness}
            onChange={(e) => setLoudness(e.target.value)}
            className="px-2 py-1 rounded outline-none"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
          >
            <option value="">Original levels</option>
            <option value="-14">-14 LUFS (YouTube / Social)</option>
            <option value="-16">-16 LUFS (Podcast)</option>
            <option value="-23">-23 LUFS (Broadcast)</option>
          </select>
        </div>

        {project.playRange && (
          <label className="flex items-center gap-2 text-[11px]">
            <input type="checkbox" checked={rangeOnly} onChange={(e) => setRangeOnly(e.target.checked)} />
            Export In/Out range only
          </label>
        )}
        <label className="flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={enhanceDetail || isUpscaling}
            onChange={(e) => setEnhanceDetail(e.target.checked)}
          />
          <span>Enhance detail (Lanczos + CAS sharpen{isUpscaling ? ' · auto on upscale' : ''})</span>
        </label>

        <div className="flex items-center justify-between pt-2">
          <span className="mono-num text-[11px]" style={{ color: 'var(--text-dim)' }}>
            {format === 'audio' ? '48 kHz WAV' : `${size.width}x${size.height} · ${project.fps} fps`}
          </span>
          <button
            onClick={() => {
              onStart({
                format,
                shape,
                height,
                codec,
                quality,
                includeAudio: true,
                loudness: loudness ? Number(loudness) : undefined,
                rangeOnly,
                enhanceDetail: enhanceDetail || isUpscaling,
                reframeX: 0.5,
                reframeY: 0.5,
                name: title,
              });
              onClose();
            }}
            className="px-4 py-1.5 rounded-full text-[11px] font-semibold"
            style={{ background: 'var(--text)', color: 'var(--on-text)' }}
          >
            Export...
          </button>
        </div>
      </div>
    </div>
  );
};

export const MagicPopover: React.FC<{
  assets: MediaAsset[];
  selectedIds: string[];
  canUndo: boolean;
  onUndo: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}> = ({ assets, selectedIds, canUndo, onUndo, onOpenSettings, onClose }) => {
  const [prompt, setPrompt] = useState('');
  const [backend, setBackend] = useState<MagicBackend>('local');
  const [cloudReady, setCloudReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  useEffect(() => {
    void window.vectrail.getCloudAiConfig().then((cfg) => {
      const ready = Boolean(cfg.apiKey.trim());
      setCloudReady(ready);
      if (ready) setBackend('cloud');
    });
  }, []);

  const mentionQuery = useMemo(() => {
    const m = prompt.match(/@([^\s]*)$/);
    return m ? m[1].toLowerCase() : null;
  }, [prompt]);

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) return [];
    const all = [
      { id: 'playhead', label: 'playhead', sub: 'Current playhead time' },
      ...(selectedIds.length ? [{ id: 'selected', label: 'selected', sub: `${selectedIds.length} selected clip(s)` }] : []),
      ...assets.map((a) => ({ id: a.id, label: a.name.replace(/\s+/g, '_'), sub: a.kind })),
    ];
    return all.filter((o) => o.label.toLowerCase().includes(mentionQuery)).slice(0, 6);
  }, [mentionQuery, assets, selectedIds.length]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  const insertMention = (label: string) => {
    setPrompt((prev) => prev.replace(/@([^\s]*)$/, `@${label} `));
  };

  const run = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setMsg('');
    setSteps([]);
    try {
      const res = await window.vectrail.runMagic(prompt, backend, selectedIds);
      setMsg(res.summary);
      setSteps(res.steps ?? []);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const backends: Array<{ id: MagicBackend; label: string }> = [
    { id: 'cloud', label: 'Cloud AI' },
    { id: 'local', label: 'Rules' },
    { id: 'codex', label: 'Codex' },
    { id: 'claude', label: 'Claude' },
  ];

  return (
    <div className="fixed top-11 right-4 z-50 w-[410px]">
      <div
        className="rounded-xl p-3.5 space-y-2.5 shadow-2xl backdrop-blur-md"
        style={{ background: 'rgba(18, 19, 22, 0.96)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
            <Sparkles size={13} style={{ color: 'var(--accent)' }} /> Magic
          </span>
          <div className="flex items-center gap-2">
            {backend === 'cloud' && !cloudReady && (
              <button
                onClick={onOpenSettings}
                className="text-[10px] underline"
                style={{ color: 'var(--accent)' }}
              >
                Set API Key
              </button>
            )}
            <button onClick={onClose} style={{ color: 'var(--text-dim)' }} title="Close (Esc)">
              <X size={14} />
            </button>
          </div>
        </div>

        <textarea
          autoFocus
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Cut @clip to the beat, warm film grade, zoom in, or add title at @playhead..."
          className="w-full p-2.5 rounded-lg text-[12px] outline-none resize-none"
          style={{ background: 'var(--sheet-field)', color: 'var(--text)', border: '1px solid var(--sheet-field-stroke)' }}
          onKeyDown={(e) => {
            if (mentionOptions.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % mentionOptions.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
                e.preventDefault();
                insertMention(mentionOptions[mentionIndex].label);
                return;
              }
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void run();
            if (e.key === 'Escape') onClose();
          }}
        />

        {mentionOptions.length > 0 && (
          <div
            className="rounded-lg p-1 space-y-0.5 max-h-36 overflow-y-auto"
            style={{ background: 'var(--field)', border: '1px solid var(--stroke)' }}
          >
            {mentionOptions.map((opt, idx) => (
              <button
                key={opt.id}
                onClick={() => insertMention(opt.label)}
                className="w-full flex items-center justify-between px-2 py-1 rounded text-[11px]"
                style={{
                  background: idx === mentionIndex ? 'var(--hover)' : 'transparent',
                  color: 'var(--text)',
                }}
              >
                <span>@{opt.label}</span>
                <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                  {opt.sub}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {backends.map((b) => (
              <button
                key={b.id}
                onClick={() => setBackend(b.id)}
                className="px-2 py-1 rounded-full text-[10px] font-medium"
                style={{
                  background: backend === b.id ? 'var(--accent)' : 'var(--button)',
                  color: backend === b.id ? '#FFF' : 'var(--chip)',
                }}
              >
                {b.label}
              </button>
            ))}
          </div>
          <button
            disabled={busy || !prompt.trim()}
            onClick={() => void run()}
            className="px-3.5 py-1 rounded-full text-[11px] font-semibold"
            style={{ background: 'var(--text)', color: 'var(--on-text)' }}
          >
            {busy ? 'Cutting...' : 'Cut (Ctrl+↵)'}
          </button>
        </div>

        {msg && (
          <div
            className="p-2.5 rounded text-[11px] space-y-1.5 max-h-36 overflow-y-auto"
            style={{ background: 'var(--field)', color: 'var(--text-dim)', border: '1px solid var(--stroke)' }}
          >
            <div className="flex items-start justify-between gap-2">
              <span>{msg}</span>
              {canUndo && (
                <button
                  onClick={onUndo}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] shrink-0"
                  style={{ background: 'var(--button)', color: 'var(--text)' }}
                >
                  <RotateCcw size={10} /> Undo
                </button>
              )}
            </div>
            {steps.some((st) => st !== msg) && (
              <div className="flex flex-wrap gap-1">
                {steps
                  .filter((st) => st !== msg)
                  .map((st, idx) => (
                  <span
                    key={idx}
                    className="mono-num px-1.5 py-0.5 rounded text-[9px]"
                    style={{ background: 'var(--raised)', color: 'var(--text-faint)' }}
                  >
                    {st}
                  </span>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const SettingsModal: React.FC<{
  theme: AppThemeName;
  shortcutMap: Record<string, string>;
  onUpdateShortcuts: (next: Record<string, string>) => void;
  onChangeTheme: (t: AppThemeName) => void;
  onClose: () => void;
}> = ({ theme, shortcutMap, onUpdateShortcuts, onChangeTheme, onClose }) => {
  const [tab, setTab] = useState<'general' | 'shortcuts'>('general');
  const [mcp, setMcp] = useState<MCPStatusInfo | null>(null);
  const [agents, setAgents] = useState<AgentTargetStatus[]>([]);
  const [whisper, setWhisper] = useState<WhisperStatus | null>(null);
  const [cloudAi, setCloudAi] = useState<CloudAiConfig>({ baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' });
  const [cloudStatus, setCloudStatus] = useState('');
  const [cloudBusy, setCloudBusy] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlErr, setDlErr] = useState('');
  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null);

  useEffect(() => {
    void window.vectrail.getMcpStatus().then(setMcp);
    void window.vectrail.getAgentStatuses().then(setAgents);
    void window.vectrail.getWhisperStatus().then(setWhisper);
    void window.vectrail.getCloudAiConfig().then(setCloudAi);
  }, []);

  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecordingId(null);
        return;
      }
      const combo = formatEventCombo(e);
      if (!combo) return;
      const next = { ...shortcutMap, [recordingId]: combo };
      onUpdateShortcuts(next);
      setRecordingId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recordingId, shortcutMap, onUpdateShortcuts]);

  const toggleAgent = async (item: AgentTargetStatus) => {
    const next = item.connected
      ? await window.vectrail.disconnectAgent(item.id as AgentTarget)
      : await window.vectrail.connectAgent(item.id as AgentTarget);
    setAgents(next);
  };

  const bindings = mergeShortcutBindings(shortcutMap);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div
        className="w-[520px] max-h-[82vh] flex flex-col rounded-xl p-4 space-y-3"
        style={{ background: 'var(--sheet)', border: '1px solid var(--sheet-field-stroke)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold mr-2">Settings</span>
            {(['general', 'shortcuts'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="px-2.5 py-0.5 rounded text-[11px] capitalize"
                style={{
                  background: tab === t ? 'var(--raised)' : 'transparent',
                  color: tab === t ? 'var(--text)' : 'var(--text-dim)',
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-dim)' }}>
            <X size={15} />
          </button>
        </div>

        {tab === 'general' ? (
          <div className="space-y-4 overflow-y-auto pr-1">
            <div>
          <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
            APPEARANCE
          </div>
          <div className="flex gap-2">
            {(Object.keys(THEMES) as AppThemeName[]).map((name) => (
              <button
                key={name}
                onClick={() => onChangeTheme(name)}
                className="flex-1 py-1.5 rounded text-[11px] capitalize"
                style={{
                  background: theme === name ? 'var(--accent)' : 'var(--sheet-field)',
                  color: theme === name ? '#FFF' : 'var(--text)',
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
            CLOUD AI (OPENAI-COMPATIBLE API)
          </div>
          <div
            className="p-2.5 rounded space-y-2"
            style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
          >
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <label>
                Base URL
                <input
                  value={cloudAi.baseUrl}
                  onChange={(e) => setCloudAi({ ...cloudAi, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="mono-num mt-1 w-full px-2 py-1 rounded outline-none"
                  style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
                />
              </label>
              <label>
                Model
                <input
                  value={cloudAi.model}
                  onChange={(e) => setCloudAi({ ...cloudAi, model: e.target.value })}
                  placeholder="gpt-4o-mini"
                  className="mono-num mt-1 w-full px-2 py-1 rounded outline-none"
                  style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
                />
              </label>
            </div>
            <label className="block text-[11px]">
              API Key
              <input
                type="password"
                value={cloudAi.apiKey}
                onChange={(e) => setCloudAi({ ...cloudAi, apiKey: e.target.value })}
                placeholder="sk-..."
                className="mono-num mt-1 w-full px-2 py-1 rounded outline-none"
                style={{ background: 'var(--field)', border: '1px solid var(--stroke)', color: 'var(--text)' }}
              />
            </label>
            <div className="flex items-center justify-between pt-0.5">
              <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
                {cloudStatus || 'Used by Magic -> Cloud AI'}
              </span>
              <div className="flex gap-1.5">
                <button
                  disabled={cloudBusy}
                  onClick={async () => {
                    setCloudBusy(true);
                    setCloudStatus('Testing...');
                    const saved = await window.vectrail.saveCloudAiConfig(cloudAi);
                    setCloudAi(saved);
                    const res = await window.vectrail.testCloudAiConnection(saved);
                    setCloudStatus(res.message);
                    setCloudBusy(false);
                  }}
                  className="px-2.5 py-1 rounded text-[11px]"
                  style={{ background: 'var(--button)', color: 'var(--text)' }}
                >
                  Test
                </button>
                <button
                  onClick={async () => {
                    const saved = await window.vectrail.saveCloudAiConfig(cloudAi);
                    setCloudAi(saved);
                    setCloudStatus('Saved');
                  }}
                  className="px-2.5 py-1 rounded text-[11px] font-medium"
                  style={{ background: 'var(--accent)', color: '#FFF' }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-dim)' }}>
              AI AGENTS & MCP SERVER
            </span>
            {mcp && (
              <label className="flex items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={mcp.enabled}
                  onChange={async (e) => setMcp(await window.vectrail.setMcpEnabled(e.target.checked))}
                />
                Enabled
              </label>
            )}
          </div>
          {mcp && (
            <div
              className="mono-num px-2.5 py-1.5 rounded text-[11px] mb-2.5 flex items-center justify-between"
              style={{ background: 'var(--sheet-field)', color: 'var(--text-dim)' }}
            >
              <span>{mcp.endpoint}</span>
              <span style={{ color: mcp.running ? '#30D158' : 'var(--text-faint)' }}>
                {mcp.running ? 'LISTENING' : 'OFF'}
              </span>
            </div>
          )}
          <div className="space-y-1.5">
            {agents.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between px-2.5 py-2 rounded"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div>
                  <div className="text-[12px] font-medium">{a.title}</div>
                  <div className="mono-num text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {a.detail}
                  </div>
                </div>
                <button
                  onClick={() => void toggleAgent(a)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px]"
                  style={{
                    background: a.connected ? 'rgba(48, 209, 88, 0.16)' : 'var(--button)',
                    color: a.connected ? '#30D158' : 'var(--text)',
                  }}
                >
                  {a.connected ? <Check size={12} /> : <Plug size={12} />}
                  {a.connected ? 'Connected' : 'Connect'}
                </button>
              </div>
            ))}
          </div>
        </div>

            <div>
              <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
                WHISPER SPEECH TRANSCRIPTION
              </div>
              <div
                className="flex items-center justify-between px-2.5 py-2 rounded"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div>
                  <div className="text-[11px] font-medium">
                    {whisper?.modelName ? `Model ready: ${whisper.modelName}` : 'No Whisper GGML model downloaded'}
                  </div>
                  <div className="mono-num text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {whisper?.supported ? 'FFmpeg whisper.cpp filter available' : 'Whisper filter unavailable'}
                  </div>
                  {dlErr && <div className="text-[10px] text-red-400 mt-0.5">{dlErr}</div>}
                </div>
                <button
                  disabled={dlBusy || !whisper?.supported}
                  onClick={async () => {
                    setDlBusy(true);
                    setDlErr('');
                    try {
                      await window.vectrail.downloadWhisperModel('tiny');
                      setWhisper(await window.vectrail.getWhisperStatus());
                    } catch (err) {
                      setDlErr(err instanceof Error ? err.message : String(err));
                    } finally {
                      setDlBusy(false);
                    }
                  }}
                  className="px-2.5 py-1 rounded text-[11px]"
                  style={{ background: 'var(--button)', color: 'var(--text)' }}
                >
                  {dlBusy ? 'Downloading...' : whisper?.modelPath ? 'Ready' : 'Download Tiny (75 MB)'}
                </button>
              </div>
            </div>

            <div>
              <div className="text-[10px] font-semibold tracking-[0.08em] mb-2" style={{ color: 'var(--text-dim)' }}>
                ABOUT & UPDATES
              </div>
              <div
                className="flex items-center justify-between px-2.5 py-2 rounded"
                style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
              >
                <div>
                  <div className="text-[11px] font-medium">Vectrail v1.0.0 · Built by Makur</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {updateInfo
                      ? updateInfo.error
                        ? updateInfo.error
                        : updateInfo.hasUpdate
                        ? `New version v${updateInfo.latestVersion} available`
                        : `Up to date (v${updateInfo.currentVersion})`
                      : 'Inspired by Editroom for macOS'}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  {updateInfo?.hasUpdate && updateInfo.releaseUrl && (
                    <button
                      onClick={() => void window.vectrail.openExternalUrl(updateInfo.releaseUrl!)}
                      className="px-2.5 py-1 rounded text-[11px] font-medium"
                      style={{ background: 'var(--accent)', color: '#FFF' }}
                    >
                      Download
                    </button>
                  )}
                  <button
                    disabled={updateBusy}
                    onClick={async () => {
                      setUpdateBusy(true);
                      setUpdateInfo(await window.vectrail.checkForUpdates());
                      setUpdateBusy(false);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px]"
                    style={{ background: 'var(--button)', color: 'var(--text)' }}
                  >
                    <RefreshCw size={11} className={updateBusy ? 'animate-spin' : ''} />
                    Check
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                Click any binding and press a new key combination.
              </span>
              <button
                onClick={() => {
                  const defaults: Record<string, string> = {};
                  DEFAULT_SHORTCUTS.forEach((b) => (defaults[b.id] = b.combo));
                  onUpdateShortcuts(defaults);
                }}
                className="px-2 py-0.5 rounded text-[10px]"
                style={{ background: 'var(--button)', color: 'var(--chip)' }}
              >
                Reset Defaults
              </button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {bindings.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between px-2.5 py-1.5 rounded"
                  style={{ background: 'var(--sheet-field)', border: '1px solid var(--sheet-field-stroke)' }}
                >
                  <span className="text-[11px]">{b.label}</span>
                  <button
                    onClick={() => setRecordingId(b.id)}
                    className="mono-num px-2 py-0.5 rounded text-[10px]"
                    style={{
                      background: recordingId === b.id ? 'var(--accent)' : 'var(--button)',
                      color: recordingId === b.id ? '#FFF' : 'var(--text)',
                    }}
                  >
                    {recordingId === b.id ? 'Press key...' : b.combo}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
