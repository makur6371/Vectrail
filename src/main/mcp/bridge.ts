import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const MCP_DEFAULT_PORT = 47920;

function resolveRuntimeDir(): string {
  const override = process.env.EDITROOM_CACHE_DIR;
  if (override) return path.join(override, 'Runtime');
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'EditroomWindows', 'Runtime');
}

function resolveActivePort(explicitPort?: number): number {
  if (explicitPort && explicitPort > 0) return explicitPort;
  const envPort = Number.parseInt(process.env.EDITROOM_MCP_PORT || '', 10);
  if (envPort > 0) return envPort;
  try {
    const pf = path.join(resolveRuntimeDir(), 'mcp-port.json');
    if (fs.existsSync(pf)) {
      const info = JSON.parse(fs.readFileSync(pf, 'utf8')) as { port?: number };
      if (info.port && info.port > 0) return info.port;
    }
  } catch {
    // fall back to default
  }
  return MCP_DEFAULT_PORT;
}

function forwardToServer(line: string, port: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(line, 'utf8');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.byteLength,
          'X-Editroom-Client': process.env.EDITROOM_MCP_CLIENT || 'Codex',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 202) resolve(undefined);
          else resolve(Buffer.concat(chunks).toString('utf8'));
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export function runStdioMcpBridge(port?: number): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('close', () => {
    process.exit(0);
  });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const reply = await forwardToServer(trimmed, resolveActivePort(port));
      if (reply) process.stdout.write(`${reply}\n`);
    } catch {
      let id: unknown = null;
      try {
        id = (JSON.parse(trimmed) as { id?: unknown }).id ?? null;
      } catch {
        id = null;
      }
      if (id !== null) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: 'Editroom for Windows is not running. Launch Editroom and open a project first.',
            },
          }) + '\n'
        );
      }
    }
  });
}

if (require.main === module) {
  const portArg = Number.parseInt(process.env.EDITROOM_MCP_PORT || '', 10) || undefined;
  runStdioMcpBridge(portArg);
}
