import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../state';
import { callMCPTool, MCP_TOOL_DEFINITIONS } from '../mcp/tools';
import { MCP_DEFAULT_PORT, MCPServer } from '../mcp/server';
import { getCacheDir } from '../engine/ffmpeg';
import { getCloudAiConfig } from '../settings';
import { analyzeMusicAsset, analyzeVisualAsset, computeClipSceneTags, getMediaNote } from '../engine/analyzer';
import { BUILT_IN_LOOKS } from '../../shared/colorGrade';
import { planLocalMagic } from '../../shared/localMagic';
import { buildClipLabels, buildMarkerLabels, findMentions } from '../../shared/magicMentions';
import { clipName, cloneProject, trackLabel } from '../../shared/project';
import {
  CloudAiConfig,
  MagicBackend,
  MagicProcessStep,
  MagicProgressEvent,
  MagicRunResult,
  MagicStage,
} from '../../shared/types';

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

export function ensureStableBridgeCopy(): string {
  const src = findBridgeScript();
  const dest = path.join(getCacheDir('Runtime'), 'vectrail-mcp-bridge.js');
  try {
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    return src;
  }
}

function resolveWinCliCommand(
  cli: string,
  args: string[],
  backend: 'codex' | 'claude'
): { bin: string; args: string[]; shell: boolean } {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(cli)) {
    return { bin: cli, args, shell: false };
  }
  const shimDir = path.dirname(cli);
  const nodeBin = findOnPath('node');
  try {
    const cmdText = fs.readFileSync(cli, 'utf8');
    const quotedTargets = [...cmdText.matchAll(/"([^"]+)"/g)].map((m) =>
      m[1].replace(/%~?dp0%?/gi, shimDir + path.sep).replace(/[\\/]+/g, path.sep)
    );
    const exeTarget = quotedTargets.find((t) => t.toLowerCase().endsWith('.exe') && fs.existsSync(t));
    if (exeTarget) {
      return { bin: exeTarget, args, shell: false };
    }
    const jsTarget = quotedTargets.find((t) => /\.(m?js|cjs)$/i.test(t) && fs.existsSync(t));
    if (nodeBin && jsTarget) {
      return { bin: nodeBin, args: [jsTarget, ...args], shell: false };
    }
  } catch {
    // fall through to known package layout checks
  }
  if (backend === 'codex') {
    const codexJs = path.join(shimDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (nodeBin && fs.existsSync(codexJs)) {
      return { bin: nodeBin, args: [codexJs, ...args], shell: false };
    }
  } else {
    const claudeExe = path.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(claudeExe)) {
      return { bin: claudeExe, args, shell: false };
    }
  }
  return { bin: cli, args, shell: true };
}

function extractCliError(stderr: string, stdout: string, worker: string, code: number | null): string {
  const combined = `${stderr}\n${stdout}`;
  const lines = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !l.includes('ERROR codex_core::session::session: failed to load skill') &&
        !l.startsWith('OpenAI Codex v') &&
        l !== '--------' &&
        !/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(l)
    );
  const errorLines = [...new Set(lines.filter((l) => /^error\b|failed|not supported|unauthorized|authentication/i.test(l)))];
  const picked = (errorLines.length > 0 ? errorLines : lines.slice(-6)).join('\n').trim();
  if (!picked) return `${worker} exited with code ${code ?? 'unknown'}.`;
  return picked.length > 600 ? `${picked.slice(0, 597)}...` : picked;
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
  const useStableNodeBridge = isPackaged && Boolean(nodeBin);
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

export type { MagicBackend };

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

function summarizeToolArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (!entries.length) return '';
  return entries
    .slice(0, 4)
    .map(([k, v]) => {
      const raw = typeof v === 'string' ? v : JSON.stringify(v);
      const compact = raw.length > 36 ? `${raw.slice(0, 35)}…` : raw;
      return `${k}=${compact}`;
    })
    .join(', ');
}

function summarizeToolResult(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 110 ? `${clean.slice(0, 109)}…` : clean;
}

type EmitStepFn = (
  step: MagicProcessStep,
  extra?: {
    stage?: MagicStage;
    status?: string;
    focusAssetId?: string;
    draftProject?: MagicProgressEvent['draftProject'];
  }
) => void;

async function runCloudAiMagic(
  prompt: string,
  store: ProjectStore,
  matchedAssets: Array<{ id: string; name: string; kind: string; duration: number }>,
  targetClipIds: string[],
  usesPlayhead: boolean,
  ctrl?: ActiveMagicControl,
  emitStep?: EmitStepFn
): Promise<{ ok: boolean; summary: string; steps?: string[] }> {
  const cfg = getCloudAiConfig();
  if (!cfg.apiKey.trim()) {
    throw new Error('Configure your Cloud AI API Key in Settings -> Cloud AI first.');
  }
  const toolDocs = MCP_TOOL_DEFINITIONS.map((t) => {
    const propMap = (t.inputSchema?.properties as Record<string, { type?: string; enum?: string[]; description?: string }>) ?? {};
    const argsDoc = Object.entries(propMap)
      .map(([k, v]) => {
        const ty = v.enum ? v.enum.join('|') : v.type ?? 'any';
        return `${k}: ${ty}`;
      })
      .join(', ');
    return `- ${t.name}(${argsDoc}): ${t.description}`;
  }).join('\n');

  const buildContext = () => {
    const p = store.project;
    return {
      sequence: {
        width: p.width,
        height: p.height,
        fps: p.fps,
        playhead: Number(store.playhead.toFixed(2)),
        playRange: p.playRange ?? null,
        tracks: {
          video: p.videoTracks.map((t, i) => `V${i + 1}${t.hidden ? ' (hidden)' : ''}${t.locked ? ' (locked)' : ''}`),
          audio: p.audioTracks.map((t, i) => `A${i + 1}${t.muted ? ' (muted)' : ''}${t.locked ? ' (locked)' : ''}`),
        },
      },
      assets: p.assets.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        duration: Number(a.duration.toFixed(2)),
        ...(store.musicAnalyses[a.id]?.bpm ? { bpm: Math.round(store.musicAnalyses[a.id].bpm) } : {}),
        ...(getMediaNote(a.path)?.text ? { notes: getMediaNote(a.path)!.text } : {}),
        ...(store.transcripts[a.id]?.words?.length
          ? { transcriptPreview: store.transcripts[a.id].words.slice(0, 24).map((w) => w.text).join(' ') }
          : {}),
      })),
      clips: p.clips.map((c) => ({
        id: c.id,
        name: clipName(p, c),
        track: trackLabel(p, c.trackID),
        kind: c.kind,
        start: Number(c.start.toFixed(2)),
        duration: Number(c.duration.toFixed(2)),
        ...(c.grade ? { grade: c.grade } : {}),
        ...(c.transitionIn ? { transitionIn: c.transitionIn } : {}),
        ...(c.text ? { text: c.text.string } : {}),
      })),
      markers: (p.markers ?? []).map((m) => ({ id: m.id, time: Number(m.time.toFixed(2)), name: m.name })),
      selectedClipIds: targetClipIds,
      mentionedAssets: matchedAssets.map((a) => ({ id: a.id, name: a.name })),
      usesPlayhead,
      builtInLooks: BUILT_IN_LOOKS.map((l) => l.name),
    };
  };

  const sysPrompt = [
    'You are the AI editing planner inside Vectrail (Windows non-linear video editor).',
    'Track names are V1, V2, ... and A1, A2, .... Always pass clip_id/clip_ids or asset_id from Project state.',
    'Convert the user editing request into a clean JSON sequence of MCP tool calls.',
    'Respond ONLY with valid JSON: {"summary":"short human summary","steps":[{"tool":"tool_name","args":{...}}]}',
    'Available tools:',
    toolDocs,
  ].join('\n');

  const readOnlyTools = new Set(['get_project', 'list_media', 'analyze_media', 'get_transcript', 'search_media', 'list_looks']);
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: `Project state:\n${JSON.stringify(buildContext())}\n\nInstruction:\n${prompt}` },
  ];
  const ranSteps: string[] = [];
  let finalSummary = '';

  for (let round = 0; round < 4; round++) {
    if (ctrl?.aborted) {
      return { ok: false, summary: 'Stopped.', steps: ranSteps };
    }
    const roundStepId = `cloud-round-${round + 1}`;
    emitStep?.(
      {
        id: roundStepId,
        timestamp: Date.now(),
        stage: 'thinking',
        title: round === 0 ? `Cloud AI planning (${cfg.model})` : `Cloud AI refining (round ${round + 1})`,
        detail: `Sending context & ${MCP_TOOL_DEFINITIONS.length} tools`,
        status: 'running',
      },
      {
        stage: 'thinking',
        status: round === 0 ? `Planning with ${cfg.model}` : `Refining plan with ${cfg.model}`,
      }
    );
    const abortController = new AbortController();
    ctrl?.abortHandlers.push(() => abortController.abort());
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
        messages,
      }),
    });
    if (ctrl?.aborted) {
      return { ok: false, summary: 'Stopped.', steps: ranSteps };
    }
    const raw = await res.text();
    if (!res.ok) {
      emitStep?.({
        id: roundStepId,
        timestamp: Date.now(),
        stage: 'thinking',
        title: `Cloud AI planning (round ${round + 1})`,
        detail: `HTTP ${res.status}`,
        status: 'error',
      });
      throw new Error(`Cloud AI HTTP ${res.status}: ${raw.slice(0, 240)}`);
    }
    const payload = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? '';
    const parsed = extractJsonObject(content);
    finalSummary = String(parsed.summary ?? '');
    const steps = Array.isArray(parsed.steps)
      ? (parsed.steps as Array<{ tool?: string; args?: Record<string, unknown> }>)
      : [];
    emitStep?.({
      id: roundStepId,
      timestamp: Date.now(),
      stage: 'thinking',
      title: `Cloud AI plan (round ${round + 1})`,
      detail: finalSummary
        ? `${finalSummary} (${steps.length} step${steps.length === 1 ? '' : 's'})`
        : `${steps.length} tool step${steps.length === 1 ? '' : 's'}`,
      status: 'done',
    });
    if (!steps.length) {
      return { ok: true, summary: finalSummary || 'No changes required.', steps: ranSteps };
    }

    const toolResults: Array<{ tool: string; result: string }> = [];
    let didEdit = false;
    const cappedSteps = steps.slice(0, 16);
    for (let idx = 0; idx < cappedSteps.length; idx++) {
      const step = cappedSteps[idx];
      if (ctrl?.aborted) break;
      if (!step.tool) continue;
      const stepId = `cloud-tool-${round + 1}-${idx + 1}`;
      const argsSummary = summarizeToolArgs(step.args ?? {});
      emitStep?.(
        {
          id: stepId,
          timestamp: Date.now(),
          stage: 'thinking',
          title: step.tool,
          detail: argsSummary || undefined,
          toolName: step.tool,
          status: 'running',
        },
        {
          stage: 'thinking',
          status: `Running ${step.tool.replace(/_/g, ' ')}`,
        }
      );
      let out: Array<{ type: string; text?: string }>;
      try {
        out = await callMCPTool(step.tool, step.args ?? {}, store, `Cloud (${cfg.model})`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        emitStep?.({
          id: stepId,
          timestamp: Date.now(),
          stage: 'thinking',
          title: step.tool,
          detail: [argsSummary, errMsg].filter(Boolean).join(' -> '),
          toolName: step.tool,
          status: 'error',
        });
        throw err;
      }
      ranSteps.push(step.tool);
      const txt = out.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      toolResults.push({ tool: step.tool, result: txt.slice(0, 1200) });
      if (!readOnlyTools.has(step.tool)) didEdit = true;
      const resSummary = summarizeToolResult(txt);
      emitStep?.(
        {
          id: stepId,
          timestamp: Date.now(),
          stage: 'thinking',
          title: step.tool,
          detail: [argsSummary, resSummary].filter(Boolean).join(' -> ') || undefined,
          toolName: step.tool,
          status: 'done',
        },
        {
          stage: 'thinking',
          status: `Sketching ${step.tool.replace(/_/g, ' ')}`,
          draftProject: cloneProject(store.project),
        }
      );
    }
    if (didEdit || round === 3) break;
    messages.push(
      { role: 'assistant', content },
      {
        role: 'user',
        content: `Tool results:\n${JSON.stringify(toolResults)}\nUpdated state:\n${JSON.stringify(buildContext())}\nNow return the editing steps as JSON.`,
      }
    );
  }
  return {
    ok: true,
    summary: finalSummary || `Executed ${ranSteps.join(', ')}`,
    steps: ranSteps,
  };
}

function resolveMagicMentions(prompt: string, store: ProjectStore, selectedClipIds: string[]) {
  const p = store.project;
  const clipLabels = buildClipLabels(p);
  const markerLabels = buildMarkerLabels(p);
  const found = findMentions(prompt, p.assets, clipLabels, markerLabels);
  const pointedAssetIds = new Set<string>();
  const pointedClipIds = new Set<string>();
  const markerNotes: string[] = [];
  let usesPlayhead = false;
  let usesRange = false;
  let usesSelected = false;
  for (const m of found) {
    if (m.mention.kind === 'media') pointedAssetIds.add(m.mention.id);
    else if (m.mention.kind === 'clip') pointedClipIds.add(m.mention.id);
    else if (m.mention.kind === 'playhead') usesPlayhead = true;
    else if (m.mention.kind === 'range') usesRange = true;
    else if (m.mention.kind === 'selected') usesSelected = true;
    else if (m.mention.kind === 'marker') {
      const markerId = m.mention.id;
      const lbl = markerLabels.find((mk) => mk.id === markerId);
      if (lbl) markerNotes.push(`${lbl.name} @ ${lbl.time.toFixed(2)}s`);
    }
  }
  const mentionTokens = [...prompt.matchAll(/@([^\s,;!?]+)/g)].map((m) => m[1].toLowerCase());
  const matchedAssets = p.assets.filter((a) =>
    pointedAssetIds.has(a.id) ||
    mentionTokens.some((tok) => tok !== 'playhead' && tok !== 'selected' && tok !== 'in-out' && a.name.toLowerCase().includes(tok))
  );
  const matchedAssetIds = new Set(matchedAssets.map((a) => a.id));
  const mentionedClipIds = p.clips
    .filter(
      (c) =>
        pointedClipIds.has(c.id) ||
        (c.assetID && matchedAssetIds.has(c.assetID)) ||
        mentionTokens.some((tok) => tok !== 'playhead' && tok !== 'selected' && tok !== 'in-out' && clipName(p, c).toLowerCase().includes(tok))
    )
    .map((c) => c.id);
  const targetClipIds = usesSelected && selectedClipIds.length
    ? [...new Set([...mentionedClipIds, ...selectedClipIds])]
    : mentionedClipIds.length
    ? mentionedClipIds
    : selectedClipIds.length
    ? selectedClipIds
    : p.clips.filter((c) => c.kind !== 'audio').map((c) => c.id);
  return { matchedAssets, targetClipIds, usesPlayhead: usesPlayhead || mentionTokens.includes('playhead'), usesRange, markerNotes };
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
    onProgress?.({ runId, stage, worker, backend, status, focusAssetId, draftProject });
  };

  const processSteps: MagicProcessStep[] = [];
  const emitStep: EmitStepFn = (step, extra) => {
    if (ctrl.aborted) return;
    const idx = processSteps.findIndex((s) => s.id === step.id);
    if (idx >= 0) processSteps[idx] = step;
    else processSteps.push(step);
    onProgress?.({
      runId,
      stage: extra?.stage ?? step.stage,
      worker,
      backend,
      status: extra?.status,
      focusAssetId: extra?.focusAssetId,
      draftProject: extra?.draftProject,
      step,
    });
  };

  try {
    emitStep(
      {
        id: 'scan-media',
        timestamp: Date.now(),
        stage: 'looking',
        title: 'Scan media & timeline',
        detail: `${draftStore.project.assets.length} asset(s), ${draftStore.project.clips.length} clip(s)`,
        status: 'running',
      },
      { stage: 'looking', status: 'Going through your media' }
    );
    await sleepMs(380, ctrl);
    if (ctrl.aborted) return { ok: false, cancelled: true, summary: 'Stopped.', worker, backend, processSteps };
    emitStep({
      id: 'scan-media',
      timestamp: Date.now(),
      stage: 'looking',
      title: 'Scan media & timeline',
      detail: `${draftStore.project.assets.length} asset(s), ${draftStore.project.clips.length} clip(s)`,
      status: 'done',
    });

    const visualAssets = draftStore.project.assets.filter((a) => a.kind !== 'audio');
    if (visualAssets.length > 0) {
      const scanCount = Math.min(visualAssets.length, 4);
      for (let i = 0; i < scanCount; i++) {
        if (ctrl.aborted) return { ok: false, cancelled: true, summary: 'Stopped.', worker, backend, processSteps };
        emitStep(
          {
            id: 'analyze-media',
            timestamp: Date.now(),
            stage: 'analyzing',
            title: 'Analyze visual media',
            detail: `${i + 1} / ${visualAssets.length}: ${visualAssets[i].name}`,
            status: 'running',
          },
          { stage: 'analyzing', status: `Analyzing ${i + 1} of ${visualAssets.length}`, focusAssetId: visualAssets[i].id }
        );
        await sleepMs(260, ctrl);
      }
      emitStep({
        id: 'analyze-media',
        timestamp: Date.now(),
        stage: 'analyzing',
        title: 'Analyze visual media',
        detail: `${visualAssets.length} visual asset(s) ready`,
        status: 'done',
      });
    } else {
      emitStep(
        {
          id: 'analyze-media',
          timestamp: Date.now(),
          stage: 'analyzing',
          title: 'Read timeline state',
          detail: `${draftStore.project.clips.length} clip(s)`,
          status: 'done',
        },
        { stage: 'analyzing', status: 'Reading timeline' }
      );
      await sleepMs(240, ctrl);
    }
    if (ctrl.aborted) return { ok: false, cancelled: true, summary: 'Stopped.', worker, backend, processSteps };

    const { matchedAssets, targetClipIds, usesPlayhead, usesRange, markerNotes } = resolveMagicMentions(
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
        emitStep
      );
    } else if (backend === 'local') {
      const lower = effectivePrompt.toLowerCase();
      emitStage('thinking', 'Sketching edit');

      if (lower.includes('undo') || lower.includes('撤销')) {
        emitStep({
          id: 'local-history',
          timestamp: Date.now(),
          stage: 'editing',
          title: 'history (undo)',
          toolName: 'history',
          detail: 'Undoing previous timeline change',
          status: 'done',
        });
        await callMCPTool('history', { action: 'undo' }, store, 'Local');
        return { ok: true, summary: 'Undid the previous edit.', worker, backend, changed: false, processSteps };
      }
      if (lower.includes('redo') || lower.includes('重做')) {
        emitStep({
          id: 'local-history',
          timestamp: Date.now(),
          stage: 'editing',
          title: 'history (redo)',
          toolName: 'history',
          detail: 'Redoing timeline change',
          status: 'done',
        });
        await callMCPTool('history', { action: 'redo' }, store, 'Local');
        return { ok: true, summary: 'Redid the edit.', worker, backend, changed: false, processSteps };
      }

      let analyzedLocalCount = 0;
      for (const a of draftStore.project.assets) {
        if (ctrl.aborted) return { ok: false, cancelled: true, summary: 'Stopped.', worker, backend, processSteps };
        if (a.kind === 'audio') {
          if (!draftStore.musicAnalyses[a.id]) {
            emitStep({
              id: 'local-analyze',
              timestamp: Date.now(),
              stage: 'analyzing',
              title: 'Analyze beats & visual scenes',
              detail: a.name,
              status: 'running',
            });
            const ma = await analyzeMusicAsset(a);
            if (ma) {
              draftStore.musicAnalyses[a.id] = ma;
              store.musicAnalyses[a.id] = ma;
              analyzedLocalCount++;
            }
          }
        } else if (!draftStore.clipAnalyses[a.id]) {
          emitStep({
            id: 'local-analyze',
            timestamp: Date.now(),
            stage: 'analyzing',
            title: 'Analyze beats & visual scenes',
            detail: a.name,
            status: 'running',
          });
          const va = await analyzeVisualAsset(a);
          if (va) {
            draftStore.clipAnalyses[a.id] = va;
            store.clipAnalyses[a.id] = va;
            const tags = computeClipSceneTags(va);
            draftStore.sceneTags[a.id] = tags;
            store.sceneTags[a.id] = tags;
            analyzedLocalCount++;
          }
        }
      }
      if (analyzedLocalCount > 0) {
        emitStep({
          id: 'local-analyze',
          timestamp: Date.now(),
          stage: 'analyzing',
          title: 'Analyze beats & visual scenes',
          detail: `Computed analysis for ${analyzedLocalCount} asset(s)`,
          status: 'done',
        });
      }

      if (lower.includes('export') || lower.includes('导出')) {
        const shape =
          lower.includes('vertical') || lower.includes('9:16') || lower.includes('竖屏')
            ? 'vertical'
            : lower.includes('square') || lower.includes('1:1')
            ? 'square'
            : lower.includes('portrait') || lower.includes('4:5')
            ? 'portrait'
            : 'original';
        emitStep({
          id: 'local-export',
          timestamp: Date.now(),
          stage: 'editing',
          title: 'export',
          toolName: 'export',
          detail: `shape=${shape}`,
          status: 'running',
        });
        const res = await callMCPTool('export', { shape, wait: false }, draftStore, 'Local');
        const exportSummary = res[0].type === 'text' ? res[0].text : 'Export started';
        emitStep({
          id: 'local-export',
          timestamp: Date.now(),
          stage: 'editing',
          title: 'export',
          toolName: 'export',
          detail: summarizeToolResult(exportSummary),
          status: 'done',
        });
        outcome = {
          ok: true,
          summary: exportSummary,
          steps: ['export'],
        };
      } else {
        emitStep({
          id: 'local-plan',
          timestamp: Date.now(),
          stage: 'thinking',
          title: 'Local rule & beat planner',
          detail: matchedAssets.length
            ? `Targeting ${matchedAssets.map((a) => a.name).join(', ')}`
            : `Evaluating ${draftStore.project.assets.length} asset(s)`,
          status: 'running',
        });
        const range = draftStore.project.playRange
          ? { start: draftStore.project.playRange.in, end: draftStore.project.playRange.out }
          : undefined;
        const localRes = planLocalMagic(trimmed, {
          project: draftStore.project,
          pointers: {
            playhead: draftStore.playhead,
            selected: selectedClipIds,
            range,
          },
          clipAnalyses: draftStore.clipAnalyses,
          musicAnalyses: draftStore.musicAnalyses,
          transcripts: draftStore.transcripts,
          waveforms: draftStore.waveforms,
          sceneTags: draftStore.sceneTags,
        });
        if (localRes.nextProject) {
          draftStore.replaceProject(localRes.nextProject, false);
        }
        emitStep({
          id: 'local-plan',
          timestamp: Date.now(),
          stage: 'thinking',
          title: 'Local rule & beat planner',
          detail: localRes.summary,
          status: 'done',
        });
        (localRes.notes ?? []).forEach((note, idx) => {
          emitStep({
            id: `local-note-${idx + 1}`,
            timestamp: Date.now(),
            stage: 'editing',
            title: note,
            status: 'done',
          });
        });
        emitStage('thinking', 'Preparing edit', undefined, cloneProject(draftStore.project));
        await sleepMs(420, ctrl);
        outcome = {
          ok: true,
          summary: localRes.summary,
          steps: localRes.notes,
        };
      }
    } else {
      const cli = backend === 'codex' ? findOnPath('codex') : findOnPath('claude');
      if (!cli) {
        throw new Error(`${worker} CLI was not found on PATH. Connect ${worker} in Settings -> AI Agents.`);
      }

      const mentionNote = matchedAssets.length
        ? `Mentioned assets: ${matchedAssets.map((a) => `${a.name} (${a.id})`).join(', ')}. `
        : '';
      const rangeNote = usesRange && draftStore.project.playRange
        ? `In/Out range: ${draftStore.project.playRange.in.toFixed(2)}s-${draftStore.project.playRange.out.toFixed(2)}s. `
        : '';
      const markerNote = markerNotes.length ? `Markers: ${markerNotes.join(', ')}. ` : '';
      const contextLine = targetClipIds.length ? `Target clip ids: ${targetClipIds.join(', ')}. ` : '';
      const fullPrompt = `You are editing in Vectrail for Windows via the vectrail MCP server. Playhead is at ${draftStore.playhead.toFixed(2)}s. ${contextLine}User request: ${effectivePrompt}`;
      const fullPromptWithMentions = `${fullPrompt} ${mentionNote}${rangeNote}${markerNote}`.trim();
      const selectedModel = options?.model?.trim();
      const selectedEffort = options?.effort?.trim();
      const args =
        backend === 'codex'
          ? [
              'exec',
              '--skip-git-repo-check',
              ...(selectedModel ? ['--model', selectedModel] : []),
              ...(selectedEffort ? ['-c', `model_reasoning_effort=${selectedEffort}`] : []),
              '-',
            ]
          : [
              '-p',
              ...(selectedModel ? ['--model', selectedModel] : []),
              ...(selectedEffort ? ['--effort', selectedEffort] : []),
            ];

      const cliStepId = 'cli-session';
      const cliSteps: string[] = [];
      emitStep(
        {
          id: cliStepId,
          timestamp: Date.now(),
          stage: 'thinking',
          title: `${worker} CLI session`,
          detail: [selectedModel || 'CLI Default', selectedEffort].filter(Boolean).join(' · '),
          status: 'running',
        },
        { stage: 'thinking', status: `${worker} is planning` }
      );

      let mcpCallCounter = 0;
      if (options?.mcpServer) {
        options.mcpServer.setMagicDraft(draftStore, (toolName, toolArgs, activeDraft, resultText, isError) => {
          if (ctrl.aborted) return;
          mcpCallCounter += 1;
          cliSteps.push(toolName);
          const argsSummary = summarizeToolArgs(toolArgs);
          const resSummary = summarizeToolResult(resultText);
          const stepStage: MagicStage =
            toolName === 'look_at_media' || toolName === 'analyze_media' ? 'analyzing' : 'thinking';
          const assetId =
            stepStage === 'analyzing' && typeof toolArgs.asset_id === 'string' ? toolArgs.asset_id : undefined;
          const statusText =
            toolName === 'get_frame'
              ? 'Inspecting frame'
              : stepStage === 'analyzing'
              ? toolName.replace(/_/g, ' ')
              : `Planning ${toolName.replace(/_/g, ' ')}`;
          emitStep(
            {
              id: `cli-mcp-${mcpCallCounter}`,
              timestamp: Date.now(),
              stage: stepStage,
              title: toolName,
              detail: [argsSummary, resSummary].filter(Boolean).join(' -> ') || undefined,
              toolName,
              status: isError ? 'error' : 'done',
            },
            {
              stage: stepStage,
              status: statusText,
              focusAssetId: assetId,
              draftProject: stepStage === 'analyzing' ? undefined : cloneProject(activeDraft.project),
            }
          );
        });
      }

      outcome = await new Promise<{ ok: boolean; summary: string; steps?: string[] }>((resolve, reject) => {
        const resolved = resolveWinCliCommand(cli, args, backend === 'codex' ? 'codex' : 'claude');
        const proc: ChildProcess = spawn(resolved.bin, resolved.args, {
          cwd: os.tmpdir(),
          windowsHide: true,
          shell: resolved.shell,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.stdin?.write(fullPromptWithMentions);
        proc.stdin?.end();
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
            const summaryText = out.trim() || `${worker} edit complete.`;
            emitStep({
              id: cliStepId,
              timestamp: Date.now(),
              stage: 'thinking',
              title: `${worker} CLI session`,
              detail: `${mcpCallCounter} MCP tool call(s) · ${summarizeToolResult(summaryText)}`,
              status: 'done',
            });
            resolve({ ok: true, summary: summaryText, steps: cliSteps });
          } else {
            const cliErr = extractCliError(err, out, worker, code);
            emitStep({
              id: cliStepId,
              timestamp: Date.now(),
              stage: 'thinking',
              title: `${worker} CLI session`,
              detail: cliErr,
              status: 'error',
            });
            reject(new Error(cliErr));
          }
        });
      });
    }

    if (ctrl.aborted) {
      return { ok: false, cancelled: true, summary: 'Stopped.', worker, backend, processSteps };
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
      backend,
      worker,
      detail,
      changed,
      durationMs,
      beforeProject,
      afterProject,
      processSteps,
    };
  } finally {
    options?.mcpServer?.setMagicDraft(undefined);
    if (activeMagicControl?.runId === runId) {
      activeMagicControl = undefined;
    }
  }
}
