import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DjiCameraDevice, DjiRemoteMediaItem } from '../../../shared/djiTypes';

export interface MockMediaEntry {
  item: Omit<DjiRemoteMediaItem, 'alreadyImported' | 'localPath'>;
  payload: Buffer;
}

function findSampleMp4(): Buffer {
  const candidates = [
    path.resolve(process.cwd(), 'build', 'Base.mp4'),
    path.resolve(__dirname, '../../../../build/Base.mp4'),
    path.resolve(process.resourcesPath ?? '', 'Base.mp4'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      try {
        return fs.readFileSync(p);
      } catch {
        // ignore
      }
    }
  }
  return Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
}

export class MockDjiCameraServer {
  private server: http.Server | null = null;
  private port = 0;
  private entries: MockMediaEntry[] = [];

  readonly device: DjiCameraDevice = {
    id: 'sim-osmo-pocket-4-pro',
    address: 'SIM:00:11:22:33:44',
    name: 'OsmoPocket4P-Sim',
    modelId: 0x0022,
    modelName: 'Osmo Pocket 4 Pro (Simulated)',
    rssi: -42,
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    isSimulated: true,
    lastSeenAt: Date.now(),
  };

  constructor(customEntries?: MockMediaEntry[]) {
    if (customEntries) {
      this.entries = customEntries;
    } else {
      const sample = findSampleMp4();
      const photoSvg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#18181b"/><text x="32" y="180" fill="#ff4a1c" font-size="24">DJI Osmo Simulated Frame</text></svg>',
        'utf8'
      );
      this.entries = [
        {
          item: {
            id: '0:DCIM/DJI_001/DJI_20261127_120100_0001:1074790720',
            handle: 0x40100140,
            name: 'DJI_20261127_120100_0001.MP4',
            folder: 'DJI_001',
            mediaPath: 'DCIM/DJI_001/DJI_20261127_120100_0001',
            ext: 'MP4',
            kind: 'video',
            size: sample.length,
            storage: 0,
            star: true,
            capturedAt: '2026-11-27 12:01:00',
          },
          payload: sample,
        },
        {
          item: {
            id: '1:DCIM/DJI_001/DJI_20261127_120512_0002:1074790784',
            handle: 0x40100180,
            name: 'DJI_20261127_120512_0002.MP4',
            folder: 'DJI_001',
            mediaPath: 'DCIM/DJI_001/DJI_20261127_120512_0002',
            ext: 'MP4',
            kind: 'video',
            size: sample.length,
            storage: 1,
            star: false,
            capturedAt: '2026-11-27 12:05:12',
          },
          payload: sample,
        },
        {
          item: {
            id: '0:DCIM/DJI_001/DJI_20261127_120830_0003:1074790848',
            handle: 0x401001c0,
            name: 'DJI_20261127_120830_0003.SVG',
            folder: 'DJI_001',
            mediaPath: 'DCIM/DJI_001/DJI_20261127_120830_0003',
            ext: 'SVG',
            kind: 'photo',
            size: photoSvg.length,
            storage: 0,
            star: false,
            capturedAt: '2026-11-27 12:08:30',
          },
          payload: photoSvg,
        },
      ];
    }
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  listMedia(): Array<Omit<DjiRemoteMediaItem, 'alreadyImported' | 'localPath'>> {
    return this.entries.map((e) => ({ ...e.item }));
  }

  async start(): Promise<string> {
    if (this.server) return this.baseUrl;
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/v2') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const storage = Number(url.searchParams.get('storage') ?? '0');
      const mediaPath = url.searchParams.get('path') ?? '';
      const entry = this.entries.find((e) => e.item.storage === storage && e.item.mediaPath === mediaPath);
      if (!entry) {
        res.writeHead(404);
        res.end('Media not found');
        return;
      }
      const total = entry.payload.length;
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(total), 'Accept-Ranges': 'bytes' });
        res.end();
        return;
      }
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/i.exec(range);
        if (!m) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }
        const start = Number(m[1]);
        const end = m[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
        if (start >= total || start < 0 || end < start) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }
        const slice = entry.payload.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Length': String(slice.length),
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'Content-Length': String(total), 'Accept-Ranges': 'bytes' });
      res.end(entry.payload);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.port = 0;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}
