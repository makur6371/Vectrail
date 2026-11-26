import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../state';
import { callMCPTool, MCP_TOOL_DEFINITIONS } from '../mcp/tools';
import { MCP_DEFAULT_PORT, MCPServer } from '../mcp/server';
import { getCacheDir } from '../engine/ffmpeg';
import { getCloudAiConfig } from '../settings';
import { BUILT_IN_LOOKS } from '../../shared/colorGrade';
import { clipName, cloneProject, snapFrame } from '../../shared/project';
import { CloudAiConfig, MagicProgressEvent, MagicRunResult } from '../../shared/types';

export type AgentTarget = 'codex' | 'claudeCode' | 'claudeDesktop';

export interface AgentTargetStatus {
  id: AgentTarget;
  title: string;
  installed: boolean;
  connected: boolean;
  detail: string;
}

function codexConfigPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function claudeCodeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

function claudeDesktopConfigPath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Claude', 'claude_desktop_config.json');
}

function findBridgeScript(): string {
  return path.resolve(__dirname, '../mcp/bridge.js');
}

function isEphemeralPortableExec(): boolean {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return true;
  const execResolved = path.resolve(process.execPath).toLowerCase();
  const tmpResolved = path.resolve(os.tmpdir()).toLowerCase();
  return execResolved.startsWith(tmpResolved);
}

function ensureStableBridgeCopy(): string {
  const src = findBridgeScript();
  const dest = path.join(getCacheDir('Runtime'), 'vectrail-mcp-bridge.js');
  try {
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    return src;
  }
}

function commandPathIsValid(cmd: string, firstArg?: string): boolean {
  if (!cmd) return false;
  const cmdOk = path.isAbsolute(cmd) ? fs.existsSync(cmd) : Boolean(findOnPath(cmd));
  if (!cmdOk) return false;
  if (firstArg && !fs.existsSync(firstArg)) return false;
  return true;
}

function extractCodexSectionTargets(toml: string, sectionHeader = '[mcp_servers.vectrail]'): { command?: string; firstArg?: string } {
  const lines = toml.split(/\r?\n/);
  let inSection = false;
  let command: string | undefined;
  let firstArg: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === sectionHeader) {
      inSection = true;
      continue;
    }
    if (inSection && trimmed.startsWith('[')) break;
    if (!inSection) continue;
    const cmdMatch = trimmed.match(/^command\s*=\s*"([^"]+)"/);
    if (cmdMatch) command = cmdMatch[1].replace(/\\\\/g, '\\');
    const argsMatch = trimmed.match(/^args\s*=\s*\[\s*"([^"]+)"/);
    if (argsMatch) firstArg = argsMatch[1].replace(/\\\\/g, '\\');
  }
  return { command, firstArg };
}

function findOnPath(cmd: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, `${cmd}${ext}`);
      if (fs.existsSync(full)) return full;
    }
  }
  return undefined;
}

function removeTomlMcpSections(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[mcp_servers.vectrail]' || trimmed === '[mcp_servers.editroom]') {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith('[')) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').trimEnd();
}

export function getAgentStatuses(): AgentTargetStatus[] {
  const codexExists = fs.existsSync(path.dirname(codexConfigPath())) || Boolean(findOnPath('codex'));
  const codexContent = fs.existsSync(codexConfigPath()) ? fs.readFileSync(codexConfigPath(), 'utf8') : '';
  const codexTargets = extractCodexSectionTargets(codexContent, '[mcp_servers.vectrail]');
  const codexConnected =
    codexContent.includes('[mcp_servers.vectrail]') &&
    commandPathIsValid(codexTargets.command ?? '', codexTargets.firstArg);

  const claudeCli = findOnPath('claude');
  let claudeCodeConnected = false;
  if (fs.existsSync(claudeCodeConfigPath())) {
    try {
      const json = JSON.parse(fs.readFileSync(claudeCodeConfigPath(), 'utf8')) as { mcpServers?: Record<string, unknown> };
      const entry = json.mcpServers?.vectrail as { command?: string; args?: string[] } | undefined;
      claudeCodeConnected = Boolean(entry && commandPathIsValid(entry.command ?? '', entry.args?.[0]));
    } catch {
      // ignore
    }
  }

  const cdPath = claudeDesktopConfigPath();
  const cdInstalled = fs.existsSync(path.dirname(cdPath));
  let cdConnected = false;
  if (fs.existsSync(cdPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(cdPath, 'utf8')) as { mcpServers?: Record<string, unknown> };
      const entry = json.mcpServers?.vectrail as { command?: string; args?: string[] } | undefined;
      cdConnected = Boolean(entry && commandPathIsValid(entry.command ?? '', entry.args?.[0]));
    } catch {
      // ignore
    }
  }

  return [
    {
      id: 'codex',
      title: 'Codex / ChatGPT',
      installed: codexExists,
      connected: codexConnected,
      detail: codexConfigPath(),
    },
    {
      id: 'claudeCode',
      title: 'Claude Code',
      installed: Boolean(claudeCli) || fs.existsSync(claudeCodeConfigPath()),
      connected: claudeCodeConnected,
      detail: claudeCodeConfigPath(),
    },
    {
      id: 'claudeDesktop',
      title: 'Claude Desktop',
      installed: cdInstalled,
      connected: cdConnected,
      detail: cdPath,
    },
  ];
}

export function connectAgent(target: AgentTarget): AgentTargetStatus[] {
  let isPackaged = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronMod = require('electron') as { app?: { isPackaged?: boolean } } | string;
    if (typeof electronMod === 'object' && electronMod?.app?.isPackaged) {
      isPackaged = true;
    }
  } catch {
    isPackaged = false;
  }
  const nodeBin = findOnPath('node');
  const useStableNodeBridge = isPackaged && isEphemeralPortableExec() && Boolean(nodeBin);
  const useElectronAsNode = isPackaged && !useStableNodeBridge;
  const cmdBin = useStableNodeBridge
    ? nodeBin!
    : useElectronAsNode
    ? process.execPath
    : process.execPath.toLowerCase().endsWith('node.exe')
    ? process.execPath
    : nodeBin ?? 'node';
  const bridgeArgs = [useStableNodeBridge ? ensureStableBridgeCopy() : findBridgeScript()];
  const escapedCmd = cmdBin.replace(/\\/g, '\\\\');
  const escapedArgs = bridgeArgs.map((a) => `"${a.replace(/\\/g, '\\\\')}"`).join(', ');

  if (target === 'codex') {
    const cfg = codexConfigPath();
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    const existing = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
    const backup = `${cfg}.before-vectrail`;
    if (existing && !fs.existsSync(backup)) {
      fs.writeFileSync(backup, existing, 'utf8');
    }
    const cleaned = removeTomlMcpSections(existing);
    const block = [
      '[mcp_servers.vectrail]',
      `command = "${escapedCmd}"`,
      `args = [${escapedArgs}]`,
      ...(useElectronAsNode ? ['env = { ELECTRON_RUN_AS_NODE = "1" }'] : []),
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 300',
    ].join('\n');
    fs.writeFileSync(cfg, cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`, 'utf8');
  } else if (target === 'claudeCode' || target === 'claudeDesktop') {
    const cfg = target === 'claudeCode' ? claudeCodeConfigPath() : claudeDesktopConfigPath();
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    let json: Record<string, unknown> = {};
    if (fs.existsSync(cfg)) {
      try {
        json = JSON.parse(fs.readFileSync(cfg, 'utf8')) as Record<string, unknown>;
      } catch {
        json = {};
      }
    }
    const servers = ((json.mcpServers as Record<string, unknown>) ?? {});
    delete servers.editroom;
    servers.vectrail = {
      command: cmdBin,
      args: bridgeArgs,
      env: {
        ...(useElectronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        VECTRAIL_MCP_PORT: String(MCP_DEFAULT_PORT),
        VECTRAIL_MCP_CLIENT: 'Claude',
      },
    };
    json.mcpServers = servers;
    fs.writeFileSync(cfg, JSON.stringify(json, null, 2), 'utf8');
  }
  return getAgentStatuses();
}

export function disconnectAgent(target: AgentTarget): AgentTargetStatus[] {
  if (target === 'codex') {
    const cfg = codexConfigPath();
    if (fs.existsSync(cfg)) {
      const cleaned = removeTomlMcpSections(fs.readFileSync(cfg, 'utf8'));
      fs.writeFileSync(cfg, cleaned ? `${cleaned}\n` : '', 'utf8');
    }
  } else {
    const cfg = target === 'claudeCode' ? claudeCodeConfigPath() : claudeDesktopConfigPath();
    if (fs.existsSync(cfg)) {
      try {
        const json = JSON.parse(fs.readFileSync(cfg, 'utf8')) as { mcpServers?: Record<string, unknown> };
        if (json.mcpServers) {
          delete json.mcpServers.editroom;
          delete json.mcpServers.vectrail;
          fs.writeFileSync(cfg, JSON.stringify(json, null, 2), 'utf8');
        }
      } catch {
        // ignore
      }
    }
  }
  return getAgentStatuses();
}

export type MagicBackend = 'cloud' | 'local' | 'codex' | 'claude';

interface ActiveMagicControl {
  runId: string;
  aborted: boolean;
  abortHandlers: Array<() => void>;
}

let activeMagicControl: ActiveMagicControl | undefined;

export function cancelMagicRun(runId?: string): boolean {
  if (!activeMagicControl) return false;
  if (runId && activeMagicControl.runId !== runId) return false;
  activeMagicControl.aborted = true;
  for (const fn of activeMagicControl.abortHandlers) {
    try {
      fn();
    } catch {
      // ignore cleanup errors
    }
  }
  activeMagicControl.abortHandlers = [];
  return true;
}

function sleepMs(ms: number, ctrl?: ActiveMagicControl): Promise<void> {
  return new Promise((resolve) => {
    if (ctrl?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    ctrl?.abortHandlers.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function workerDisplayName(backend: MagicBackend): string {
  switch (backend) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'cloud':
      return 'Cloud AI';
    default:
      return 'Local';
  }
}

function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
  }
  return JSON.parse(candidate) as Record<string, unknown>;
}

export async function testCloudAiConnection(config: CloudAiConfig): Promise<{ ok: boolean; message: string }> {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  if (!baseUrl.startsWith('http')) {
    return { ok: false, message: 'Base URL must start with http:// or https://' };
  }
  if (!config.apiKey.trim()) {
    return { ok: false, message: 'API key is required.' };
  }
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with OK' }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status}: ${raw.slice(0, 180)}` };
    }
    return { ok: true, message: `Connected to ${config.model}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function runCloudAiMagic(
  prompt: string,
  store: ProjectStore,
  matchedAssets: Array<{ id: string; name: string; kind: string; duration: number }>,
  targetClipIds: string[],
  usesPlayhead: boolean,
  ctrl?: ActiveMagicControl,
  onProgress?: (ev: MagicProgressEvent) => void
): Promise<{ ok: boolean; summary: string; steps?: string[] }> {
  const cfg = getCloudAiConfig();
  if (!cfg.apiKey.trim()) {
    throw new Error('Configure your Cloud AI API Key in Settings -> Cloud AI first.');
  }
  const p = store.project;
  const toolDocs = MCP_TOOL_DEFINITIONS.map((t) => {
    const props = Object.keys((t.inputSchema?.properties as Record<string, unknown>) ?? {});
    return `- ${t.name}(${props.join(', ')})`;
  }).join('\n');

  const contextObj = {
    sequence: { width: p.width, height: p.height, fps: p.fps, playhead: Number(store.playhead.toFixed(2)) },
    assets: p.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind, duration: Number(a.duration.toFixed(2)) })),
    clips: p.clips.map((c) => ({
      id: c.id,
      name: clipName(p, c),
      track: c.trackID,
      kind: c.kind,
      start: Number(c.start.toFixed(2)),
      duration: Number(c.duration.toFixed(2)),
    })),
    selectedClipIds: targetClipIds,
    mentionedAssets: matchedAssets.map((a) => ({ id: a.id, name: a.name })),
    usesPlayhead,
    builtInLooks: BUILT_IN_LOOKS.map((l) => l.name),
  };

  const sysPrompt = [
    'You are the AI editing planner inside Vectrail (Windows non-linear video editor).',
    'Convert the user editing request into a short JSON sequence of MCP tool calls.',
    'Respond ONLY with valid JSON: {"summary":"short human summary","steps":[{"tool":"tool_name","args":{...}}]}',
    'Available tools:',
    toolDocs,
  ].join('\n');

  onProgress?.({
    runId: ctrl?.runId ?? '',
    stage: 'thinking',
    worker: 'Cloud AI',
    status: `Planning with ${cfg.model}`,
  });
  const abortController = new AbortController();
  ctrl?.abortHandlers.push(() => abortController.abort());
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: abortController.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: `Project state:\n${JSON.stringify(contextObj)}\n\nInstruction:\n${prompt}` },
      ],
    }),
  });
  if (ctrl?.aborted) {
    return { ok: false, summary: 'Stopped.', steps: [] };
  }
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Cloud AI HTTP ${res.status}: ${raw.slice(0, 240)}`);
  }
  const payload = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? '';
  const parsed = extractJsonObject(content);
  const steps = Array.isArray(parsed.steps)
    ? (parsed.steps as Array<{ tool?: string; args?: Record<string, unknown> }>)
    : [];
  if (!steps.length) {
    return { ok: true, summary: String(parsed.summary ?? 'No changes required.'), steps: [] };
  }

  const ranSteps: string[] = [];
  for (const step of steps.slice(0, 16)) {
    if (ctrl?.aborted) break;
    if (!step.tool) continue;
    await callMCPTool(step.tool, step.args ?? {}, store, `Cloud (${cfg.model})`);
    ranSteps.push(step.tool);
    onProgress?.({
      runId: ctrl?.runId ?? '',
      stage: 'thinking',
      worker: 'Cloud AI',
      status: `Sketching ${step.tool.replace(/_/g, ' ')}`,
      draftProject: cloneProject(store.project),
    });
  }
  return {
    ok: true,
    summary: String(parsed.summary ?? `Executed ${ranSteps.join(', ')}`),
    steps: ranSteps,
  };
}

function resolveMagicMentions(prompt: string, store: ProjectStore, selectedClipIds: string[]) {
  const p = store.project;
  const mentionTokens = [...prompt.matchAll(/@([^\s,;!?]+)/g)].map((m) => m[1].toLowerCase());
  const matchedAssets = p.assets.filter((a) =>
    mentionTokens.some((tok) => tok !== 'playhead' && a.name.toLowerCase().includes(tok))
  );
  const matchedAssetIds = new Set(matchedAssets.map((a) => a.id));
  const mentionedClipIds = p.clips
    .filter(
      (c) =>
        (c.assetID && matchedAssetIds.has(c.assetID)) ||
        mentionTokens.some((tok) => tok !== 'playhead' && clipName(p, c).toLowerCase().includes(tok))
    )
    .map((c) => c.id);
  const targetClipIds = mentionedClipIds.length
    ? mentionedClipIds
    : selectedClipIds.length
    ? selectedClipIds
    : p.clips.filter((c) => c.kind !== 'audio').map((c) => c.id);
  const usesPlayhead = mentionTokens.includes('playhead');
  return { matchedAssets, targetClipIds, usesPlayhead };
}

export async function runMagicPrompt(
  prompt: string,
  backend: MagicBackend,
  store: ProjectStore,
  selectedClipIds: string[],
  options?: {
    runId?: string;
    mcpServer?: MCPServer;
    model?: string;
    effort?: string;
    onProgress?: (ev: MagicProgressEvent) => void;
  }
): Promise<MagicRunResult> {
  const startedAt = Date.now();
  const trimmed = prompt.trim();
  const effectivePrompt =
    trimmed ||
    (store.project.clips.length > 0
      ? 'Tighten and polish this edit with balanced pacing, look, and sound.'
      : 'Make the best cut you can from the clips and music in Media.');

  const runId = options?.runId ?? `magic-${Date.now()}`;
  const worker = workerDisplayName(backend);
  const ctrl: ActiveMagicControl = { runId, aborted: false, abortHandlers: [] };
  cancelMagicRun();
  activeMagicControl = ctrl;

  const onProgress = options?.onProgress;
  const useDraft = Boolean(onProgress);
  const beforeProject = cloneProject(store.project);
  const draftStore = useDraft ? store.createDraftClone() : store;

  const emitStage = (
    stage: MagicProgressEvent['stage'],
    status?: string,
    focusAssetId?: string,
    draftProject?: MagicProgressEvent['draftProject']
  ) => {
    if (ctrl.aborted) return;
    onProgress?.({ runId, stage, worker, status, focusAssetId, draftProject });
  };

  try {
    emitStage('looking', 'Going through your media');
    await sleepMs(380, ctrl);
    if (ctrl.aborted) return { ok: false, cancelled: true, summary: 'Stopped.', worker };

    const visualAssets = draftStore.project.assets.filter((a) => a.kind !== 'audio');
    if (visualAssets.length > 0) {
      const scanCount = Math.min(visualAssets.length, 4);
      for (let i = 0; i < scanCount; i++) {
        if (ctrl.aborted) return { ok: false, cancelled: true, summary: 'Stopped.', worker };
        emitStage('analyzing', `Analyzing ${i + 1} of ${visualAssets.length}`, visualAssets[i].id);
        await sleepMs(260, ctrl);
      }
    } else {
      emitStage('analyzing', 'Reading timeline');
      await sleepMs(240, ctrl);
    }
    if (ctrl.aborted) return { ok: false, cancelled: true, summary: 'Stopped.', worker };

    const { matchedAssets, targetClipIds, usesPlayhead } = resolveMagicMentions(
      effectivePrompt,
      draftStore,
      selectedClipIds
    );

    let outcome: { ok: boolean; summary: string; steps?: string[] };

    if (backend === 'cloud') {
      outcome = await runCloudAiMagic(
        effectivePrompt,
        draftStore,
        matchedAssets,
        targetClipIds,
        usesPlayhead,
        ctrl,
        onProgress
      );
    } else if (backend === 'local') {
      const lower = effectivePrompt.toLowerCase();
      const actions: string[] = [];
      emitStage('thinking', 'Sketching edit');

      if (lower.includes('undo') || lower.includes('撤销')) {
        await callMCPTool('history', { action: 'undo' }, store, 'Local');
        return { ok: true, summary: 'Undid the previous edit.', worker, changed: false };
      }
      if (lower.includes('redo') || lower.includes('重做')) {
        await callMCPTool('history', { action: 'redo' }, store, 'Local');
        return { ok: true, summary: 'Redid the edit.', worker, changed: false };
      }

      // Frame shape adjustments (vertical 9:16, square 1:1, portrait 4:5, horizontal 16:9)
      if (lower.includes('vertical') || lower.includes('9:16') || lower.includes('reel') || lower.includes('tiktok') || lower.includes('竖屏')) {
        await callMCPTool('set_sequence', { width: 1080, height: 1920, lock: true }, draftStore, 'Local');
        actions.push('Set 9:16 vertical frame');
      } else if (lower.includes('square') || lower.includes('1:1') || lower.includes('方形')) {
        await callMCPTool('set_sequence', { width: 1080, height: 1080, lock: true }, draftStore, 'Local');
        actions.push('Set 1:1 square frame');
      } else if (lower.includes('portrait') || lower.includes('4:5')) {
        await callMCPTool('set_sequence', { width: 1080, height: 1350, lock: true }, draftStore, 'Local');
        actions.push('Set 4:5 portrait frame');
      } else if (lower.includes('horizontal') || lower.includes('16:9') || lower.includes('横屏')) {
        await callMCPTool('set_sequence', { width: 1920, height: 1080, lock: true }, draftStore, 'Local');
        actions.push('Set 16:9 widescreen frame');
      }

      const wantsNewCut =
        lower.includes('auto') ||
        lower.includes('montage') ||
        lower.includes('highlight') ||
        lower.includes('beat') ||
        lower.includes('quick cut') ||
        lower.includes('new ') ||
        lower.includes('timelapse') ||
        lower.includes('calm') ||
        lower.includes('混剪') ||
        lower.includes('节奏') ||
        draftStore.project.clips.length === 0;

      if (wantsNewCut && draftStore.project.assets.length > 0 && !lower.includes('only grade')) {
        const secMatch = lower.match(/(\d{1,3})\s*(?:s|sec|second|seconds|秒)/);
        const targetSec = secMatch ? Math.min(180, Math.max(5, Number(secMatch[1]))) : undefined;
        const pace =
          lower.includes('fast') || lower.includes('quick') || lower.includes('punchy')
            ? 'fast'
            : lower.includes('calm') || lower.includes('slow')
            ? 'slow'
            : undefined;
        const onlyIds = matchedAssets.length ? matchedAssets.map((a) => a.id) : undefined;
        await callMCPTool(
          'auto_edit',
          {
            ...(onlyIds ? { only: onlyIds } : {}),
            ...(targetSec ? { duration: targetSec } : {}),
            ...(pace ? { pace } : {}),
          },
          draftStore,
          'Local'
        );
        actions.push(targetSec ? `Built ${targetSec}s beat-synced cut` : 'Built beat-synced cut');
        emitStage('thinking', 'Laying out timeline', undefined, cloneProject(draftStore.project));
        await sleepMs(260, ctrl);
      }

      if (lower.includes('tighten') || lower.includes('shorter') || lower.includes('clean')) {
        const vClips = draftStore.project.clips.filter((c) => c.kind !== 'audio').sort((a, b) => a.start - b.start);
        if (vClips.length > 0) {
          draftStore.mutate((draft) => {
            const fps = draft.fps || 30;
            for (const vt of draft.videoTracks) {
              const lane = draft.clips.filter((c) => c.trackID === vt.id && c.kind !== 'text').sort((a, b) => a.start - b.start);
              let cursor = lane[0]?.start ?? 0;
              for (const c of lane) {
                if (c.duration > 1.6) {
                  const trimAmt = Math.min(0.35, c.duration * 0.16);
                  c.sourceStart = (c.sourceStart ?? 0) + trimAmt * 0.5;
                  c.duration = snapFrame(Math.max(0.7, c.duration - trimAmt), fps);
                }
                c.start = snapFrame(cursor, fps);
                cursor = c.start + c.duration;
              }
            }
          });
          actions.push('Tightened shot pacing');
          emitStage('thinking', 'Tightening pacing', undefined, cloneProject(draftStore.project));
        }
      }

      if (lower.includes('even out') || lower.includes('level') || lower.includes('normalize')) {
        const aClips = draftStore.project.clips.filter((c) => c.kind === 'audio' || c.kind === 'video');
        if (aClips.length > 0) {
          draftStore.mutate((draft) => {
            for (const c of draft.clips) {
              if (c.kind === 'audio') c.gainDB = -6;
            }
          });
          actions.push('Balanced audio levels');
        }
      }

      const activeTargets = targetClipIds.length
        ? targetClipIds
        : draftStore.project.clips.filter((c) => c.kind !== 'audio').map((c) => c.id);

      if (
        lower.includes('timelapse') ||
        lower.includes('slow') ||
        lower.includes('ramp') ||
        lower.includes('慢放') ||
        lower.includes('变速') ||
        /\d+(?:\.\d+)?\s*x/.test(lower)
      ) {
        const speedMatch = lower.match(/(\d+(?:\.\d+)?)\s*x/);
        const spd = speedMatch
          ? Math.min(16, Math.max(0.1, Number(speedMatch[1])))
          : lower.includes('timelapse')
          ? 8
          : 0.5;
        for (const cid of activeTargets.slice(0, 6)) {
          if (lower.includes('ramp') || lower.includes('变速')) {
            await callMCPTool('set_speed_ramp', { clip_id: cid, speed: spd }, draftStore, 'Local');
          } else {
            await callMCPTool('set_speed', { clip_id: cid, speed: spd }, draftStore, 'Local');
          }
        }
        if (activeTargets.length) actions.push(`Set speed ${spd}x`);
      }

      const matchedLook = BUILT_IN_LOOKS.find((l) => lower.includes(l.name.toLowerCase()));
      if (
        matchedLook ||
        lower.includes('warm') ||
        lower.includes('film') ||
        lower.includes('grade') ||
        lower.includes('color') ||
        lower.includes('black') ||
        lower.includes('调色')
      ) {
        const lookName =
          matchedLook?.name ??
          (lower.includes('black') || lower.includes('bw') ? 'Black & White' : 'Film print');
        if (activeTargets.length) {
          await callMCPTool('set_grade', { clip_ids: activeTargets, look: lookName }, draftStore, 'Local');
          actions.push(`Applied ${lookName} look`);
        }
      }

      if (
        lower.includes('dissolve') ||
        lower.includes('wipe') ||
        lower.includes('dip') ||
        lower.includes('transition') ||
        lower.includes('smooth') ||
        lower.includes('转场')
      ) {
        const kind = lower.includes('wipe') ? 'wipe' : lower.includes('dip') ? 'dipToBlack' : 'dissolve';
        const vClips = draftStore.project.clips.filter((c) => c.kind !== 'audio').sort((a, b) => a.start - b.start);
        for (let i = 1; i < vClips.length; i++) {
          await callMCPTool('set_transition', { clip_id: vClips[i].id, kind, duration: 0.4 }, draftStore, 'Local');
        }
        if (vClips.length > 1) actions.push(`Added ${kind} transitions`);
      }

      if (lower.includes('zoom') || lower.includes('推拉') || lower.includes('缩放')) {
        const mode = lower.includes('out') ? 'out' : lower.includes('inout') ? 'inOut' : 'in';
        for (const cid of activeTargets.slice(0, 3)) {
          await callMCPTool('set_zoom', { clip_id: cid, mode, amount: 1.25 }, draftStore, 'Local');
        }
        if (activeTargets.length) actions.push(`Applied zoom ${mode}`);
      }

      const titleMatch = effectivePrompt.match(/(?:title|标题)\s*[:：]?\s*["“]?([^"”\n]+)["”]?/i);
      if (titleMatch && titleMatch[1]) {
        await callMCPTool(
          'add_title',
          { text: titleMatch[1].trim(), start: usesPlayhead ? draftStore.playhead : 0, duration: 3 },
          draftStore,
          'Local'
        );
        actions.push(`Added title "${titleMatch[1].trim()}"`);
      }

      if (lower.includes('caption') || lower.includes('subtitle') || lower.includes('字幕')) {
        await callMCPTool('set_captions', {}, draftStore, 'Local');
        actions.push('Enabled captions');
      }

      if (lower.includes('export') || lower.includes('导出')) {
        const shape =
          lower.includes('vertical') || lower.includes('9:16') || lower.includes('竖屏')
            ? 'vertical'
            : lower.includes('square') || lower.includes('1:1')
            ? 'square'
            : 'original';
        const res = await callMCPTool('export', { shape, wait: false }, draftStore, 'Local');
        actions.push(res[0].type === 'text' ? res[0].text : 'Export started');
      }

      if (actions.length === 0 && draftStore.project.assets.length > 0) {
        const res = await callMCPTool('auto_edit', {}, draftStore, 'Local');
        actions.push(res[0].type === 'text' ? res[0].text : 'Built auto-cut');
      }

      emitStage('thinking', 'Preparing edit', undefined, cloneProject(draftStore.project));
      await sleepMs(680, ctrl);
      outcome = {
        ok: true,
        summary: actions.length ? actions.join(' · ') : 'Nothing needed changing.',
        steps: actions,
      };
    } else {
      const cli = backend === 'codex' ? findOnPath('codex') : findOnPath('claude');
      if (!cli) {
        throw new Error(`${worker} CLI was not found on PATH. Connect ${worker} in Settings -> AI Agents.`);
      }

      const mentionNote = matchedAssets.length
        ? `Mentioned assets: ${matchedAssets.map((a) => `${a.name} (${a.id})`).join(', ')}. `
        : '';
      const contextLine = targetClipIds.length ? `Target clip ids: ${targetClipIds.join(', ')}. ` : '';
      const fullPrompt = `You are editing in Vectrail for Windows via the vectrail MCP server. Playhead is at ${draftStore.playhead.toFixed(2)}s. ${contextLine}User request: ${effectivePrompt}`;
      const fullPromptWithMentions = `${fullPrompt} ${mentionNote}`.trim();
      const args =
        backend === 'codex'
          ? [
              'exec',
              '--skip-git-repo-check',
              ...(options?.model ? ['--model', options.model] : []),
              ...(options?.effort ? ['-c', `model_reasoning_effort="${options.effort}"`] : []),
              fullPromptWithMentions,
            ]
          : [
              '-p',
              ...(options?.model ? ['--model', options.model] : []),
              ...(options?.effort ? ['--effort', options.effort] : []),
              fullPromptWithMentions,
            ];

      emitStage('thinking', `${worker} is planning`);

      if (useDraft && options?.mcpServer) {
        options.mcpServer.setMagicDraft(draftStore, (toolName, toolArgs, activeDraft) => {
          if (ctrl.aborted) return;
          if (toolName === 'look_at_media' || toolName === 'analyze_media') {
            const assetId = typeof toolArgs.asset_id === 'string' ? toolArgs.asset_id : undefined;
            emitStage('analyzing', `${toolName.replace(/_/g, ' ')}`, assetId);
          } else if (toolName === 'get_frame') {
            emitStage('thinking', 'Inspecting frame', undefined, cloneProject(activeDraft.project));
          } else {
            emitStage('thinking', `Planning ${toolName.replace(/_/g, ' ')}`, undefined, cloneProject(activeDraft.project));
          }
        });
      }

      outcome = await new Promise<{ ok: boolean; summary: string; steps?: string[] }>((resolve, reject) => {
        const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli);
        const proc: ChildProcess = spawn(cli, args, { windowsHide: true, shell: needsShell });
        ctrl.abortHandlers.push(() => {
          try {
            proc.kill();
          } catch {
            // ignore kill error
          }
        });
        let out = '';
        let err = '';
        proc.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
        proc.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (ctrl.aborted) {
            resolve({ ok: false, summary: 'Stopped.' });
          } else if (code === 0) {
            resolve({ ok: true, summary: out.trim() || `${worker} edit complete.` });
          } else {
            reject(new Error(err.trim() || out.trim() || `${worker} exited with code ${code}`));
          }
        });
      });
    }

    if (ctrl.aborted) {
      return { ok: false, cancelled: true, summary: 'Stopped.', worker };
    }

    const afterProject = cloneProject(draftStore.project);
    const changed = JSON.stringify(beforeProject) !== JSON.stringify(afterProject);
    const durationMs = Date.now() - startedAt;
    const detail = [
      backend === 'cloud'
        ? getCloudAiConfig().model
        : backend === 'local'
        ? 'On this PC'
        : [options?.model || `${worker} MCP`, options?.effort].filter(Boolean).join(' · '),
      `${Math.max(1, Math.round(durationMs / 1000))}s`,
    ].join(' · ');

    if (!useDraft && changed) {
      store.commitMagicProject(afterProject, trimmed, backend);
    }

    return {
      ...outcome,
      worker,
      detail,
      changed,
      durationMs,
      beforeProject,
      afterProject,
    };
  } finally {
    options?.mcpServer?.setMagicDraft(undefined);
    if (activeMagicControl?.runId === runId) {
      activeMagicControl = undefined;
    }
  }
}
