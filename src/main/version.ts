import fs from 'node:fs';
import path from 'node:path';

let cachedVersion: string | null = null;

/** Resolve the single-source application version from package.json. */
export function getVectrailVersion(): string {
  if (cachedVersion) return cachedVersion;
  const candidates = [
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(__dirname, '../../package.json'),
    path.resolve(__dirname, '../../../package.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string };
      if (parsed.version && parsed.version.trim()) {
        cachedVersion = parsed.version.trim();
        return cachedVersion;
      }
    } catch {
      // try next package.json candidate
    }
  }
  cachedVersion = '1.1.0';
  return cachedVersion;
}
