import {
  Clip,
  ClipKind,
  FadeCurve,
  MediaAsset,
  Project,
  RGBA,
  Track,
  TrackKind,
} from './types';
import { clipPlaysSource, clipSourceTimeAt, clipTimelineSpan, mirrorRamp } from './speedRamp';
import { fitZoomMove, shiftZoomMove } from './zoomMove';

export const MIN_CLIP_SECONDS = 0.05;
export const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120];

export function newId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createEmptyProject(width = 1920, height = 1080, fps = 30): Project {
  return {
    version: 1,
    width,
    height,
    fps,
    settingsLocked: false,
    assets: [],
    videoTracks: [{ id: newId(), kind: 'video' }],
    audioTracks: [{ id: newId(), kind: 'audio' }],
    clips: [],
    markers: [],
  };
}

export function cloneProject(p: Project): Project {
  return JSON.parse(JSON.stringify(p)) as Project;
}

export function standardFPS(fps: number): number {
  let best = STANDARD_FPS[0];
  let bestDiff = Infinity;
  for (const s of STANDARD_FPS) {
    const d = Math.abs(s - fps);
    if (d < bestDiff) {
      bestDiff = d;
      best = s;
    }
  }
  return best;
}

export function snapFrame(t: number, fps: number): number {
  const safeFps = Math.max(1, fps);
  return Math.round(t * safeFps) / safeFps;
}

export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

export function dbToLinear(db: number): number {
  return db <= -59.5 ? 0 : Math.pow(10, db / 20);
}

export function formatDB(db: number): string {
  if (db <= -59.5) return '-inf dB';
  const v = Math.round(db * 10) / 10;
  if (v === 0) return '0.0 dB';
  return `${v > 0 ? '+' : '-'}${Math.abs(v).toFixed(1)} dB`;
}

export function applyFadeCurve(curve: FadeCurve | undefined, x: number): number {
  const clamped = Math.min(1, Math.max(0, x));
  switch (curve ?? 'linear') {
    case 'easeIn':
      return clamped * clamped * clamped;
    case 'easeOut':
      return 1 - Math.pow(1 - clamped, 3);
    case 'smooth':
      return clamped * clamped * (3 - 2 * clamped);
    default:
      return clamped;
  }
}

export function clipFadeGainAt(c: Clip, t: number): number {
  const u = t - c.start;
  if (u < 0 || u > c.duration) return 0;
  let g = 1;
  const fi = c.fadeIn ?? 0;
  const fo = c.fadeOut ?? 0;
  if (fi > 0 && u < fi) g = Math.min(g, applyFadeCurve(c.fadeInCurve, u / fi));
  if (fo > 0 && u > c.duration - fo) g = Math.min(g, applyFadeCurve(c.fadeOutCurve, (c.duration - u) / fo));
  return g;
}

export function clampClipFades(c: Clip): void {
  const fi = Math.min(Math.max(0, c.fadeIn ?? 0), c.duration);
  const fo = Math.min(Math.max(0, c.fadeOut ?? 0), c.duration - fi);
  c.fadeIn = fi;
  c.fadeOut = fo;
}

export function trimClipHead(c: Clip, t: number): void {
  const d = t - c.start;
  const newSource = clipSourceTimeAt(c, t);
  c.start = t;
  c.duration = Math.max(MIN_CLIP_SECONDS, c.duration - d);
  if (clipPlaysSource(c)) {
    c.sourceStart = Math.max(0, newSource);
  }
  clampClipFades(c);
  if (c.transform?.zoom) {
    c.transform.zoom = shiftZoomMove(c.transform.zoom, d, c.duration);
  }
}

export function trimClipTail(c: Clip, t: number): void {
  c.duration = Math.max(MIN_CLIP_SECONDS, t - c.start);
  clampClipFades(c);
  if (c.transform?.zoom) {
    c.transform.zoom = fitZoomMove(c.transform.zoom, c.duration);
  }
}

export function projectDuration(p: Project): number {
  return p.clips.reduce((mx, c) => Math.max(mx, clipEnd(c)), 0);
}

export function tracksOfKind(p: Project, kind: TrackKind): Track[] {
  return kind === 'video' ? p.videoTracks : p.audioTracks;
}

export function trackLabel(p: Project, trackID: string): string {
  const vi = p.videoTracks.findIndex((t) => t.id === trackID);
  if (vi >= 0) return `V${vi + 1}`;
  const ai = p.audioTracks.findIndex((t) => t.id === trackID);
  if (ai >= 0) return `A${ai + 1}`;
  return '?';
}

export function resolveTrackByName(p: Project, name: string, expectedKind?: TrackKind): Track | undefined {
  const n = name.trim().toUpperCase();
  const isV = n.startsWith('V');
  const isA = n.startsWith('A');
  if (!isV && !isA) return undefined;
  const kind: TrackKind = isV ? 'video' : 'audio';
  if (expectedKind && kind !== expectedKind) return undefined;
  const idx = Number.parseInt(n.slice(1), 10);
  const list = tracksOfKind(p, kind);
  if (!Number.isFinite(idx) || idx < 1 || idx > list.length) return undefined;
  return list[idx - 1];
}

export function clipName(p: Project, c: Clip): string {
  if (c.kind === 'text') return c.text?.string?.trim() || 'Text';
  if (c.kind === 'solid') return 'Solid';
  const asset = p.assets.find((a) => a.id === c.assetID);
  return asset?.name ?? 'Clip';
}

export function linkedIds(p: Project, seedIds: string[]): Set<string> {
  const seeds = new Set(seedIds);
  const linkKeys = new Set<string>();
  for (const c of p.clips) {
    if (seeds.has(c.id) && c.linkID) linkKeys.add(c.linkID);
  }
  const out = new Set<string>(seedIds);
  if (linkKeys.size > 0) {
    for (const c of p.clips) {
      if (c.linkID && linkKeys.has(c.linkID)) out.add(c.id);
    }
  }
  return out;
}

export function isTrackLocked(p: Project, trackID: string): boolean {
  const t = [...p.videoTracks, ...p.audioTracks].find((x) => x.id === trackID);
  return Boolean(t?.locked);
}

export function addTrack(p: Project, kind: TrackKind, id?: string): Track {
  const track: Track = { id: id ?? newId(), kind };
  if (kind === 'video') p.videoTracks.push(track);
  else p.audioTracks.push(track);
  return track;
}

export function removeTrack(p: Project, trackID: string): boolean {
  const vi = p.videoTracks.findIndex((t) => t.id === trackID);
  if (vi >= 0 && p.videoTracks.length > 1) {
    p.videoTracks.splice(vi, 1);
    p.clips = p.clips.filter((c) => c.trackID !== trackID);
    return true;
  }
  const ai = p.audioTracks.findIndex((t) => t.id === trackID);
  if (ai >= 0 && p.audioTracks.length > 1) {
    p.audioTracks.splice(ai, 1);
    p.clips = p.clips.filter((c) => c.trackID !== trackID);
    return true;
  }
  return false;
}

export function freeTrack(p: Project, kind: TrackKind, start: number, duration: number): string | undefined {
  const eps = 1e-6;
  for (const t of tracksOfKind(p, kind)) {
    if (t.locked) continue;
    const busy = p.clips.some(
      (c) => c.trackID === t.id && c.start < start + duration - eps && clipEnd(c) > start + eps
    );
    if (!busy) return t.id;
  }
  return undefined;
}

export function resolveOverlaps(p: Project, keepingIds: Set<string>): void {
  const eps = 1e-6;
  const winners = p.clips.filter((c) => keepingIds.has(c.id));
  for (const m of winners) {
    const nextClips: Clip[] = [];
    for (const raw of p.clips) {
      const c = raw;
      if (
        keepingIds.has(c.id) ||
        c.trackID !== m.trackID ||
        clipEnd(c) <= m.start + eps ||
        c.start >= clipEnd(m) - eps
      ) {
        nextClips.push(c);
        continue;
      }
      const head = c.start < m.start - eps;
      const tail = clipEnd(c) > clipEnd(m) + eps;
      if (head && tail) {
        const right: Clip = JSON.parse(JSON.stringify(c)) as Clip;
        right.id = newId();
        right.linkID = undefined;
        right.fadeIn = 0;
        trimClipHead(right, clipEnd(m));
        c.fadeOut = 0;
        trimClipTail(c, m.start);
        nextClips.push(c, right);
      } else if (head) {
        trimClipTail(c, m.start);
        nextClips.push(c);
      } else if (tail) {
        trimClipHead(c, clipEnd(m));
        nextClips.push(c);
      }
    }
    p.clips = nextClips;
  }
}

export function makeClipsForAsset(
  p: Project,
  asset: MediaAsset,
  at: number,
  videoTrackID: string,
  audioTrackID: string,
  sourceStart = 0,
  duration?: number
): Clip[] {
  const dur = snapFrame(
    duration ?? (asset.kind === 'image' ? 5 : Math.max(MIN_CLIP_SECONDS, asset.duration - sourceStart)),
    p.fps
  );
  const start = snapFrame(Math.max(0, at), p.fps);
  if (asset.kind === 'audio') {
    return [
      {
        id: newId(),
        trackID: audioTrackID,
        kind: 'audio',
        assetID: asset.id,
        start,
        duration: dur,
        sourceStart,
        speed: 1,
        gainDB: 0,
      },
    ];
  }
  if (asset.kind === 'image') {
    return [
      {
        id: newId(),
        trackID: videoTrackID,
        kind: 'image',
        assetID: asset.id,
        start,
        duration: dur,
      },
    ];
  }
  const linkID = asset.hasAudio ? newId() : undefined;
  const vClip: Clip = {
    id: newId(),
    trackID: videoTrackID,
    kind: 'video',
    assetID: asset.id,
    start,
    duration: dur,
    sourceStart,
    speed: 1,
    linkID,
  };
  if (!asset.hasAudio) return [vClip];
  const aClip: Clip = {
    id: newId(),
    trackID: audioTrackID,
    kind: 'audio',
    assetID: asset.id,
    start,
    duration: dur,
    sourceStart,
    speed: 1,
    gainDB: 0,
    linkID,
  };
  return [vClip, aClip];
}

export function splitClipsAt(p: Project, targetIds: string[], t: number): string[] {
  const minDur = 0.5 / Math.max(1, p.fps);
  const created: string[] = [];
  const linkMap = new Map<string, string>();
  for (const id of targetIds) {
    const idx = p.clips.findIndex((c) => c.id === id);
    if (idx < 0) continue;
    const c = p.clips[idx];
    if (t <= c.start + minDur || t >= clipEnd(c) - minDur) continue;
    const right = JSON.parse(JSON.stringify(c)) as Clip;
    right.id = newId();
    right.fadeIn = 0;
    trimClipHead(right, t);
    if (c.linkID) {
      let mapped = linkMap.get(c.linkID);
      if (!mapped) {
        mapped = newId();
        linkMap.set(c.linkID, mapped);
      }
      right.linkID = mapped;
    }
    c.fadeOut = 0;
    trimClipTail(c, t);
    p.clips.push(right);
    created.push(right.id);
  }
  return created;
}

export function removeClips(p: Project, ids: Set<string>, ripple: boolean): void {
  const removed = p.clips.filter((c) => ids.has(c.id)).sort((a, b) => b.start - a.start);
  p.clips = p.clips.filter((c) => !ids.has(c.id));
  if (!ripple) return;
  for (const r of removed) {
    for (const c of p.clips) {
      if (c.trackID === r.trackID && c.start >= clipEnd(r) - 1e-6) {
        c.start = Math.max(0, c.start - r.duration);
      }
    }
  }
}

export function rippleDeleteRange(p: Project, a: number, b: number, trackIds: Set<string>): void {
  const allowed = new Set([...trackIds].filter((id) => !isTrackLocked(p, id)));
  const gap = b - a;
  if (gap <= 1e-9 || allowed.size === 0) return;
  splitClipsAt(
    p,
    p.clips.filter((c) => allowed.has(c.trackID) && c.start < a && clipEnd(c) > a).map((c) => c.id),
    a
  );
  splitClipsAt(
    p,
    p.clips.filter((c) => allowed.has(c.trackID) && c.start < b && clipEnd(c) > b).map((c) => c.id),
    b
  );
  const eps = 0.5 / Math.max(1, p.fps);
  p.clips = p.clips.filter(
    (c) => !(allowed.has(c.trackID) && c.start >= a - eps && clipEnd(c) <= b + eps)
  );
  for (const c of p.clips) {
    if (allowed.has(c.trackID) && c.start >= b - eps) {
      c.start = Math.max(0, snapFrame(c.start - gap, p.fps));
    }
  }
}

export function detachAudioLinks(p: Project, seedIds: string[]): string[] {
  const group = linkedIds(p, seedIds);
  for (const c of p.clips) {
    if (group.has(c.id)) c.linkID = undefined;
  }
  return [...group];
}

export function cloneClipGroup(group: Clip[], startAt: number, fps: number): Clip[] {
  if (!group.length) return [];
  const t0 = Math.min(...group.map((c) => c.start));
  const at = snapFrame(Math.max(0, startAt), fps);
  const linkMap = new Map<string, string>();
  return group.map((orig) => {
    const copy = JSON.parse(JSON.stringify(orig)) as Clip;
    copy.id = newId();
    if (copy.linkID) {
      let mapped = linkMap.get(copy.linkID);
      if (!mapped) {
        mapped = newId();
        linkMap.set(copy.linkID, mapped);
      }
      copy.linkID = mapped;
    }
    copy.start = at + (orig.start - t0);
    return copy;
  });
}

export function duplicateClips(p: Project, seedIds: string[], startAt?: number): Clip[] {
  const groupIds = linkedIds(p, seedIds);
  const group = p.clips.filter((c) => groupIds.has(c.id));
  if (!group.length) return [];
  const defaultAt = Math.max(...group.map((c) => clipEnd(c)));
  const copies = cloneClipGroup(group, startAt ?? defaultAt, p.fps);
  p.clips.push(...copies);
  resolveOverlaps(p, new Set(copies.map((c) => c.id)));
  return copies;
}

export function pasteClipGroup(p: Project, sourceClips: Clip[], startAt: number): Clip[] {
  const copies = cloneClipGroup(sourceClips, startAt, p.fps);
  for (const copy of copies) {
    const list = copy.kind === 'audio' ? p.audioTracks : p.videoTracks;
    if (!list.some((t) => t.id === copy.trackID) && list[0]) {
      copy.trackID = list[0].id;
    }
  }
  p.clips.push(...copies);
  resolveOverlaps(p, new Set(copies.map((c) => c.id)));
  return copies;
}

export function applyStickyEdgeShift(
  p: Project,
  excludeIds: Set<string>,
  trackIDs: Set<string>,
  edgeTime: number,
  delta: number
): void {
  if (Math.abs(delta) < 1e-4) return;
  const eps = 0.025;
  const candidates = p.clips
    .filter((c) => !excludeIds.has(c.id) && trackIDs.has(c.trackID) && c.start >= edgeTime - eps)
    .map((c) => c.id);
  if (!candidates.length) return;
  const affected = linkedIds(p, candidates);
  for (const c of p.clips) {
    if (excludeIds.has(c.id) || !affected.has(c.id)) continue;
    c.start = snapFrame(Math.max(0, c.start + delta), p.fps);
  }
}

export function createSolidClip(
  p: Project,
  colorHex = '#111216',
  start = 0,
  duration = 3,
  trackID?: string
): Clip {
  const rgba = hexToRgba(colorHex) ?? { r: 0.07, g: 0.07, b: 0.09, a: 1 };
  const vTrack =
    trackID && p.videoTracks.some((t) => t.id === trackID)
      ? trackID
      : p.videoTracks[0]?.id ?? addTrack(p, 'video').id;
  const clip: Clip = {
    id: newId(),
    trackID: vTrack,
    kind: 'solid',
    start: snapFrame(Math.max(0, start), p.fps),
    duration: Math.max(MIN_CLIP_SECONDS, duration),
    color: rgba,
  };
  p.clips.push(clip);
  resolveOverlaps(p, new Set([clip.id]));
  return clip;
}

export function freezeFrameClip(p: Project, clipID: string, atTime?: number, holdSeconds = 2): Clip | undefined {
  const clip = p.clips.find((c) => c.id === clipID && c.kind === 'video');
  if (!clip) return undefined;
  const at = snapFrame(
    Math.min(clipEnd(clip), Math.max(clip.start, atTime ?? clip.start + clip.duration / 2)),
    p.fps
  );
  const hold = snapFrame(Math.max(MIN_CLIP_SECONDS, holdSeconds), p.fps);
  const asset = p.assets.find((a) => a.id === clip.assetID);
  const rawSrc = clipSourceTimeAt(clip, at);
  const srcTime = clip.reversed && asset ? Math.max(0, asset.duration - rawSrc) : rawSrc;
  const groupIds = [...linkedIds(p, [clip.id])];
  if (at > clip.start + 1 / p.fps && at < clipEnd(clip) - 1 / p.fps) {
    splitClipsAt(p, groupIds, at);
  }
  for (const c of p.clips) {
    if ((c.trackID === clip.trackID || groupIds.includes(c.id)) && c.start >= at - 1e-4) {
      c.start = snapFrame(c.start + hold, p.fps);
    }
  }
  const frozen: Clip = {
    id: newId(),
    trackID: clip.trackID,
    kind: 'video',
    assetID: clip.assetID,
    start: at,
    duration: hold,
    sourceStart: srcTime,
    speed: 1,
    freeze: true,
    grade: clip.grade ? JSON.parse(JSON.stringify(clip.grade)) : undefined,
    transform: clip.transform ? { ...clip.transform, zoom: undefined } : undefined,
  };
  p.clips.push(frozen);
  resolveOverlaps(p, new Set([frozen.id]));
  return frozen;
}

export function reverseClipGroup(p: Project, clipID: string): string[] {
  const groupIds = [...linkedIds(p, [clipID])];
  for (const id of groupIds) {
    const c = p.clips.find((x) => x.id === id);
    if (!c || !clipPlaysSource(c)) continue;
    const asset = p.assets.find((a) => a.id === c.assetID);
    const len = asset?.duration;
    if (c.ramp && len) {
      c.ramp = mirrorRamp(c.ramp, len);
    }
    c.reversed = !c.reversed || undefined;
  }
  return groupIds;
}

export function snapPoints(p: Project, excludingIds: Set<string>): number[] {
  const pts = new Set<number>([0]);
  for (const c of p.clips) {
    if (excludingIds.has(c.id)) continue;
    pts.add(c.start);
    pts.add(clipEnd(c));
  }
  for (const m of p.markers ?? []) pts.add(m.time);
  if (p.playRange) {
    pts.add(p.playRange.in);
    pts.add(p.playRange.out);
  }
  return [...pts].sort((a, b) => a - b);
}

export function sourceLimit(p: Project, c: Clip): number | undefined {
  if (!clipPlaysSource(c) || !c.assetID) return undefined;
  return p.assets.find((a) => a.id === c.assetID)?.duration;
}

export function trimLimits(
  p: Project,
  c: Clip,
  left: boolean,
  excludingIds: Set<string>
): [number, number] {
  const others = p.clips.filter(
    (o) => o.trackID === c.trackID && !excludingIds.has(o.id) && o.id !== c.id
  );
  const minDur = Math.max(MIN_CLIP_SECONDS, 1 / p.fps);
  if (left) {
    const prevEnd = others.filter((o) => clipEnd(o) <= c.start + 1e-6).reduce((mx, o) => Math.max(mx, clipEnd(o)), 0);
    let lo = prevEnd - c.start;
    if (clipPlaysSource(c)) {
      lo = Math.max(lo, -clipTimelineSpan(c, 0, c.sourceStart ?? 0));
    }
    const hi = c.duration - minDur;
    return [Math.min(lo, hi), hi];
  }
  const nextStart = others.filter((o) => o.start >= clipEnd(c) - 1e-6).reduce((mn, o) => Math.min(mn, o.start), Infinity);
  let hi = nextStart - clipEnd(c);
  const limit = sourceLimit(p, c);
  if (limit !== undefined) {
    hi = Math.min(hi, clipTimelineSpan(c, c.sourceStart ?? 0, limit) - c.duration);
  }
  const lo = minDur - c.duration;
  return [lo, Math.max(lo, hi)];
}

export function sanitizeProject(p: Project): void {
  const trackIDs = new Set([...p.videoTracks.map((t) => t.id), ...p.audioTracks.map((t) => t.id)]);
  p.clips = p.clips.filter((c) => trackIDs.has(c.trackID) && c.duration > 1e-6);
  for (const c of p.clips) {
    c.start = Math.max(0, c.start);
    clampClipFades(c);
    if (c.transform?.zoom) {
      c.transform.zoom = fitZoomMove(c.transform.zoom, c.duration);
    }
  }
  if (p.captions && !p.clips.some((c) => c.captioned)) {
    p.captions = undefined;
    p.captionFixes = undefined;
  }
}

export function formatTimecode(t: number, fps: number, simple = false): string {
  const clamped = Math.max(0, t);
  if (simple) {
    const cs = Math.round(clamped * 100);
    const c = cs % 100;
    const secs = Math.floor(cs / 100);
    const s = secs % 60;
    const m = Math.floor(secs / 60) % 60;
    const h = Math.floor(secs / 3600);
    const pad = (v: number) => String(v).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(c)}` : `${m}:${pad(s)}.${pad(c)}`;
  }
  const f = Math.max(1, Math.round(fps));
  const total = Math.round(clamped * fps);
  const frames = total % f;
  const secs = Math.floor(total / f);
  const s = secs % 60;
  const m = Math.floor(secs / 60) % 60;
  const h = Math.floor(secs / 3600);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

export function parseTimecode(input: string, fps: number): number | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (/^\d+(:\d{1,2}){0,2}\.\d+$/.test(text)) {
    const parts = text.split(':').map((x) => Number.parseFloat(x) || 0);
    return parts.reduce((acc, v) => acc * 60 + v, 0);
  }
  const f = Math.max(1, Math.round(fps));
  let parts: number[] = [];
  if (/[:;.]/.test(text)) {
    const comps = text.split(/[:;.]/);
    if (!comps.length || comps.length > 4) return undefined;
    for (const c of comps) {
      const v = Number.parseInt(c, 10);
      if (!Number.isFinite(v) || v < 0) return undefined;
      parts.push(v);
    }
  } else if (/^\d{1,8}$/.test(text)) {
    let s = text;
    while (s.length > 0) {
      const take = Math.min(2, s.length);
      parts.unshift(Number.parseInt(s.slice(s.length - take), 10) || 0);
      s = s.slice(0, s.length - take);
    }
  } else {
    return undefined;
  }
  const r = [...parts.reverse(), 0, 0, 0, 0];
  const frames = ((r[3] * 60 + r[2]) * 60 + r[1]) * f + r[0];
  return frames / fps;
}

export function rgbaToHex(c?: RGBA): string {
  if (!c) return '#FFFFFF';
  const toHex = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`;
}

export function hexToRgba(hex: string): RGBA | undefined {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return undefined;
  const n = Number.parseInt(clean, 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
    a: 1,
  };
}

export function computeExportRenderSize(
  project: Project,
  shape: 'original' | 'vertical' | 'square' | 'portrait',
  height?: number
): { width: number; height: number } {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const tallMap: Record<string, number | undefined> = {
    original: undefined,
    vertical: 16 / 9,
    square: 1,
    portrait: 5 / 4,
  };
  const tall = tallMap[shape];
  if (tall !== undefined) {
    const shortSide = height ?? Math.min(project.width, project.height);
    return { width: even(shortSide), height: even(shortSide * tall) };
  }
  const h = height ?? project.height;
  const w = (h * project.width) / Math.max(1, project.height);
  return { width: even(w), height: even(h) };
}

export function addClipDefaults(kind: ClipKind): Partial<Clip> {
  if (kind === 'solid') return { color: { r: 0.16, g: 0.16, b: 0.2, a: 1 } };
  if (kind === 'text') {
    return {
      text: {
        string: 'Text',
        fontName: '',
        bold: true,
        size: 110,
        color: { r: 1, g: 1, b: 1, a: 1 },
        x: 0.5,
        y: 0.5,
      },
    };
  }
  return {};
}
