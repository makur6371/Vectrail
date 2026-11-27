import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import type { DjiRemoteMediaItem } from '../../../shared/djiTypes';
import {
  ADDR_APP,
  DUML_FLAGS_REQUEST,
  DumlFrameParser,
  decodeManifestBuffer,
  dumlCommands,
  encodeDumlFrame,
  hasManifestFrames,
  reassembleManifestChunks,
} from './duml';

const REF_HANDSHAKE = Buffer.from(
  '000064006400c005140000640000019001c005140000640014006400c00514000064000101040102',
  'hex'
);
const LIST_BASE = Buffer.from(
  '4a002a10010000000000010000002d000d0100ffffffffffffffff000100000000000000000000000000',
  'hex'
);
const LIST_TRIGGER = Buffer.from('4a040e1001000000000001000000', 'hex');
const APP_PRESENCE = Buffer.from('170046237c415050000000000002', 'hex');
const SD_QUERY_CTR = 1;
const INTERNAL_QUERY_CTR = 2;
const NEWEST_SENTINEL = 0x40000001;
const PLAYBACK_ENTER = Buffer.from('01010001', 'hex');

function buildUdpHeader(pktType: number, payloadLen: number, sessionId: number, seq: number): Buffer {
  const w0 = (1 << 15) | ((8 + payloadLen) & 0x3fff);
  const hdr = Buffer.allocUnsafe(8);
  hdr[0] = w0 & 0xff;
  hdr[1] = (w0 >> 8) & 0xff;
  hdr[2] = sessionId & 0xff;
  hdr[3] = (sessionId >> 8) & 0xff;
  hdr[4] = seq & 0xff;
  hdr[5] = (seq >> 8) & 0xff;
  hdr[6] = pktType & 0xff;
  let xor = 0;
  for (let i = 0; i < 7; i++) xor ^= hdr[i];
  hdr[7] = xor;
  return hdr;
}

async function tcpPoke7001(cameraIp: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = net.createConnection({ host: cameraIp, port: 7001, timeout: 1500 }, () => {
      try {
        socket.write(dumlCommands.setPairingPin(0x8092, 'vectrail-win', 'osmo'));
      } catch {
        // ignore write errors
      }
      socket.end();
      resolve();
    });
    socket.on('error', () => resolve());
    socket.on('timeout', () => {
      socket.destroy();
      resolve();
    });
  });
}

export async function isCameraHttpReachable(cameraIp: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.request(
      `http://${cameraIp}/`,
      { method: 'HEAD', timeout: 2000 },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildListCommand(requestCtr: number, cursor: number): Buffer {
  const payload = Buffer.from(LIST_BASE);
  payload[4] = requestCtr;
  payload.writeUInt32LE(cursor >>> 0, 10);
  return payload;
}

function cameraReceiver(receiverType: number, receiverId: number): number {
  return ((receiverId << 5) | receiverType) & 0xff;
}

export async function queryCameraMediaOverWifi(
  cameraIp = '192.168.2.1',
  port = 9004,
  poke = true
): Promise<Array<Omit<DjiRemoteMediaItem, 'alreadyImported' | 'localPath'>>> {
  const reachable = await isCameraHttpReachable(cameraIp);
  if (!reachable) {
    throw new Error(
      `Cannot reach DJI camera at ${cameraIp}. Connect Windows Wi-Fi to the camera hotspot first.`
    );
  }

  if (poke) {
    await tcpPoke7001(cameraIp);
    await delay(300);
  }

  const socket = dgram.createSocket('udp4');
  const parser = new DumlFrameParser();
  const frames: ReturnType<DumlFrameParser['feed']> = [];
  socket.on('message', (msg) => {
    frames.push(...parser.feed(msg));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });

    const sessionId = 0x1000 + Math.floor(Math.random() * 0xeffe);
    const baseSeq = (0x1000 + Math.floor(Math.random() * 0xe000)) & 0xfff8;
    let cameraChannel = baseSeq;
    const syn = Buffer.concat([Buffer.from([baseSeq & 0xff, (baseSeq >> 8) & 0xff]), REF_HANDSHAKE.subarray(2)]);
    let handshakeReply = false;
    for (let attempt = 0; attempt < 20 && !handshakeReply; attempt++) {
      socket.send(Buffer.concat([buildUdpHeader(0x00, syn.length, sessionId, 0), syn]), port, cameraIp);
      await delay(350);
      handshakeReply = frames.length > 0;
    }
    if (!handshakeReply) {
      throw new Error('DJI datalink handshake timed out.');
    }

    let udpSeq = (cameraChannel + 8) & 0xffff;
    let dumlSeq = 0xa000;
    let cmdCtr = 0;

    const sendDl = (cmdSet: number, cmdId: number, payload: Buffer, receiver = cameraReceiver(0x01, 0x00)) => {
      cmdCtr += 1;
      const ack = (udpSeq - 8) & 0xffff;
      const rt = Buffer.from([
        ack & 0xff,
        (ack >> 8) & 0xff,
        udpSeq & 0xff,
        (udpSeq >> 8) & 0xff,
        0,
        0,
        0,
        0,
        cmdCtr & 0xff,
        0x01,
        0,
        0,
      ]);
      const frame = encodeDumlFrame({
        sender: ADDR_APP,
        receiver,
        msgId: dumlSeq,
        flags: DUML_FLAGS_REQUEST,
        cmdSet,
        cmdId,
        payload,
      });
      dumlSeq = (dumlSeq + 1) & 0xffff;
      const pkt = Buffer.concat([buildUdpHeader(0x05, rt.length + frame.length, sessionId, udpSeq), rt, frame]);
      udpSeq = (udpSeq + 8) & 0xffff;
      socket.send(pkt, port, cameraIp);
    };

    sendDl(0x00, 0x88, APP_PRESENCE, cameraReceiver(0x08, 0x01));
    sendDl(0x02, 0x0c, PLAYBACK_ENTER);
    await delay(400);

    sendDl(0x00, 0x26, buildListCommand(SD_QUERY_CTR, 1));
    let lastCount = -1;
    let stableBatches = 0;
    for (let batch = 0; batch < 15; batch++) {
      await delay(800);
      if (batch === 1) sendDl(0x00, 0x26, LIST_TRIGGER);
      if (batch === 2) sendDl(0x00, 0x26, buildListCommand(INTERNAL_QUERY_CTR, NEWEST_SENTINEL));
      if (batch === 4 && !hasManifestFrames(frames)) break;

      const byStorage = decodeManifestBuffer(reassembleManifestChunks(frames, SD_QUERY_CTR), 0)
        .map((item) => ({ ...item, storage: 0 as const }));
      const internal = decodeManifestBuffer(reassembleManifestChunks(frames, INTERNAL_QUERY_CTR), 1)
        .map((item) => ({ ...item, storage: 1 as const }));
      let items = [...internal, ...byStorage];
      const seen = new Set<string>();
      items = items.filter((item) => {
        const key = `${item.storage}:${item.mediaPath}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (items.length === 0) {
        items = decodeManifestBuffer(reassembleManifestChunks(frames), 0);
      }

      if (items.length > 0 && items.length === lastCount) {
        stableBatches++;
        if (batch >= 4 && stableBatches >= 2) return items;
      } else {
        stableBatches = 0;
      }
      lastCount = items.length;
    }
    return decodeManifestBuffer(reassembleManifestChunks(frames), 0);
  } finally {
    // Leave playback best-effort after the datalink scope has closed.
    try {
      socket.close();
    } catch {
      // ignore close errors
    }
  }
}
