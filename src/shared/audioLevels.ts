import { clipEnd, clipFadeGainAt, dbToLinear } from './project';
import { clipSourceLength, clipSourceTimeAt } from './speedRamp';
import { Clip, Project } from './types';

export interface WaveformEnvelopeInput {
  peaksPerSecond: number;
  peaks: number[];
}

export interface AudioActivitySpan {
  start: number;
  end: number;
}

export function clipEnvelopeDB(
  c: Clip,
  wf: WaveformEnvelopeInput | undefined
): number | undefined {
  if (!wf || !wf.peaks.length) return undefined;
  const s0 = c.sourceStart ?? 0;
  const len = clipSourceLength(c);
  const lo = Math.max(0, Math.floor(s0 * wf.peaksPerSecond));
  const hi = Math.min(wf.peaks.length, Math.floor((s0 + len) * wf.peaksPerSecond));
  if (hi <= lo) return undefined;
  let sum = 0;
  let count = 0;
  for (let i = lo; i < hi; i++) {
    const v = wf.peaks[i];
    if (v > 0.003) {
      sum += v * v;
      count++;
    }
  }
  if (count === 0) return undefined;
  return 10 * Math.log10(sum / count);
}

export function clipPeakDB(
  c: Clip,
  wf: WaveformEnvelopeInput | undefined
): number | undefined {
  if (!wf || !wf.peaks.length) return undefined;
  const s0 = c.sourceStart ?? 0;
  const len = clipSourceLength(c);
  const lo = Math.max(0, Math.floor(s0 * wf.peaksPerSecond));
  const hi = Math.min(wf.peaks.length, Math.floor((s0 + len) * wf.peaksPerSecond));
  if (hi <= lo) return undefined;
  let peak = 0;
  for (let i = lo; i < hi; i++) {
    if (wf.peaks[i] > peak) peak = wf.peaks[i];
  }
  if (peak <= 0) return undefined;
  return 20 * Math.log10(peak);
}

export function trackAudioActivity(
  trackID: string,
  project: Project,
  waveforms: Record<string, WaveformEnvelopeInput>
): AudioActivitySpan[] {
  const spans: AudioActivitySpan[] = [];
  const step = 0.05;
  for (const c of project.clips) {
    if (c.trackID !== trackID || c.kind !== 'audio' || !c.assetID) continue;
    const wf = waveforms[c.assetID];
    if (!wf || !wf.peaks.length) {
      spans.push({ start: c.start, end: clipEnd(c) });
      continue;
    }
    const end = clipEnd(c);
    let open: number | undefined;
    let t = c.start;
    while (t < end) {
      const src = clipSourceTimeAt(c, t);
      const srcNext = clipSourceTimeAt(c, t + step);
      const lo = Math.max(0, Math.floor(Math.min(src, srcNext) * wf.peaksPerSecond));
      const hi = Math.min(
        wf.peaks.length - 1,
        Math.floor(Math.max(src, srcNext) * wf.peaksPerSecond)
      );
      let peak = 0;
      for (let i = lo; i <= hi; i++) {
        if (wf.peaks[i] > peak) peak = wf.peaks[i];
      }
      const active = peak * dbToLinear(c.gainDB ?? 0) * clipFadeGainAt(c, t) > 0.03;
      if (active && open === undefined) open = t;
      if (!active && open !== undefined) {
        spans.push({ start: open, end: t });
        open = undefined;
      }
      t += step;
    }
    if (open !== undefined) spans.push({ start: open, end });
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: AudioActivitySpan[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < 0.35) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

export function duckGainAt(t: number, spans: AudioActivitySpan[], low: number): number {
  const attack = 0.15;
  const release = 0.5;
  let g = 1;
  for (const s of spans) {
    if (t < s.start - attack || t > s.end + release) continue;
    let f: number;
    if (t < s.start) f = (s.start - t) / attack;
    else if (t > s.end) f = (t - s.end) / release;
    else f = 0;
    g = Math.min(g, low + (1 - low) * f);
  }
  return g;
}

export function computeLevelEqualizationGains(
  clips: Clip[],
  waveforms: Record<string, WaveformEnvelopeInput>,
  targetDB?: number
): { gains: Map<string, number>; silentClipIds: string[] } {
  const measured: Array<{ clip: Clip; db: number }> = [];
  const silentClipIds: string[] = [];
  for (const c of clips) {
    if (c.kind !== 'audio' || !c.assetID) continue;
    const db = clipEnvelopeDB(c, waveforms[c.assetID]);
    if (db === undefined) {
      silentClipIds.push(c.id);
      continue;
    }
    measured.push({ clip: c, db });
  }
  const gains = new Map<string, number>();
  if (!measured.length) return { gains, silentClipIds };
  const sorted = [...measured].map((m) => m.db + (m.clip.gainDB ?? 0)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const target = targetDB ?? Math.min(-10, Math.max(-24, median));
  for (const m of measured) {
    const next = Math.round(Math.max(-60, Math.min(12, target - m.db)) * 10) / 10;
    gains.set(m.clip.id, next);
  }
  return { gains, silentClipIds };
}
