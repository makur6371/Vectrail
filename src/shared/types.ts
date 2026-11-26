export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const RGBA_WHITE: RGBA = { r: 1, g: 1, b: 1, a: 1 };
export const RGBA_BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  hidden?: boolean;
  muted?: boolean;
  gainDB?: number;
  solo?: boolean;
  locked?: boolean;
  duckUnder?: string;
  duckDB?: number;
}

export type ClipKind = 'video' | 'audio' | 'image' | 'solid' | 'text';

export interface TextStyle {
  string: string;
  fontName: string;
  bold: boolean;
  size: number;
  color: RGBA;
  x: number;
  y: number;
  strokeColor?: RGBA;
  strokeWidth?: number;
  bgColor?: RGBA;
  bgPadding?: number;
}

export type FadeCurve = 'linear' | 'easeIn' | 'easeOut' | 'smooth';

export interface WheelPoint {
  x: number;
  y: number;
}

export interface ColorGrade {
  look?: string;
  lookIntensity?: number;
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  shadows?: WheelPoint;
  midtones?: WheelPoint;
  highlights?: WheelPoint;
}

export type TransitionKind = 'dissolve' | 'dipToBlack' | 'wipe';

export interface Transition {
  kind: TransitionKind;
  duration: number;
}

export type ZoomMode = 'in' | 'inOut' | 'out';

export interface ZoomMove {
  mode: ZoomMode;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  smooth?: boolean;
}

export interface ClipTransform {
  scale: number;
  x: number;
  y: number;
  zoom?: ZoomMove;
}

export interface SpeedRamp {
  inFrom: number;
  inTo: number;
  outFrom: number;
  outTo: number;
  startSpeed: number;
  endSpeed: number;
}

export interface ReverseSource {
  assetID: string;
  sourceStart: number;
}

export interface Clip {
  id: string;
  trackID: string;
  kind: ClipKind;
  assetID?: string;
  start: number;
  duration: number;
  sourceStart?: number;
  speed?: number;
  fadeIn?: number;
  fadeOut?: number;
  fadeInCurve?: FadeCurve;
  fadeOutCurve?: FadeCurve;
  gainDB?: number;
  linkID?: string;
  color?: RGBA;
  text?: TextStyle;
  grade?: ColorGrade;
  transform?: ClipTransform;
  transitionIn?: Transition;
  freeze?: boolean;
  reversedFrom?: ReverseSource;
  reversed?: boolean;
  ramp?: SpeedRamp;
  captioned?: boolean;
}

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaAsset {
  id: string;
  path: string;
  relativePath?: string;
  playablePath?: string;
  name: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export type MarkerTint = 'orange' | 'red' | 'yellow' | 'green' | 'blue' | 'purple';

export interface Marker {
  id: string;
  time: number;
  name: string;
  color?: MarkerTint;
}

export interface PlayRange {
  in: number;
  out: number;
}

export interface CaptionStyle {
  size: number;
  position: number;
  highlight: boolean;
  hidden?: boolean;
}

export interface CaptionFix {
  start: number;
  text?: string;
  merged?: boolean;
}

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  duration: number;
  words: TranscriptWord[];
}

export interface CaptionWord {
  start: number;
  end: number;
  text: string;
  source: number;
  covers: number[];
}

export interface CaptionBlock {
  clipID: string;
  assetID: string;
  start: number;
  end: number;
  words: CaptionWord[];
}

export interface Project {
  version: number;
  width: number;
  height: number;
  fps: number;
  settingsLocked?: boolean;
  assets: MediaAsset[];
  videoTracks: Track[];
  audioTracks: Track[];
  clips: Clip[];
  markers?: Marker[];
  playRange?: PlayRange;
  captions?: CaptionStyle;
  captionFixes?: Record<string, CaptionFix[]>;
  exportDir?: string;
  exportName?: string;
}

export interface ClipSample {
  time: number;
  luma: number;
  sharpness: number;
  motion: number;
  color: number;
  faces: number;
  aesthetic?: number;
  utility?: boolean;
}

export interface ClipAnalysis {
  duration: number;
  created?: string;
  samples: ClipSample[];
}

export interface MusicAnalysis {
  duration: number;
  bpm: number;
  beats: number[];
  barPhase: number;
  energy: number[];
}

export interface AgentCursorState {
  name: string;
  activity?: string;
  clipID?: string;
  time?: number;
  updatedAt: number;
}

export type ExportFormat = 'video' | 'audio';
export type ExportQuality = 'high' | 'web';
export type ExportCodec = 'h264' | 'hevc';
export type ExportShape = 'original' | 'vertical' | 'square' | 'portrait';

export interface ExportSettings {
  format: ExportFormat;
  height?: number;
  codec: ExportCodec;
  quality: ExportQuality;
  includeAudio: boolean;
  loudness?: number;
  shape: ExportShape;
  reframeX: number;
  reframeY: number;
  rangeOnly: boolean;
  enhanceDetail?: boolean;
  name?: string;
  outputDir?: string;
}

export interface CloudAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion?: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  error?: string;
}

export interface ExportJobInfo {
  id: string;
  file: string;
  status: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  sizeLabel: string;
  error?: string;
}
