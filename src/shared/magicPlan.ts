import { clipName, cloneProject, sanitizeProject } from './project';
import { Clip, ColorGrade, Project, TransitionKind } from './types';

export type MagicStepKind =
  | 'remove'
  | 'place'
  | 'move'
  | 'trim'
  | 'grade'
  | 'transition'
  | 'zoom'
  | 'title'
  | 'audio'
  | 'captions'
  | 'sequence';

export interface MagicActor {
  id: string;
  name: string;
  color: string;
}

export interface MagicChoreoStep {
  id: string;
  kind: MagicStepKind;
  actor: MagicActor;
  clipId?: string;
  assetId?: string;
  trackId?: string;
  time: number;
  duration: number;
  label: string;
  grade?: ColorGrade;
  transitionKind?: TransitionKind;
  snapTimes?: number[];
  cutTime?: number;
  startMs: number;
  endMs: number;
}

export interface MagicChoreography {
  before: Project;
  after: Project;
  actors: MagicActor[];
  steps: MagicChoreoStep[];
  totalDurationMs: number;
}

const AGENT_COLORS: Record<string, string> = {
  Claude: '#D97757',
  Codex: '#10A37F',
  ChatGPT: '#10A37F',
  'Cloud AI': '#FF6B35',
  Local: '#EAECEF',
  Cutter: '#58A6FF',
  Color: '#F5A623',
  Sound: '#30D158',
  Titles: '#BF5AF2',
};

function colorFor(name: string, fallbackIdx = 0): string {
  if (AGENT_COLORS[name]) return AGENT_COLORS[name];
  const palette = ['#58A6FF', '#F5A623', '#30D158', '#BF5AF2', '#FF6B35'];
  return palette[fallbackIdx % palette.length];
}

function gradeChanged(a?: ColorGrade, b?: ColorGrade): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

function transitionChanged(a?: Clip['transitionIn'], b?: Clip['transitionIn']): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

function zoomChanged(a?: Clip['transform'], b?: Clip['transform']): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

function audioChanged(a: Clip, b: Clip): boolean {
  return (
    (a.gainDB ?? 0) !== (b.gainDB ?? 0) ||
    (a.fadeIn ?? 0) !== (b.fadeIn ?? 0) ||
    (a.fadeOut ?? 0) !== (b.fadeOut ?? 0)
  );
}

/**
 * Diffs a before/after project pair into animated swarm cursor steps, splitting
 * larger edits across specialized actors (Cutter, Color, Sound, Titles) just
 * like Editroom's MagicShow choreographer.
 */
export function buildMagicPlan(before: Project, after: Project, worker: string): MagicChoreography {
  const beforeMap = new Map(before.clips.map((c) => [c.id, c]));
  const afterMap = new Map(after.clips.map((c) => [c.id, c]));
  const primary: MagicActor = { id: 'primary', name: worker || 'Local', color: colorFor(worker || 'Local') };
  const cutter: MagicActor = { id: 'cutter', name: 'Cutter', color: colorFor('Cutter') };
  const colorActor: MagicActor = { id: 'color', name: 'Color', color: colorFor('Color') };
  const soundActor: MagicActor = { id: 'sound', name: 'Sound', color: colorFor('Sound') };
  const titlesActor: MagicActor = { id: 'titles', name: 'Titles', color: colorFor('Titles') };

  const rawSteps: Array<Omit<MagicChoreoStep, 'startMs' | 'endMs'>> = [];

  const removedClips = before.clips.filter((c) => !afterMap.has(c.id)).sort((a, b) => a.start - b.start);
  for (const oldClip of removedClips) {
    rawSteps.push({
      id: `rm-${oldClip.id}`,
      kind: 'remove',
      actor: removedClips.length >= 2 ? cutter : primary,
      clipId: oldClip.id,
      assetId: oldClip.assetID,
      trackId: oldClip.trackID,
      time: oldClip.start,
      duration: oldClip.duration,
      label: `Removing ${clipName(before, oldClip)}`,
    });
  }

  const addedSorted = after.clips
    .filter((c) => !beforeMap.has(c.id))
    .sort((a, b) => a.start - b.start);

  let placeCounter = 0;
  for (const nextClip of addedSorted) {
    if (nextClip.kind === 'text') {
      rawSteps.push({
        id: `title-${nextClip.id}`,
        kind: 'title',
        actor: addedSorted.length >= 3 ? titlesActor : primary,
        clipId: nextClip.id,
        trackId: nextClip.trackID,
        time: nextClip.start,
        duration: nextClip.duration,
        label: nextClip.text?.string ? `Title "${nextClip.text.string.slice(0, 18)}"` : 'Adding title',
        snapTimes: [nextClip.start],
      });
      continue;
    }

    if (nextClip.kind === 'audio') {
      rawSteps.push({
        id: `audio-${nextClip.id}`,
        kind: 'audio',
        actor: addedSorted.length >= 3 ? soundActor : primary,
        clipId: nextClip.id,
        assetId: nextClip.assetID,
        trackId: nextClip.trackID,
        time: nextClip.start,
        duration: nextClip.duration,
        label: `Scoring ${clipName(after, nextClip)}`,
        snapTimes: [nextClip.start, nextClip.start + nextClip.duration],
      });
      continue;
    }

    const actor = addedSorted.length >= 4 && placeCounter % 2 === 1 ? cutter : primary;
    placeCounter++;
    rawSteps.push({
      id: `place-${nextClip.id}`,
      kind: 'place',
      actor,
      clipId: nextClip.id,
      assetId: nextClip.assetID,
      trackId: nextClip.trackID,
      time: nextClip.start,
      duration: nextClip.duration,
      label: `Placing ${clipName(after, nextClip)}`,
      snapTimes: [nextClip.start, nextClip.start + nextClip.duration],
    });

    if (nextClip.grade) {
      rawSteps.push({
        id: `grade-${nextClip.id}`,
        kind: 'grade',
        actor: addedSorted.length >= 3 ? colorActor : primary,
        clipId: nextClip.id,
        trackId: nextClip.trackID,
        time: nextClip.start + nextClip.duration * 0.5,
        duration: nextClip.duration,
        label: nextClip.grade.look ? `Look: ${nextClip.grade.look}` : 'Color grade',
        grade: nextClip.grade,
      });
    }
    if (nextClip.transitionIn) {
      rawSteps.push({
        id: `trans-${nextClip.id}`,
        kind: 'transition',
        actor: cutter,
        clipId: nextClip.id,
        trackId: nextClip.trackID,
        time: nextClip.start,
        duration: nextClip.transitionIn.duration,
        label: nextClip.transitionIn.kind,
        transitionKind: nextClip.transitionIn.kind,
      });
    }
  }

  for (const nextClip of after.clips) {
    const prevClip = beforeMap.get(nextClip.id);
    if (!prevClip) continue;
    if (Math.abs(prevClip.start - nextClip.start) > 1e-3 || prevClip.trackID !== nextClip.trackID) {
      rawSteps.push({
        id: `move-${nextClip.id}`,
        kind: 'move',
        actor: primary,
        clipId: nextClip.id,
        trackId: nextClip.trackID,
        time: nextClip.start,
        duration: nextClip.duration,
        label: `Moving ${clipName(after, nextClip)}`,
        snapTimes: [nextClip.start],
      });
    }
    if (
      Math.abs(prevClip.duration - nextClip.duration) > 1e-3 ||
      Math.abs((prevClip.sourceStart ?? 0) - (nextClip.sourceStart ?? 0)) > 1e-3 ||
      (prevClip.speed ?? 1) !== (nextClip.speed ?? 1)
    ) {
      rawSteps.push({
        id: `trim-${nextClip.id}`,
        kind: 'trim',
        actor: cutter,
        clipId: nextClip.id,
        trackId: nextClip.trackID,
        time: nextClip.start + nextClip.duration,
        duration: nextClip.duration,
        label: `Trimming ${clipName(after, nextClip)}`,
        cutTime: nextClip.start + nextClip.duration,
      });
    }
    if (gradeChanged(prevClip.grade, nextClip.grade) && nextClip.grade) {
      rawSteps.push({
        id: `grade-${nextClip.id}`,
        kind: 'grade',
        actor: colorActor,
        clipId: nextClip.id,
        trackId: nextClip.trackID,
        time: nextClip.start + nextClip.duration * 0.5,
        duration: nextClip.duration,
        label: nextClip.grade.look ? `Look: ${nextClip.grade.look}` : 'Grading shot',
        grade: nextClip.grade,
      });
    }
    if (transitionChanged(prevClip.transitionIn, nextClip.transitionIn) && nextClip.transitionIn) {
      rawSteps.push({
        id: `trans-${nextClip.id}`,
        kind: 'transition',
        actor: cutter,
        clipId: nextClip.id,
        trackId: nextClip.trackID,
        time: nextClip.start,
        duration: nextClip.transitionIn.duration,
        label: nextClip.transitionIn.kind,
        transitionKind: nextClip.transitionIn.kind,
      });
    }
    if (zoomChanged(prevClip.transform, nextClip.transform)) {
      rawSteps.push({
        id: `zoom-${nextClip.id}`,
        kind: 'zoom',
        actor: primary,
        clipId: nextClip.id,
        trackId: nextClip.trackID,
        time: nextClip.start + nextClip.duration * 0.5,
        duration: nextClip.duration,
        label: 'Framing zoom',
      });
    }
    if (audioChanged(prevClip, nextClip)) {
      rawSteps.push({
        id: `aud-${nextClip.id}`,
        kind: 'audio',
        actor: soundActor,
        clipId: nextClip.id,
        trackId: nextClip.trackID,
        time: nextClip.start + nextClip.duration * 0.5,
        duration: nextClip.duration,
        label: 'Balancing audio',
      });
    }
  }

  if (before.width !== after.width || before.height !== after.height) {
    rawSteps.unshift({
      id: 'sequence-size',
      kind: 'sequence',
      actor: primary,
      time: 0,
      duration: 0,
      label: `Frame ${after.width}x${after.height}`,
    });
  }

  if (JSON.stringify(before.captions ?? null) !== JSON.stringify(after.captions ?? null)) {
    rawSteps.push({
      id: 'captions',
      kind: 'captions',
      actor: titlesActor,
      time: 0,
      duration: 0,
      label: 'Styling captions',
    });
  }

  const count = Math.max(1, rawSteps.length);
  const targetTotalMs = count <= 3 ? Math.max(1400, count * 680) : Math.min(6800, 1400 + count * 340);
  const stepSpanMs = Math.max(420, Math.min(920, targetTotalMs / count));
  const staggerMs = count <= 2 ? stepSpanMs * 0.88 : (targetTotalMs - stepSpanMs) / Math.max(1, count - 1);

  const actorTrackEnd = new Map<string, number>();
  const steps: MagicChoreoStep[] = rawSteps.map((s, idx) => {
    const prevEnd = actorTrackEnd.get(s.actor.id) ?? 0;
    const startMs = Math.max(idx * staggerMs, prevEnd * 0.72);
    const dur =
      s.kind === 'grade'
        ? Math.max(stepSpanMs, 780)
        : s.kind === 'transition'
        ? Math.max(stepSpanMs, 720)
        : stepSpanMs;
    const endMs = startMs + dur;
    actorTrackEnd.set(s.actor.id, endMs);
    return { ...s, startMs, endMs };
  });

  const actorsMap = new Map<string, MagicActor>();
  for (const s of steps) actorsMap.set(s.actor.id, s.actor);
  const maxEnd = steps.reduce((acc, s) => Math.max(acc, s.endMs), 900);

  return {
    before: cloneProject(before),
    after: cloneProject(after),
    actors: [...actorsMap.values()],
    steps,
    totalDurationMs: maxEnd + 460,
  };
}

/**
 * Progressively applies a completed choreographic step onto a working project clone
 * so clips/grades/transitions land live as each AI cursor finishes its action.
 */
export function applyMagicStep(working: Project, step: MagicChoreoStep, target: Project): Project {
  const next = cloneProject(working);
  const targetClip = step.clipId ? target.clips.find((c) => c.id === step.clipId) : undefined;

  if (step.kind === 'sequence') {
    next.width = target.width;
    next.height = target.height;
    next.fps = target.fps;
    next.videoTracks = target.videoTracks.map((t) => ({ ...t }));
    next.audioTracks = target.audioTracks.map((t) => ({ ...t }));
    return next;
  }

  if (step.kind === 'captions') {
    next.captions = target.captions ? { ...target.captions } : undefined;
    return next;
  }

  if (step.kind === 'remove' && step.clipId) {
    next.clips = next.clips.filter((c) => c.id !== step.clipId);
    return next;
  }

  if (!targetClip) return next;

  for (const vt of target.videoTracks) {
    if (!next.videoTracks.some((t) => t.id === vt.id)) next.videoTracks.push({ ...vt });
  }
  for (const at of target.audioTracks) {
    if (!next.audioTracks.some((t) => t.id === at.id)) next.audioTracks.push({ ...at });
  }

  const idx = next.clips.findIndex((c) => c.id === targetClip.id);
  if (idx === -1) {
    const placed = cloneProject({ ...target, clips: [targetClip] }).clips[0];
    if (step.kind === 'place') {
      delete placed.grade;
      delete placed.transitionIn;
    }
    next.clips.push(placed);
  } else {
    const cur = next.clips[idx];
    if (step.kind === 'grade') {
      cur.grade = targetClip.grade ? { ...targetClip.grade } : undefined;
    } else if (step.kind === 'transition') {
      cur.transitionIn = targetClip.transitionIn ? { ...targetClip.transitionIn } : undefined;
    } else if (step.kind === 'zoom') {
      cur.transform = targetClip.transform ? JSON.parse(JSON.stringify(targetClip.transform)) : undefined;
    } else if (step.kind === 'audio') {
      cur.gainDB = targetClip.gainDB;
      cur.fadeIn = targetClip.fadeIn;
      cur.fadeOut = targetClip.fadeOut;
    } else {
      next.clips[idx] = cloneProject({ ...target, clips: [targetClip] }).clips[0];
    }
  }

  sanitizeProject(next);
  return next;
}
