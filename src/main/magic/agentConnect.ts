import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../state';
import { callMCPTool } from '../mcp/tools';
import { MCP_DEFAULT_PORT } from '../mcp/server';
import { getCacheDir } from '../engine/ffmpeg';
import { BUILT_IN_LOOKS } from '../../shared/colorGrade';
import { clipName } from '../../shared/project';

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
  const dest = path.join(getCacheDir('Runtime'), 'editroom-mcp-bridge.js');
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

function extractCodexEditroomTargets(toml: string): { command?: string; firstArg?: string } {
  const lines = toml.split(/\r?\n/);
  let inSection = false;
  let command: string | undefined;
  let firstArg: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[mcp_servers.editroom]') {
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

function removeEditroomTomlSection(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[mcp_servers.editroom]') {
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
  const codexTargets = extractCodexEditroomTargets(codexContent);
  const codexConnected =
    codexContent.includes('[mcp_servers.editroom]') &&
    commandPathIsValid(codexTargets.command ?? '', codexTargets.firstArg);

  const claudeCli = findOnPath('claude');
  let claudeCodeConnected = false;
  if (fs.existsSync(claudeCodeConfigPath())) {
    try {
      const json = JSON.parse(fs.readFileSync(claudeCodeConfigPath(), 'utf8')) as { mcpServers?: Record<string, unknown> };
      const entry = json.mcpServers?.editroom as { command?: string; args?: string[] } | undefined;
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
      const entry = json.mcpServers?.editroom as { command?: string; args?: string[] } | undefined;
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
    const backup = `${cfg}.before-editroom`;
    if (existing && !fs.existsSync(backup)) {
      fs.writeFileSync(backup, existing, 'utf8');
    }
    const cleaned = removeEditroomTomlSection(existing);
    const block = [
      '[mcp_servers.editroom]',
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
    servers.editroom = {
      command: cmdBin,
      args: bridgeArgs,
      env: {
        ...(useElectronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        EDITROOM_MCP_PORT: String(MCP_DEFAULT_PORT),
        EDITROOM_MCP_CLIENT: 'Claude',
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
      const cleaned = removeEditroomTomlSection(fs.readFileSync(cfg, 'utf8'));
      fs.writeFileSync(cfg, cleaned ? `${cleaned}\n` : '', 'utf8');
    }
  } else {
    const cfg = target === 'claudeCode' ? claudeCodeConfigPath() : claudeDesktopConfigPath();
    if (fs.existsSync(cfg)) {
      try {
        const json = JSON.parse(fs.readFileSync(cfg, 'utf8')) as { mcpServers?: Record<string, unknown> };
        if (json.mcpServers) {
          delete json.mcpServers.editroom;
          fs.writeFileSync(cfg, JSON.stringify(json, null, 2), 'utf8');
        }
      } catch {
        // ignore
      }
    }
  }
  return getAgentStatuses();
}

export type MagicBackend = 'local' | 'codex' | 'claude';

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
  selectedClipIds: string[]
): Promise<{ ok: boolean; summary: string }> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('Enter a Magic instruction first.');
  const { matchedAssets, targetClipIds, usesPlayhead } = resolveMagicMentions(trimmed, store, selectedClipIds);

  if (backend === 'local') {
    const lower = trimmed.toLowerCase();
    const actions: string[] = [];

    if (lower.includes('undo') || lower.includes('撤销')) {
      await callMCPTool('history', { action: 'undo' }, store, 'Magic');
      return { ok: true, summary: 'Undid the previous edit.' };
    }
    if (lower.includes('redo') || lower.includes('重做')) {
      await callMCPTool('history', { action: 'redo' }, store, 'Magic');
      return { ok: true, summary: 'Redid the edit.' };
    }

    const wantsMontage =
      lower.includes('auto') ||
      lower.includes('montage') ||
      lower.includes('beat') ||
      lower.includes('cut') ||
      lower.includes('混剪') ||
      lower.includes('节奏') ||
      store.project.clips.length === 0;
    if (wantsMontage && store.project.assets.length > 0 && !lower.includes('only grade')) {
      const onlyIds = matchedAssets.length ? matchedAssets.map((a) => a.id) : undefined;
      await callMCPTool('auto_edit', onlyIds ? { only: onlyIds } : {}, store, 'Magic');
      actions.push('Built montage cut');
    }

    const activeTargets = targetClipIds.length
      ? targetClipIds
      : store.project.clips.filter((c) => c.kind !== 'audio').map((c) => c.id);

    if (lower.includes('slow') || lower.includes('ramp') || lower.includes('慢放') || lower.includes('变速')) {
      const speedMatch = lower.match(/(\d+(?:\.\d+)?)\s*x/);
      const spd = speedMatch ? Math.min(10, Math.max(0.1, Number(speedMatch[1]))) : 0.5;
      for (const cid of activeTargets.slice(0, 3)) {
        if (lower.includes('ramp') || lower.includes('变速')) {
          await callMCPTool('set_speed_ramp', { clip_id: cid, speed: spd }, store, 'Magic');
        } else {
          await callMCPTool('set_speed', { clip_id: cid, speed: spd }, store, 'Magic');
        }
      }
      if (activeTargets.length) actions.push(`Set speed ${spd}x`);
    }

    const matchedLook = BUILT_IN_LOOKS.find((l) => lower.includes(l.name.toLowerCase()));
    if (matchedLook || lower.includes('warm') || lower.includes('film') || lower.includes('grade') || lower.includes('color') || lower.includes('调色')) {
      const lookName = matchedLook?.name ?? (lower.includes('black') || lower.includes('bw') ? 'Black & White' : 'Warm film');
      if (activeTargets.length) {
        await callMCPTool('set_grade', { clip_ids: activeTargets, look: lookName }, store, 'Magic');
        actions.push(`Applied ${lookName} grade`);
      }
    }

    if (lower.includes('dissolve') || lower.includes('wipe') || lower.includes('dip') || lower.includes('transition') || lower.includes('转场')) {
      const kind = lower.includes('wipe') ? 'wipe' : lower.includes('dip') ? 'dipToBlack' : 'dissolve';
      const vClips = store.project.clips.filter((c) => c.kind !== 'audio').sort((a, b) => a.start - b.start);
      for (let i = 1; i < vClips.length; i++) {
        await callMCPTool('set_transition', { clip_id: vClips[i].id, kind, duration: 0.4 }, store, 'Magic');
      }
      if (vClips.length > 1) actions.push(`Added ${kind} transitions`);
    }

    if (lower.includes('zoom') || lower.includes('推拉') || lower.includes('缩放')) {
      const mode = lower.includes('out') ? 'out' : lower.includes('inout') ? 'inOut' : 'in';
      for (const cid of activeTargets.slice(0, 3)) {
        await callMCPTool('set_zoom', { clip_id: cid, mode, amount: 1.25 }, store, 'Magic');
      }
      if (activeTargets.length) actions.push(`Applied zoom ${mode}`);
    }

    const titleMatch = trimmed.match(/(?:title|标题)\s*[:：]?\s*["“]?([^"”\n]+)["”]?/i);
    if (titleMatch && titleMatch[1]) {
      await callMCPTool(
        'add_title',
        { text: titleMatch[1].trim(), start: usesPlayhead ? store.playhead : 0, duration: 3 },
        store,
        'Magic'
      );
      actions.push(`Added title "${titleMatch[1].trim()}"`);
    }

    if (lower.includes('caption') || lower.includes('subtitle') || lower.includes('字幕')) {
      await callMCPTool('set_captions', {}, store, 'Magic');
      actions.push('Enabled captions');
    }

    if (lower.includes('export') || lower.includes('导出')) {
      const shape =
        lower.includes('vertical') || lower.includes('9:16') || lower.includes('竖屏')
          ? 'vertical'
          : lower.includes('square') || lower.includes('1:1')
          ? 'square'
          : 'original';
      const res = await callMCPTool('export', { shape, wait: false }, store, 'Magic');
      actions.push(res[0].type === 'text' ? res[0].text : 'Export started');
    }

    if (actions.length > 0) {
      return { ok: true, summary: actions.join(' · ') };
    }
    const res = await callMCPTool('auto_edit', {}, store, 'Magic');
    return { ok: true, summary: res[0].type === 'text' ? res[0].text : 'Built auto-cut.' };
  }

  const cli = backend === 'codex' ? findOnPath('codex') : findOnPath('claude');
  if (!cli) {
    throw new Error(`${backend === 'codex' ? 'Codex' : 'Claude'} CLI was not found on PATH.`);
  }

  const mentionNote = matchedAssets.length
    ? `Mentioned assets: ${matchedAssets.map((a) => `${a.name} (${a.id})`).join(', ')}. `
    : '';
  const contextLine = targetClipIds.length ? `Target clip ids: ${targetClipIds.join(', ')}. ` : '';
  const fullPrompt = `You are editing in Editroom for Windows via the editroom MCP server. Playhead is at ${store.playhead.toFixed(2)}s. ${contextLine}User request: ${trimmed}`;
  const fullPromptWithMentions = `${fullPrompt} ${mentionNote}`.trim();
  const args =
    backend === 'codex'
      ? ['exec', '--skip-git-repo-check', fullPromptWithMentions]
      : ['-p', fullPromptWithMentions];

  store.setAgentCursor({ name: backend === 'codex' ? 'Codex' : 'Claude', activity: 'working on Magic edit' });

  return new Promise((resolve, reject) => {
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli);
    const proc = spawn(cli, args, { windowsHide: true, shell: needsShell });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, summary: out.trim() || 'Magic edit complete.' });
      } else {
        reject(new Error(err.trim() || out.trim() || `${backend} exited with code ${code}`));
      }
    });
  });
}
