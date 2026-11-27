import { clipEnd, clipName, trackLabel } from './project';
import { ClipKind, MarkerTint, MediaAsset, Project } from './types';

export interface MagicPointers {
  playhead: number;
  selected: string[];
  range?: { start: number; end: number };
}

export type MagicMention =
  | { kind: 'playhead' }
  | { kind: 'selected' }
  | { kind: 'range' }
  | { kind: 'media'; id: string }
  | { kind: 'clip'; id: string }
  | { kind: 'marker'; id: string };

export interface ClipMentionLabel {
  id: string;
  name: string;
  kind: ClipKind;
  track: string;
  start: number;
}

export interface MarkerMentionLabel {
  id: string;
  name: string;
  time: number;
  tint: MarkerTint;
}

export interface MentionMatch {
  start: number;
  end: number;
  mention: MagicMention;
  raw: string;
}

export interface ParsedMagicTime {
  start: number;
  end: number;
  text: string;
  seconds: number;
  unitOnly: boolean;
}

export interface ParsedMagicSpan {
  start: number;
  end: number;
  text: string;
}

export function formatClock(t: number): string {
  const rounded = Math.max(0, Math.round(t * 100) / 100);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  let sec = (rounded % 60).toFixed(2);
  if ((rounded % 60) < 10) sec = `0${sec}`;
  sec = sec.replace(/\.?0+$/, '');
  if (sec.indexOf('.') === -1 && sec.length === 1) sec = `0${sec}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function buildMarkerLabels(p: Project): MarkerMentionLabel[] {
  const seen = new Map<string, number>();
  const sorted = [...(p.markers ?? [])].sort((a, b) => a.time - b.time);
  return sorted.map((m) => {
    const own = (m.name ?? '').trim();
    const tint = (m.color ?? 'orange') as MarkerTint;
    const base = own || `${tint[0].toUpperCase()}${tint.slice(1)} marker`;
    const key = base.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return {
      id: m.id,
      name: n === 1 ? base : `${base}·${n}`,
      time: m.time,
      tint,
    };
  });
}

export function buildClipLabels(p: Project): ClipMentionLabel[] {
  const videoLinks = new Set(
    p.clips.filter((c) => c.kind !== 'audio' && c.linkID).map((c) => c.linkID!)
  );
  const trackIdxMap = new Map<string, number>();
  p.videoTracks.forEach((t, i) => trackIdxMap.set(t.id, i));
  p.audioTracks.forEach((t, i) => trackIdxMap.set(t.id, 1000 + i));

  const visibleClips = p.clips
    .filter((c) => !(c.kind === 'audio' && c.linkID && videoLinks.has(c.linkID)))
    .sort((a, b) => a.start - b.start || (trackIdxMap.get(a.trackID) ?? 0) - (trackIdxMap.get(b.trackID) ?? 0));

  const seen = new Map<string, number>();
  return visibleClips.map((c) => {
    let base = clipName(p, c).trim();
    if (c.kind === 'text' && base.length > 24) {
      base = `${base.slice(0, 22).trim()}…`;
    }
    const key = base.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return {
      id: c.id,
      name: n === 1 ? base : `${base}·${n}`,
      kind: c.kind,
      track: trackLabel(p, c.trackID),
      start: c.start,
    };
  });
}

export function findMentions(
  text: string,
  media: MediaAsset[],
  clips: ClipMentionLabel[] = [],
  markers: MarkerMentionLabel[] = []
): MentionMatch[] {
  const candidates: Array<{ token: string; mention: MagicMention }> = [
    { token: 'playhead', mention: { kind: 'playhead' as const } },
    { token: 'selected', mention: { kind: 'selected' as const } },
    { token: 'in-out', mention: { kind: 'range' as const } },
    ...markers.map((m) => ({ token: `marker:${m.name}`, mention: { kind: 'marker' as const, id: m.id } })),
    ...markers.map((m) => ({ token: m.name, mention: { kind: 'marker' as const, id: m.id } })),
    ...clips.map((c) => ({ token: `clip:${c.name}`, mention: { kind: 'clip' as const, id: c.id } })),
    ...media.map((a) => ({ token: a.name, mention: { kind: 'media' as const, id: a.id } })),
    ...media.map((a) => ({ token: a.name.replace(/\s+/g, '_'), mention: { kind: 'media' as const, id: a.id } })),
  ].sort((a, b) => b.token.length - a.token.length);

  const matches: MentionMatch[] = [];
  const lower = text.toLowerCase();
  let pos = 0;
  while (pos < text.length) {
    const atIdx = text.indexOf('@', pos);
    if (atIdx < 0) break;
    const after = atIdx + 1;
    let hit: MentionMatch | undefined;
    for (const c of candidates) {
      const tokLower = c.token.toLowerCase();
      if (lower.startsWith(tokLower, after)) {
        const endIdx = after + c.token.length;
        const nextChar = text[endIdx];
        if (!nextChar || !/[a-zA-Z0-9_\-.]/.test(nextChar)) {
          hit = { start: atIdx, end: endIdx, mention: c.mention, raw: text.slice(atIdx, endIdx) };
          break;
        }
      }
    }
    if (hit) {
      matches.push(hit);
      pos = hit.end;
    } else {
      pos = after;
    }
  }
  return matches;
}

export function markersAsTimes(text: string, p: Project): string {
  const marks = buildMarkerLabels(p);
  if (!marks.length) return text;
  const matches = findMentions(text, p.assets, buildClipLabels(p), marks);
  let out = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    if (m.mention.kind !== 'marker') continue;
    const label = marks.find((x) => x.id === (m.mention as { kind: 'marker'; id: string }).id);
    if (!label) continue;
    out = `${out.slice(0, m.start)}${formatClock(label.time)}${out.slice(m.end)}`;
  }
  return out;
}

function parseTimeTokenSeconds(token: string, fps: number): number | undefined {
  const clean = token.trim();
  if (!clean) return undefined;
  const parts = clean.split(':').map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 4) {
    const f = Math.max(1, Math.round(fps));
    return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / f;
  }
  return undefined;
}

export function extractMagicTimes(text: string, fps = 30): ParsedMagicTime[] {
  const out: ParsedMagicTime[] = [];
  // Clock formats: 0:12, 1:02:03.5, 00:00:05:15
  const clockRe = /\b(\d{1,2}:\d{2}(?::\d{2}){0,2}(?:\.\d+)?)\b/g;
  let m: RegExpExecArray | null;
  while ((m = clockRe.exec(text)) !== null) {
    const sec = parseTimeTokenSeconds(m[1], fps);
    if (sec !== undefined) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0], seconds: sec, unitOnly: false });
    }
  }
  // Unit-suffixed times: "12s", "12.5 seconds", "1.5 min", "12秒"
  const unitRe = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|秒|分钟)\b/gi;
  while ((m = unitRe.exec(text)) !== null) {
    const idx = m.index;
    const end = idx + m[0].length;
    if (out.some((x) => idx >= x.start && idx < x.end)) continue;
    const val = Number(m[1]);
    if (!Number.isFinite(val)) continue;
    const unit = m[2].toLowerCase();
    const seconds = unit.startsWith('m') || unit.includes('分') ? val * 60 : val;
    out.push({ start: idx, end, text: m[0], seconds, unitOnly: true });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function extractMagicSpan(text: string, fps = 30): ParsedMagicSpan | undefined {
  const resolved = text;
  const times = extractMagicTimes(resolved, fps);
  if (times.length >= 2) {
    const a = times[0];
    const b = times[1];
    const between = resolved.slice(a.end, b.start).toLowerCase();
    const isConnector =
      /^\s*(-|–|—|to|and|until|through|til|till|到|至)\s*$/i.test(between) ||
      resolved.slice(Math.max(0, a.start - 10), a.start).toLowerCase().includes('between') ||
      resolved.slice(Math.max(0, a.start - 8), a.start).toLowerCase().includes('from') ||
      resolved.slice(Math.max(0, a.start - 4), a.start).includes('从');
    if (isConnector && b.seconds > a.seconds) {
      return {
        start: a.seconds,
        end: b.seconds,
        text: resolved.slice(a.start, b.end),
      };
    }
  }
  return undefined;
}

export function buildPointingBrief(ptr: MagicPointers, request: string, p: Project): string | undefined {
  const labels = buildClipLabels(p);
  const marks = buildMarkerLabels(p);
  const found = findMentions(request, p.assets, labels, marks);
  const lines: string[] = [];

  lines.push(`Playhead is at ${ptr.playhead.toFixed(2)}s.`);
  if (ptr.selected.length > 0) {
    const selNames = ptr.selected
      .map((id) => {
        const c = p.clips.find((x) => x.id === id);
        return c ? `${clipName(p, c)} (${c.id}, ${trackLabel(p, c.trackID)}, ${c.start.toFixed(2)}s–${clipEnd(c).toFixed(2)}s)` : id;
      })
      .join('; ');
    lines.push(`Selected clips: ${selNames}.`);
  }
  if (ptr.range) {
    lines.push(`In/out range: ${ptr.range.start.toFixed(2)}s to ${ptr.range.end.toFixed(2)}s.`);
  }

  const meant: string[] = [];
  for (const m of found) {
    if (m.mention.kind === 'playhead') {
      meant.push(`@playhead means ${ptr.playhead.toFixed(2)}s on the timeline.`);
    } else if (m.mention.kind === 'selected') {
      meant.push(
        ptr.selected.length
          ? `@selected means the selected clips above.`
          : `@selected: nothing is selected.`
      );
    } else if (m.mention.kind === 'range') {
      meant.push(
        ptr.range
          ? `@in-out means ${ptr.range.start.toFixed(2)}s to ${ptr.range.end.toFixed(2)}s.`
          : `@in-out: no in/out range was set.`
      );
    } else if (m.mention.kind === 'media') {
      const assetId = m.mention.id;
      const a = p.assets.find((x) => x.id === assetId);
      if (a) meant.push(`@${a.name} means library asset ${a.name} (asset_id ${a.id}).`);
    } else if (m.mention.kind === 'clip') {
      const clipId = m.mention.id;
      const c = p.clips.find((x) => x.id === clipId);
      const l = labels.find((x) => x.id === clipId);
      if (c && l) {
        meant.push(`@clip:${l.name} means timeline clip ${c.id} (${trackLabel(p, c.trackID)}, ${c.start.toFixed(2)}s–${clipEnd(c).toFixed(2)}s).`);
      }
    } else if (m.mention.kind === 'marker') {
      const markerId = m.mention.id;
      const mk = marks.find((x) => x.id === markerId);
      if (mk) {
        meant.push(`@${mk.name} means marker "${mk.name}" at ${mk.time.toFixed(2)}s.`);
      }
    }
  }
  if (meant.length) {
    lines.push(`They pointed with @: ${[...new Set(meant)].join(' ')} Act on exactly what they pointed at.`);
  }

  const withMarkerTimes = markersAsTimes(request, p);
  const span = extractMagicSpan(withMarkerTimes, p.fps);
  const timed: string[] = [];
  if (span) {
    timed.push(`"${span.text}" is ${span.start.toFixed(2)}s to ${span.end.toFixed(2)}s on the timeline.`);
  }
  for (const t of extractMagicTimes(withMarkerTimes, p.fps)) {
    if (t.unitOnly) continue;
    if (span && span.text.includes(t.text)) continue;
    timed.push(`"${t.text}" is ${t.seconds.toFixed(2)}s.`);
  }
  if (timed.length) lines.push(`Times in request: ${timed.join(' ')}`);
  lines.push(
    'Use the playhead, selection and range only when their words point at them ("here", "this clip", "these", "this spot", "from here on", or an @). Otherwise the request is about the whole edit.'
  );
  return lines.join('\n');
}
