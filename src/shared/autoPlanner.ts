import { ClipAnalysis, ClipSample, MediaAsset, MusicAnalysis, Project } from './types';

export interface PlannedShot {
  asset: MediaAsset;
  source: number;
  duration: number;
  exposure: number;
  gainDB: number;
  dissolve: boolean;
  score: number;
}

export interface PlannedMusic {
  asset: MediaAsset;
  source: number;
  duration: number;
  fadeOut: number;
}

export interface EditDecision {
  shots: PlannedShot[];
  music?: PlannedMusic;
  title: string;
  look: string;
  bpm?: number;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

export function createSampleScorer(all: ClipSample[]): (s: ClipSample) => number {
  const sharpLog = all.map((s) => Math.log1p(s.sharpness));
  const s10 = percentile(sharpLog, 0.1);
  const s90 = Math.max(percentile(sharpLog, 0.9), s10 + 1e-6);
  const m90 = Math.max(percentile(all.map((s) => s.motion), 0.9), 0.02);
  const c90 = Math.max(percentile(all.map((s) => s.color), 0.9), 0.05);
  return (s: ClipSample) => {
    const sharp = Math.min(1, Math.max(0, (Math.log1p(s.sharpness) - s10) / (s90 - s10)));
    const exposure = 1 - Math.min(1, Math.abs(s.luma - 0.45) / 0.38);
    const color = Math.min(1, s.color / c90);
    const motion = s.motion / m90;
    let q = 0.36 * sharp + 0.2 * exposure + 0.14 * color;
    q += s.faces > 0 ? 0.16 : 0;
    q += s.aesthetic !== undefined ? (0.26 * (s.aesthetic + 1)) / 2 : 0.12;
    if (s.utility) q -= 0.35;
    if (motion > 1.1) q -= Math.min(0.3, (motion - 1.1) * 0.3);
    return q;
  };
}

export function findBestMoments(
  analysis: ClipAnalysis,
  limit: number,
  length = 2,
  count = 5,
  scoreFn?: (s: ClipSample) => number
): Array<{ start: number; end: number; score: number; faces: number }> {
  const score = scoreFn ?? createSampleScorer(analysis.samples);
  const scores = analysis.samples.map(score);
  const end = Math.min(analysis.duration, limit);
  const len = Math.min(length, end);
  if (len <= 0 || !analysis.samples.length) return [];

  const windows: Array<{ start: number; score: number; faces: number }> = [];
  for (let start = 0; start + len <= end + 1e-6; start += 0.25) {
    const inside: number[] = [];
    let faces = 0;
    for (let i = 0; i < analysis.samples.length; i++) {
      const smp = analysis.samples[i];
      if (smp.time >= start && smp.time <= start + len) {
        inside.push(scores[i]);
        faces = Math.max(faces, smp.faces);
      }
    }
    if (inside.length > 0) {
      const avg = inside.reduce((a, b) => a + b, 0) / inside.length;
      const minV = Math.min(...inside);
      windows.push({ start, score: avg * 0.75 + minV * 0.25, faces });
    }
  }

  const picked: Array<{ start: number; end: number; score: number; faces: number }> = [];
  for (const w of windows.sort((a, b) => b.score - a.score)) {
    if (picked.length >= count) break;
    if (picked.every((p) => w.start + len <= p.start || w.start >= p.end)) {
      picked.push({ start: w.start, end: w.start + len, score: w.score, faces: w.faces });
    }
  }
  return picked;
}

export function autoPlanEdit(
  _project: Project,
  clips: Array<{ asset: MediaAsset; analysis: ClipAnalysis }>,
  music?: { asset: MediaAsset; analysis: MusicAnalysis }
): EditDecision | undefined {
  const usable = clips.filter((c) => c.analysis.samples.length > 0);
  if (!usable.length) return undefined;

  const allSamples = usable.flatMap((c) => c.analysis.samples);
  const score = createSampleScorer(allSamples);
  const period = music ? 60 / Math.max(40, music.analysis.bpm) : undefined;
  let longBeats = 4;
  let shortBeats = 2;
  if (period) {
    longBeats = [2, 4, 8, 16].find((b) => b * period >= 1.5) ?? 16;
    shortBeats = (longBeats / 2) * period >= 0.8 ? longBeats / 2 : longBeats;
  }

  const rhythm = [true, false, false, true, true, false];
  const shots: PlannedShot[] = [];
  const shotBeats: number[] = [];
  let k = 0;
  const targetShots = Math.min(18, Math.max(usable.length, usable.length * 2));
  const pickedByAsset = new Map<string, Array<[number, number]>>();

  while (shots.length < targetShots) {
    let addedAny = false;
    for (const item of usable) {
      if (shots.length >= targetShots) break;
      const beats = rhythm[k % rhythm.length] ? longBeats : shortBeats;
      const dur = period ? beats * period : rhythm[k % rhythm.length] ? 2.4 : 1.4;
      if (item.asset.kind === 'image') {
        const existing = pickedByAsset.get(item.asset.id) ?? [];
        if (existing.length > 0) continue;
        existing.push([0, dur]);
        pickedByAsset.set(item.asset.id, existing);
        shots.push({
          asset: item.asset,
          source: 0,
          duration: dur,
          exposure: 0,
          gainDB: 0,
          dissolve: shots.length > 0 && shots.length % 4 === 0,
          score: score(item.analysis.samples[0]),
        });
        shotBeats.push(beats);
        k++;
        addedAny = true;
        continue;
      }
      const candidates = findBestMoments(item.analysis, item.asset.duration, dur, 6, score);
      const used = pickedByAsset.get(item.asset.id) ?? [];
      const chosen = candidates.find((c) => used.every(([u0, u1]) => c.end <= u0 || c.start >= u1));
      if (!chosen) continue;
      used.push([chosen.start, chosen.end]);
      pickedByAsset.set(item.asset.id, used);
      const meanLuma =
        item.analysis.samples.reduce((acc, s) => acc + s.luma, 0) / item.analysis.samples.length;
      const exposure = Math.max(-0.5, Math.min(0.5, (0.45 - meanLuma) * 0.9));
      shots.push({
        asset: item.asset,
        source: Math.max(0, Math.min(chosen.start, item.asset.duration - dur - 0.02)),
        duration: dur,
        exposure,
        gainDB: music && item.asset.hasAudio ? -16 : 0,
        dissolve: shots.length > 0 && shots.length % 4 === 0,
        score: chosen.score,
      });
      shotBeats.push(beats);
      k++;
      addedAny = true;
    }
    if (!addedAny) break;
  }

  if (!shots.length) return undefined;

  let musicPlan: PlannedMusic | undefined;
  if (music && music.analysis.beats.length > 4) {
    const m = music.analysis;
    const totalBeats = shotBeats.reduce((a, b) => a + b, 0);
    const grid = [...m.beats];
    const lastBeat = grid[grid.length - 1];
    while (grid.length <= totalBeats + 8) {
      grid.push(lastBeat + (grid.length - m.beats.length + 1) * (60 / m.bpm));
    }
    let b0 = m.barPhase % 4;
    let bestEnergy = -1;
    for (let i = b0; i + totalBeats < m.beats.length; i += 4) {
      const e = m.energy[i] ?? 0;
      if (e > bestEnergy) {
        bestEnergy = e;
        b0 = i;
      }
    }
    let at = b0;
    for (let i = 0; i < shots.length; i++) {
      const next = at + shotBeats[i];
      shots[i].duration = Math.max(0.25, grid[next] - grid[at]);
      shots[i].dissolve = i > 0 && (at - b0) % 16 === 0;
      if (shots[i].asset.kind === 'video') {
        shots[i].source = Math.max(0, Math.min(shots[i].source, shots[i].asset.duration - shots[i].duration - 0.02));
      }
      at = next;
    }
    const length = grid[at] - grid[b0];
    const tail = Math.min(1.2, Math.max(0, m.duration - grid[at]));
    musicPlan = {
      asset: music.asset,
      source: grid[b0],
      duration: length + tail,
      fadeOut: tail + 0.6,
    };
  }

  const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return {
    shots,
    music: musicPlan,
    title: month,
    look: 'Warm film',
    bpm: music?.analysis.bpm,
  };
}
