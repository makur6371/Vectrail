import { computeLevelEqualizationGains, WaveformEnvelopeInput } from './audioLevels';
import { autoPlanEdit, AutoPlanRecipe, createSampleScorer, EditDecision, findBestMoments, percentile } from './autoPlanner';
import { buildCaptionBlocks, defaultCaptionStyle } from './captions';
import { BUILT_IN_LOOKS } from './colorGrade';
import {
  buildClipLabels,
  buildMarkerLabels,
  extractMagicSpan,
  extractMagicTimes,
  findMentions,
  MagicPointers,
  markersAsTimes,
} from './magicMentions';
import {
  addTrack,
  clipEnd,
  clipName,
  cloneProject,
  closeAllGaps,
  freeTrack,
  isTrackLocked,
  linkedIds,
  makeClipsForAsset,
  newId,
  projectCroppedToRange,
  projectDuration,
  removeClips,
  resolveOverlaps,
  rippleDeleteRange,
  sanitizeProject,
  snapFrame,
  splitClipsAt,
  trimClipHead,
  trimClipTail,
} from './project';
import { clipSourceLength, retimeClip } from './speedRamp';
import { starterZoomMove } from './zoomMove';
import {
  Clip,
  ClipAnalysis,
  MediaAsset,
  MusicAnalysis,
  Project,
  Transcript,
} from './types';

export interface LocalRecipe {
  seconds?: number;
  pace: 'unchanged' | 'calm' | 'fast';
  look?: string;
  music: 'unchanged' | 'off' | 'add';
  frame: 'unchanged' | 'vertical' | 'horizontal' | 'square' | 'portrait';
  keepOnly: Set<string>;
  takeOut: Set<string>;
  mediaNames: string[];
  clearRest: boolean;
  moments: Record<string, number[]>;
  wholeLibrary: boolean;
  shots?: number;
  every: boolean;
  onlyAsked: boolean;
  speed?: number;
  title?: string;
  titleAtEnd: boolean;
  zoom?: 'in' | 'out' | 'inOut' | 'none';
  transition?: 'dissolve' | 'wipe' | 'dipToBlack' | 'none';
  levelAudio: boolean;
  levelGains: Map<string, number>;
  levelSilentNames: string[];
}

export interface LocalMagicOutcome {
  changed: boolean;
  summary: string;
  nextProject?: Project;
  notes?: string[];
}

export interface LocalMagicContext {
  project: Project;
  pointers: MagicPointers;
  clipAnalyses: Record<string, ClipAnalysis>;
  musicAnalyses: Record<string, MusicAnalysis>;
  transcripts: Record<string, Transcript>;
  waveforms: Record<string, WaveformEnvelopeInput>;
  sceneTags?: Record<string, string[]>;
}

function saysAny(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

function parseLookFromRequest(lower: string): string | undefined {
  if (
    saysAny(lower, [
      'no look',
      'remove look',
      'remove the look',
      'clear look',
      'no colour',
      'no color',
      'no filter',
      '去掉滤镜',
      '无调色',
      '清除调色',
    ])
  ) {
    return 'none';
  }
  for (const l of BUILT_IN_LOOKS) {
    if (lower.includes(l.name.toLowerCase())) return l.name;
  }
  if (saysAny(lower, ['black and white', 'black & white', 'b&w', 'monochrome', '黑白'])) return 'Mono';
  if (saysAny(lower, ['golden hour', 'golden', '黄金', '日落'])) return 'Golden hour';
  if (saysAny(lower, ['teal and orange', 'teal & orange', 'cinematic', 'blockbuster', 'cyber', '青橙', '电影感', '大片感', '赛博'])) return 'Teal and orange';
  if (saysAny(lower, ['bleach bypass', 'bleach', 'gritty', 'high contrast', 'dramatic', '漂白', '高对比'])) return 'Bleach bypass';
  if (saysAny(lower, ['cool night', 'night', 'moody', 'cool tone', '冷夜', '冷色调', '冷调'])) return 'Cool night';
  if (saysAny(lower, ['film print', 'filmic', 'print', 'documentary', '胶片打印', '质感', '高级感'])) return 'Film print';
  if (saysAny(lower, ['pastel', '柔和', '粉彩'])) return 'Pastel';
  if (saysAny(lower, ['warm film', 'warm', 'vintage', 'retro', 'nostalgic', '胶片', '暖色', '暖调', '复古'])) return 'Warm film';
  if (saysAny(lower, ['faded', '褪色'])) return 'Faded';
  return undefined;
}

function parseQuotedWords(request: string): string | undefined {
  const m = request.match(/["“「]([^"”」]{1,120})["”」]|'([^']{1,120})'/);
  const val = (m?.[1] ?? m?.[2] ?? '').trim();
  return val || undefined;
}

function parseShotCount(lower: string): number | undefined {
  const wordNums: Record<string, number> = {
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    twelve: 12,
    fifteen: 15,
    twenty: 20,
  };
  let norm = lower;
  for (const [w, n] of Object.entries(wordNums)) {
    norm = norm.replace(new RegExp(`\\b${w}\\b`, 'g'), String(n));
  }
  const m = norm.match(/(\d+)\s*(?:different |unique |separate |short |quick |fast )?(?:clips|shots|cuts|scenes|videos|个镜头|个片段)/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 2 && n <= 200 ? n : undefined;
}

function parseSpeedRequested(lower: string): number | undefined {
  if (saysAny(lower, ['timelapse', 'time lapse', 'time-lapse', '延时'])) return 8;
  if (saysAny(lower, ['half speed', 'slow motion', 'slow-mo', 'slow mo', '慢动作', '慢放'])) return 0.5;
  if (saysAny(lower, ['double speed', '2x speed', '两倍速'])) return 2;
  const xMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:x|times|倍)\b/);
  if (xMatch) {
    const v = Number(xMatch[1]);
    if (v > 0.05 && v <= 100) return v;
  }
  const pctMatch = lower.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch && saysAny(lower, ['speed', 'fast', 'slow', '速度', '倍速'])) {
    const v = Number(pctMatch[1]) / 100;
    if (v > 0.05 && v <= 100) return v;
  }
  return undefined;
}

function findNamedMedia(request: string, media: MediaAsset[]): MediaAsset[] {
  const text = request.toLowerCase();
  const words = new Set(text.split(/[^a-z0-9_\-\u4e00-\u9fff]+/i).filter(Boolean));
  return media.filter((a) => {
    const bare = a.name.replace(/\.[^.]+$/, '').toLowerCase();
    if (bare.length >= 3 && text.includes(bare)) return true;
    const nums = bare.split(/\D+/).filter((s) => s.length >= 3);
    return nums.some((n) => words.has(n));
  });
}

export function parseLocalRecipe(request: string, ctx: LocalMagicContext): LocalRecipe {
  const p = ctx.project;
  const lower = request.toLowerCase();
  const mentions = findMentions(request, p.assets, buildClipLabels(p), buildMarkerLabels(p));
  const pointedAssets = mentions
    .filter((m) => m.mention.kind === 'media')
    .map((m) => p.assets.find((a) => a.id === (m.mention as { kind: 'media'; id: string }).id))
    .filter((a): a is MediaAsset => Boolean(a));
  const namedAssets = [...new Set([...pointedAssets, ...findNamedMedia(request, p.assets)])];

  const keepOnly = new Set<string>();
  const takeOut = new Set<string>();
  const mediaNames: string[] = [];
  if (namedAssets.length > 0) {
    const removeIntent = saysAny(lower, [
      'without ',
      'remove ',
      'take out',
      'drop ',
      'delete ',
      'exclude',
      'except ',
      '去掉',
      '移除',
      '不要',
    ]);
    const onlyIntent = saysAny(lower, ['only ', 'just ', 'nothing else', '只用', '只要', '仅保留']);
    if (removeIntent && !onlyIntent) {
      namedAssets.forEach((a) => takeOut.add(a.id));
    } else {
      namedAssets.forEach((a) => keepOnly.add(a.id));
    }
    namedAssets.forEach((a) => mediaNames.push(a.name));
  }

  let seconds: number | undefined;
  const times = extractMagicTimes(request, p.fps);
  const span = extractMagicSpan(markersAsTimes(request, p), p.fps);
  if (!span) {
    const durMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds|秒)\b/);
    const minMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes|分钟?)\b/);
    if (durMatch) {
      seconds = Math.min(900, Math.max(2, Number(durMatch[1])));
    } else if (minMatch) {
      seconds = Math.min(900, Math.max(5, Number(minMatch[1]) * 60));
    } else if (times.length === 1 && !times[0].unitOnly && saysAny(lower, ['long', 'length', 'duration', '时长'])) {
      seconds = Math.min(900, Math.max(2, times[0].seconds));
    }
  }

  const pace: LocalRecipe['pace'] = saysAny(lower, ['fast', 'quick', 'punchy', 'snappy', 'energetic', '快切', '紧凑', '高燃'])
    ? 'fast'
    : saysAny(lower, ['calm', 'slow', 'gentle', 'relaxed', '舒缓', '慢节奏', '平静'])
    ? 'calm'
    : 'unchanged';

  const look = parseLookFromRequest(lower);

  const music: LocalRecipe['music'] = saysAny(lower, [
    'no music',
    'without music',
    'remove music',
    'remove the music',
    'drop the music',
    'mute music',
    '不要音乐',
    '去掉音乐',
    '无配乐',
  ])
    ? 'off'
    : saysAny(lower, ['add music', 'with music', 'put music', 'background music', 'music', '配乐', '加音乐', '背景音乐'])
    ? 'add'
    : 'unchanged';

  const frame: LocalRecipe['frame'] = saysAny(lower, ['vertical', '9:16', 'reel', 'reels', 'tiktok', 'shorts', '竖屏'])
    ? 'vertical'
    : saysAny(lower, ['square', '1:1', '方形', '正方形'])
    ? 'square'
    : saysAny(lower, ['portrait', '4:5'])
    ? 'portrait'
    : saysAny(lower, ['horizontal', '16:9', 'landscape', 'widescreen', 'youtube', '横屏'])
    ? 'horizontal'
    : 'unchanged';

  const shots = parseShotCount(lower);
  const every =
    /\b(?:all|every|each)\s+(?:of\s+)?(?:the\s+|my\s+)?(?:clips|videos|shots|files|media)\b/.test(lower) ||
    saysAny(lower, ['所有素材', '每个素材', '全部片段']);
  const wholeLibrary =
    every ||
    saysAny(lower, [
      'from scratch',
      'start over',
      'new cut',
      'new edit',
      'new video',
      'montage',
      'whole library',
      'all my media',
      '重新剪',
      '混剪',
      '重剪',
    ]);

  const speed = parseSpeedRequested(lower);
  const titleAsked = saysAny(lower, ['title', 'heading', '标题', '片名'])
    ? parseQuotedWords(request) ?? ''
    : undefined;
  const titleAtEnd = saysAny(lower, ['at the end', 'end title', '结尾']);

  const zoom: LocalRecipe['zoom'] = saysAny(lower, ['no zoom', 'remove zoom', '去掉缩放', '取消缩放'])
    ? 'none'
    : saysAny(lower, ['zoom', '推拉', '缩放'])
    ? (lower.includes('inout') || lower.includes('in-out') || lower.includes('in and out')
        ? 'inOut'
        : lower.includes('out')
        ? 'out'
        : 'in')
    : undefined;

  const transition: LocalRecipe['transition'] = saysAny(lower, ['no transition', 'remove transition', '去掉转场'])
    ? 'none'
    : saysAny(lower, ['dissolve', 'wipe', 'dip to black', 'diptoblack', 'transition', 'transitions', '转场', '叠化', '擦除'])
    ? (lower.includes('wipe') || lower.includes('擦除')
        ? 'wipe'
        : lower.includes('dip')
        ? 'dipToBlack'
        : 'dissolve')
    : undefined;

  const levelAudio = saysAny(lower, [
    'equalize',
    'even out',
    'same volume',
    'same level',
    'level the audio',
    'balance audio',
    '平衡音量',
    '统一音量',
    '均衡音频',
  ]);
  const levelGains = new Map<string, number>();
  const levelSilentNames: string[] = [];
  if (levelAudio) {
    const audioClips = p.clips.filter((c) => c.kind === 'audio' && !isTrackLocked(p, c.trackID));
    const eq = computeLevelEqualizationGains(audioClips, ctx.waveforms);
    for (const [cid, gain] of eq.gains.entries()) levelGains.set(cid, gain);
    for (const sid of eq.silentClipIds) {
      const sc = p.clips.find((c) => c.id === sid);
      if (sc) levelSilentNames.push(clipName(p, sc));
    }
  }

  const clearRest = keepOnly.size > 0 && saysAny(lower, ['nothing else', 'only those', 'clear the rest', '只留这些']);
  const onlyAsked =
    !saysAny(lower, ['improve', 'better', 'tighten', 'tidy', 'clean', 'polish', '优化', '精剪', '润色']) &&
    (speed !== undefined || look !== undefined || zoom !== undefined || transition !== undefined || levelAudio || keepOnly.size > 0 || takeOut.size > 0);

  return {
    seconds,
    pace,
    look,
    music,
    frame,
    keepOnly,
    takeOut,
    mediaNames,
    clearRest,
    moments: {},
    wholeLibrary,
    shots,
    every,
    onlyAsked,
    speed,
    title: titleAsked,
    titleAtEnd,
    zoom,
    transition,
    levelAudio,
    levelGains,
    levelSilentNames,
  };
}

function applyFrameChoice(p: Project, frame: LocalRecipe['frame']): boolean {
  let targetW = p.width;
  let targetH = p.height;
  if (frame === 'vertical') {
    targetW = 1080;
    targetH = 1920;
  } else if (frame === 'square') {
    targetW = 1080;
    targetH = 1080;
  } else if (frame === 'portrait') {
    targetW = 1080;
    targetH = 1350;
  } else if (frame === 'horizontal') {
    targetW = 1920;
    targetH = 1080;
  }
  if (targetW === p.width && targetH === p.height) return false;
  p.width = targetW;
  p.height = targetH;
  p.settingsLocked = true;
  return true;
}

function applyEditDecision(base: Project, decision: EditDecision, frame: LocalRecipe['frame']): Project {
  const next = cloneProject(base);
  next.clips = [];
  next.markers = [];
  next.playRange = undefined;
  next.captions = undefined;
  next.captionFixes = undefined;

  if (frame !== 'unchanged') {
    applyFrameChoice(next, frame);
  } else if (!next.settingsLocked && decision.shots.length > 0) {
    const portraitCount = decision.shots.filter((s) => s.asset.height > s.asset.width).length;
    if (portraitCount > decision.shots.length / 2) {
      next.width = 1080;
      next.height = 1920;
    } else {
      next.width = 1920;
      next.height = 1080;
    }
  }

  const v1 = next.videoTracks[0] ?? addTrack(next, 'video');
  const a1 = next.audioTracks[0] ?? addTrack(next, 'audio');
  let cursor = 0;
  const usedAudioTracks: string[] = [];

  for (let i = 0; i < decision.shots.length; i++) {
    const shot = decision.shots[i];
    const dur = snapFrame(Math.max(0.2, shot.duration), next.fps);
    const audioTrack =
      freeTrack(next, 'audio', cursor, dur) ??
      (decision.music ? addTrack(next, 'audio').id : a1.id);
    const clips = makeClipsForAsset(next, shot.asset, cursor, v1.id, audioTrack, shot.source, dur);
    const v = clips.find((c) => c.kind !== 'audio');
    const a = clips.find((c) => c.kind === 'audio');
    if (v) {
      if (decision.look || Math.abs(shot.exposure) >= 0.08) {
        v.grade = {
          ...(decision.look ? { look: decision.look, lookIntensity: 1 } : {}),
          ...(Math.abs(shot.exposure) >= 0.08 ? { exposure: shot.exposure } : {}),
        };
      }
      if (shot.dissolve && i > 0) {
        v.transitionIn = { kind: 'dissolve', duration: 0.4 };
      }
    }
    if (a) {
      a.gainDB = shot.gainDB;
      if (i === 0) a.fadeIn = Math.min(0.3, dur * 0.2);
      if (i === decision.shots.length - 1) a.fadeOut = Math.min(0.5, dur * 0.3);
      usedAudioTracks.push(a.trackID);
    }
    next.clips.push(...clips);
    cursor = snapFrame(cursor + dur, next.fps);
  }

  if (decision.music) {
    const mTrack =
      next.audioTracks.find((t) => !usedAudioTracks.includes(t.id) && !isTrackLocked(next, t.id)) ??
      addTrack(next, 'audio');
    next.clips.push({
      id: newId(),
      trackID: mTrack.id,
      kind: 'audio',
      assetID: decision.music.asset.id,
      start: 0,
      duration: snapFrame(decision.music.duration, next.fps),
      sourceStart: decision.music.source,
      speed: 1,
      gainDB: 0,
      fadeIn: 0.3,
      fadeOut: Math.min(decision.music.fadeOut, decision.music.duration * 0.4),
    });
  }

  if (decision.title) {
    const v2 = next.videoTracks[1] ?? addTrack(next, 'video');
    const titleDur = Math.min(3.5, Math.max(1.5, cursor));
    const titleStart = decision.titleAtEnd ? Math.max(0, snapFrame(cursor - titleDur, next.fps)) : 0;
    next.clips.push({
      id: newId(),
      trackID: v2.id,
      kind: 'text',
      start: titleStart,
      duration: titleDur,
      fadeIn: 0.4,
      fadeOut: 0.4,
      text: {
        string: decision.title,
        fontName: '',
        bold: true,
        size: 110,
        color: { r: 1, g: 1, b: 1, a: 1 },
        x: 0.5,
        y: 0.5,
      },
    });
  }

  sanitizeProject(next);
  return next;
}

function tryLocalPointed(request: string, recipe: LocalRecipe, ctx: LocalMagicContext): LocalMagicOutcome | undefined {
  const p = ctx.project;
  const ptr = ctx.pointers;
  const withMarks = markersAsTimes(request, p);
  const found = findMentions(request, p.assets, buildClipLabels(p), buildMarkerLabels(p));
  const namedClipIds = found
    .filter((m) => m.mention.kind === 'clip')
    .map((m) => (m.mention as { kind: 'clip'; id: string }).id);
  const lower = request.toLowerCase();
  const hasSelectionMention =
    namedClipIds.length > 0 ||
    found.some((m) => m.mention.kind === 'selected') ||
    (ptr.selected.length > 0 &&
      saysAny(lower, ['selected', 'selection', 'this clip', 'this shot', 'these clips', '选中的', '这个片段']));
  const typedSpan = extractMagicSpan(withMarks, p.fps);
  const hasRange =
    typedSpan !== undefined ||
    found.some((m) => m.mention.kind === 'range') ||
    saysAny(lower, ['in/out', 'in-out', 'marked range', 'the range', '出入点', '选区']);
  const hasPlayhead =
    found.some((m) => m.mention.kind === 'playhead') ||
    saysAny(lower, ['playhead', 'right here', '播放头', '这里']);

  if (!hasSelectionMention && !hasRange && !hasPlayhead) return undefined;

  const wantsRemove = saysAny(lower, [
    'remove',
    'delete',
    'take out',
    'get rid',
    'cut out',
    'drop',
    '删除',
    '去掉',
    '剪掉',
  ]);

  if (hasSelectionMention) {
    const seed = namedClipIds.length > 0 ? namedClipIds : ptr.selected;
    const ids = new Set(
      [...linkedIds(p, seed)].filter((id) => {
        const c = p.clips.find((x) => x.id === id);
        return c && !isTrackLocked(p, c.trackID);
      })
    );
    if (!ids.size) {
      return { changed: false, summary: 'Nothing unlocked is selected to edit.' };
    }
    const next = cloneProject(p);
    if (wantsRemove && recipe.speed === undefined && !recipe.look) {
      removeClips(next, ids, true);
      sanitizeProject(next);
      return { changed: true, summary: 'Removed the selected clips and closed the gap.', nextProject: next };
    }
    const parts: string[] = [];
    if (recipe.speed !== undefined) {
      for (const id of ids) {
        const c = next.clips.find((x) => x.id === id);
        if (!c) continue;
        retimeClip(c, (t) => snapFrame(t, next.fps), 1 / Math.max(1, next.fps), (x) => {
          x.speed = recipe.speed;
        });
      }
      resolveOverlaps(next, ids);
      parts.push(`set speed to ${recipe.speed}x`);
    }
    if (recipe.look) {
      for (const c of next.clips) {
        if (!ids.has(c.id) || c.kind === 'audio') continue;
        if (recipe.look === 'none') {
          if (c.grade) c.grade.look = undefined;
        } else {
          c.grade = { ...(c.grade ?? {}), look: recipe.look, lookIntensity: c.grade?.lookIntensity ?? 1 };
        }
      }
      parts.push(recipe.look === 'none' ? 'removed look' : `applied ${recipe.look}`);
    }
    if (!parts.length) return undefined;
    sanitizeProject(next);
    return { changed: true, summary: `Updated selected clips: ${parts.join(', ')}.`, nextProject: next };
  }

  if (hasRange) {
    const r = typedSpan
      ? { start: typedSpan.start, end: Math.min(typedSpan.end, projectDuration(p)) }
      : ptr.range;
    if (!r || r.end <= r.start + 0.02) {
      return { changed: false, summary: 'Set an In/Out range first (I / O), then try again.' };
    }
    if (saysAny(lower, ['only', 'keep ', 'just ', '只保留']) && !wantsRemove) {
      const next = projectCroppedToRange(p, r.start, r.end);
      sanitizeProject(next);
      return { changed: true, summary: `Kept ${r.start.toFixed(1)}s–${r.end.toFixed(1)}s.`, nextProject: next };
    }
    if (wantsRemove && recipe.speed === undefined && !recipe.look) {
      const next = cloneProject(p);
      const trackIds = new Set([...next.videoTracks, ...next.audioTracks].map((t) => t.id));
      rippleDeleteRange(next, r.start, r.end, trackIds);
      next.playRange = undefined;
      sanitizeProject(next);
      return { changed: true, summary: `Removed ${r.start.toFixed(1)}s–${r.end.toFixed(1)}s and closed the gap.`, nextProject: next };
    }
    if (recipe.speed !== undefined || recipe.look) {
      const next = cloneProject(p);
      const allIds = next.clips.filter((c) => !isTrackLocked(next, c.trackID)).map((c) => c.id);
      splitClipsAt(next, allIds, r.start);
      splitClipsAt(next, next.clips.filter((c) => !isTrackLocked(next, c.trackID)).map((c) => c.id), r.end);
      const inside = new Set(
        next.clips
          .filter((c) => c.start >= r.start - 1e-4 && clipEnd(c) <= r.end + 1e-4 && !isTrackLocked(next, c.trackID))
          .map((c) => c.id)
      );
      for (const c of next.clips) {
        if (!inside.has(c.id)) continue;
        if (recipe.speed !== undefined) {
          retimeClip(c, (t) => snapFrame(t, next.fps), 1 / Math.max(1, next.fps), (x) => {
            x.speed = recipe.speed;
          });
        }
        if (recipe.look && c.kind !== 'audio') {
          if (recipe.look === 'none') {
            if (c.grade) c.grade.look = undefined;
          } else {
            c.grade = { ...(c.grade ?? {}), look: recipe.look, lookIntensity: c.grade?.lookIntensity ?? 1 };
          }
        }
      }
      resolveOverlaps(next, inside);
      sanitizeProject(next);
      return { changed: true, summary: `Updated ${r.start.toFixed(1)}s–${r.end.toFixed(1)}s.`, nextProject: next };
    }
  }

  if (hasPlayhead && saysAny(lower, ['split', 'cut here', 'razor', 'blade', '分割', '切一刀'])) {
    const next = cloneProject(p);
    const t = snapFrame(ptr.playhead, next.fps);
    const under = next.clips
      .filter((c) => !isTrackLocked(next, c.trackID) && t > c.start + 0.04 && t < clipEnd(c) - 0.04)
      .map((c) => c.id);
    const created = splitClipsAt(next, under, t);
    if (!created.length) return { changed: false, summary: 'Nothing under the playhead to split.' };
    sanitizeProject(next);
    return { changed: true, summary: `Split ${created.length} clip(s) at ${t.toFixed(2)}s.`, nextProject: next };
  }

  return undefined;
}

function tryLocalSpeechCut(request: string, ctx: LocalMagicContext): LocalMagicOutcome | undefined {
  const lower = request.toLowerCase();
  if (
    !saysAny(lower, [
      'dead space',
      'dead air',
      'pause',
      'pauses',
      'silence',
      'silent',
      'filler',
      'jump cut',
      'jumpcut',
      'tighten the talk',
      'tighten the speech',
      '去静音',
      '去气口',
      '剪气口',
      '删停顿',
    ])
  ) {
    return undefined;
  }
  const p = ctx.project;
  const mainTrack = p.videoTracks.find((vt) => p.clips.some((c) => c.trackID === vt.id && c.kind === 'video'));
  if (!mainTrack) return { changed: false, summary: 'There are no video shots on the timeline.' };
  if (isTrackLocked(p, mainTrack.id)) return { changed: false, summary: 'The main video track is locked.' };

  const shots = p.clips
    .filter((c) => c.trackID === mainTrack.id && c.kind === 'video')
    .sort((a, b) => a.start - b.start);
  const JOIN = 0.45;
  const KEEP_BEFORE = 0.12;
  const KEEP_AFTER = 0.2;
  const SHORTEST = 0.3;

  const cuts: Array<{ start: number; end: number }> = [];
  let talking = 0;
  let unheard = 0;

  for (const c of shots) {
    if (!c.assetID) continue;
    const tr = ctx.transcripts[c.assetID];
    if (!tr || !tr.words.length) {
      unheard++;
      continue;
    }
    if (Math.abs((c.speed ?? 1) - 1) > 1e-3 || c.reversed) continue;
    const s0 = c.sourceStart ?? 0;
    const s1 = s0 + c.duration;
    const speech: Array<{ start: number; end: number }> = [];
    for (const w of tr.words) {
      if (w.end <= s0 || w.start >= s1) continue;
      const prev = speech[speech.length - 1];
      if (prev && w.start - prev.end < JOIN) {
        prev.end = Math.max(prev.end, w.end);
      } else {
        speech.push({ start: w.start, end: w.end });
      }
    }
    if (!speech.length) continue;
    talking++;
    const keep: Array<[number, number]> = [];
    for (const sp of speech) {
      const a = Math.max(s0, sp.start - KEEP_BEFORE);
      const b = Math.min(s1, sp.end + KEEP_AFTER);
      const last = keep[keep.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else keep.push([a, b]);
    }
    let at = s0;
    for (const [a, b] of keep) {
      if (a - at >= SHORTEST) cuts.push({ start: c.start + (at - s0), end: c.start + (a - s0) });
      at = b;
    }
    if (s1 - at >= SHORTEST) cuts.push({ start: c.start + (at - s0), end: c.start + (s1 - s0) });
  }

  if (talking === 0) {
    return {
      changed: false,
      summary:
        unheard > 0
          ? 'No speech transcripts are ready yet. Transcribe the speaking clips first.'
          : 'Nobody talks in the edit, so there were no pauses to cut.',
    };
  }
  if (!cuts.length) {
    return { changed: false, summary: 'The talking is already tight: no pauses long enough to cut.' };
  }

  const next = cloneProject(p);
  const soundLinks = new Set(
    next.clips.filter((c) => c.trackID === mainTrack.id && c.linkID).map((c) => c.linkID!)
  );
  const syncTracks = new Set(
    [
      mainTrack.id,
      ...next.clips.filter((c) => c.trackID !== mainTrack.id && c.linkID && soundLinks.has(c.linkID)).map((c) => c.trackID),
    ].filter((tid) => !isTrackLocked(next, tid))
  );

  const totalRemoved = cuts.reduce((acc, x) => acc + (x.end - x.start), 0);
  for (const cut of cuts.sort((a, b) => b.start - a.start)) {
    rippleDeleteRange(next, cut.start, cut.end, syncTracks);
  }
  sanitizeProject(next);
  return {
    changed: true,
    summary: `Cut ${cuts.length} pause${cuts.length === 1 ? '' : 's'} (${totalRemoved.toFixed(1)}s) from ${talking} speaking shot${talking === 1 ? '' : 's'}.`,
    nextProject: next,
  };
}

function tryLocalCaptions(request: string, ctx: LocalMagicContext): LocalMagicOutcome | undefined {
  const lower = request.toLowerCase();
  if (!saysAny(lower, ['caption', 'captions', 'subtitle', 'subtitles', '字幕'])) return undefined;
  if (parseQuotedWords(request)) return undefined;
  const p = ctx.project;
  const removes = saysAny(lower, ['remove', 'delete', 'take off', 'no caption', 'no subtitle', 'hide', '去掉', '关闭', '删除']);
  const next = cloneProject(p);
  if (removes) {
    if (!next.captions) return { changed: false, summary: 'There are no captions to remove.' };
    next.captions = undefined;
    next.captionFixes = undefined;
    for (const c of next.clips) c.captioned = undefined;
    return { changed: true, summary: 'Removed the captions.', nextProject: next };
  }
  const selected = new Set(ctx.pointers.selected);
  const audioTargets = next.clips.filter(
    (c) =>
      c.kind === 'audio' &&
      !isTrackLocked(next, c.trackID) &&
      (selected.size === 0 || selected.has(c.id) || (c.linkID && next.clips.some((v) => v.linkID === c.linkID && selected.has(v.id))))
  );
  if (!audioTargets.length) {
    return { changed: false, summary: 'There is no audio clip on the timeline to caption.' };
  }
  for (const c of audioTargets) c.captioned = true;
  if (!next.captions) next.captions = defaultCaptionStyle();
  const blocks = buildCaptionBlocks(next, ctx.transcripts);
  sanitizeProject(next);
  return {
    changed: true,
    summary:
      blocks.length > 0
        ? `Captioned speech: ${blocks.length} caption block${blocks.length === 1 ? '' : 's'}.`
        : 'Enabled caption track for speaking clips.',
    nextProject: next,
  };
}

function tryLocalTitle(request: string, ctx: LocalMagicContext): LocalMagicOutcome | undefined {
  const lower = request.toLowerCase();
  if (!saysAny(lower, ['add title', 'add a title', 'put a title', 'title saying', '加标题', '添加标题'])) {
    return undefined;
  }
  if (saysAny(lower, ['new cut', 'new video', 'montage', 'from scratch', '混剪'])) return undefined;
  const words = parseQuotedWords(request) ?? 'Title';
  const p = ctx.project;
  const next = cloneProject(p);
  const dur = projectDuration(next);
  const atEnd = saysAny(lower, ['at the end', 'end', '结尾']);
  const atPlayhead = saysAny(lower, ['playhead', 'here', '播放头']);
  const len = Math.min(3.5, Math.max(1.5, dur || 3));
  const start = atEnd ? Math.max(0, snapFrame(dur - len, next.fps)) : atPlayhead ? snapFrame(ctx.pointers.playhead, next.fps) : 0;
  const trackId =
    freeTrack(next, 'video', start, len) ??
    next.videoTracks[1]?.id ??
    addTrack(next, 'video').id;
  next.clips.push({
    id: newId(),
    trackID: trackId,
    kind: 'text',
    start,
    duration: len,
    fadeIn: 0.4,
    fadeOut: 0.5,
    text: {
      string: words,
      fontName: '',
      bold: true,
      size: 130,
      color: { r: 1, g: 1, b: 1, a: 1 },
      x: 0.5,
      y: 0.5,
    },
  });
  sanitizeProject(next);
  return { changed: true, summary: `Added title "${words}".`, nextProject: next };
}

function tryLocalZoomOrTransition(request: string, recipe: LocalRecipe, ctx: LocalMagicContext): LocalMagicOutcome | undefined {
  if (
    recipe.wholeLibrary ||
    recipe.look !== undefined ||
    recipe.speed !== undefined ||
    recipe.title !== undefined ||
    recipe.levelAudio ||
    recipe.frame !== 'unchanged' ||
    recipe.pace !== 'unchanged' ||
    recipe.music !== 'unchanged'
  ) {
    return undefined;
  }
  if (!recipe.zoom && !recipe.transition) return undefined;
  const p = ctx.project;
  const next = cloneProject(p);
  const parts: string[] = [];

  if (recipe.zoom) {
    const found = findMentions(request, p.assets, buildClipLabels(p), buildMarkerLabels(p));
    const namedClips = found
      .filter((m) => m.mention.kind === 'clip')
      .map((m) => (m.mention as { kind: 'clip'; id: string }).id);
    const targets = namedClips.length
      ? namedClips
      : ctx.pointers.selected.length
      ? ctx.pointers.selected
      : next.clips.filter((c) => c.kind !== 'audio' && c.kind !== 'text' && !isTrackLocked(next, c.trackID)).slice(0, 4).map((c) => c.id);
    const targetSet = new Set(targets);
    let count = 0;
    for (const c of next.clips) {
      if (!targetSet.has(c.id) || c.kind === 'audio' || isTrackLocked(next, c.trackID)) continue;
      if (recipe.zoom === 'none') {
        if (c.transform) delete c.transform.zoom;
      } else {
        c.transform = {
          scale: Math.max(1.25, c.transform?.scale ?? 1.25),
          x: c.transform?.x ?? 0,
          y: c.transform?.y ?? 0,
          zoom: starterZoomMove(recipe.zoom, c.duration),
        };
      }
      count++;
    }
    if (count > 0) {
      parts.push(recipe.zoom === 'none' ? 'removed zoom' : `applied zoom ${recipe.zoom}`);
    }
  }

  if (recipe.transition) {
    const vClips = next.clips
      .filter((c) => c.kind !== 'audio' && c.kind !== 'text' && !isTrackLocked(next, c.trackID))
      .sort((a, b) => a.start - b.start);
    let count = 0;
    for (let i = 1; i < vClips.length; i++) {
      if (recipe.transition === 'none') vClips[i].transitionIn = undefined;
      else vClips[i].transitionIn = { kind: recipe.transition, duration: 0.45 };
      count++;
    }
    if (count > 0) {
      parts.push(recipe.transition === 'none' ? 'removed transitions' : `added ${recipe.transition} transitions`);
    }
  }

  if (!parts.length) return undefined;
  sanitizeProject(next);
  return { changed: true, summary: parts.join(' · '), nextProject: next };
}

function improveExistingEdit(recipe: LocalRecipe, ctx: LocalMagicContext): LocalMagicOutcome | undefined {
  const p = ctx.project;
  if (recipe.onlyAsked && recipe.levelAudio && recipe.speed === undefined && !recipe.look) {
    if (recipe.levelGains.size === 0) {
      return { changed: false, summary: 'Your audio clips are already balanced or have no sound.' };
    }
    const next = cloneProject(p);
    let leveled = 0;
    for (const c of next.clips) {
      const g = recipe.levelGains.get(c.id);
      if (g !== undefined && Math.abs(g - (c.gainDB ?? 0)) > 0.05) {
        c.gainDB = g;
        leveled++;
      }
    }
    if (!leveled) return { changed: false, summary: 'Your audio clips are already at the same level.' };
    return { changed: true, summary: `Balanced ${leveled} audio clip(s) to the same level.`, nextProject: next };
  }

  const mainTrack = p.videoTracks.find((t) => p.clips.some((c) => c.trackID === t.id && (c.kind === 'video' || c.kind === 'image')));
  if (!mainTrack || isTrackLocked(p, mainTrack.id)) return undefined;

  const next = cloneProject(p);
  const allAnalyses = Object.values(ctx.clipAnalyses).flatMap((a) => a.samples);
  const scorer = allAnalyses.length > 0 ? createSampleScorer(allAnalyses) : undefined;
  const shotScore = (c: Clip): number => {
    if (!c.assetID || !scorer) return 0.5;
    const an = ctx.clipAnalyses[c.assetID];
    if (!an || !an.samples.length) return 0.5;
    const s0 = c.sourceStart ?? 0;
    const s1 = s0 + clipSourceLength(c);
    const inside = an.samples.filter((s) => (c.kind === 'image' ? true : s.time >= s0 && s.time <= s1));
    if (!inside.length) return 0.5;
    return inside.reduce((acc, s) => acc + scorer(s), 0) / inside.length;
  };

  let keep = next.clips
    .filter((c) => c.trackID === mainTrack.id && (c.kind === 'video' || c.kind === 'image') && c.assetID)
    .sort((a, b) => a.start - b.start);
  if (!keep.length) return undefined;

  const droppedIds = new Set<string>();
  if (recipe.keepOnly.size > 0) {
    keep = keep.filter((c) => {
      const ok = Boolean(c.assetID && recipe.keepOnly.has(c.assetID));
      if (!ok) droppedIds.add(c.id);
      return ok;
    });
  }
  if (recipe.takeOut.size > 0) {
    keep = keep.filter((c) => {
      const drop = Boolean(c.assetID && recipe.takeOut.has(c.assetID));
      if (drop) droppedIds.add(c.id);
      return !drop;
    });
  }
  if (!keep.length) return { changed: false, summary: 'No matching shots remained on the main track.' };

  const focused = recipe.keepOnly.size > 0 || recipe.takeOut.size > 0 || recipe.onlyAsked;
  let repeats = 0;
  if (!focused) {
    for (let i = 0; i < keep.length; i++) {
      for (let j = i + 1; j < keep.length; ) {
        const a = keep[i];
        const b = keep[j];
        if (a.assetID === b.assetID && a.kind === b.kind) {
          const a0 = a.sourceStart ?? 0;
          const a1 = a0 + clipSourceLength(a);
          const b0 = b.sourceStart ?? 0;
          const b1 = b0 + clipSourceLength(b);
          const overlap = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
          const shorter = Math.max(0.01, Math.min(a1 - a0, b1 - b0));
          if (a.kind === 'image' || overlap / shorter > 0.5) {
            if (shotScore(b) > shotScore(a)) {
              droppedIds.add(a.id);
              keep[i] = b;
            } else {
              droppedIds.add(b.id);
            }
            keep.splice(j, 1);
            repeats++;
            continue;
          }
        }
        j++;
      }
    }

    if (keep.length > 4) {
      const scores = keep.map(shotScore);
      const floor = percentile(scores, 0.15) - 0.05;
      const weakIdx = keep
        .map((_, idx) => idx)
        .filter((idx) => scores[idx] < floor)
        .sort((a, b) => scores[a] - scores[b]);
      const canDrop = Math.min(weakIdx.length, Math.floor(keep.length / 4), keep.length - 4);
      const weakSet = new Set(weakIdx.slice(0, canDrop).map((idx) => keep[idx].id));
      keep = keep.filter((c) => {
        if (weakSet.has(c.id)) {
          droppedIds.add(c.id);
          return false;
        }
        return true;
      });
    }
  }

  if (droppedIds.size > 0) {
    removeClips(next, linkedIds(next, [...droppedIds]), false);
    keep = keep.sort((a, b) => a.start - b.start);
  }

  const pacedDur = (c: Clip): number => {
    if (recipe.pace === 'calm') return c.duration > 6 ? Math.max(4, c.duration * 0.8) : c.duration;
    if (recipe.pace === 'fast') return c.duration > 2 ? Math.max(1.2, Math.min(2.5, c.duration * 0.5)) : c.duration;
    if (focused) return c.duration;
    return c.duration > 3.5 ? Math.min(c.duration, Math.max(2.5, Math.min(4.5, c.duration * 0.6))) : c.duration;
  };
  const planned = new Map<string, number>(keep.map((c) => [c.id, pacedDur(c)]));
  if (recipe.seconds !== undefined) {
    const nowTotal = keep.reduce((acc, c) => acc + c.duration, 0);
    const pacedTotal = keep.reduce((acc, c) => acc + (planned.get(c.id) ?? c.duration), 0);
    if (recipe.seconds <= pacedTotal) {
      for (const c of keep) {
        planned.set(c.id, Math.max(0.8, ((planned.get(c.id) ?? c.duration) * recipe.seconds) / Math.max(0.01, pacedTotal)));
      }
    } else if (recipe.seconds <= nowTotal) {
      const f = (recipe.seconds - pacedTotal) / Math.max(0.01, nowTotal - pacedTotal);
      for (const c of keep) {
        const pd = planned.get(c.id) ?? c.duration;
        planned.set(c.id, pd + (c.duration - pd) * f);
      }
    }
  }

  if (recipe.speed !== undefined) {
    const keepGroup = linkedIds(next, keep.map((c) => c.id));
    for (const c of next.clips) {
      if (!keepGroup.has(c.id)) continue;
      retimeClip(c, (t) => snapFrame(t, next.fps), 1 / Math.max(1, next.fps), (x) => {
        x.speed = recipe.speed;
      });
      if (c.kind === 'audio' && (recipe.speed ?? 1) >= 2.5) {
        c.gainDB = -60;
      }
    }
  }

  const firstStart = keep[0].start;
  let cursor = firstStart;
  let gapsClosed = 0;
  let trimmedShots = 0;
  for (const shot of keep) {
    const desired = snapFrame(Math.max(0.4, recipe.speed !== undefined ? shot.duration : (planned.get(shot.id) ?? shot.duration)), next.fps);
    const group = [...linkedIds(next, [shot.id])];
    if (shot.kind === 'video' && desired < shot.duration - 0.5 / Math.max(1, next.fps) && shot.assetID) {
      const an = ctx.clipAnalyses[shot.assetID];
      if (an && an.samples.length > 0) {
        const s0 = shot.sourceStart ?? 0;
        const best = findBestMoments(an, s0 + clipSourceLength(shot), desired, 1, scorer).find(
          (m) => m.start >= s0 - 0.05
        );
        if (best) {
          const newHead = snapFrame(shot.start + (best.start - s0) / Math.max(0.01, shot.speed ?? 1), next.fps);
          for (const gid of group) {
            const item = next.clips.find((x) => x.id === gid);
            if (item && newHead > item.start + 0.02) trimClipHead(item, newHead);
          }
        }
      }
    }
    const delta = cursor - shot.start;
    if (Math.abs(delta) > 0.02) gapsClosed++;
    for (const gid of group) {
      const item = next.clips.find((x) => x.id === gid);
      if (!item || isTrackLocked(next, item.trackID)) continue;
      item.start = snapFrame(Math.max(0, item.start + delta), next.fps);
      if (item.duration > desired + 0.02) {
        trimClipTail(item, snapFrame(item.start + desired, next.fps));
        if (item.id === shot.id) trimmedShots++;
      }
    }
    cursor = snapFrame(cursor + shot.duration, next.fps);
  }

  let targetLook = recipe.look;
  if (!targetLook && !focused) {
    const counts = new Map<string, number>();
    for (const c of keep) {
      if (c.grade?.look) counts.set(c.grade.look, (counts.get(c.grade.look) ?? 0) + 1);
    }
    let bestLook: string | undefined;
    let bestCount = 0;
    for (const [k, v] of counts.entries()) {
      if (v > bestCount) {
        bestCount = v;
        bestLook = k;
      }
    }
    targetLook = bestLook;
  }
  let looksChanged = 0;
  if (targetLook) {
    for (const c of keep) {
      if (targetLook === 'none') {
        if (c.grade?.look) {
          c.grade.look = undefined;
          looksChanged++;
        }
      } else {
        if (c.grade?.look !== targetLook) looksChanged++;
        c.grade = { ...(c.grade ?? {}), look: targetLook, lookIntensity: c.grade?.lookIntensity ?? 1 };
      }
    }
  }

  if (recipe.levelAudio) {
    for (const c of next.clips) {
      const g = recipe.levelGains.get(c.id);
      if (g !== undefined) c.gainDB = g;
    }
  }

  const songClip = next.clips.find(
    (c) =>
      c.kind === 'audio' &&
      !c.linkID &&
      next.assets.some((a) => a.id === c.assetID && a.kind === 'audio' && a.duration >= 8)
  );
  if (recipe.music === 'off' && songClip && !isTrackLocked(next, songClip.trackID)) {
    removeClips(next, new Set([songClip.id]), false);
  } else if (recipe.music === 'add' && !songClip) {
    const musicAsset = next.assets.find((a) => a.kind === 'audio' && a.duration >= 8);
    if (musicAsset) {
      const ma = ctx.musicAnalyses[musicAsset.id];
      const barStart = ma?.beats[ma.barPhase % 4] ?? 0;
      const tid = freeTrack(next, 'audio', firstStart, Math.max(1, cursor - firstStart)) ?? addTrack(next, 'audio').id;
      next.clips.push({
        id: newId(),
        trackID: tid,
        kind: 'audio',
        assetID: musicAsset.id,
        start: firstStart,
        duration: snapFrame(Math.max(1, cursor - firstStart), next.fps),
        sourceStart: barStart,
        speed: 1,
        gainDB: 0,
        fadeOut: Math.min(2, (cursor - firstStart) * 0.15),
      });
      for (const c of next.clips) {
        if (c.kind === 'audio' && c.linkID && (c.gainDB ?? 0) > -10) c.gainDB = -16;
      }
    }
  } else if (songClip && !isTrackLocked(next, songClip.trackID)) {
    if (clipEnd(songClip) > cursor + 0.05) {
      trimClipTail(songClip, Math.max(songClip.start + 0.5, cursor));
    }
    if ((songClip.fadeOut ?? 0) < 1.2) {
      songClip.fadeOut = Math.min(2, Math.max(0.5, songClip.duration * 0.15));
    }
  }

  if (recipe.frame !== 'unchanged') {
    applyFrameChoice(next, recipe.frame);
  }
  if (recipe.transition) {
    const vLane = next.clips
      .filter((c) => c.trackID === mainTrack.id && c.kind !== 'audio' && c.kind !== 'text')
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < vLane.length; i++) {
      if (recipe.transition === 'none') vLane[i].transitionIn = undefined;
      else vLane[i].transitionIn = { kind: recipe.transition, duration: 0.45 };
    }
  }
  if (recipe.zoom) {
    for (const c of keep.slice(0, 4)) {
      if (recipe.zoom === 'none') {
        if (c.transform) delete c.transform.zoom;
      } else {
        c.transform = {
          scale: Math.max(1.25, c.transform?.scale ?? 1.25),
          x: c.transform?.x ?? 0,
          y: c.transform?.y ?? 0,
          zoom: starterZoomMove(recipe.zoom, c.duration),
        };
      }
    }
  }
  if (recipe.title) {
    const dur = Math.max(cursor, projectDuration(next));
    const titleDur = Math.min(3.5, Math.max(1.5, dur || 3));
    const titleStart = recipe.titleAtEnd
      ? Math.max(0, snapFrame(dur - titleDur, next.fps))
      : snapFrame(ctx.pointers.playhead, next.fps);
    const tTrack =
      freeTrack(next, 'video', titleStart, titleDur) ??
      next.videoTracks[1]?.id ??
      addTrack(next, 'video').id;
    next.clips.push({
      id: newId(),
      trackID: tTrack,
      kind: 'text',
      start: titleStart,
      duration: titleDur,
      fadeIn: 0.4,
      fadeOut: 0.4,
      text: {
        string: recipe.title,
        fontName: '',
        bold: true,
        size: 110,
        color: { r: 1, g: 1, b: 1, a: 1 },
        x: 0.5,
        y: 0.5,
      },
    });
  }
  closeAllGaps(next);
  sanitizeProject(next);

  const summaryParts: string[] = [];
  if (repeats > 0) summaryParts.push(`${repeats} repeat(s) removed`);
  if (droppedIds.size - repeats > 0) summaryParts.push(`${droppedIds.size - repeats} weak/filtered shot(s) dropped`);
  if (gapsClosed > 0) summaryParts.push(`closed ${gapsClosed} gap(s)`);
  if (trimmedShots > 0) summaryParts.push(`trimmed ${trimmedShots} shot(s)`);
  if (targetLook && looksChanged > 0) summaryParts.push(targetLook === 'none' ? 'removed look' : `applied ${targetLook}`);
  if (recipe.speed !== undefined) summaryParts.push(`speed ${recipe.speed}x`);
  if (recipe.zoom) summaryParts.push(recipe.zoom === 'none' ? 'removed zoom' : `zoom ${recipe.zoom}`);
  if (recipe.transition) summaryParts.push(recipe.transition === 'none' ? 'removed transitions' : `${recipe.transition} transitions`);
  if (recipe.title) summaryParts.push(`title "${recipe.title}"`);
  if (recipe.frame !== 'unchanged') summaryParts.push(recipe.frame);
  if (!summaryParts.length) summaryParts.push(`polished ${keep.length} shots (${cursor.toFixed(1)}s)`);
  return { changed: true, summary: summaryParts.join(' · '), nextProject: next };
}

export function planLocalMagic(request: string, ctx: LocalMagicContext): LocalMagicOutcome {
  const p = ctx.project;
  const trimmed = request.trim();
  const recipe = parseLocalRecipe(trimmed, ctx);

  const pointed = tryLocalPointed(trimmed, recipe, ctx);
  if (pointed) return pointed;

  const speech = tryLocalSpeechCut(trimmed, ctx);
  if (speech) return speech;

  const captions = tryLocalCaptions(trimmed, ctx);
  if (captions) return captions;

  const zt = tryLocalZoomOrTransition(trimmed, recipe, ctx);
  if (zt) return zt;

  const title = tryLocalTitle(trimmed, ctx);
  if (title) return title;

  const hasExistingEdit = p.clips.some((c) => c.kind === 'video' || c.kind === 'image');
  if (hasExistingEdit && !recipe.wholeLibrary) {
    const improved = improveExistingEdit(recipe, ctx);
    if (improved) return improved;
  }

  const visualAssets = p.assets.filter((a) => {
    if (a.kind === 'audio') return false;
    if (recipe.keepOnly.size > 0 && !recipe.keepOnly.has(a.id)) return false;
    if (recipe.takeOut.has(a.id)) return false;
    return Boolean(ctx.clipAnalyses[a.id]?.samples.length);
  });
  if (!visualAssets.length) {
    return {
      changed: false,
      summary: p.assets.some((a) => a.kind !== 'audio')
        ? 'Visual footage is still analyzing; try again in a moment.'
        : 'Import video or image clips into Media first.',
    };
  }
  const clips = visualAssets.map((asset) => ({ asset, analysis: ctx.clipAnalyses[asset.id] }));
  const musicAsset =
    recipe.music === 'off'
      ? undefined
      : p.assets.find((a) => a.kind === 'audio' && a.duration >= 8 && ctx.musicAnalyses[a.id]);
  const music = musicAsset ? { asset: musicAsset, analysis: ctx.musicAnalyses[musicAsset.id] } : undefined;

  const autoRecipe: AutoPlanRecipe = {
    seconds: recipe.seconds,
    pace: recipe.pace,
    look: recipe.look ?? 'Warm film',
    musicMode: recipe.music,
    shots: recipe.shots,
    every: recipe.every,
    moments: recipe.moments,
    title: recipe.title,
    titleAtEnd: recipe.titleAtEnd,
    defaultTitle: recipe.title === undefined && !trimmed,
  };
  const decision = autoPlanEdit(p, clips, music, autoRecipe);
  if (!decision) {
    return { changed: false, summary: 'Could not find enough usable moments to assemble a cut.' };
  }
  const next = applyEditDecision(p, decision, recipe.frame);
  if (recipe.speed !== undefined) {
    for (const c of next.clips) {
      if (c.kind === 'video') {
        retimeClip(c, (t) => snapFrame(t, next.fps), 1 / Math.max(1, next.fps), (x) => {
          x.speed = recipe.speed;
        });
      } else if (c.kind === 'audio' && c.linkID && (recipe.speed ?? 1) >= 2.5) {
        c.gainDB = -60;
      }
    }
    closeAllGaps(next);
    sanitizeProject(next);
  }
  const dur = projectDuration(next);
  const summary = `Built ${decision.shots.length}-shot edit (${dur.toFixed(1)}s)${decision.bpm ? ` at ${Math.round(decision.bpm)} BPM` : ''}${decision.look ? ` · ${decision.look}` : ''}.`;
  return { changed: true, summary, nextProject: next };
}
