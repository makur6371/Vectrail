import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_LOOKS,
  bakeGradeLUT,
  isGradeNeutral,
  parseCubeText,
  serializeGradeAsCubeText,
} from '../src/shared/colorGrade';
import { rampSource, rampSpan, retimeClip } from '../src/shared/speedRamp';
import { starterZoomMove, transformAt, zoomAmountAt } from '../src/shared/zoomMove';
import { buildCaptionBlocks } from '../src/shared/captions';
import { computeLevelEqualizationGains, duckGainAt, trackAudioActivity } from '../src/shared/audioLevels';
import { buildClipLabels, buildMarkerLabels, extractMagicSpan, findMentions, markersAsTimes } from '../src/shared/magicMentions';
import { planLocalMagic } from '../src/shared/localMagic';
import {
  applyStickyEdgeShift,
  cloneProject,
  closeAllGaps,
  computeExportRenderSize,
  createEmptyProject,
  createSolidClip,
  detachAudioLinks,
  duplicateClips,
  evenOutAudioLevels,
  formatTimecode,
  freezeFrameClip,
  makeClipsForAsset,
  nearestEditPoint,
  parseTimecode,
  pasteClipGroup,
  projectCroppedToRange,
  removeClips,
  resolveOverlaps,
  reverseClipGroup,
  rippleTrimEdge,
  snapFrame,
  splitClipsAt,
  transitionPlanForClip,
} from '../src/shared/project';
import { autoPlanEdit, findBestMoments } from '../src/shared/autoPlanner';
import { mergeShortcutBindings } from '../src/shared/shortcuts';
import { collectMediaFiles } from '../src/main/engine/ffmpeg';
import { applyMagicStep, buildMagicPlan } from '../src/shared/magicPlan';
import { MediaAsset, Transcript } from '../src/shared/types';

describe('ColorGrade & 3D LUT', () => {
  it('treats empty grade as neutral and bakes non-neutral looks', () => {
    expect(isGradeNeutral(undefined)).toBe(true);
    expect(isGradeNeutral({ exposure: 0, contrast: 0 })).toBe(true);
    expect(isGradeNeutral({ look: 'Film print', lookIntensity: 1 })).toBe(false);

    for (const look of BUILT_IN_LOOKS) {
      const cube = bakeGradeLUT({ look: look.name, lookIntensity: 1, exposure: 0.2 });
      expect(cube).toBeInstanceOf(Float32Array);
      expect(cube?.length).toBe(32 * 32 * 32 * 4);
    }
  });

  it('parses and serializes .cube 3D LUT files', () => {
    const cubeText = serializeGradeAsCubeText({ look: 'Golden hour', saturation: 15 });
    expect(cubeText).toContain('LUT_3D_SIZE 32');
    const parsed = parseCubeText(cubeText!);
    expect(parsed?.size).toBe(32);
  });
});

describe('SpeedRamp & ZoomMove', () => {
  it('integrates piecewise speed ramp consistently', () => {
    const ramp = { inFrom: 1, inTo: 2, outFrom: 4, outTo: 5, startSpeed: 1, endSpeed: 1 };
    const span = rampSpan(ramp, 0, 6, 2);
    expect(span).toBeGreaterThan(3);
    expect(span).toBeLessThan(6);
    const backToSource = rampSource(ramp, 0, span, 2);
    expect(backToSource).toBeCloseTo(6, 2);
  });

  it('retimes clip duration when speed changes', () => {
    const proj = createEmptyProject();
    const asset: MediaAsset = {
      id: 'a1',
      path: 'test.mp4',
      name: 'test.mp4',
      kind: 'video',
      duration: 10,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: false,
    };
    const [clip] = makeClipsForAsset(proj, asset, 0, proj.videoTracks[0].id, proj.audioTracks[0].id, 0, 4);
    retimeClip(clip, (t) => snapFrame(t, 30), 1 / 30, (c) => {
      c.speed = 2;
    });
    expect(clip.duration).toBeCloseTo(2, 2);
  });

  it('computes smooth ZoomMove curves', () => {
    const zm = starterZoomMove('inOut', 4);
    expect(zoomAmountAt(zm, 0)).toBe(0);
    expect(zoomAmountAt(zm, 2)).toBeCloseTo(1, 5);
    expect(zoomAmountAt(zm, 4)).toBeCloseTo(0, 5);
    const tf = transformAt({ scale: 1.5, x: 0.2, y: -0.1, zoom: zm }, 2);
    expect(tf.scale).toBeCloseTo(1.5, 4);
  });
});

describe('Project Timeline Ops, Timecode, Captions & AutoPlanner', () => {
  it('splits, freezes, reverses, detaches, duplicates, and ripple-deletes clips', () => {
    const proj = createEmptyProject();
    const asset: MediaAsset = {
      id: 'v1',
      path: 'clip.mp4',
      name: 'clip.mp4',
      kind: 'video',
      duration: 12,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
    };
    proj.assets.push(asset);
    const made = makeClipsForAsset(proj, asset, 0, proj.videoTracks[0].id, proj.audioTracks[0].id, 0, 6);
    proj.clips.push(...made);
    expect(proj.clips.length).toBe(2);

    const rightIds = splitClipsAt(proj, [made[0].id, made[1].id], 3);
    expect(rightIds.length).toBe(2);
    expect(proj.clips.length).toBe(4);

    const frozen = freezeFrameClip(proj, made[0].id, 1.5, 2);
    expect(frozen?.freeze).toBe(true);

    reverseClipGroup(proj, rightIds[0]);
    expect(proj.clips.find((c) => c.id === rightIds[0])?.reversed).toBe(true);

    const copies = duplicateClips(proj, [rightIds[0]], 12);
    expect(copies.length).toBe(2);

    detachAudioLinks(proj, [rightIds[0]]);
    expect(proj.clips.find((c) => c.id === rightIds[0])?.linkID).toBeUndefined();

    const beforeCount = proj.clips.length;
    removeClips(proj, new Set([copies[0].id]), true);
    expect(proj.clips.length).toBe(beforeCount - 1);

    resolveOverlaps(proj, new Set([made[0].id]));
  });

  it('formats and parses timecodes and export sizes', () => {
    expect(formatTimecode(12.2, 30)).toBe('00:00:12:06');
    expect(parseTimecode('00:00:12:06', 30)).toBeCloseTo(12.2, 3);
    expect(formatTimecode(65.5, 30, true)).toBe('1:05.50');

    const proj = createEmptyProject(1920, 1080, 30);
    expect(computeExportRenderSize(proj, 'vertical', 1080)).toEqual({ width: 1080, height: 1920 });
    expect(computeExportRenderSize(proj, 'square', 1080)).toEqual({ width: 1080, height: 1080 });
    expect(computeExportRenderSize(proj, 'portrait', 1080)).toEqual({ width: 1080, height: 1350 });
  });

  it('builds balanced caption blocks from transcript', () => {
    const proj = createEmptyProject();
    const asset: MediaAsset = {
      id: 'aud1',
      path: 'talk.wav',
      name: 'talk.wav',
      kind: 'audio',
      duration: 8,
      width: 0,
      height: 0,
      fps: 30,
      hasAudio: true,
    };
    proj.assets.push(asset);
    const [clip] = makeClipsForAsset(proj, asset, 0, proj.videoTracks[0].id, proj.audioTracks[0].id, 0, 8);
    clip.captioned = true;
    proj.clips.push(clip);

    const transcripts: Record<string, Transcript> = {
      aud1: {
        duration: 8,
        words: [
          { start: 0.2, end: 0.5, text: 'Welcome' },
          { start: 0.55, end: 0.8, text: 'to' },
          { start: 0.85, end: 1.4, text: 'Vectrail.' },
          { start: 2.5, end: 3.1, text: 'Cut' },
          { start: 3.15, end: 3.6, text: 'faster.' },
        ],
      },
    };
    const blocks = buildCaptionBlocks(proj, transcripts);
    expect(blocks.length).toBe(2);
    expect(blocks[0].words.map((w) => w.text).join(' ')).toBe('Welcome to Vectrail.');
  });

  it('plans beat-synced montage in AutoPlanner', () => {
    const proj = createEmptyProject();
    const videoAsset: MediaAsset = {
      id: 'vid',
      path: 'v.mp4',
      name: 'v.mp4',
      kind: 'video',
      duration: 12,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
    };
    const musicAsset: MediaAsset = {
      id: 'mus',
      path: 'm.mp3',
      name: 'm.mp3',
      kind: 'audio',
      duration: 20,
      width: 0,
      height: 0,
      fps: 30,
      hasAudio: true,
    };
    const samples = Array.from({ length: 24 }, (_, i) => ({
      time: i * 0.5,
      luma: 0.45,
      sharpness: 0.1 + (i % 4) * 0.02,
      motion: 0.05,
      color: 0.3,
      faces: i % 3 === 0 ? 1 : 0,
    }));
    const moments = findBestMoments({ duration: 12, samples }, 12, 2, 3);
    expect(moments.length).toBeGreaterThan(0);

    const beats = Array.from({ length: 40 }, (_, i) => i * 0.5);
    const plan = autoPlanEdit(
      proj,
      [{ asset: videoAsset, analysis: { duration: 12, samples } }],
      { asset: musicAsset, analysis: { duration: 20, bpm: 120, beats, barPhase: 0, energy: beats.map(() => 0.8) } }
    );
    expect(plan).toBeDefined();
    expect(plan!.shots.length).toBeGreaterThan(0);
    expect(plan!.music).toBeDefined();
  });

  it('supports sticky edges, clip paste, solid clips, shortcut clearing, and folder import scanning', () => {
    const proj = createEmptyProject();
    const vTrack = proj.videoTracks[0].id;
    const aTrack = proj.audioTracks[0].id;
    const asset: MediaAsset = {
      id: 'v1',
      path: 'clip.mp4',
      name: 'clip.mp4',
      kind: 'video',
      duration: 10,
      width: 1280,
      height: 720,
      fps: 30,
      hasAudio: true,
    };
    proj.assets.push(asset);
    const first = makeClipsForAsset(proj, asset, 0, vTrack, aTrack, 0, 3);
    const second = makeClipsForAsset(proj, asset, 3, vTrack, aTrack, 3, 2);
    proj.clips.push(...first, ...second);

    applyStickyEdgeShift(
      proj,
      new Set(first.map((c) => c.id)),
      new Set([vTrack, aTrack]),
      3,
      -0.5
    );
    expect(proj.clips.find((c) => c.id === second[0].id)!.start).toBeCloseTo(2.5, 3);
    expect(proj.clips.find((c) => c.id === second[1].id)!.start).toBeCloseTo(2.5, 3);

    const pasted = pasteClipGroup(proj, first, 8);
    expect(pasted.length).toBe(2);
    expect(pasted[0].linkID).toBe(pasted[1].linkID);
    expect(pasted[0].linkID).not.toBe(first[0].linkID);

    const solid = createSolidClip(proj, '#FF4A1C', 12, 2);
    expect(solid.kind).toBe('solid');
    expect(solid.color?.r).toBeCloseTo(1, 2);

    const cleared = mergeShortcutBindings({ toggleSnap: '' });
    expect(cleared.find((b) => b.id === 'toggleSnap')?.combo).toBe('');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vectrail-folder-'));
    try {
      const sub = path.join(tmpRoot, 'B-Roll');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'intro.mp4'), 'x');
      fs.writeFileSync(path.join(sub, 'shot1.mov'), 'x');
      fs.writeFileSync(path.join(tmpRoot, '.hidden.mp4'), 'x');
      fs.writeFileSync(path.join(tmpRoot, 'notes.txt'), 'x');
      const found = collectMediaFiles([tmpRoot]);
      const rootName = path.basename(tmpRoot);
      expect(found.map((f) => path.basename(f.path))).toEqual(['intro.mp4', 'shot1.mov']);
      expect(found[0].folder).toBe(rootName);
      expect(found[1].folder).toBe(`${rootName}/B-Roll`);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('choreographs Magic before/after diffs into swarm steps and converges cleanly', () => {
    const before = createEmptyProject();
    const after = cloneProject(before);
    const vTrack = after.videoTracks[0].id;
    const aTrack = after.audioTracks[0].id;
    const asset = {
      id: 'asset-magic-1',
      path: '/tmp/clip.mp4',
      name: 'clip.mp4',
      kind: 'video' as const,
      duration: 8,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
    };
    after.assets.push(asset);
    const placed = makeClipsForAsset(after, asset, 0, vTrack, aTrack, 0, 4);
    placed[0].grade = { look: 'Film print', exposure: 0.2 };
    placed[0].transitionIn = { kind: 'dissolve', duration: 0.5 };
    after.clips.push(...placed);

    const plan = buildMagicPlan(before, after, 'Claude');
    expect(plan.steps.length).toBeGreaterThanOrEqual(4);
    expect(plan.steps.some((s) => s.kind === 'place')).toBe(true);
    expect(plan.steps.some((s) => s.kind === 'grade')).toBe(true);
    expect(plan.steps.some((s) => s.kind === 'transition')).toBe(true);

    let working = cloneProject(before);
    for (const step of plan.steps) {
      working = applyMagicStep(working, step, after);
    }
    expect(working.clips.length).toBe(after.clips.length);
    expect(working.clips[0].grade?.look).toBe('Film print');
    expect(working.clips[0].transitionIn?.kind).toBe('dissolve');
  });

  it('closes gaps, evens audio levels, ripple-trims edges, and finds nearest edit points', () => {
    const p = createEmptyProject();
    const vt = p.videoTracks[0].id;
    const at = p.audioTracks[0].id;
    p.clips.push(
      { id: 'v1', trackID: vt, kind: 'solid', start: 1, duration: 3 },
      { id: 'v2', trackID: vt, kind: 'solid', start: 6, duration: 2 },
      { id: 'a1', trackID: at, kind: 'audio', start: 0, duration: 4, gainDB: -14 }
    );

    expect(nearestEditPoint(p, 2, true)).toBe(4);
    expect(nearestEditPoint(p, 5, false)).toBe(4);

    closeAllGaps(p);
    expect(p.clips.find((c) => c.id === 'v1')!.start).toBe(0);
    expect(p.clips.find((c) => c.id === 'v2')!.start).toBe(3);

    evenOutAudioLevels(p, -6);
    expect(p.clips.find((c) => c.id === 'a1')!.gainDB).toBe(-6);

    rippleTrimEdge(p, ['v1'], 2, false);
    expect(p.clips.find((c) => c.id === 'v1')!.duration).toBe(2);
    expect(p.clips.find((c) => c.id === 'v2')!.start).toBe(2);
  });

  it('computes upstream-parity transition plans, range cropping, reverse mirroring, audio ducking, and local magic', () => {
    const p = createEmptyProject();
    const vt = p.videoTracks[0].id;
    const at = p.audioTracks[0].id;
    const asset = {
      id: 'a-vid',
      path: 'vid.mp4',
      name: 'Beach Walk.mp4',
      kind: 'video' as const,
      duration: 10,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
    };
    p.assets.push(asset);
    p.clips.push(
      { id: 'c1', trackID: vt, kind: 'video', assetID: asset.id, start: 0, duration: 3, sourceStart: 1, speed: 1 },
      {
        id: 'c2',
        trackID: vt,
        kind: 'video',
        assetID: asset.id,
        start: 3,
        duration: 3,
        sourceStart: 4,
        speed: 1,
        transitionIn: { kind: 'dissolve', duration: 0.5 },
      },
      { id: 'a1', trackID: at, kind: 'audio', assetID: asset.id, start: 0, duration: 3, sourceStart: 0, speed: 1, gainDB: -6 }
    );

    const plan1 = transitionPlanForClip(p, p.clips[0]);
    const plan2 = transitionPlanForClip(p, p.clips[1]);
    expect(plan2.leadIn).toBeCloseTo(0.5, 3);
    expect(plan2.reveal?.start).toBeCloseTo(2.5, 3);
    expect(plan1.conceal).toBeUndefined();

    p.clips[1].transitionIn = { kind: 'dipToBlack', duration: 0.6 };
    const dip1 = transitionPlanForClip(p, p.clips[0]);
    const dip2 = transitionPlanForClip(p, p.clips[1]);
    expect(dip1.conceal?.start).toBeCloseTo(2.7, 3);
    expect(dip1.conceal?.end).toBeCloseTo(3, 3);
    expect(dip2.reveal?.start).toBeCloseTo(3, 3);
    expect(dip2.reveal?.end).toBeCloseTo(3.3, 3);

    reverseClipGroup(p, 'c1');
    expect(p.clips[0].reversed).toBe(true);
    expect(p.clips[0].sourceStart).toBeCloseTo(6, 3);
    reverseClipGroup(p, 'c1');
    expect(p.clips[0].reversed).toBeUndefined();
    expect(p.clips[0].sourceStart).toBeCloseTo(1, 3);

    p.markers = [{ id: 'm1', time: 2.5, name: 'Peak' }];
    const cropped = projectCroppedToRange(p, 1.5, 4.5);
    expect(cropped.markers?.[0].time).toBeCloseTo(1.0, 3);
    expect(cropped.clips.every((c) => c.start >= 0)).toBe(true);

    const wf = {
      'a-vid': {
        peaksPerSecond: 10,
        peaks: Array.from({ length: 100 }, (_, i) => (i >= 10 && i <= 20 ? 0.5 : 0.001)),
      },
    };
    const spans = trackAudioActivity(at, p, wf);
    expect(spans.length).toBe(1);
    expect(duckGainAt(1.5, spans, 0.25)).toBeCloseTo(0.25, 2);
    expect(duckGainAt(0.1, spans, 0.25)).toBeCloseTo(1, 2);
    const eq = computeLevelEqualizationGains([p.clips[2]], wf, -12);
    expect(eq.gains.has('a1')).toBe(true);

    const mLabels = buildMarkerLabels(p);
    const cLabels = buildClipLabels(p);
    const found = findMentions('apply @Peak to @clip:' + cLabels[0].name, p.assets, cLabels, mLabels);
    expect(found.some((f) => f.mention.kind === 'marker')).toBe(true);
    expect(found.some((f) => f.mention.kind === 'clip')).toBe(true);
    const spanText = markersAsTimes('keep 1s to @Peak', p);
    expect(extractMagicSpan(spanText, 30)?.end).toBeCloseTo(2.5, 3);

    const res = planLocalMagic('remove @selected', {
      project: p,
      pointers: { playhead: 0, selected: ['c2'] },
      clipAnalyses: {},
      musicAnalyses: {},
      transcripts: {},
      waveforms: wf,
    });
    expect(res.changed).toBe(true);
    expect(res.nextProject?.clips.some((c) => c.id === 'c2')).toBe(false);

    const combo = planLocalMagic('add cross dissolve and make it cinematic', {
      project: p,
      pointers: { playhead: 0, selected: [] },
      clipAnalyses: {},
      musicAnalyses: {},
      transcripts: {},
      waveforms: wf,
    });
    expect(combo.changed).toBe(true);
    const gradedV = combo.nextProject?.clips.filter((c) => c.kind === 'video') ?? [];
    expect(gradedV.some((c) => c.grade?.look === 'Teal and orange')).toBe(true);
    expect(gradedV.slice(1).some((c) => c.transitionIn?.kind === 'dissolve')).toBe(true);
  });
});
