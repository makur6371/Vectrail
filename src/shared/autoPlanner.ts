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
  titleAtEnd?: boolean;
  look: string;
  bpm?: number;
}

export interface AutoPlanRecipe {
  seconds?: number;
  pace?: 'unchanged' | 'calm' | 'fast';
  look?: string; // look name, 'none', or undefined
  musicMode?: 'unchanged' | 'off' | 'add';
  shots?: number;
  every?: boolean;
  moments?: Record<string, number[]>;
  title?: string; // undefined = no title unless defaultTitle=true; '' = placeholder 'Title'
  titleAtEnd?: boolean;
  defaultTitle?: boolean;
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
  music?: { asset: MediaAsset; analysis: MusicAnalysis },
  recipe: AutoPlanRecipe = { defaultTitle: true, look: 'Warm film' }
): EditDecision | undefined {
  const usable = clips.filter((c) => c.analysis.samples.length > 0);
  if (!usable.length) return undefined;

  const activeMusic = recipe.musicMode === 'off' ? undefined : music;
  const allSamples = usable.flatMap((c) => c.analysis.samples);
  const score = createSampleScorer(allSamples);

  interface SourceEntry {
    asset: MediaAsset;
    analysis: ClipAnalysis;
    scores: number[];
    picked: Array<[number, number]>;
  }

  const sources: SourceEntry[] = usable
    .map((c, idx) => ({
      idx,
      entry: {
        asset: c.asset,
        analysis: c.analysis,
        scores: c.analysis.samples.map(score),
        picked: [] as Array<[number, number]>,
      },
    }))
    .sort((a, b) => {
      const ca = a.entry.analysis.created;
      const cb = b.entry.analysis.created;
      if (ca && cb) return ca < cb ? -1 : ca > cb ? 1 : a.idx - b.idx;
      if (ca && !cb) return -1;
      if (!ca && cb) return 1;
      return a.idx - b.idx;
    })
    .map((x) => x.entry);

  const allScores = sources.flatMap((s) => s.scores);
  const floor = percentile(allScores, 0.3);

  let period = activeMusic ? 60 / Math.max(40, activeMusic.analysis.bpm) : undefined;
  const wanted = recipe.every ? Math.max(recipe.shots ?? 0, sources.length) : recipe.shots;
  let sub = 1;
  const pace = recipe.pace === 'fast' ? 0.55 : recipe.pace === 'calm' ? 1.7 : 1;
  let longBeats = 4;
  let shortBeats = 2;
  if (period) {
    longBeats = [2, 4, 8, 16].find((b) => b * period! >= 1.5 * pace) ?? 16;
    shortBeats = (longBeats / 2) * period >= 0.8 ? longBeats / 2 : longBeats;
  }

  let perShot: number | undefined;
  if (wanted !== undefined) {
    const len = recipe.seconds ?? wanted * (recipe.pace === 'calm' ? 2.5 : recipe.pace === 'fast' ? 0.9 : 1.5);
    perShot = Math.max(recipe.every ? 0.2 : 0.35, len / Math.max(1, wanted));
    if (recipe.every && period && perShot < period * 0.9) {
      sub = 2;
      period = period / 2;
    }
    if (period) {
      const b = Math.max(1, Math.floor(perShot / period));
      longBeats = b;
      shortBeats = b;
    }
  }

  const rhythm = [true, false, false, true, true, false];
  const beatsFor = (k: number) => (rhythm[k % rhythm.length] ? longBeats : shortBeats);
  const lengthFor = (k: number) => {
    if (period) return beatsFor(k) * period;
    if (perShot !== undefined) return perShot * [1.08, 0.94, 1.0, 1.06, 0.92, 1.0][k % 6];
    return [2.4, 1.8, 2.1, 2.8, 1.7, 2.2][k % 6] * pace;
  };

  const good = sources.reduce((sum, s) => {
    const step = s.analysis.samples.length > 1 ? s.analysis.duration / s.analysis.samples.length : 2.5;
    return sum + s.scores.filter((v) => v >= floor).length * step;
  }, 0);
  let target =
    recipe.seconds ??
    (perShot !== undefined ? perShot * (wanted ?? 1) : Math.min(40, Math.max(12, good * 0.5)));
  if (activeMusic) target = Math.min(target, Math.max(2, activeMusic.analysis.duration - 2));

  const bestWindow = (
    s: SourceEntry,
    len: number,
    apart = 0.3
  ): { start: number; score: number } | undefined => {
    const a = s.analysis;
    if (s.asset.kind === 'image') {
      return s.picked.length === 0 ? { start: 0, score: s.scores[0] ?? 0 } : undefined;
    }
    const limit = Math.min(a.duration, s.asset.duration);
    if (limit < len + 0.1) return undefined;
    let best: { start: number; score: number } | undefined;
    let bestWanted: { start: number; score: number } | undefined;
    const wantedTimes = recipe.moments?.[s.asset.id] ?? [];
    for (let start = 0.05; start + len <= limit - 0.05 + 1e-6; start += 0.25) {
      const end = start + len;
      const clear = s.picked.every(([p0, p1]) => end + apart <= p0 || start >= p1 + apart);
      if (!clear) continue;
      const vals: number[] = [];
      for (let idx = 0; idx < a.samples.length; idx++) {
        if (a.samples[idx].time >= start && a.samples[idx].time <= end) {
          vals.push(s.scores[idx]);
        }
      }
      if (!vals.length) continue;
      const v = (vals.reduce((acc, x) => acc + x, 0) / vals.length) * 0.75 + Math.min(...vals) * 0.25;
      if (!best || v > best.score) best = { start, score: v };
      const margin = Math.min(0.3, len / 4);
      if (
        wantedTimes.some((wt) => wt >= start + margin && wt <= end - margin) &&
        (!bestWanted || v > bestWanted.score)
      ) {
        bestWanted = { start, score: v };
      }
    }
    return bestWanted ?? best;
  };

  const shots: PlannedShot[] = [];
  const shotBeats: number[] = [];
  let total = 0;
  let round = 0;
  const p12 = percentile(allScores, 0.12);

  while (total < target) {
    let added = 0;
    for (let i = 0; i < sources.length; i++) {
      if (!(total < target || (recipe.every && round === 0))) break;
      const s = sources[i];
      if (round > 0 && Math.min(s.analysis.duration, s.asset.duration) < 12) continue;
      const apart = round > 0 ? 4.0 : 0.3;
      let len = lengthFor(shots.length);
      let beats = beatsFor(shots.length);
      let found = bestWindow(s, len + 0.08, apart);
      if (!found && (beats !== shortBeats || !period)) {
        beats = shortBeats;
        len = period ? shortBeats * period : Math.min(1.6, perShot ?? 1.6);
        found = bestWindow(s, len + 0.08, apart);
      }
      if (!found) continue;
      const minScore = round === 0 || total < 18 ? p12 : floor;
      if (!((recipe.every && round === 0) || found.score >= minScore)) continue;
      if (shots.length > 0 && shots[shots.length - 1].asset.id === s.asset.id && sources.length > 1) {
        continue;
      }
      s.picked.push([found.start, found.start + len]);
      const lumaSamples = s.analysis.samples.filter(
        (smp) => smp.time >= found!.start && smp.time <= found!.start + len
      );
      const meanLuma = lumaSamples.length
        ? lumaSamples.reduce((acc, smp) => acc + smp.luma, 0) / lumaSamples.length
        : 0.45;
      const rawExp = Math.log2(0.45 / Math.max(0.05, meanLuma)) * 0.5;
      const exposure = Math.round(Math.max(-0.5, Math.min(0.5, rawExp)) * 10) / 10;
      shots.push({
        asset: s.asset,
        source: found.start,
        duration: len,
        exposure,
        gainDB: 0,
        dissolve: false,
        score: found.score,
      });
      shotBeats.push(beats);
      total += len;
      added++;
    }
    if (added === 0) break;
    round++;
    if (recipe.every) break;
  }

  // Growth pass when short of target
  const unit = period ?? 0.25;
  let grew = true;
  while (total + unit <= target + 0.05 && grew) {
    grew = false;
    for (let i = 0; i < shots.length && total + unit <= target + 0.05; i++) {
      const s = shots[i];
      if (s.asset.kind !== 'video') continue;
      const srcEntry = sources.find((x) => x.asset.id === s.asset.id);
      const limit = Math.min(s.asset.duration, srcEntry?.analysis.duration ?? s.asset.duration);
      if (s.source + s.duration + unit > limit - 0.05) continue;
      const end = s.source + s.duration + unit;
      const clear = shots.every(
        (other, j) =>
          j === i ||
          other.asset.id !== s.asset.id ||
          end + 0.1 <= other.source ||
          other.source + other.duration <= s.source
      );
      if (!clear) continue;
      shots[i].duration += unit;
      shotBeats[i] += 1;
      total += unit;
      grew = true;
    }
  }

  // Trim excess if every && seconds
  if (recipe.every && recipe.seconds !== undefined) {
    const limit = recipe.seconds;
    while (total > limit + 0.15 && shots.length > sources.length) {
      total -= shots.pop()!.duration;
      shotBeats.pop();
    }
    if (total > limit + 0.15 && shots.length > 0) {
      const last = shots.length - 1;
      if (period) {
        while (total > limit + 0.15 && shotBeats[last] > 1) {
          shotBeats[last] -= 1;
          shots[last].duration -= period;
          total -= period;
        }
      } else {
        const cut = Math.max(0, Math.min(total - limit, shots[last].duration - 0.3));
        shots[last].duration -= cut;
        total -= cut;
      }
    }
  }

  if (!shots.length) return undefined;

  const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const title =
    recipe.title !== undefined
      ? recipe.title === ''
        ? 'Title'
        : recipe.title
      : recipe.defaultTitle
      ? month
      : '';
  const look = recipe.look === 'none' ? '' : recipe.look ?? '';

  let musicPlan: PlannedMusic | undefined;
  if (activeMusic && activeMusic.analysis.beats.length > 4) {
    const m = activeMusic.analysis;
    let grid = [...m.beats];
    let energy = [...m.energy];
    if (sub === 2) {
      const halfGrid: number[] = [];
      const halfEnergy: number[] = [];
      for (let i = 0; i < m.beats.length; i++) {
        halfGrid.push(m.beats[i]);
        halfEnergy.push(m.energy[i] ?? 0);
        if (i + 1 < m.beats.length) {
          halfGrid.push((m.beats[i] + m.beats[i + 1]) / 2);
          halfEnergy.push(m.energy[i] ?? 0);
        }
      }
      grid = halfGrid;
      energy = halfEnergy;
    }
    const bar = 4 * sub;
    const phase = (m.barPhase % 4) * sub;
    const step = (60 / Math.max(40, m.bpm)) / sub;

    const count = shotBeats.reduce((a, b) => a + b, 0);
    const extra = recipe.every && recipe.seconds !== undefined ? 0 : (bar - (count % bar)) % bar;
    if (extra > 0 && shots.length > 0) {
      const last = shots.length - 1;
      const s = shots[last];
      const needed = s.duration + extra * step;
      const fits = (st: number) => {
        if (s.asset.kind !== 'video') return true;
        if (st < 0 || st + needed > s.asset.duration - 0.05) return false;
        return shots.every(
          (other, j) =>
            j === last ||
            other.asset.id !== s.asset.id ||
            st + needed + 0.1 <= other.source ||
            st >= other.source + other.duration + 0.1
        );
      };
      if (fits(s.source)) {
        shotBeats[last] += extra;
      } else if (fits(s.source - (needed - s.duration))) {
        shotBeats[last] += extra;
        shots[last].source = s.source - (needed - s.duration);
      } else if (shotBeats[last] > bar - extra) {
        shotBeats[last] -= bar - extra;
      } else if (shots.length > 1) {
        const popped = shotBeats.pop()!;
        shots.pop();
        if (shotBeats.length > 0) {
          // Drop excess if needed
          void popped;
        }
      }
    }

    let totalBeats = shotBeats.reduce((a, b) => a + b, 0);
    while (totalBeats + 2 >= grid.length && shotBeats.length > 1) {
      totalBeats -= shotBeats.pop()!;
      shots.pop();
    }

    let bestBeat = Math.min(phase, Math.max(0, grid.length - 1));
    let bestScore = -Infinity;
    const lookWin = 8 * sub;
    for (let b = phase; b + totalBeats + 1 < grid.length && b + totalBeats <= energy.length; b += bar) {
      const win = energy.slice(b, b + totalBeats);
      const mean = win.reduce((acc, v) => acc + v, 0) / Math.max(1, win.length);
      const beforeSlice = b >= lookWin ? energy.slice(b - lookWin, b) : [];
      const before = beforeSlice.length
        ? beforeSlice.reduce((acc, v) => acc + v, 0) / beforeSlice.length
        : mean;
      const afterSlice = energy.slice(b, Math.min(energy.length, b + lookWin));
      const after = afterSlice.length
        ? afterSlice.reduce((acc, v) => acc + v, 0) / afterSlice.length
        : mean;
      const sc = mean + 0.5 * Math.max(0, after - before) - (b === phase && b < bar ? 0.05 : 0);
      if (sc > bestScore) {
        bestScore = sc;
        bestBeat = b;
      }
    }

    const b0 = bestBeat;
    let at = b0;
    for (let i = 0; i < shots.length; i++) {
      const next = at + shotBeats[i];
      if (next < grid.length) {
        shots[i].duration = Math.max(0.2, grid[next] - grid[at]);
        shots[i].dissolve = sub === 1 && i > 0 && (at - b0) % 16 === 0;
        at = next;
      }
    }
    const length = Math.max(0.5, grid[at] - grid[b0]);
    const tail = Math.min(1.2, Math.max(0, m.duration - grid[at]));
    musicPlan = {
      asset: activeMusic.asset,
      source: grid[b0],
      duration: length + tail,
      fadeOut: tail + 0.6,
    };
    for (const s of shots) {
      if (s.asset.hasAudio) s.gainDB = -16;
    }
  } else {
    for (let i = 0; i < shots.length; i++) {
      shots[i].dissolve = i > 0 && i % 4 === 0;
    }
  }

  for (const s of shots) {
    if (s.asset.kind === 'video') {
      s.source = Math.max(0, Math.min(s.source, s.asset.duration - s.duration - 0.02));
    }
  }

  return {
    shots,
    music: musicPlan,
    title,
    titleAtEnd: recipe.titleAtEnd,
    look,
    bpm: activeMusic?.analysis.bpm,
  };
}
