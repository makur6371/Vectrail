import { Project } from '../../shared/types';
import { clipEnd, clipFadeGainAt, dbToLinear } from '../../shared/project';
import { clipSourceTimeAt } from '../../shared/speedRamp';
import { duckGainAt, trackAudioActivity, WaveformEnvelopeInput } from '../../shared/audioLevels';

interface AudioNodeChain {
  el: HTMLAudioElement;
  gain?: GainNode;
}

export class AudioMixer {
  private chains = new Map<string, AudioNodeChain>();
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private leftAnalyser: AnalyserNode | null = null;
  private rightAnalyser: AnalyserNode | null = null;
  private meterBuf = new Float32Array(256);
  private lastScrubMs = 0;
  private scrubStopTimer: number | null = null;

  private ensureContext(): void {
    if (this.ctx || typeof AudioContext === 'undefined') return;
    const ctx = new AudioContext();
    const master = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);
    const la = ctx.createAnalyser();
    const ra = ctx.createAnalyser();
    la.fftSize = 256;
    ra.fftSize = 256;
    master.connect(splitter);
    splitter.connect(la, 0);
    splitter.connect(ra, 1);
    master.connect(ctx.destination);
    this.ctx = ctx;
    this.masterGain = master;
    this.leftAnalyser = la;
    this.rightAnalyser = ra;
  }

  private getChain(pathStr: string): AudioNodeChain {
    let chain = this.chains.get(pathStr);
    if (!chain) {
      const el = document.createElement('audio');
      el.crossOrigin = 'anonymous';
      el.src = `vectrail-media://local?path=${encodeURIComponent(pathStr)}`;
      el.preload = 'auto';
      chain = { el };
      if (this.ctx && this.masterGain) {
        try {
          const src = this.ctx.createMediaElementSource(el);
          const gain = this.ctx.createGain();
          src.connect(gain);
          gain.connect(this.masterGain);
          chain.gain = gain;
        } catch {
          // fallback to HTMLAudioElement volume
        }
      }
      this.chains.set(pathStr, chain);
    }
    return chain;
  }

  private readRms(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this.meterBuf);
    let sum = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = this.meterBuf[i];
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.meterBuf.length) * 3.2);
  }

  sync(
    project: Project,
    playhead: number,
    playing: boolean,
    waveforms: Record<string, WaveformEnvelopeInput> = {}
  ): { left: number; right: number } {
    if (playing) {
      this.ensureContext();
      if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => {});
    }
    const anySolo = project.audioTracks.some((t) => t.solo);
    const activePaths = new Set<string>();
    let maxLevel = 0;

    for (const track of project.audioTracks) {
      if (track.muted || (anySolo && !track.solo)) continue;
      let duckMult = 1;
      if (track.duckUnder) {
        const underTrack = project.audioTracks.find((t) => t.id === track.duckUnder);
        const underAudible = underTrack && !underTrack.muted && (!anySolo || underTrack.solo);
        if (underAudible) {
          const spans = trackAudioActivity(track.duckUnder, project, waveforms);
          if (spans.length) {
            duckMult = duckGainAt(playhead, spans, dbToLinear(track.duckDB ?? -10));
          }
        }
      }
      for (const clip of project.clips) {
        if (clip.trackID !== track.id || clip.kind !== 'audio' || !clip.assetID) continue;
        if (playhead < clip.start || playhead > clipEnd(clip)) continue;
        const asset = project.assets.find((a) => a.id === clip.assetID);
        if (!asset) continue;
        const mediaPath = asset.playablePath ?? asset.path;
        activePaths.add(mediaPath);
        const chain = this.getChain(mediaPath);
        const el = chain.el;
        const gain = dbToLinear((clip.gainDB ?? 0) + (track.gainDB ?? 0)) * clipFadeGainAt(clip, playhead) * duckMult;
        if (chain.gain) {
          chain.gain.gain.value = Math.max(0, gain);
          el.volume = 1;
        } else {
          el.volume = Math.min(1, Math.max(0, gain));
        }
        maxLevel = Math.max(maxLevel, Math.min(1, gain));
        const targetSrc = Math.max(
          0,
          Math.min(
            asset.duration - 0.02,
            clip.reversed ? asset.duration - clipSourceTimeAt(clip, playhead) : clipSourceTimeAt(clip, playhead)
          )
        );
        if (playing && !clip.reversed) {
          el.playbackRate = Math.min(4, Math.max(0.25, clip.speed ?? 1));
          if (Math.abs(el.currentTime - targetSrc) > 0.25) el.currentTime = targetSrc;
          if (el.paused && el.readyState >= 2) void el.play().catch(() => {});
        } else {
          if (!el.paused) el.pause();
        }
      }
    }

    for (const [p, chain] of this.chains.entries()) {
      if (!activePaths.has(p) && !chain.el.paused) chain.el.pause();
    }

    if (!playing) return { left: 0, right: 0 };
    const rmsL = this.readRms(this.leftAnalyser);
    const rmsR = this.readRms(this.rightAnalyser);
    if (rmsL > 0.001 || rmsR > 0.001) return { left: rmsL, right: rmsR };
    return { left: maxLevel, right: maxLevel * 0.96 };
  }

  pauseAll(): void {
    if (this.scrubStopTimer) {
      window.clearTimeout(this.scrubStopTimer);
      this.scrubStopTimer = null;
    }
    for (const chain of this.chains.values()) {
      if (!chain.el.paused) chain.el.pause();
    }
  }

  scrubAt(project: Project, time: number): void {
    const now = performance.now();
    if (now - this.lastScrubMs < 55) return;
    this.lastScrubMs = now;
    this.ensureContext();
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => {});

    const anySolo = project.audioTracks.some((t) => t.solo);
    const playingChains: HTMLAudioElement[] = [];

    for (const track of project.audioTracks) {
      if (track.muted || (anySolo && !track.solo)) continue;
      for (const clip of project.clips) {
        if (clip.trackID !== track.id || clip.kind !== 'audio' || !clip.assetID) continue;
        if (time < clip.start || time > clipEnd(clip)) continue;
        const asset = project.assets.find((a) => a.id === clip.assetID);
        if (!asset) continue;
        const chain = this.getChain(asset.playablePath ?? asset.path);
        const gain = dbToLinear((clip.gainDB ?? 0) + (track.gainDB ?? 0)) * clipFadeGainAt(clip, time);
        if (chain.gain) {
          chain.gain.gain.value = Math.max(0, gain);
          chain.el.volume = 1;
        } else {
          chain.el.volume = Math.min(1, Math.max(0, gain));
        }
        const targetSrc = Math.max(
          0,
          Math.min(
            Math.max(0, asset.duration - 0.05),
            clip.reversed ? asset.duration - clipSourceTimeAt(clip, time) : clipSourceTimeAt(clip, time)
          )
        );
        chain.el.playbackRate = 1;
        if (Math.abs(chain.el.currentTime - targetSrc) > 0.04) {
          chain.el.currentTime = targetSrc;
        }
        if (chain.el.readyState >= 2) {
          void chain.el.play().catch(() => {});
          playingChains.push(chain.el);
        }
      }
    }

    if (this.scrubStopTimer) window.clearTimeout(this.scrubStopTimer);
    this.scrubStopTimer = window.setTimeout(() => {
      this.scrubStopTimer = null;
      for (const el of playingChains) {
        if (!el.paused) el.pause();
      }
    }, 70);
  }
}
