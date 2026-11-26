import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  Clip,
  ColorGrade,
  ExportSettings,
  MarkerTint,
  MediaAsset,
  Project,
  SpeedRamp,
  TrackKind,
  TransitionKind,
  ZoomMode,
} from '../../shared/types';
import { BUILT_IN_LOOKS, findBuiltInLook, isGradeNeutral, parseCubeText } from '../../shared/colorGrade';
import {
  addTrack,
  clipEnd,
  clipName,
  computeExportRenderSize,
  detachAudioLinks,
  duplicateClips,
  freeTrack,
  freezeFrameClip,
  hexToRgba,
  linkedIds,
  makeClipsForAsset,
  newId,
  projectDuration,
  removeClips,
  resolveOverlaps,
  resolveTrackByName,
  reverseClipGroup,
  rgbaToHex,
  snapFrame,
  splitClipsAt,
  standardFPS,
  trackLabel,
  trimClipHead,
  trimClipTail,
} from '../../shared/project';
import { clipSourceLength, clipSourceTimeAt, retimeClip } from '../../shared/speedRamp';
import { buildCaptionBlocks, defaultCaptionStyle } from '../../shared/captions';
import { autoPlanEdit, findBestMoments } from '../../shared/autoPlanner';
import { starterZoomMove } from '../../shared/zoomMove';
import { ProjectStore } from '../state';
import { buildContactSheet, extractFrameJpeg } from '../engine/ffmpeg';
import { renderTimelineFrameJpeg } from '../engine/exporter';
import {
  analyzeMusicAsset,
  analyzeVisualAsset,
  computeClipSceneTags,
  getMediaNote,
  saveMediaNote,
} from '../engine/analyzer';

export const MCP_INSTRUCTIONS =
  'Vectrail is an AI-native Windows video editor. Times are in seconds. Video tracks are V1, V2, ... (V1 is the bottom; higher tracks cover lower ones) and audio tracks are A1, A2, .... A video with sound is placed as a linked pair: moving, trimming or deleting either moves both. Placing, moving or trimming a clip over another on the same track overwrites what is underneath. Start with get_project and list_media; analyze_media finds a clip\'s best moments or a song\'s beats; look_at_media shows you a clip or photo, and get_frame shows you the cut; search_media finds shots by what they show or what is said. After looking at a clip, save what you saw with note_media; list_media gives those notes back next time. Each edit is shown with your cursor and can be undone with history. auto_edit builds a whole cut on its own, and export delivers it to a file.';

export interface MCPToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });

function def(
  name: string,
  title: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  readOnlyHint = false
): MCPToolDefinition {
  return {
    name,
    title,
    description,
    inputSchema: { type: 'object', properties, required },
    annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false },
  };
}

export const MCP_TOOL_DEFINITIONS: MCPToolDefinition[] = [
  def('get_project', 'Get project', 'The sequence (size, frame rate, length), tracks, and every clip with its id, track, times, source, grade, sound and transition.', {}, [], true),
  def('list_media', 'List media', 'Everything in the library: id, name, kind, length, size, frame rate, whether people talk in it, and saved notes.', {}, [], true),
  def('import_media', 'Import media', 'Adds files to the library.', { paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths.' } }, ['paths']),
  def(
    'download_media',
    'Download media',
    'Downloads one music or sound file from an https URL and adds it to the library.',
    { url: str('Direct link to audio file.'), name: str('Track name.'), source_page: str('Source page URL.'), licence: str('Licence description.') },
    ['url', 'source_page', 'licence']
  ),
  def('analyze_media', 'Analyze media', 'Scores best moments for video/photo or detects BPM and beats for music.', { asset_id: str('Library item id.'), moment_length: num('Seconds per moment (default 2).') }, ['asset_id'], true),
  def('transcribe_media', 'Transcribe media', 'Transcribes spoken audio in a media item using local Whisper.', { asset_id: str('Library item id.'), language: str('Language code or auto.') }, ['asset_id']),
  def('get_transcript', 'Get transcript', 'Returns cached speech transcript for an asset if available.', { asset_id: str('Library item id.'), words: bool('Include word timings.') }, ['asset_id'], true),
  def('look_at_media', 'Look at media', 'Returns a photo or a contact-sheet grid of frames across a video.', { asset_id: str('Library item id.'), frames: { type: 'integer', description: 'Frame count (1..12, default 6).' }, times: { type: 'array', items: { type: 'number' }, description: 'Explicit times in seconds.' } }, ['asset_id'], true),
  def('note_media', 'Note media', 'Saves descriptive notes for a library asset.', { asset_id: str('Library item id.'), notes: str('What happens and when.') }, ['asset_id', 'notes']),
  def('get_frame', 'Get frame', 'Captures a frame of the timeline cut at a given time (default playhead).', { time: num('Timeline seconds.') }, [], true),
  def('search_media', 'Search media', 'Finds library items by visual notes or spoken words.', { shows: str('Keywords in notes.'), said: str('Words in transcript.') }, [], true),
  def('add_clip', 'Add clip', 'Places a library item onto the timeline.', { asset_id: str('Library item id.'), start: num('Timeline start.'), track: str('V1, V2... or A1, A2...'), source_start: num('Source in-point.'), duration: num('Duration in seconds.') }, ['asset_id']),
  def('add_title', 'Add title', 'Adds a text title clip.', { text: str('Title text.'), start: num('Default 0.'), duration: num('Default 3.'), track: str('Video track name.') }, ['text']),
  def('add_solid', 'Add solid', 'Adds a solid colour clip.', { color: str('Hex color like #000000.'), start: num('Default 0.'), duration: num('Default 3.'), track: str('Video track name.') }),
  def('set_solid_color', 'Solid colour', 'Changes a solid clip colour.', { clip_id: str('Clip id.'), color: str('Hex color.') }, ['clip_id', 'color']),
  def('move_clip', 'Move clip', 'Moves a clip (and linked partner) in time or track.', { clip_id: str('Clip id.'), start: num('New start seconds.'), track: str('Optional target track.') }, ['clip_id', 'start']),
  def('trim_clip', 'Trim clip', 'Trims a clip start and/or end.', { clip_id: str('Clip id.'), start: num('New start edge.'), end: num('New end edge.') }, ['clip_id']),
  def('split_clip', 'Split clip', 'Splits a clip at timeline time.', { clip_id: str('Clip id.'), at: num('Timeline seconds inside clip.') }, ['clip_id', 'at']),
  def('delete_clips', 'Delete clips', 'Deletes clips and linked partners.', { clip_ids: { type: 'array', items: { type: 'string' } }, ripple: bool('Close gap (default false).') }, ['clip_ids']),
  def('duplicate_clip', 'Duplicate clip', 'Copies a clip and linked partner.', { clip_id: str('Clip id.'), start: num('Optional target start.') }, ['clip_id']),
  def('set_speed', 'Set speed', 'Sets playback speed (0.05..100).', { clip_id: str('Clip id.'), speed: num('Playback speed multiplier.') }, ['clip_id', 'speed']),
  def('set_speed_ramp', 'Set speed ramp', 'Sets or removes a smooth speed ramp on a clip.', { clip_id: str('Clip id.'), speed: num('Target speed.'), from: num('Ease-in end in source seconds.'), to: num('Ease-out start in source seconds.'), ease: num('Ease duration in seconds.'), around: num('Surrounding speed.'), remove: bool('Remove ramp.') }, ['clip_id']),
  def('reverse_clip', 'Reverse', 'Toggles reverse playback on a clip.', { clip_id: str('Clip id.') }, ['clip_id']),
  def('freeze_frame', 'Freeze frame', 'Holds one frame of a video clip.', { clip_id: str('Clip id.'), at: num('Timeline time.'), seconds: num('Hold duration (default 2).') }, ['clip_id']),
  def('detach_audio', 'Detach audio', 'Unlinks a video clip from its audio.', { clip_id: str('Clip id.') }, ['clip_id']),
  def('list_looks', 'List looks', 'Lists built-in color looks.', {}, [], true),
  def('set_grade', 'Set grade', 'Adjusts colour grading and LUT look on clips.', { clip_id: str('Single clip id.'), clip_ids: { type: 'array', items: { type: 'string' } }, look: str('Look name, .cube path, or "none".'), look_intensity: num('0..1.'), exposure: num('-2..2.'), contrast: num('-50..50.'), saturation: num('-100..100.'), temperature: num('-50..50.'), tint: num('-50..50.') }),
  def('set_audio', 'Set audio', 'Sets gain dB and fades.', { clip_id: str('Clip id.'), gain_db: num('-60..12.'), fade_in: num('Fade in seconds.'), fade_out: num('Fade out seconds.') }, ['clip_id']),
  def('set_transition', 'Set transition', 'Sets incoming transition between touching clips.', { clip_id: str('Later clip id.'), kind: { type: 'string', enum: ['dissolve', 'dipToBlack', 'wipe', 'none'] }, duration: num('Seconds (default 0.5).') }, ['clip_id', 'kind']),
  def('set_transform', 'Set transform', 'Moves and scales a visual clip.', { clip_id: str('Clip id.'), scale: num('0.05..10.'), x: num('Normalized X offset.'), y: num('Normalized Y offset.'), reset: bool('Reset transform.') }, ['clip_id']),
  def('set_zoom', 'Set zoom', 'Applies or removes a smooth zoom/pan animation on a visual clip.', { clip_id: str('Clip id.'), mode: { type: 'string', enum: ['in', 'out', 'inOut', 'none'] }, amount: num('Target scale (1.05..3.0, default 1.2).') }, ['clip_id', 'mode']),
  def('set_title_style', 'Title style', 'Updates text clip styling.', { clip_id: str('Title clip id.'), text: str('Words.'), font: str('Font family.'), size: num('12..600.'), bold: bool('Bold.'), color: str('Hex color.'), x: num('0..1.'), y: num('0..1.') }, ['clip_id']),
  def('set_sequence', 'Set sequence', 'Sets sequence resolution and frame rate.', { width: { type: 'integer' }, height: { type: 'integer' }, fps: num('Frame rate.') }),
  def('add_track', 'Add track', 'Adds an empty video or audio track.', { kind: { type: 'string', enum: ['video', 'audio'] } }, ['kind']),
  def('set_track', 'Set track', 'Updates track flags, gain, and audio ducking.', { track: str('V1.. or A1..'), hidden: bool('Video hidden.'), muted: bool('Audio muted.'), solo: bool('Audio solo.'), locked: bool('Locked.'), gain_db: num('-60..12.'), duck_under: str('Audio track name to duck under (e.g. A1), or "none".'), duck_db: num('Duck attenuation dB (-30..0).') }, ['track']),
  def('set_marker', 'Set marker', 'Adds or edits a timeline marker.', { marker_id: str('Existing marker id.'), time: num('Timeline seconds.'), name: str('Marker label.'), color: { type: 'string', enum: ['orange', 'red', 'yellow', 'green', 'blue', 'purple'] } }),
  def('delete_markers', 'Delete markers', 'Removes markers.', { marker_ids: { type: 'array', items: { type: 'string' } }, all: bool('Remove all markers.') }),
  def('set_in_out', 'Set in and out', 'Sets or clears timeline in/out range.', { in: num('In seconds.'), out: num('Out seconds.'), clear: bool('Clear range.') }),
  def('set_captions', 'Set captions', 'Captions spoken clips or updates caption style/text.', { clip_ids: { type: 'array', items: { type: 'string' } }, remove: bool('Remove captions.'), size: num('28..140.'), position: num('0.1..0.95.'), highlight: bool('Word highlight.'), hidden: bool('Hide captions.'), edit: { type: 'array', items: { type: 'object' } } }),
  def('playback', 'Playback', 'Play, pause, or seek playhead.', { action: { type: 'string', enum: ['play', 'pause', 'seek'] }, time: num('Seek target seconds.') }, ['action']),
  def('history', 'Undo or redo', 'Undoes or redoes the last edit.', { action: { type: 'string', enum: ['undo', 'redo'] } }, ['action']),
  def('auto_edit', 'Auto edit', 'Builds a beat-synced montage from library media.'),
  def('save_project', 'Save project', 'Saves the current project file.'),
  def('export', 'Export', 'Exports the timeline to MP4 or WAV using FFmpeg.', { name: str('Output base name.'), format: { type: 'string', enum: ['video', 'audio'] }, shape: { type: 'string', enum: ['original', 'vertical', 'square', 'portrait'] }, height: { type: 'integer' }, codec: { type: 'string', enum: ['h264', 'hevc'] }, quality: { type: 'string', enum: ['high', 'web'] }, include_audio: bool('Include audio.'), loudness: num('Target LUFS (-40..-5).'), range_only: bool('In/out range only.'), reframe_x: num('0..1.'), reframe_y: num('0..1.'), wait: bool('Wait for export completion.') }),
  def('export_status', 'Export status', 'Lists active and finished export jobs.', {}, [], true),
];

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function assetToJson(a: MediaAsset) {
  const note = getMediaNote(a.path);
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    duration: r3(a.duration),
    width: a.width,
    height: a.height,
    fps: a.fps,
    has_audio: a.hasAudio,
    path: a.path,
    ...(note ? { notes: note.text } : {}),
  };
}

function clipToJson(c: Clip, p: Project) {
  return {
    id: c.id,
    name: clipName(p, c),
    kind: c.kind,
    track: trackLabel(p, c.trackID),
    asset_id: c.assetID,
    start: r3(c.start),
    end: r3(clipEnd(c)),
    duration: r3(c.duration),
    source_start: r3(c.sourceStart ?? 0),
    speed: r3(c.speed ?? 1),
    reversed: Boolean(c.reversed),
    freeze: Boolean(c.freeze),
    gain_db: r3(c.gainDB ?? 0),
    fade_in: r3(c.fadeIn ?? 0),
    fade_out: r3(c.fadeOut ?? 0),
    link_id: c.linkID,
    grade: c.grade,
    transform: c.transform,
    transition_in: c.transitionIn,
    text: c.text ? { ...c.text, color: rgbaToHex(c.text.color) } : undefined,
    color: c.kind === 'solid' ? rgbaToHex(c.color) : undefined,
    captioned: Boolean(c.captioned),
  };
}

function projectToJson(store: ProjectStore) {
  const p = store.project;
  return {
    title: store.title,
    file: store.filePath,
    width: p.width,
    height: p.height,
    fps: p.fps,
    duration: r3(projectDuration(p)),
    playhead: r3(store.playhead),
    play_range: p.playRange,
    tracks: {
      video: p.videoTracks.map((t, i) => ({ name: `V${i + 1}`, id: t.id, hidden: Boolean(t.hidden), locked: Boolean(t.locked) })),
      audio: p.audioTracks.map((t, i) => ({ name: `A${i + 1}`, id: t.id, muted: Boolean(t.muted), solo: Boolean(t.solo), locked: Boolean(t.locked), gain_db: r3(t.gainDB ?? 0) })),
    },
    clips: p.clips.map((c) => clipToJson(c, p)),
    markers: p.markers ?? [],
    captions: p.captions,
  };
}

function requireAsset(args: Record<string, unknown>, p: Project): MediaAsset {
  const id = String(args.asset_id ?? '');
  const a = p.assets.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown asset_id: ${id}`);
  return a;
}

function requireClip(args: Record<string, unknown>, p: Project): Clip {
  const id = String(args.clip_id ?? '');
  const c = p.clips.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown clip_id: ${id}`);
  return c;
}

function downloadFile(urlStr: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = urlStr.startsWith('https:') ? https : http;
    client
      .get(urlStr, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadFile(res.headers.location, destPath).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

export type MCPContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

const textOut = (text: string): MCPContentBlock[] => [{ type: 'text', text }];
const jsonOut = (val: unknown): MCPContentBlock[] => textOut(JSON.stringify(val, null, 2));

export async function callMCPTool(
  name: string,
  args: Record<string, unknown>,
  store: ProjectStore,
  clientName = 'Agent'
): Promise<MCPContentBlock[]> {
  const p = store.project;
  const touchCursor = (activity: string, clipID?: string, time?: number) => {
    store.setAgentCursor({ name: clientName, activity, clipID, time });
  };

  switch (name) {
    case 'get_project':
      return jsonOut(projectToJson(store));

    case 'list_media':
      return jsonOut(p.assets.map(assetToJson));

    case 'list_looks':
      return jsonOut(BUILT_IN_LOOKS.map((l) => l.name));

    case 'import_media': {
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      const missing = paths.filter((fp) => !fs.existsSync(fp));
      if (missing.length) throw new Error(`No file at: ${missing.join(', ')}`);
      const assets = await store.importFiles(paths);
      return jsonOut({ imported: assets.map(assetToJson), failed: paths.length - assets.length });
    }

    case 'download_media': {
      const url = String(args.url ?? '').trim();
      if (!url.startsWith('https://')) throw new Error('url must be an https link to an audio file.');
      const baseDir = store.filePath ? path.dirname(store.filePath) : path.join(os.homedir(), 'Videos', 'VectrailMedia');
      fs.mkdirSync(baseDir, { recursive: true });
      const ext = path.extname(new URL(url).pathname) || '.mp3';
      const safeName = String(args.name ?? 'audio')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-|-$/g, '') || 'audio';
      const dest = path.join(baseDir, `${safeName}${ext}`);
      await downloadFile(url, dest);
      const imported = await store.importFiles([dest]);
      if (!imported.length) throw new Error('Downloaded file could not be imported.');
      saveMediaNote(dest, `Downloaded from ${String(args.source_page ?? url)} (${String(args.licence ?? '')})`, clientName);
      return jsonOut({ added: assetToJson(imported[0]), saved_to: dest });
    }

    case 'analyze_media': {
      const asset = requireAsset(args, p);
      touchCursor(`analyzing ${asset.name}`);
      if (asset.kind === 'audio') {
        const m = await analyzeMusicAsset(asset);
        if (!m) throw new Error(`Could not analyze audio for ${asset.name}`);
        store.musicAnalyses[asset.id] = m;
        return jsonOut({
          bpm: m.bpm,
          beat_length: r3(60 / m.bpm),
          beat_count: m.beats.length,
          first_beat: r3(m.beats[0] ?? 0),
          bar_starts: m.beats.filter((_, i) => (i - m.barPhase) % 4 === 0).slice(0, 80).map(r3),
        });
      }
      const a = await analyzeVisualAsset(asset);
      if (!a) throw new Error(`Could not analyze visual asset ${asset.name}`);
      store.clipAnalyses[asset.id] = a;
      const tags = computeClipSceneTags(a);
      store.sceneTags[asset.id] = tags;
      const length = asNum(args.moment_length) ?? 2;
      const moments = findBestMoments(a, asset.duration, length, 5);
      const meanLuma = a.samples.reduce((acc, s) => acc + s.luma, 0) / Math.max(1, a.samples.length);
      return jsonOut({
        duration: r3(Math.min(a.duration, asset.duration)),
        best_moments: moments.map((m) => ({ start: r3(m.start), end: r3(m.end), score: r3(m.score), faces: m.faces })),
        average_brightness: r3(meanLuma),
        has_faces: a.samples.some((s) => s.faces > 0),
        tags,
        ...(a.created ? { filmed: a.created } : {}),
      });
    }

    case 'transcribe_media': {
      const asset = requireAsset(args, p);
      if (asset.kind === 'image' || (!asset.hasAudio && asset.kind !== 'audio')) {
        return jsonOut({ asset_id: asset.id, status: 'no_sound', words: [] });
      }
      touchCursor(`transcribing ${asset.name}`);
      const tr = await store.transcribeAsset(asset.id, String(args.language ?? 'auto'));
      return jsonOut({
        asset_id: asset.id,
        duration: r3(tr.duration),
        word_count: tr.words.length,
        text: tr.words.map((w) => w.text).join(' '),
      });
    }

    case 'get_transcript': {
      const asset = requireAsset(args, p);
      const tr = store.transcripts[asset.id];
      if (!tr) {
        return jsonOut({
          asset_id: asset.id,
          status: asset.kind === 'image' || !asset.hasAudio ? 'no_sound' : 'unavailable',
          note: 'No local speech transcript is cached for this asset yet.',
        });
      }
      return jsonOut({
        asset_id: asset.id,
        duration: r3(tr.duration),
        text: tr.words.map((w) => w.text).join(' '),
        ...(args.words ? { words: tr.words } : {}),
      });
    }

    case 'look_at_media': {
      const asset = requireAsset(args, p);
      if (asset.kind === 'audio') throw new Error(`${asset.name} is audio-only; use analyze_media for beats.`);
      touchCursor(`looking at ${asset.name}`);
      const frames = asNum(args.frames) ?? 6;
      const times = Array.isArray(args.times) ? args.times.map(Number).filter(Number.isFinite) : undefined;
      const sheet = await buildContactSheet(asset, frames, times);
      if (!sheet) throw new Error(`Could not extract contact sheet for ${asset.name}`);
      const saved = getMediaNote(asset.path);
      const note =
        asset.kind === 'image'
          ? `${asset.name}, a photo.`
          : `${asset.name}, ${r3(asset.duration)}s long. Frames at ${sheet.times.map((t) => `${t.toFixed(1)}s`).join(', ')}.`;
      return [
        { type: 'image', data: sheet.base64, mimeType: 'image/jpeg' },
        { type: 'text', text: note + (saved ? ` Saved notes: ${saved.text}` : ' Save what you see with note_media.') },
      ];
    }

    case 'note_media': {
      const asset = requireAsset(args, p);
      const notes = String(args.notes ?? '').trim();
      if (!notes) throw new Error('notes cannot be empty.');
      saveMediaNote(asset.path, notes, clientName);
      return textOut(`Saved notes for ${asset.name}.`);
    }

    case 'get_frame': {
      if (!p.clips.length) throw new Error('Timeline is empty.');
      const t = asNum(args.time) ?? store.playhead;
      const activeClips = [...p.clips]
        .filter((c) => {
          if (c.kind === 'audio' || c.start > t || clipEnd(c) < t) return false;
          const tr = p.videoTracks.find((vt) => vt.id === c.trackID);
          return !tr?.hidden;
        })
        .sort((a, b) => {
          const ia = p.videoTracks.findIndex((tr) => tr.id === a.trackID);
          const ib = p.videoTracks.findIndex((tr) => tr.id === b.trackID);
          return ib - ia;
        });
      if (!activeClips.length) throw new Error(`No visual clip at ${r3(t)}s.`);
      const baseClip = [...activeClips].reverse().find((c) => c.kind === 'video' || c.kind === 'image') ?? activeClips[0];
      const hasActiveCaption =
        Boolean(p.captions && !p.captions.hidden) &&
        buildCaptionBlocks(p, store.transcripts).some((b) => t >= b.start && t <= b.end);
      const needsComposite =
        activeClips.length > 1 ||
        hasActiveCaption ||
        baseClip.kind === 'solid' ||
        baseClip.kind === 'text' ||
        Boolean(baseClip.grade && !isGradeNeutral(baseClip.grade)) ||
        Boolean(baseClip.transform);

      if (needsComposite) {
        const compBuf = await renderTimelineFrameJpeg(p, t, store.transcripts, 854);
        if (compBuf) {
          const layerNames = [...activeClips].reverse().map((c) => clipName(p, c));
          return [
            { type: 'image', data: compBuf.toString('base64'), mimeType: 'image/jpeg' },
            { type: 'text', text: `Composited frame at timeline ${r3(t)}s. Layers: ${layerNames.join(' + ')}.` },
          ];
        }
      }

      const overlays = activeClips
        .filter((c) => c.kind === 'text')
        .map((c) => c.text?.string ?? 'Title');
      const clip = baseClip;
      if (clip.kind === 'solid' || clip.kind === 'text') {
        return textOut(`At ${r3(t)}s: ${clip.kind} clip "${clipName(p, clip)}"`);
      }
      const asset = p.assets.find((a) => a.id === clip.assetID);
      if (!asset) throw new Error('Missing source asset for clip.');
      const srcTime = clip.kind === 'image' ? 0 : clipSourceTimeAt(clip, t);
      const buf = await extractFrameJpeg(asset.path, srcTime, 640);
      const overlayNote = overlays.length ? ` Overlays: ${overlays.join(', ')}.` : '';
      return [
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text', text: `Frame from ${asset.name} at timeline ${r3(t)}s (source ${r3(srcTime)}s).${overlayNote}` },
      ];
    }

    case 'search_media': {
      const shows = String(args.shows ?? '').toLowerCase().trim().split(/\s+/).filter(Boolean);
      const said = String(args.said ?? '').toLowerCase().trim();
      const matches = p.assets.filter((a) => {
        const noteParts = [
          getMediaNote(a.path)?.text ?? '',
          a.name,
          ...(store.sceneTags[a.id] ?? []),
        ];
        const note = noteParts.join(' ').toLowerCase();
        const trText = (store.transcripts[a.id]?.words.map((w) => w.text).join(' ') ?? '').toLowerCase();
        const okShows = shows.length === 0 || shows.every((w) => note.includes(w));
        const okSaid = !said || trText.includes(said);
        return okShows && okSaid;
      });
      return jsonOut(matches.map(assetToJson));
    }

    case 'add_clip': {
      const asset = requireAsset(args, p);
      const audioOnly = asset.kind === 'audio';
      const track = resolveTrackByName(p, String(args.track ?? (audioOnly ? 'A1' : 'V1')), audioOnly ? 'audio' : 'video');
      if (!track) throw new Error(`Invalid track: ${String(args.track)}`);
      const trackMax = p.clips.filter((c) => c.trackID === track.id).reduce((mx, c) => Math.max(mx, clipEnd(c)), 0);
      const start = Math.max(0, asNum(args.start) ?? trackMax);
      const sourceStart = Math.max(0, asNum(args.source_start) ?? 0);
      if (asset.kind !== 'image' && sourceStart >= asset.duration - 0.05) {
        throw new Error(`source_start exceeds duration of ${asset.name}`);
      }
      const rest = asset.kind === 'image' ? 5 : asset.duration - sourceStart;
      const dur = Math.max(1 / p.fps, Math.min(asNum(args.duration) ?? rest, asset.kind === 'image' ? 3600 : rest));
      let addedClips: Clip[] = [];
      store.mutate((draft) => {
        const audioTrackID = audioOnly
          ? track.id
          : freeTrack(draft, 'audio', start, dur) ?? draft.audioTracks[0]?.id ?? addTrack(draft, 'audio').id;
        addedClips = makeClipsForAsset(draft, asset, start, audioOnly ? draft.videoTracks[0].id : track.id, audioTrackID, sourceStart, dur);
        draft.clips.push(...addedClips);
        resolveOverlaps(draft, new Set(addedClips.map((c) => c.id)));
      });
      touchCursor(`placing ${asset.name}`, addedClips[0]?.id, start);
      return jsonOut({ added: addedClips.map((c) => clipToJson(c, store.project)) });
    }

    case 'add_title': {
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('Title text is required.');
      const start = snapFrame(Math.max(0, asNum(args.start) ?? 0), p.fps);
      const duration = snapFrame(Math.max(0.2, asNum(args.duration) ?? 3), p.fps);
      let created!: Clip;
      store.mutate((draft) => {
        let trackID: string;
        if (typeof args.track === 'string') {
          const tr = resolveTrackByName(draft, args.track, 'video');
          if (!tr) throw new Error(`Unknown track ${args.track}`);
          trackID = tr.id;
        } else {
          const freeUpper = draft.videoTracks
            .slice(1)
            .find((t) => !draft.clips.some((c) => c.trackID === t.id && c.start < start + duration && clipEnd(c) > start));
          trackID = freeUpper?.id ?? addTrack(draft, 'video').id;
        }
        created = {
          id: newId(),
          trackID,
          kind: 'text',
          start,
          duration,
          text: { string: text, fontName: '', bold: true, size: 110, color: { r: 1, g: 1, b: 1, a: 1 }, x: 0.5, y: 0.5 },
        };
        draft.clips.push(created);
        resolveOverlaps(draft, new Set([created.id]));
      });
      touchCursor(`adding title "${text}"`, created.id, start);
      return jsonOut(clipToJson(created, store.project));
    }

    case 'add_solid': {
      const color = args.color ? hexToRgba(String(args.color)) : { r: 0, g: 0, b: 0, a: 1 };
      if (!color) throw new Error('Invalid hex color.');
      const start = snapFrame(Math.max(0, asNum(args.start) ?? 0), p.fps);
      const duration = snapFrame(Math.max(1 / p.fps, asNum(args.duration) ?? 3), p.fps);
      let created!: Clip;
      store.mutate((draft) => {
        const trackID =
          typeof args.track === 'string'
            ? resolveTrackByName(draft, args.track, 'video')?.id ?? draft.videoTracks[0].id
            : freeTrack(draft, 'video', start, duration) ?? addTrack(draft, 'video').id;
        created = { id: newId(), trackID, kind: 'solid', start, duration, color };
        draft.clips.push(created);
        resolveOverlaps(draft, new Set([created.id]));
      });
      touchCursor('adding solid', created.id, start);
      return jsonOut(clipToJson(created, store.project));
    }

    case 'set_solid_color': {
      const c = requireClip(args, p);
      if (c.kind !== 'solid') throw new Error('Clip is not a solid.');
      const color = hexToRgba(String(args.color ?? ''));
      if (!color) throw new Error('color must be hex like #1A1A1A.');
      store.mutate((draft) => {
        const target = draft.clips.find((x) => x.id === c.id);
        if (target) target.color = color;
      });
      touchCursor('changing solid colour', c.id, c.start);
      return jsonOut(clipToJson(store.project.clips.find((x) => x.id === c.id)!, store.project));
    }

    case 'move_clip': {
      const c = requireClip(args, p);
      const newStart = snapFrame(Math.max(0, asNum(args.start) ?? c.start), p.fps);
      const groupIds = linkedIds(p, [c.id]);
      store.mutate((draft) => {
        const delta = newStart - c.start;
        for (const item of draft.clips) {
          if (!groupIds.has(item.id)) continue;
          item.start = Math.max(0, snapFrame(item.start + delta, draft.fps));
          if (item.id === c.id && typeof args.track === 'string') {
            const expectedKind: TrackKind = item.kind === 'audio' ? 'audio' : 'video';
            const tr = resolveTrackByName(draft, args.track, expectedKind);
            if (!tr) throw new Error(`Invalid track ${args.track}`);
            item.trackID = tr.id;
          }
        }
        resolveOverlaps(draft, groupIds);
      });
      touchCursor(`moving ${clipName(p, c)}`, c.id, newStart);
      return jsonOut([...groupIds].map((id) => clipToJson(store.project.clips.find((x) => x.id === id)!, store.project)));
    }

    case 'trim_clip': {
      const c = requireClip(args, p);
      const groupIds = linkedIds(p, [c.id]);
      const newStart = asNum(args.start);
      const newEnd = asNum(args.end);
      if (newStart === undefined && newEnd === undefined) throw new Error('Provide start and/or end.');
      store.mutate((draft) => {
        for (const item of draft.clips) {
          if (!groupIds.has(item.id)) continue;
          if (newStart !== undefined) trimClipHead(item, snapFrame(Math.max(0, newStart), draft.fps));
          if (newEnd !== undefined) trimClipTail(item, snapFrame(Math.max(item.start + 1 / draft.fps, newEnd), draft.fps));
        }
        resolveOverlaps(draft, groupIds);
      });
      touchCursor(`trimming ${clipName(p, c)}`, c.id, newStart ?? c.start);
      return jsonOut([...groupIds].map((id) => clipToJson(store.project.clips.find((x) => x.id === id)!, store.project)));
    }

    case 'split_clip': {
      const c = requireClip(args, p);
      const at = snapFrame(asNum(args.at) ?? store.playhead, p.fps);
      const groupIds = [...linkedIds(p, [c.id])];
      let created: string[] = [];
      store.mutate((draft) => {
        created = splitClipsAt(draft, groupIds, at);
      });
      if (!created.length) throw new Error('Split point must be inside the clip.');
      touchCursor(`splitting ${clipName(p, c)}`, created[0], at);
      return jsonOut(created.map((id) => clipToJson(store.project.clips.find((x) => x.id === id)!, store.project)));
    }

    case 'delete_clips': {
      const ids = Array.isArray(args.clip_ids) ? args.clip_ids.map(String) : [];
      const group = linkedIds(p, ids);
      store.mutate((draft) => {
        removeClips(draft, group, Boolean(args.ripple));
      });
      touchCursor('removing clips');
      return textOut(`Deleted ${group.size} clip(s).`);
    }

    case 'duplicate_clip': {
      const c = requireClip(args, p);
      let copies: Clip[] = [];
      store.mutate((draft) => {
        copies = duplicateClips(draft, [c.id], asNum(args.start));
      });
      touchCursor(`duplicating ${clipName(p, c)}`, copies[0]?.id, copies[0]?.start);
      return jsonOut(copies.map((x) => clipToJson(x, store.project)));
    }

    case 'set_speed': {
      const c = requireClip(args, p);
      const speed = clamp(asNum(args.speed) ?? 1, 0.05, 100);
      const groupIds = [...linkedIds(p, [c.id])];
      store.mutate((draft) => {
        for (const id of groupIds) {
          const item = draft.clips.find((x) => x.id === id);
          if (!item) continue;
          retimeClip(item, (t) => snapFrame(t, draft.fps), 1 / draft.fps, (x) => {
            x.speed = speed;
          });
        }
        resolveOverlaps(draft, new Set(groupIds));
      });
      touchCursor(`setting speed ${speed}x`, c.id, c.start);
      return jsonOut(groupIds.map((id) => clipToJson(store.project.clips.find((x) => x.id === id)!, store.project)));
    }

    case 'set_speed_ramp': {
      const c = requireClip(args, p);
      const groupIds = [...linkedIds(p, [c.id])];
      store.mutate((draft) => {
        for (const id of groupIds) {
          const item = draft.clips.find((x) => x.id === id);
          if (!item) continue;
          retimeClip(item, (t) => snapFrame(t, draft.fps), 1 / draft.fps, (x) => {
            if (args.remove) {
              x.ramp = undefined;
              return;
            }
            const s0 = x.sourceStart ?? 0;
            const s1 = s0 + clipSourceLength(x);
            const spd = clamp(asNum(args.speed) ?? 0.5, 0.05, 100);
            const around = clamp(asNum(args.around) ?? 1, 0.05, 100);
            const ease = Math.max(0.05, asNum(args.ease) ?? 0.4);
            const inTo = asNum(args.from) ?? s0;
            const outFrom = asNum(args.to) ?? s1;
            const ramp: SpeedRamp = {
              inFrom: Math.max(s0, inTo - ease),
              inTo,
              outFrom,
              outTo: Math.min(s1, outFrom + ease),
              startSpeed: around,
              endSpeed: around,
            };
            x.speed = spd;
            x.ramp = ramp;
          });
        }
        resolveOverlaps(draft, new Set(groupIds));
      });
      touchCursor(`setting speed ramp`, c.id, c.start);
      return jsonOut(groupIds.map((id) => clipToJson(store.project.clips.find((x) => x.id === id)!, store.project)));
    }

    case 'reverse_clip': {
      const c = requireClip(args, p);
      let group: string[] = [];
      store.mutate((draft) => {
        group = reverseClipGroup(draft, c.id);
      });
      touchCursor(`reversing ${clipName(p, c)}`, c.id, c.start);
      return jsonOut(group.map((id) => clipToJson(store.project.clips.find((x) => x.id === id)!, store.project)));
    }

    case 'freeze_frame': {
      const c = requireClip(args, p);
      let frozen: Clip | undefined;
      store.mutate((draft) => {
        frozen = freezeFrameClip(draft, c.id, asNum(args.at), asNum(args.seconds) ?? 2);
      });
      if (!frozen) throw new Error('Freeze frame requires a video clip.');
      touchCursor(`freezing frame`, frozen.id, frozen.start);
      return jsonOut(clipToJson(frozen, store.project));
    }

    case 'detach_audio': {
      const c = requireClip(args, p);
      let ids: string[] = [];
      store.mutate((draft) => {
        ids = detachAudioLinks(draft, [c.id]);
      });
      touchCursor('detaching audio', c.id, c.start);
      return jsonOut(ids.map((id) => clipToJson(store.project.clips.find((x) => x.id === id)!, store.project)));
    }

    case 'set_grade': {
      const ids = Array.isArray(args.clip_ids)
        ? args.clip_ids.map(String)
        : typeof args.clip_id === 'string'
        ? [args.clip_id]
        : [];
      if (!ids.length) throw new Error('Provide clip_ids or clip_id.');
      store.mutate((draft) => {
        for (const id of ids) {
          const c = draft.clips.find((x) => x.id === id);
          if (!c || c.kind === 'audio') continue;
          const g: ColorGrade = { ...(c.grade ?? {}) };
          if (typeof args.look === 'string') {
            if (args.look === 'none') {
              g.look = undefined;
            } else if (findBuiltInLook(args.look) || (args.look.endsWith('.cube') && fs.existsSync(args.look) && parseCubeText(fs.readFileSync(args.look, 'utf8')))) {
              g.look = args.look;
            } else {
              throw new Error(`Unknown look: ${args.look}`);
            }
          }
          if (asNum(args.look_intensity) !== undefined) g.lookIntensity = clamp(asNum(args.look_intensity)!, 0, 1);
          if (asNum(args.exposure) !== undefined) g.exposure = clamp(asNum(args.exposure)!, -2, 2);
          if (asNum(args.contrast) !== undefined) g.contrast = clamp(asNum(args.contrast)!, -50, 50);
          if (asNum(args.saturation) !== undefined) g.saturation = clamp(asNum(args.saturation)!, -100, 100);
          if (asNum(args.temperature) !== undefined) g.temperature = clamp(asNum(args.temperature)!, -50, 50);
          if (asNum(args.tint) !== undefined) g.tint = clamp(asNum(args.tint)!, -50, 50);
          c.grade = isGradeNeutral(g) ? undefined : g;
        }
      });
      touchCursor('grading clips', ids[0]);
      return jsonOut(ids.map((id) => clipToJson(store.project.clips.find((x) => x.id === id)!, store.project)));
    }

    case 'set_audio': {
      const c = requireClip(args, p);
      store.mutate((draft) => {
        const item = draft.clips.find((x) => x.id === c.id);
        if (!item) return;
        if (asNum(args.gain_db) !== undefined) item.gainDB = clamp(asNum(args.gain_db)!, -60, 12);
        if (asNum(args.fade_in) !== undefined) item.fadeIn = clamp(asNum(args.fade_in)!, 0, item.duration);
        if (asNum(args.fade_out) !== undefined) item.fadeOut = clamp(asNum(args.fade_out)!, 0, item.duration);
      });
      touchCursor('mixing audio', c.id, c.start);
      return jsonOut(clipToJson(store.project.clips.find((x) => x.id === c.id)!, store.project));
    }

    case 'set_transition': {
      const c = requireClip(args, p);
      const kind = String(args.kind ?? 'dissolve');
      store.mutate((draft) => {
        const item = draft.clips.find((x) => x.id === c.id);
        if (!item) return;
        if (kind === 'none') {
          item.transitionIn = undefined;
        } else {
          if (!['dissolve', 'dipToBlack', 'wipe'].includes(kind)) throw new Error('kind must be dissolve, dipToBlack, wipe or none.');
          item.transitionIn = { kind: kind as TransitionKind, duration: Math.max(0.04, asNum(args.duration) ?? 0.5) };
        }
      });
      touchCursor('adding transition', c.id, c.start);
      return jsonOut(clipToJson(store.project.clips.find((x) => x.id === c.id)!, store.project));
    }

    case 'set_transform': {
      const c = requireClip(args, p);
      store.mutate((draft) => {
        const item = draft.clips.find((x) => x.id === c.id);
        if (!item) return;
        if (args.reset) {
          item.transform = undefined;
          return;
        }
        const cur = item.transform ?? { scale: 1, x: 0, y: 0 };
        item.transform = {
          ...cur,
          scale: asNum(args.scale) !== undefined ? clamp(asNum(args.scale)!, 0.05, 10) : cur.scale,
          x: asNum(args.x) ?? cur.x,
          y: asNum(args.y) ?? cur.y,
        };
      });
      touchCursor('framing clip', c.id, c.start);
      return jsonOut(clipToJson(store.project.clips.find((x) => x.id === c.id)!, store.project));
    }

    case 'set_zoom': {
      const c = requireClip(args, p);
      const mode = String(args.mode ?? 'in');
      store.mutate((draft) => {
        const item = draft.clips.find((x) => x.id === c.id);
        if (!item) return;
        if (mode === 'none') {
          if (item.transform) item.transform = { ...item.transform, scale: 1, x: 0, y: 0, zoom: undefined };
          return;
        }
        if (!['in', 'out', 'inOut'].includes(mode)) throw new Error('mode must be in, out, inOut or none.');
        const amount = clamp(asNum(args.amount) ?? 1.2, 1.02, 3.0);
        const cur = item.transform ?? { scale: amount, x: 0, y: 0 };
        item.transform = {
          ...cur,
          scale: Math.max(cur.scale > 1.02 ? cur.scale : amount, 1.02),
          zoom: starterZoomMove(mode as ZoomMode, item.duration),
        };
      });
      touchCursor(`zooming ${mode}`, c.id, c.start);
      return jsonOut(clipToJson(store.project.clips.find((x) => x.id === c.id)!, store.project));
    }

    case 'set_title_style': {
      const c = requireClip(args, p);
      if (c.kind !== 'text') throw new Error('Clip is not a title.');
      store.mutate((draft) => {
        const item = draft.clips.find((x) => x.id === c.id);
        if (!item || !item.text) return;
        if (typeof args.text === 'string') item.text.string = args.text;
        if (typeof args.font === 'string') item.text.fontName = args.font === 'System' ? '' : args.font;
        if (asNum(args.size) !== undefined) item.text.size = clamp(asNum(args.size)!, 12, 600);
        if (typeof args.bold === 'boolean') item.text.bold = args.bold;
        if (typeof args.color === 'string') {
          const col = hexToRgba(args.color);
          if (!col) throw new Error('Invalid hex color.');
          item.text.color = col;
        }
        if (asNum(args.x) !== undefined) item.text.x = clamp(asNum(args.x)!, 0, 1);
        if (asNum(args.y) !== undefined) item.text.y = clamp(asNum(args.y)!, 0, 1);
      });
      touchCursor('styling title', c.id, c.start);
      return jsonOut(clipToJson(store.project.clips.find((x) => x.id === c.id)!, store.project));
    }

    case 'set_sequence': {
      store.mutate((draft) => {
        if (asNum(args.width) !== undefined && asNum(args.height) !== undefined) {
          draft.width = clamp(Math.round(asNum(args.width)!), 16, 8192);
          draft.height = clamp(Math.round(asNum(args.height)!), 16, 8192);
        }
        if (asNum(args.fps) !== undefined) draft.fps = standardFPS(asNum(args.fps)!);
        draft.settingsLocked = true;
      });
      touchCursor('updating sequence');
      return jsonOut({ width: store.project.width, height: store.project.height, fps: store.project.fps });
    }

    case 'add_track': {
      const kind: TrackKind = args.kind === 'audio' ? 'audio' : 'video';
      store.mutate((draft) => {
        addTrack(draft, kind);
      });
      const count = kind === 'video' ? store.project.videoTracks.length : store.project.audioTracks.length;
      return textOut(`Added ${kind === 'video' ? 'V' : 'A'}${count}.`);
    }

    case 'set_track': {
      const nameStr = String(args.track ?? '');
      const tr = resolveTrackByName(p, nameStr);
      if (!tr) throw new Error(`Unknown track ${nameStr}`);
      store.mutate((draft) => {
        const target = [...draft.videoTracks, ...draft.audioTracks].find((t) => t.id === tr.id);
        if (!target) return;
        if (typeof args.hidden === 'boolean') target.hidden = args.hidden;
        if (typeof args.muted === 'boolean') target.muted = args.muted;
        if (typeof args.solo === 'boolean') target.solo = args.solo;
        if (typeof args.locked === 'boolean') target.locked = args.locked;
        if (asNum(args.gain_db) !== undefined) target.gainDB = clamp(asNum(args.gain_db)!, -60, 12);
        if (typeof args.duck_under === 'string') {
          if (args.duck_under.toLowerCase() === 'none' || !args.duck_under.trim()) {
            target.duckUnder = undefined;
          } else {
            const under = resolveTrackByName(draft, args.duck_under, 'audio');
            if (!under) throw new Error(`Unknown audio track ${args.duck_under}`);
            target.duckUnder = under.id;
          }
        }
        if (asNum(args.duck_db) !== undefined) target.duckDB = clamp(asNum(args.duck_db)!, -30, 0);
      });
      return textOut(`Updated track ${nameStr}.`);
    }

    case 'set_marker': {
      let markerId = typeof args.marker_id === 'string' ? args.marker_id : undefined;
      store.mutate((draft) => {
        if (!draft.markers) draft.markers = [];
        if (markerId) {
          const existing = draft.markers.find((m) => m.id === markerId);
          if (!existing) throw new Error(`Unknown marker_id: ${markerId}`);
          if (asNum(args.time) !== undefined) existing.time = Math.max(0, asNum(args.time)!);
          if (typeof args.name === 'string') existing.name = args.name;
          if (typeof args.color === 'string') existing.color = args.color as MarkerTint;
        } else {
          const t = asNum(args.time) ?? store.playhead;
          markerId = newId();
          draft.markers.push({
            id: markerId,
            time: Math.max(0, t),
            name: String(args.name ?? 'Marker'),
            color: (args.color as MarkerTint | undefined) ?? 'orange',
          });
        }
      });
      return jsonOut(store.project.markers?.find((m) => m.id === markerId));
    }

    case 'delete_markers': {
      store.mutate((draft) => {
        if (args.all) {
          draft.markers = [];
          return;
        }
        const ids = new Set(Array.isArray(args.marker_ids) ? args.marker_ids.map(String) : []);
        draft.markers = (draft.markers ?? []).filter((m) => !ids.has(m.id));
      });
      return textOut('Markers updated.');
    }

    case 'set_in_out': {
      store.mutate((draft) => {
        if (args.clear) {
          draft.playRange = undefined;
          return;
        }
        const inT = Math.max(0, asNum(args.in) ?? draft.playRange?.in ?? 0);
        const outT = Math.max(inT + 0.1, asNum(args.out) ?? draft.playRange?.out ?? projectDuration(draft));
        draft.playRange = { in: inT, out: outT };
      });
      return jsonOut(store.project.playRange ?? null);
    }

    case 'set_captions': {
      store.mutate((draft) => {
        if (args.remove && !Array.isArray(args.clip_ids)) {
          for (const c of draft.clips) c.captioned = false;
          draft.captions = undefined;
          return;
        }
        if (!draft.captions) draft.captions = defaultCaptionStyle();
        if (asNum(args.size) !== undefined) draft.captions.size = clamp(asNum(args.size)!, 28, 140);
        if (asNum(args.position) !== undefined) draft.captions.position = clamp(asNum(args.position)!, 0.1, 0.95);
        if (typeof args.highlight === 'boolean') draft.captions.highlight = args.highlight;
        if (typeof args.hidden === 'boolean') draft.captions.hidden = args.hidden;
        if (Array.isArray(args.clip_ids)) {
          const set = new Set(args.clip_ids.map(String));
          for (const c of draft.clips) {
            if (set.has(c.id)) c.captioned = !args.remove;
          }
        } else if (!args.remove) {
          for (const c of draft.clips) {
            if (
              c.kind === 'audio' ||
              (c.kind === 'video' && !(c.linkID && draft.clips.some((o) => o.kind === 'audio' && o.linkID === c.linkID)))
            ) {
              c.captioned = true;
            }
          }
        }
      });
      return jsonOut(buildCaptionBlocks(store.project, store.transcripts));
    }

    case 'playback': {
      const action = String(args.action ?? 'pause');
      if (action === 'play') store.setPlaying(true);
      else if (action === 'pause') store.setPlaying(false);
      else if (action === 'seek') store.setPlayhead(asNum(args.time) ?? 0);
      return jsonOut({ playing: store.playing, playhead: r3(store.playhead) });
    }

    case 'history': {
      const action = String(args.action ?? 'undo');
      const ok = action === 'redo' ? store.redo() : store.undo();
      if (!ok) throw new Error(`Nothing to ${action}.`);
      return textOut(`${action === 'redo' ? 'Redid' : 'Undid'} last edit.`);
    }

    case 'auto_edit': {
      const visualAssets = p.assets.filter((a) => a.kind !== 'audio');
      if (!visualAssets.length) throw new Error('Import at least one video or image first.');
      const clipInputs = [];
      for (const a of visualAssets) {
        const analysis = store.clipAnalyses[a.id] ?? (await analyzeVisualAsset(a));
        if (analysis) {
          store.clipAnalyses[a.id] = analysis;
          clipInputs.push({ asset: a, analysis });
        }
      }
      const musicAsset = p.assets.find((a) => a.kind === 'audio');
      let musicInput;
      if (musicAsset) {
        const ma = store.musicAnalyses[musicAsset.id] ?? (await analyzeMusicAsset(musicAsset));
        if (ma) {
          store.musicAnalyses[musicAsset.id] = ma;
          musicInput = { asset: musicAsset, analysis: ma };
        }
      }
      const decision = autoPlanEdit(p, clipInputs, musicInput);
      if (!decision) throw new Error('Could not build an auto edit from current library.');
      store.mutate((draft) => {
        draft.clips = [];
        let cursor = 0;
        for (const shot of decision.shots) {
          const vTrack = draft.videoTracks[0].id;
          const aTrack = draft.audioTracks[0].id;
          const made = makeClipsForAsset(draft, shot.asset, cursor, vTrack, aTrack, shot.source, shot.duration);
          for (const c of made) {
            if (c.kind !== 'audio') {
              c.grade = { look: decision.look, lookIntensity: 1, exposure: shot.exposure };
              if (shot.dissolve) c.transitionIn = { kind: 'dissolve', duration: 0.45 };
            } else {
              c.gainDB = shot.gainDB;
            }
          }
          draft.clips.push(...made);
          cursor += shot.duration;
        }
        if (decision.music) {
          const mTrack = draft.audioTracks[1]?.id ?? addTrack(draft, 'audio').id;
          draft.clips.push({
            id: newId(),
            trackID: mTrack,
            kind: 'audio',
            assetID: decision.music.asset.id,
            start: 0,
            duration: decision.music.duration,
            sourceStart: decision.music.source,
            speed: 1,
            gainDB: -3,
            fadeOut: decision.music.fadeOut,
          });
        }
        const titleTrack = draft.videoTracks[1]?.id ?? addTrack(draft, 'video').id;
        draft.clips.push({
          id: newId(),
          trackID: titleTrack,
          kind: 'text',
          start: 0.3,
          duration: Math.min(3.5, Math.max(1.5, cursor)),
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
      });
      touchCursor('building auto edit', store.project.clips[0]?.id, 0);
      return jsonOut({
        shots: decision.shots.length,
        bpm: decision.bpm,
        title: decision.title,
        duration: r3(projectDuration(store.project)),
      });
    }

    case 'save_project': {
      if (!store.filePath) throw new Error('Project has not been saved to a file yet; user must choose a save path.');
      const saved = store.saveToFile();
      return textOut(`Saved to ${saved}`);
    }

    case 'export': {
      if (!p.clips.length) throw new Error('Timeline is empty.');
      const settings: ExportSettings = {
        format: args.format === 'audio' ? 'audio' : 'video',
        shape: (['original', 'vertical', 'square', 'portrait'].includes(String(args.shape)) ? String(args.shape) : 'original') as ExportSettings['shape'],
        height: asNum(args.height) ? clamp(Math.round(asNum(args.height)!), 144, 4320) : undefined,
        codec: args.codec === 'hevc' ? 'hevc' : 'h264',
        quality: args.quality === 'web' ? 'web' : 'high',
        includeAudio: args.include_audio !== false,
        loudness: asNum(args.loudness) !== undefined ? clamp(asNum(args.loudness)!, -40, -5) : undefined,
        rangeOnly: Boolean(args.range_only),
        enhanceDetail: Boolean(args.enhance_detail),
        reframeX: clamp(asNum(args.reframe_x) ?? 0.5, 0, 1),
        reframeY: clamp(asNum(args.reframe_y) ?? 0.5, 0, 1),
      };
      const outDir =
        p.exportDir && fs.existsSync(p.exportDir)
          ? p.exportDir
          : store.filePath
          ? path.dirname(store.filePath)
          : path.join(os.homedir(), 'Videos');
      fs.mkdirSync(outDir, { recursive: true });
      const ext = settings.format === 'audio' ? 'wav' : 'mp4';
      const base = String(args.name ?? p.exportName ?? store.title).replace(/[\\/:*?"<>|]/g, '-').trim() || 'Vectrail-Export';
      let target = path.join(outDir, `${base}.${ext}`);
      let n = 2;
      while (fs.existsSync(target)) {
        target = path.join(outDir, `${base} ${n}.${ext}`);
        n++;
      }
      const size = computeExportRenderSize(p, settings.shape, settings.height);
      const runPromise = store.exports.startExport(p, settings, target, store.transcripts);
      if (args.wait) {
        const done = await runPromise;
        return jsonOut(done);
      }
      return jsonOut({
        file: target,
        size: settings.format === 'audio' ? 'audio' : `${size.width}x${size.height}`,
        status: 'running',
      });
    }

    case 'export_status':
      return jsonOut(store.exports.list());

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
