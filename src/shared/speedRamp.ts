import { Clip, SpeedRamp } from './types';

const ease = (u: number): number => u * u * (3 - 2 * u);

export function rampSpeedAt(ramp: SpeedRamp, s: number, mid: number): number {
  if (s <= ramp.inFrom) return ramp.startSpeed;
  if (s < ramp.inTo) {
    const u = (s - ramp.inFrom) / Math.max(1e-9, ramp.inTo - ramp.inFrom);
    return ramp.startSpeed + (mid - ramp.startSpeed) * ease(u);
  }
  if (s <= ramp.outFrom) return mid;
  if (s < ramp.outTo) {
    const u = (s - ramp.outFrom) / Math.max(1e-9, ramp.outTo - ramp.outFrom);
    return mid + (ramp.endSpeed - mid) * ease(u);
  }
  return ramp.endSpeed;
}

export function rampSpan(ramp: SpeedRamp, a: number, b: number, mid: number): number {
  if (Math.abs(b - a) <= 1e-12) return 0;
  const steps = 48;
  const h = (b - a) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t0 = a + i * h;
    const t1 = t0 + h;
    const tm = (t0 + t1) / 2;
    sum +=
      (1 / Math.max(1e-4, rampSpeedAt(ramp, t0, mid)) +
        4 / Math.max(1e-4, rampSpeedAt(ramp, tm, mid)) +
        1 / Math.max(1e-4, rampSpeedAt(ramp, t1, mid))) *
      (h / 6);
  }
  return sum;
}

function solveRamp(ramp: SpeedRamp, a: number, b: number, time: number, mid: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (Math.abs(rampSpan(ramp, a, a + (b - a) * m, mid)) < time) lo = m;
    else hi = m;
  }
  return a + (b - a) * ((lo + hi) / 2);
}

export function rampSource(ramp: SpeedRamp, s0: number, dt: number, mid: number): number {
  if (Math.abs(dt) <= 1e-12) return s0;
  const forward = dt > 0;
  let left = Math.abs(dt);
  let a = s0;
  const marks = [ramp.inFrom, ramp.inTo, ramp.outFrom, ramp.outTo];
  const stops = forward
    ? marks.filter((m) => m > s0).sort((x, y) => x - y)
    : marks.filter((m) => m < s0).sort((x, y) => y - x);
  for (const m of stops) {
    const t = Math.abs(rampSpan(ramp, a, m, mid));
    if (t >= left) return solveRamp(ramp, a, m, left, mid);
    left -= t;
    a = m;
  }
  const v = rampSpeedAt(ramp, forward ? a + 1e-9 : a - 1e-9, mid);
  return a + (forward ? 1 : -1) * left * v;
}

export function shiftRamp(ramp: SpeedRamp, d: number): SpeedRamp {
  return {
    inFrom: ramp.inFrom + d,
    inTo: ramp.inTo + d,
    outFrom: ramp.outFrom + d,
    outTo: ramp.outTo + d,
    startSpeed: ramp.startSpeed,
    endSpeed: ramp.endSpeed,
  };
}

export function mirrorRamp(ramp: SpeedRamp, length: number): SpeedRamp {
  return {
    inFrom: length - ramp.outTo,
    inTo: length - ramp.outFrom,
    outFrom: length - ramp.inTo,
    outTo: length - ramp.inFrom,
    startSpeed: ramp.endSpeed,
    endSpeed: ramp.startSpeed,
  };
}

export function clipPlaysSource(clip: Clip): boolean {
  return (clip.kind === 'video' || clip.kind === 'audio') && !clip.freeze;
}

export function clipSourceTimeAt(clip: Clip, t: number): number {
  const s0 = clip.sourceStart ?? 0;
  const spd = clip.speed ?? 1;
  if (!clipPlaysSource(clip)) return s0;
  if (!clip.ramp) return s0 + (t - clip.start) * spd;
  return rampSource(clip.ramp, s0, t - clip.start, spd);
}

export function clipSourceLength(clip: Clip): number {
  if (!clip.ramp || !clipPlaysSource(clip)) return clip.duration * (clip.speed ?? 1);
  return clipSourceTimeAt(clip, clip.start + clip.duration) - (clip.sourceStart ?? 0);
}

export function clipTimelineSpan(clip: Clip, s0: number, s1: number): number {
  const spd = clip.speed ?? 1;
  if (!clip.ramp || !clipPlaysSource(clip)) return (s1 - s0) / spd;
  return rampSpan(clip.ramp, s0, s1, spd);
}

export function retimeClip(
  clip: Clip,
  snap: (t: number) => number,
  minimum: number,
  change: (c: Clip) => void
): void {
  if (!clipPlaysSource(clip)) {
    change(clip);
    return;
  }
  const s0 = clip.sourceStart ?? 0;
  const length = clipSourceLength(clip);
  change(clip);
  clip.duration = Math.max(snap(clipTimelineSpan(clip, s0, s0 + length)), minimum);
  const fadeIn = Math.min(Math.max(0, clip.fadeIn ?? 0), clip.duration);
  const fadeOut = Math.min(Math.max(0, clip.fadeOut ?? 0), clip.duration - fadeIn);
  clip.fadeIn = fadeIn;
  clip.fadeOut = fadeOut;
}
