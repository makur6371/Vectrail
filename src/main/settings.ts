import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { AppUpdateInfo, CloudAiConfig } from '../shared/types';
import { getCacheDir } from './engine/ffmpeg';

interface PersistedSettings {
  cloudAi?: Partial<CloudAiConfig>;
  autoSave?: boolean;
}

const DEFAULT_CLOUD_AI: CloudAiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
};

function settingsFilePath(): string {
  return path.join(getCacheDir('Config'), 'settings.json');
}

function readSettingsFile(): PersistedSettings {
  const file = settingsFilePath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedSettings;
  } catch {
    return {};
  }
}

function writeSettingsFile(data: PersistedSettings): void {
  const file = settingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function getCloudAiConfig(): CloudAiConfig {
  const saved = readSettingsFile().cloudAi;
  return {
    baseUrl: (saved?.baseUrl ?? DEFAULT_CLOUD_AI.baseUrl).trim() || DEFAULT_CLOUD_AI.baseUrl,
    apiKey: saved?.apiKey ?? '',
    model: (saved?.model ?? DEFAULT_CLOUD_AI.model).trim() || DEFAULT_CLOUD_AI.model,
  };
}

export function saveCloudAiConfig(config: Partial<CloudAiConfig>): CloudAiConfig {
  const current = readSettingsFile();
  const next: CloudAiConfig = {
    baseUrl: (config.baseUrl ?? current.cloudAi?.baseUrl ?? DEFAULT_CLOUD_AI.baseUrl).trim() || DEFAULT_CLOUD_AI.baseUrl,
    apiKey: (config.apiKey ?? current.cloudAi?.apiKey ?? '').trim(),
    model: (config.model ?? current.cloudAi?.model ?? DEFAULT_CLOUD_AI.model).trim() || DEFAULT_CLOUD_AI.model,
  };
  writeSettingsFile({ ...current, cloudAi: next });
  return next;
}

export function getAutoSaveEnabled(): boolean {
  return readSettingsFile().autoSave ?? true;
}

export function setAutoSaveEnabled(enabled: boolean): boolean {
  const current = readSettingsFile();
  writeSettingsFile({ ...current, autoSave: enabled });
  return enabled;
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export async function checkForAppUpdates(currentVersion: string): Promise<AppUpdateInfo> {
  return new Promise((resolve) => {
    const req = https.get(
      'https://api.github.com/repos/makur6371/Vectrail/releases/latest',
      {
        headers: {
          'User-Agent': `Vectrail/${currentVersion}`,
          Accept: 'application/vnd.github+json',
        },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) {
            resolve({
              currentVersion,
              hasUpdate: false,
              error: `Release check returned HTTP ${res.statusCode ?? 0}`,
            });
            return;
          }
          try {
            const json = JSON.parse(body) as { tag_name?: string; html_url?: string };
            const latest = (json.tag_name ?? '').replace(/^v/i, '');
            const hasUpdate = Boolean(latest && compareSemver(latest, currentVersion) > 0);
            resolve({
              currentVersion,
              latestVersion: latest || currentVersion,
              hasUpdate,
              releaseUrl: json.html_url || 'https://github.com/makur6371/Vectrail/releases',
            });
          } catch {
            resolve({ currentVersion, hasUpdate: false, error: 'Failed to parse release metadata' });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ currentVersion, hasUpdate: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ currentVersion, hasUpdate: false, error: 'Update check timed out' });
    });
  });
}
