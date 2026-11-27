import type { DjiRemoteMediaItem } from '../../../shared/djiTypes';

export const DUML_SOF = 0x55;
export const DUML_OVERHEAD = 13;
export const DUML_FLAGS_REQUEST = 0x40;
export const DUML_FLAGS_RESPONSE = 0xc0;
export const DUML_FLAGS_PUSH = 0x00;

export const ADDR_APP = 0x02;
export const ADDR_CAMERA = 0x01;
export const ADDR_WIFI = 0x07;
export const ADDR_SESSION = 0xf0;
export const ADDR_WAKE = 0x1c;

export function crc8(data: Uint8Array): number {
  let crc = 0x77;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >> 1) ^ 0x8c : crc >> 1;
    }
  }
  return crc & 0xff;
}

export function crc16(data: Uint8Array): number {
  let crc = 0x3692;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

export interface DumlFrame {
  sender: number;
  receiver: number;
  msgId: number;
  flags: number;
  cmdSet: number;
  cmdId: number;
  payload: Buffer;
}

export function encodeDumlFrame(frame: DumlFrame): Buffer {
  const total = DUML_OVERHEAD + frame.payload.length;
  if (total > 0x3ff) {
    throw new Error(`DUML frame too long: ${total}`);
  }
  const head = Buffer.allocUnsafe(4);
  head[0] = DUML_SOF;
  head[1] = total & 0xff;
  head[2] = 0x04 | ((total >> 8) & 0x03);
  head[3] = crc8(head.subarray(0, 3));

  const body = Buffer.allocUnsafe(7 + frame.payload.length);
  body[0] = frame.sender & 0xff;
  body[1] = frame.receiver & 0xff;
  body[2] = frame.msgId & 0xff;
  body[3] = (frame.msgId >> 8) & 0xff;
  body[4] = frame.flags & 0xff;
  body[5] = frame.cmdSet & 0xff;
  body[6] = frame.cmdId & 0xff;
  frame.payload.copy(body, 7);

  const withoutCrc16 = Buffer.concat([head, body]);
  const c16 = crc16(withoutCrc16);
  const tail = Buffer.from([c16 & 0xff, (c16 >> 8) & 0xff]);
  return Buffer.concat([withoutCrc16, tail]);
}

export function decodeDumlFramePrefix(data: Buffer): { frame: DumlFrame; bytesUsed: number } {
  if (data.length < DUML_OVERHEAD) throw new Error('short frame');
  if (data[0] !== DUML_SOF) throw new Error('bad SOF');
  if (crc8(data.subarray(0, 3)) !== data[3]) throw new Error('bad header CRC8');
  const total = data[1] | ((data[2] & 0x03) << 8);
  if (total < DUML_OVERHEAD || data.length < total) throw new Error('truncated frame');
  const expectedCrc16 = data[total - 2] | (data[total - 1] << 8);
  if (crc16(data.subarray(0, total - 2)) !== expectedCrc16) throw new Error('bad CRC16');
  return {
    frame: {
      sender: data[4],
      receiver: data[5],
      msgId: data[6] | (data[7] << 8),
      flags: data[8],
      cmdSet: data[9],
      cmdId: data[10],
      payload: Buffer.from(data.subarray(11, total - 2)),
    },
    bytesUsed: total,
  };
}

export class DumlFrameParser {
  private buf = Buffer.alloc(0);

  feed(chunk: Buffer): DumlFrame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: DumlFrame[] = [];
    while (this.buf.length > 0) {
      const sofIdx = this.buf.indexOf(DUML_SOF);
      if (sofIdx < 0) {
        this.buf = Buffer.alloc(0);
        break;
      }
      if (sofIdx > 0) this.buf = this.buf.subarray(sofIdx);
      if (this.buf.length < DUML_OVERHEAD) break;
      if (crc8(this.buf.subarray(0, 3)) !== this.buf[3]) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      const total = this.buf[1] | ((this.buf[2] & 0x03) << 8);
      if (total < DUML_OVERHEAD) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (this.buf.length < total) break;
      try {
        const { frame, bytesUsed } = decodeDumlFramePrefix(this.buf.subarray(0, total));
        out.push(frame);
        this.buf = this.buf.subarray(bytesUsed);
      } catch {
        this.buf = this.buf.subarray(1);
      }
    }
    return out;
  }
}

export function packDumlString(value: string): Buffer {
  const raw = Buffer.from(value, 'utf8');
  if (raw.length > 0xff) throw new Error('PackString exceeds 255 bytes');
  return Buffer.concat([Buffer.from([raw.length]), raw]);
}

export const dumlCommands = {
  sessionOpen: (msgId: number) =>
    encodeDumlFrame({
      sender: ADDR_APP,
      receiver: ADDR_SESSION,
      msgId,
      flags: DUML_FLAGS_REQUEST,
      cmdSet: 0x00,
      cmdId: 0x2b,
      payload: Buffer.from([0x04, 0x00]),
    }),
  sessionKeepalive: (msgId: number) =>
    encodeDumlFrame({
      sender: ADDR_APP,
      receiver: ADDR_SESSION,
      msgId,
      flags: DUML_FLAGS_REQUEST,
      cmdSet: 0x00,
      cmdId: 0x2b,
      payload: Buffer.from([0x01, 0x01]),
    }),
  wake: (msgId: number) =>
    encodeDumlFrame({
      sender: ADDR_APP,
      receiver: ADDR_WAKE,
      msgId,
      flags: DUML_FLAGS_REQUEST,
      cmdSet: 0x53,
      cmdId: 0x10,
      payload: Buffer.alloc(4),
    }),
  setPairingPin: (msgId: number, identifier: string, token = 'osmo') =>
    encodeDumlFrame({
      sender: ADDR_APP,
      receiver: ADDR_WIFI,
      msgId,
      flags: DUML_FLAGS_REQUEST,
      cmdSet: 0x07,
      cmdId: 0x45,
      payload: Buffer.concat([packDumlString(identifier), packDumlString(token)]),
    }),
  pairingApprovalAck: (msgId: number) =>
    encodeDumlFrame({
      sender: ADDR_APP,
      receiver: ADDR_WIFI,
      msgId,
      flags: DUML_FLAGS_RESPONSE,
      cmdSet: 0x07,
      cmdId: 0x46,
      payload: Buffer.from([0x00]),
    }),
  getWifiSsid: (msgId: number) =>
    encodeDumlFrame({
      sender: ADDR_APP,
      receiver: ADDR_WIFI,
      msgId,
      flags: DUML_FLAGS_REQUEST,
      cmdSet: 0x07,
      cmdId: 0x07,
      payload: Buffer.alloc(0),
    }),
  getWifiPassword: (msgId: number) =>
    encodeDumlFrame({
      sender: ADDR_APP,
      receiver: ADDR_WIFI,
      msgId,
      flags: DUML_FLAGS_REQUEST,
      cmdSet: 0x07,
      cmdId: 0x0e,
      payload: Buffer.alloc(0),
    }),
};

function readPathTlv(buf: Buffer, i: number, sub: number, prefix: string): { value: string; nextIndex: number } | null {
  if (i + 6 > buf.length || buf[i] !== 0x1a) return null;
  if (buf[i + 2] !== 0 || buf[i + 3] !== 0 || buf[i + 4] !== 0 || buf[i + 5] !== sub) return null;
  const slen = buf[i + 1] - 6;
  if (slen < prefix.length || i + 6 + slen > buf.length) return null;
  const value = buf.subarray(i + 6, i + 6 + slen).toString('ascii');
  if (!value.startsWith(prefix)) return null;
  return { value, nextIndex: i + 6 + slen };
}

export function reassembleManifestChunks(frames: DumlFrame[], requestCtr?: number): Buffer {
  const chunks: Buffer[] = [];
  for (const frame of frames) {
    if (frame.cmdSet !== 0x00 || frame.cmdId !== 0x27) continue;
    const pl = frame.payload;
    if (pl.length <= 10 || pl[0] !== 0x4a || pl[1] !== 0x01) continue;
    if (requestCtr !== undefined && pl[4] !== requestCtr) continue;
    chunks.push(pl.subarray(10));
  }
  return Buffer.concat(chunks);
}

export function hasManifestFrames(frames: DumlFrame[]): boolean {
  return frames.some((frame) => frame.cmdSet === 0x00 && frame.cmdId === 0x27);
}

export function decodeManifestBuffer(
  buf: Buffer,
  storage: 0 | 1 = 0
): Array<Omit<DjiRemoteMediaItem, 'alreadyImported' | 'localPath'>> {
  const medias: Array<{ pos: number; end: number; path: string }> = [];
  let i = 0;
  while (i < buf.length) {
    const found = readPathTlv(buf, i, 1, 'DCIM/');
    if (found) {
      medias.push({ pos: i, end: found.nextIndex, path: found.value });
      i = found.nextIndex;
    } else {
      i++;
    }
  }

  const items: Array<Omit<DjiRemoteMediaItem, 'alreadyImported' | 'localPath'>> = [];
  for (let k = 0; k < medias.length; k++) {
    const { pos, end, path: mediaPath } = medias[k];
    const lo = k > 0 ? medias[k - 1].end : 0;
    const hi = k + 1 < medias.length ? medias[k + 1].pos : buf.length;
    const parts = mediaPath.split('/');
    const folder = parts[1] ?? '';
    const base = parts[parts.length - 1] ?? mediaPath;

    let ext = '';
    const needle = Buffer.from(`${base}.`, 'ascii');
    for (let j = lo; j < hi - 2 - needle.length; j++) {
      if (buf[j] === 0x0d && buf.subarray(j + 2, j + 2 + needle.length).equals(needle)) {
        const fldEnd = Math.min(buf.length, j + 2 + buf[j + 1]);
        ext = buf.subarray(j + 2 + needle.length, fldEnd).toString('ascii').toUpperCase();
        break;
      }
    }

    let thumbPath: string | undefined;
    for (let t = end; t < hi; t++) {
      const tf = readPathTlv(buf, t, 2, 'MISC/');
      if (tf) {
        thumbPath = tf.value;
        break;
      }
    }

    let handle = 0;
    let size = 0;
    let star = false;
    let foundMarker = false;
    for (let p = lo; p < pos - 1; p++) {
      if (buf[p] === 0x19 && buf[p + 1] === 0x06 && p >= 1 && (buf[p - 1] === 0xfe || buf[p - 1] === 0xff)) {
        if (p - 10 >= 0) handle = buf.readUInt32LE(p - 10);
        if (p - 14 >= 0) size = buf.readUInt32LE(p - 14);
        if (p + 7 < buf.length && buf[p + 7] !== 0x1a && p + 8 < buf.length) {
          if (buf[p + 8] === 0 || buf[p + 8] === 1) star = buf[p + 8] === 1;
        }
        foundMarker = true;
        break;
      }
    }
    if (!foundMarker) {
      const q = pos - 7;
      if (q >= 14 && buf[q] === 0x19 && buf[q + 1] === 0x06) {
        handle = buf.readUInt32LE(q - 10);
        size = buf.readUInt32LE(q - 14);
      }
    }

    const name = ext ? `${base}.${ext}` : base;
    const resolvedExt = ext || (name.includes('.') ? name.split('.').pop()!.toUpperCase() : '');
    const kind = resolvedExt === 'MP4' || resolvedExt === 'MOV' ? 'video' : 'photo';
    items.push({
      id: `${storage}:${mediaPath}:${handle}`,
      handle,
      name,
      folder,
      mediaPath,
      thumbPath,
      ext: resolvedExt,
      kind,
      size,
      storage,
      star,
    });
  }
  return items;
}
