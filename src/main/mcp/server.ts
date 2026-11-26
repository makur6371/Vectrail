import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { ProjectStore } from '../state';
import { getCacheDir } from '../engine/ffmpeg';
import { callMCPTool, MCP_INSTRUCTIONS, MCP_TOOL_DEFINITIONS } from './tools';

export const MCP_DEFAULT_PORT = 47920;

function runtimePortFile(): string {
  return path.join(getCacheDir('Runtime'), 'mcp-port.json');
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface MCPClientInfo {
  id: string;
  name: string;
  lastSeen: number;
}

export class MCPServer {
  private server?: http.Server;
  private store: ProjectStore;
  private onStatusChange?: () => void;
  private magicDraft?: {
    store: ProjectStore;
    onTool?: (name: string, args: Record<string, unknown>, draftStore: ProjectStore) => void;
  };
  running = false;
  listeningPort?: number;
  problem?: string;
  clients = new Map<string, MCPClientInfo>();
  enabled = true;

  constructor(store: ProjectStore, onStatusChange?: () => void) {
    this.store = store;
    this.onStatusChange = onStatusChange;
  }

  setMagicDraft(
    draftStore?: ProjectStore,
    onTool?: (name: string, args: Record<string, unknown>, draftStore: ProjectStore) => void
  ): void {
    this.magicDraft = draftStore ? { store: draftStore, onTool } : undefined;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.listeningPort ?? MCP_DEFAULT_PORT}/mcp`;
  }

  start(port = MCP_DEFAULT_PORT): void {
    if (this.server || !this.enabled) return;
    const srv = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    srv.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        this.server = undefined;
        this.problem = 'Another copy of Vectrail is using port 47920; running on dynamic port.';
        this.start(0);
      } else {
        this.running = false;
        this.problem = err.message;
        this.onStatusChange?.();
      }
    });
    srv.listen(port, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo | null;
      this.listeningPort = addr?.port ?? port;
      this.running = true;
      if (port === MCP_DEFAULT_PORT) this.problem = undefined;
      try {
        fs.writeFileSync(
          runtimePortFile(),
          JSON.stringify({ port: this.listeningPort, pid: process.pid }),
          'utf8'
        );
      } catch {
        // ignore runtime file write errors
      }
      this.onStatusChange?.();
    });
    this.server = srv;
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = undefined;
    this.running = false;
    this.listeningPort = undefined;
    try {
      const pf = runtimePortFile();
      if (fs.existsSync(pf)) {
        const data = JSON.parse(fs.readFileSync(pf, 'utf8')) as { pid?: number };
        if (data.pid === process.pid) fs.unlinkSync(pf);
      }
    } catch {
      // ignore cleanup error
    }
    this.onStatusChange?.();
  }

  setEnabled(val: boolean): void {
    this.enabled = val;
    if (val) this.start();
    else this.stop();
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, X-Vectrail-Client, X-Editroom-Client');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: this.listeningPort, tools: MCP_TOOL_DEFINITIONS.length }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const rawHeader = req.headers['x-vectrail-client'] ?? req.headers['x-editroom-client'];
    const clientHeader = typeof rawHeader === 'string' && rawHeader.trim() ? rawHeader.trim() : '';
    const response = await this.handleRpc(rpc, clientHeader);
    if (response === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  async handleRpc(rpc: JsonRpcRequest, fallbackClient = ''): Promise<Record<string, unknown> | null> {
    const id = rpc.id ?? null;
    const method = rpc.method ?? '';
    const params = rpc.params ?? {};

    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return null;
    }

    if (method === 'initialize') {
      const clientInfo = (params.clientInfo as { name?: string } | undefined)?.name ?? (fallbackClient || 'Agent');
      const normalized = clientInfo.toLowerCase().includes('claude')
        ? 'Claude'
        : clientInfo.toLowerCase().includes('codex') || clientInfo.toLowerCase().includes('chatgpt')
        ? 'Codex'
        : clientInfo;
      this.clients.set(normalized, { id: normalized, name: normalized, lastSeen: Date.now() });
      this.onStatusChange?.();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'vectrail', version: '1.0.0' },
          instructions: MCP_INSTRUCTIONS,
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOL_DEFINITIONS },
      };
    }

    if (method === 'tools/call') {
      const name = String(params.name ?? '');
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      const clientName = fallbackClient || [...this.clients.values()].pop()?.name || 'Agent';
      this.clients.set(clientName, { id: clientName, name: clientName, lastSeen: Date.now() });
      this.onStatusChange?.();
      try {
        const activeStore = this.magicDraft?.store ?? this.store;
        const content = await callMCPTool(name, args, activeStore, clientName);
        if (this.magicDraft) {
          this.magicDraft.onTool?.(name, args, activeStore);
        }
        return { jsonrpc: '2.0', id, result: { content, isError: false } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: msg }], isError: true },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }
}
