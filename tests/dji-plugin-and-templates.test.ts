import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectStore } from '../src/main/state';
import { PluginManager } from '../src/main/plugins/manager';
import {
  crc16,
  crc8,
  decodeDumlFramePrefix,
  decodeManifestBuffer,
  DumlFrameParser,
  dumlCommands,
} from '../src/main/plugins/dji-wireless-import/duml';
import { resolveDjiModel } from '../src/main/plugins/dji-wireless-import/models';
import { DjiWirelessImportService } from '../src/main/plugins/dji-wireless-import/service';
import { DjiDownloadQueue } from '../src/main/plugins/dji-wireless-import/downloadQueue';
import { MockDjiCameraServer } from '../src/main/plugins/dji-wireless-import/mockCamera';
import { hashFileSha256 } from '../src/main/plugins/dji-wireless-import/integrity';
import { CORE_16_SKILLS, EDITING_SKILLS_32, EDITING_TEMPLATES } from '../src/shared/editingTemplates';
import { PLUGIN_MARKETPLACE_CATALOG, filterMarketplacePlugins } from '../src/shared/pluginMarketplace';
import { getVectrailVersion } from '../src/main/version';

const tempDirs: string[] = [];
let prevCacheDir: string | undefined;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (prevCacheDir === undefined) delete process.env.VECTRAIL_CACHE_DIR;
  else process.env.VECTRAIL_CACHE_DIR = prevCacheDir;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('DJI DUML protocol & model resolution', () => {
  it('encodes, decodes, and resyncs DUML frames with valid CRC8/CRC16', () => {
    const encoded = dumlCommands.setPairingPin(0x2105, 'vectrail-win', 'osmo');
    expect(encoded[0]).toBe(0x55);
    expect(crc8(encoded.subarray(0, 3))).toBe(encoded[3]);
    const expectedCrc16 = encoded[encoded.length - 2] | (encoded[encoded.length - 1] << 8);
    expect(crc16(encoded.subarray(0, encoded.length - 2))).toBe(expectedCrc16);

    const { frame, bytesUsed } = decodeDumlFramePrefix(encoded);
    expect(bytesUsed).toBe(encoded.length);
    expect(frame.cmdSet).toBe(0x07);
    expect(frame.cmdId).toBe(0x45);
    expect(frame.msgId).toBe(0x2105);

    const parser = new DumlFrameParser();
    const noisy = Buffer.concat([Buffer.from([0x00, 0xff, 0x55, 0x01]), encoded.subarray(0, 8)]);
    expect(parser.feed(noisy)).toHaveLength(0);
    const parsed = parser.feed(encoded.subarray(8));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].cmdSet).toBe(0x07);
  });

  it('resolves classic and Pocket 4 Pro new-advert DJI models', () => {
    const p3 = resolveDjiModel({ 0x08aa: Buffer.from([0x20, 0x00]) }, 'OsmoPocket3');
    expect(p3.modelId).toBe(0x0020);
    expect(p3.modelName).toBe('Osmo Pocket 3');

    const bufP4P = Buffer.alloc(12);
    bufP4P.writeUInt16LE(218, 10);
    const p4p = resolveDjiModel({ 0x08aa: bufP4P }, 'CustomName');
    expect(p4p.modelId).toBe(0x0022);
    expect(p4p.modelName).toBe('Osmo Pocket 4 Pro');

    const xtra = resolveDjiModel({}, 'XtraEdgePro-1234');
    expect(xtra.spec?.datalinkPort).toBe(10004);
    expect(xtra.spec?.tcpPoke).toBe(false);
  });

  it('decodes CompositePack media manifest TLV records', () => {
    const mediaAscii = Buffer.from('DCIM/DJI_001/DJI_0001', 'ascii');
    const mediaTlv = Buffer.concat([
      Buffer.from([0x1a, mediaAscii.length + 6, 0x00, 0x00, 0x00, 0x01]),
      mediaAscii,
    ]);
    const nameAscii = Buffer.from('DJI_0001.MP4', 'ascii');
    const nameTlv = Buffer.concat([Buffer.from([0x0d, nameAscii.length]), nameAscii]);
    const headerBlock = Buffer.alloc(20);
    headerBlock.writeUInt32LE(123456, 0); // size at marker-14
    headerBlock.writeUInt32LE(0x40100140, 4); // handle at marker-10
    headerBlock[13] = 0xff;
    headerBlock[14] = 0x19;
    headerBlock[15] = 0x06;
    const buf = Buffer.concat([headerBlock, mediaTlv, nameTlv]);
    const items = decodeManifestBuffer(buf, 0);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('DJI_0001.MP4');
    expect(items[0].size).toBe(123456);
    expect(items[0].handle).toBe(0x40100140);
    expect(items[0].kind).toBe('video');
  });
});

describe('DJI Wireless Import plugin (Mock Camera + Plugin isolation)', () => {
  it('discovers simulated camera, downloads with resume + checksum, imports into ProjectStore, and handles disable', async () => {
    prevCacheDir = process.env.VECTRAIL_CACHE_DIR;
    process.env.VECTRAIL_CACHE_DIR = makeTempDir('vectrail-dji-cache-');
    const store = new ProjectStore();
    const manager = new PluginManager();
    const dji = new DjiWirelessImportService(store);
    manager.register(dji);
    await manager.initAll();

    const dlDir = makeTempDir('vectrail-dji-dl-');
    dji.updateSettings({ downloadDir: dlDir, autoImportToProject: true });

    const scanned = await dji.scanCameras(true);
    expect(scanned.discovered.length).toBeGreaterThan(0);
    const sim = scanned.discovered.find((d) => d.isSimulated)!;
    expect(sim).toBeTruthy();

    const connected = await dji.connectCamera(sim.id);
    expect(connected.status.connected).toBe(true);
    expect(connected.media.length).toBeGreaterThanOrEqual(2);

    const target = connected.media.find((m) => m.kind === 'photo')!;
    expect(target).toBeTruthy();

    // Seed a partial .part file to verify HTTP Range resume path against MockDjiCameraServer
    const partPath = path.join(dlDir, `${target.name}.part`);
    const prefixLen = Math.min(24, Math.floor(target.size / 2));
    // Fetch exact prefix from mock server first
    const prefixBuf = await new Promise<Buffer>((resolve, reject) => {
      const req = http.get(`${connected.status.cameraIp}/v2?storage=${target.storage}&path=${target.mediaPath}`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).subarray(0, prefixLen)));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    fs.writeFileSync(partPath, prefixBuf);

    dji.enqueueDownloads([target.id]);
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const st = dji.snapshot();
        const t = st.tasks.find((x) => x.mediaId === target.id);
        if (t?.status === 'done') {
          clearInterval(timer);
          resolve();
        } else if (t?.status === 'failed' || Date.now() - started > 8000) {
          clearInterval(timer);
          reject(new Error(t?.error || 'Timed out waiting for mock download'));
        }
      }, 50);
    });

    const after = dji.snapshot();
    const doneTask = after.tasks.find((x) => x.mediaId === target.id)!;
    expect(doneTask.status).toBe('done');
    expect(doneTask.resumedFrom).toBe(prefixLen);
    expect(doneTask.hashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(doneTask.destPath)).toBe(true);
    expect(store.project.assets.some((a) => path.resolve(a.path) === path.resolve(doneTask.destPath))).toBe(true);
    expect(after.media.find((m) => m.id === target.id)?.alreadyImported).toBe(true);

    // Disabling plugin isolates cleanly and rejects plugin actions without crashing core
    await manager.setEnabled('dji-wireless-import', false);
    expect(manager.isEnabled('dji-wireless-import')).toBe(false);
    await expect(dji.scanCameras(true)).rejects.toThrow(/disabled/i);
    await store.waitForIdle();
    await manager.disposeAll();
  }, 20000);

  it('surfaces clear diagnostic error when direct Wi-Fi target is unreachable instead of crashing', async () => {
    prevCacheDir = process.env.VECTRAIL_CACHE_DIR;
    process.env.VECTRAIL_CACHE_DIR = makeTempDir('vectrail-dji-wifi-');
    const store = new ProjectStore();
    const dji = new DjiWirelessImportService(store);
    const snap = await dji.connectDirectWifi(9004, '127.0.0.1');
    expect(snap.status.connected).toBe(false);
    expect(snap.status.phase).toBe('error');
    expect(snap.status.error).toMatch(/127\.0\.0\.1|hotspot/i);
  }, 10000);

  it('resets SHA-256 hash on HTTP 200 fallback, disambiguates duplicate names, and refreshes media', async () => {
    prevCacheDir = process.env.VECTRAIL_CACHE_DIR;
    process.env.VECTRAIL_CACHE_DIR = makeTempDir('vectrail-dji-polish-');
    const dlDir = makeTempDir('vectrail-dji-dup-');

    const payloadA = Buffer.from('CLIP_A_CONTENT_1234567890');
    const payloadB = Buffer.from('CLIP_B_DIFFERENT_PAYLOAD_XYZ');
    // Server ignores Range header and always responds 200 OK
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const storage = Number(url.searchParams.get('storage') ?? '0');
      const body = storage === 1 ? payloadB : payloadA;
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      // Seed stale .part file with unrelated bytes so 200 fallback must reset hash
      fs.writeFileSync(path.join(dlDir, 'DJI_0001.MP4.part'), Buffer.from('STALE_BYTES'));

      const queue = new DjiDownloadQueue({
        getBaseUrl: () => `http://127.0.0.1:${port}`,
        getDownloadDir: () => dlDir,
        getConcurrency: () => 2,
        getAutoImport: () => false,
        importer: { importLocalFile: async () => [] } as never,
        onUpdate: () => {},
      });

      const tasks = queue.enqueue([
        {
          id: '0:DCIM/100MEDIA/DJI_0001:1',
          handle: 1,
          name: 'DJI_0001.MP4',
          folder: '100MEDIA',
          mediaPath: 'DCIM/100MEDIA/DJI_0001',
          ext: 'MP4',
          kind: 'video',
          size: payloadA.length,
          storage: 0,
          star: true,
          alreadyImported: false,
        },
        {
          id: '1:DCIM/101MEDIA/DJI_0001:2',
          handle: 2,
          name: 'DJI_0001.MP4',
          folder: '101MEDIA',
          mediaPath: 'DCIM/101MEDIA/DJI_0001',
          ext: 'MP4',
          kind: 'video',
          size: payloadB.length,
          storage: 1,
          star: false,
          alreadyImported: false,
        },
      ]);

      expect(tasks).toHaveLength(2);
      expect(path.resolve(tasks[0].destPath)).not.toBe(path.resolve(tasks[1].destPath));

      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
          const list = queue.list();
          if (list.every((t) => t.status === 'done')) {
            clearInterval(timer);
            resolve();
          } else if (list.some((t) => t.status === 'failed') || Date.now() - start > 5000) {
            clearInterval(timer);
            reject(new Error('Queue did not finish'));
          }
        }, 30);
      });

      const finished = queue.list();
      const t0 = finished.find((t) => t.storage === 0)!;
      const t1 = finished.find((t) => t.storage === 1)!;
      const actualHash0 = (await hashFileSha256(t0.destPath)).hashHex;
      const actualHash1 = (await hashFileSha256(t1.destPath)).hashHex;
      expect(t0.hashHex).toBe(actualHash0);
      expect(t1.hashHex).toBe(actualHash1);
      expect(t0.resumedFrom).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const store = new ProjectStore();
    const dji = new DjiWirelessImportService(store);
    const scanned = await dji.scanCameras(true);
    const sim = scanned.discovered.find((d) => d.isSimulated)!;
    await dji.connectCamera(sim.id);
    const refreshed = await dji.refreshMedia();
    expect(refreshed.media.length).toBeGreaterThanOrEqual(2);
    expect(refreshed.status.phaseMessage).toMatch(/Refreshed/i);
    await dji.dispose();
    expect(MockDjiCameraServer).toBeDefined();
  }, 15000);
});

describe('Editing skills (16 Core / 32 Full) and composable templates', () => {
  it('exposes 16 core skills and 32 total skills with valid template references', () => {
    expect(CORE_16_SKILLS).toHaveLength(16);
    expect(EDITING_SKILLS_32).toHaveLength(32);
    const idSet = new Set(EDITING_SKILLS_32.map((s) => s.id));
    expect(idSet.size).toBe(32);
    for (const tpl of EDITING_TEMPLATES) {
      expect(tpl.skillIds.length).toBeGreaterThanOrEqual(8);
      for (const sid of tpl.skillIds) {
        expect(idSet.has(sid)).toBe(true);
      }
    }
  });
});

describe('Versioning and Plugin Marketplace catalog', () => {
  it('reads unified version from package.json and keeps marketplace catalog consistent', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    expect(getVectrailVersion()).toBe(pkg.version);
    expect(pkg.version).toBe('1.2.0');

    const ids = new Set(PLUGIN_MARKETPLACE_CATALOG.map((p) => p.id));
    expect(ids.size).toBe(PLUGIN_MARKETPLACE_CATALOG.length);
    expect(ids.has('dji-wireless-import')).toBe(true);
    expect(ids.has('apple-ios-import')).toBe(true);
    expect(ids.has('editing-templates-engine')).toBe(true);
    expect(ids.has('digital-human-avatar')).toBe(true);

    const avatarMatches = filterMarketplacePlugins(PLUGIN_MARKETPLACE_CATALOG, 'ai_avatar', '数字人');
    expect(avatarMatches).toHaveLength(1);
    expect(avatarMatches[0].id).toBe('digital-human-avatar');
  });
});
