import { CaptionBlock, CaptionFix, CaptionStyle, CaptionWord, Clip, MediaAsset, Project, Transcript } from './types';
import { clipSourceLength, clipTimelineSpan } from './speedRamp';

const PAUSE_SEC = 0.6;
const MAX_CHARS = 38;
const MAX_SECONDS = 3.2;

function splitPhrases(run: CaptionWord[]): CaptionWord[][] {
  if (run.length <= 1) return [run];
  const first = run[0];
  const last = run[run.length - 1];
  const ends: number[] = [];
  let total = 0;
  for (let i = 0; i < run.length; i++) {
    total += run[i].text.length + (i > 0 ? 1 : 0);
    ends.push(total);
  }
  const byChars = Math.ceil(total / MAX_CHARS);
  const byTime = Math.ceil((last.end - first.start) / MAX_SECONDS);
  const n = Math.min(run.length, Math.max(1, byChars, byTime));
  if (n <= 1) return [run];

  const cuts: number[] = [];
  let from = 0;
  for (let k = 1; k < n; k++) {
    const target = (total * k) / n;
    let best: number | undefined;
    let bestScore = Infinity;
    for (let i = from; i <= run.length - (n - k) - 1; i++) {
      if (run[i].source === run[i + 1].source) continue;
      let score = Math.abs(ends[i] - target);
      if (run[i].text.endsWith(',')) score -= 6;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best === undefined) break;
    cuts.push(best);
    from = best + 1;
    if (from > run.length - 1) break;
  }

  const out: CaptionWord[][] = [];
  let start = 0;
  for (const c of [...cuts, run.length - 1]) {
    out.push(run.slice(start, c + 1));
    start = c + 1;
  }
  return out;
}

function blocksForClip(
  clip: Clip,
  asset: MediaAsset,
  transcript: Transcript,
  fixes: CaptionFix[]
): CaptionBlock[] {
  const s0 = clip.sourceStart ?? 0;
  const s1 = s0 + clipSourceLength(clip);
  const at = (s: number) =>
    Math.min(clip.start + clip.duration, Math.max(clip.start, clip.start + clipTimelineSpan(clip, s0, s)));

  const entries: CaptionWord[] = [];
  let previous: number | undefined;
  for (const w of transcript.words) {
    const mid = (w.start + w.end) / 2;
    if (mid < s0 || mid >= s1) {
      continue;
    }
    const prev = previous;
    previous = w.start;
    const fix = fixes.find((f) => Math.abs(f.start - w.start) < 0.0005);
    const a = at(Math.max(w.start, s0));
    const b = at(Math.min(w.end, s1));
    if (fix?.merged) {
      const last = entries[entries.length - 1];
      if (prev !== undefined && last && last.covers[last.covers.length - 1] === prev) {
        last.end = Math.max(last.end, b);
        last.covers.push(w.start);
      }
      continue;
    }
    const text = fix?.text ?? w.text;
    if (!text.trim() || b <= a) continue;
    entries.push({ start: a, end: b, text, source: w.start, covers: [w.start] });
  }

  const heard: CaptionWord[] = [];
  for (const e of entries) {
    const parts = e.text.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      heard.push(e);
      continue;
    }
    const weights = parts.map((p) => p.length + 1);
    const total = weights.reduce((acc, v) => acc + v, 0);
    let t = e.start;
    for (let i = 0; i < parts.length; i++) {
      const d = ((e.end - e.start) * weights[i]) / total;
      heard.push({ start: t, end: t + d, text: parts[i], source: e.source, covers: e.covers });
      t += d;
    }
  }

  const runs: CaptionWord[][] = [];
  for (const w of heard) {
    const lastRun = runs[runs.length - 1];
    const lastWord = lastRun?.[lastRun.length - 1];
    if (
      lastWord &&
      w.start - lastWord.end < PAUSE_SEC &&
      !lastWord.text.endsWith('.') &&
      !lastWord.text.endsWith('?') &&
      !lastWord.text.endsWith('!')
    ) {
      lastRun.push(w);
    } else {
      runs.push([w]);
    }
  }

  const groups = runs.flatMap(splitPhrases);
  const out: CaptionBlock[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.length) continue;
    const first = g[0];
    const last = g[g.length - 1];
    const next = i + 1 < groups.length ? groups[i + 1][0].start : clip.start + clip.duration;
    const end = Math.min(next, clip.start + clip.duration, Math.max(last.end + 0.25, first.start + 0.6));
    out.push({
      clipID: clip.id,
      assetID: asset.id,
      start: first.start,
      end: Math.max(end, last.end),
      words: g,
    });
  }
  return out;
}

export function buildCaptionBlocks(
  project: Project,
  transcripts: Record<string, Transcript>
): CaptionBlock[] {
  const result: CaptionBlock[] = [];
  const clips = project.clips
    .filter((c) => c.captioned && c.assetID)
    .sort((a, b) => a.start - b.start);
  for (const clip of clips) {
    const asset = project.assets.find((a) => a.id === clip.assetID);
    if (!asset) continue;
    const tr = transcripts[asset.id];
    if (!tr || !tr.words.length) continue;
    const fixes = project.captionFixes?.[asset.id] ?? [];
    result.push(...blocksForClip(clip, asset, tr, fixes));
  }
  return result.sort((a, b) => a.start - b.start);
}

export function defaultCaptionStyle(): CaptionStyle {
  return { size: 64, position: 0.78, highlight: true, hidden: false };
}
