// Mixer graph: channel strips (inserts → fader → pan → mute → sends), FX return buses and master.
// The same graph is built for the live AudioContext and for OfflineAudioContext bounces.

import type { ChannelSettings, InsertEffect, Project, Track } from '../core/types';
import { dbToGain } from '../core/util';
import { autoMakeup } from './dsp/compressor';
import { DelayBus, ReverbBus, createInsert, type InsertFx } from './fx/effects';
import { createInstrument, type Instrument } from './instruments/instrument';
import { getPatch } from './instruments/patches';

export class Meter {
  private analysers: AnalyserNode[];
  private buf: Float32Array<ArrayBuffer>;
  private splitter: ChannelSplitterNode;
  private holds = [0, 0];
  private holdTimes = [0, 0];
  constructor(ctx: BaseAudioContext, src: AudioNode) {
    this.splitter = ctx.createChannelSplitter(2);
    src.connect(this.splitter);
    this.analysers = [0, 1].map((ch) => {
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      a.smoothingTimeConstant = 0;
      this.splitter.connect(a, ch);
      return a;
    });
    this.buf = new Float32Array(1024);
  }
  /** Peak levels (linear) per channel since the last read, plus a 1.5 s peak hold. */
  read(now = performance.now()): { l: number; r: number; holdL: number; holdR: number } {
    const peaks = this.analysers.map((a, i) => {
      a.getFloatTimeDomainData(this.buf);
      let p = 0;
      for (let k = 0; k < this.buf.length; k++) {
        const v = Math.abs(this.buf[k]);
        if (v > p) p = v;
      }
      if (p >= this.holds[i] || now - this.holdTimes[i] > 1500) {
        this.holds[i] = p;
        this.holdTimes[i] = now;
      }
      return p;
    });
    return { l: peaks[0], r: peaks[1], holdL: this.holds[0], holdR: this.holds[1] };
  }
  dispose(): void {
    this.splitter.disconnect();
    this.analysers.forEach((a) => a.disconnect());
  }
}

export class ChannelStrip {
  readonly input: GainNode;
  readonly fader: GainNode;
  readonly pan: StereoPannerNode;
  readonly muteGain: GainNode;
  readonly sendRev: GainNode;
  readonly sendDel: GainNode;
  readonly meter: Meter | null;
  private ctx: BaseAudioContext;
  private fx = new Map<string, InsertFx>();
  private chainKey = '';
  private active: InsertFx[] = [];

  constructor(ctx: BaseAudioContext, dest: { master: AudioNode; reverb: AudioNode; delay: AudioNode }, meters: boolean) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.fader = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.muteGain = ctx.createGain();
    this.sendRev = ctx.createGain();
    this.sendDel = ctx.createGain();
    this.sendRev.gain.value = 0;
    this.sendDel.gain.value = 0;
    this.input.connect(this.fader);
    this.fader.connect(this.pan).connect(this.muteGain);
    this.muteGain.connect(dest.master);
    this.muteGain.connect(this.sendRev).connect(dest.reverb);
    this.muteGain.connect(this.sendDel).connect(dest.delay);
    this.meter = meters ? new Meter(ctx, this.muteGain) : null;
  }

  private rebuild(inserts: InsertEffect[]): void {
    const key = inserts.map((i) => `${i.id}:${i.type}:${i.enabled ? 1 : 0}`).join('|');
    if (key === this.chainKey) return;
    this.chainKey = key;
    // create / remove effect instances
    const ids = new Set(inserts.map((i) => i.id));
    for (const [id, fx] of this.fx) {
      if (!ids.has(id)) {
        fx.dispose();
        this.fx.delete(id);
      }
    }
    for (const ins of inserts) {
      if (!this.fx.has(ins.id)) this.fx.set(ins.id, createInsert(this.ctx, ins.type));
    }
    // rewire the enabled ones in order
    this.input.disconnect();
    for (const fx of this.fx.values()) fx.output.disconnect();
    this.active = inserts.filter((i) => i.enabled).map((i) => this.fx.get(i.id)!);
    let cur: AudioNode = this.input;
    for (const fx of this.active) {
      cur.connect(fx.input);
      cur = fx.output;
    }
    cur.connect(this.fader);
  }

  apply(s: ChannelSettings, audible: boolean, bpm: number): void {
    const t = this.ctx.currentTime;
    this.rebuild(s.inserts);
    for (const ins of s.inserts) this.fx.get(ins.id)?.setParams(ins.params, bpm);
    this.fader.gain.setTargetAtTime(dbToGain(s.volumeDb), t, 0.012);
    this.pan.pan.setTargetAtTime(s.pan, t, 0.012);
    this.muteGain.gain.setTargetAtTime(audible ? 1 : 0, t, 0.008);
    this.sendRev.gain.setTargetAtTime(s.sends.reverb, t, 0.012);
    this.sendDel.gain.setTargetAtTime(s.sends.delay, t, 0.012);
  }

  /** Enabled effects that need beat-synced automation or transport notifications. */
  activeFx(): InsertFx[] {
    return this.active;
  }

  insert(id: string): InsertFx | undefined {
    return this.fx.get(id);
  }

  dispose(): void {
    for (const fx of this.fx.values()) fx.dispose();
    this.meter?.dispose();
    [this.input, this.fader, this.pan, this.muteGain, this.sendRev, this.sendDel].forEach((n) => n.disconnect());
  }
}

function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2; // the shaper is fed at half level, so this spans ±2
    const a = Math.abs(x);
    const y = a < 0.9 ? a : 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

const LIMITER_MAKEUP = autoMakeup(-1.5, 0, 20);

export class MasterBus {
  readonly input: GainNode;
  readonly meter: Meter | null;
  private ctx: BaseAudioContext;
  private gain: GainNode;
  private limiter: DynamicsCompressorNode;
  private pre: GainNode;
  private clip: WaveShaperNode;
  private limiterOn: boolean | null = null;

  constructor(ctx: BaseAudioContext, destination: AudioNode, meters: boolean) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.gain = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.1;
    this.pre = ctx.createGain();
    this.pre.gain.value = 0.5;
    this.clip = ctx.createWaveShaper();
    this.clip.curve = softClipCurve();
    this.clip.oversample = '2x';
    const post = ctx.createGain();
    post.gain.value = 1;
    this.input.connect(this.gain);
    this.pre.connect(this.clip).connect(post).connect(destination);
    this.meter = meters ? new Meter(ctx, post) : null;
  }

  get reduction(): number {
    return this.limiter.reduction;
  }

  apply(m: Project['master']): void {
    this.gain.gain.setTargetAtTime(dbToGain(m.volumeDb), this.ctx.currentTime, 0.015);
    if (this.limiterOn !== m.limiter) {
      this.limiterOn = m.limiter;
      this.gain.disconnect();
      this.limiter.disconnect();
      if (m.limiter) this.gain.connect(this.limiter).connect(this.pre);
      else this.gain.connect(this.pre);
      // undo the limiter's automatic makeup gain so its ceiling really is the threshold
      this.pre.gain.value = 0.5 / (m.limiter ? LIMITER_MAKEUP : 1);
    }
  }

  dispose(): void {
    [this.input, this.gain, this.limiter, this.pre, this.clip].forEach((n) => n.disconnect());
    this.meter?.dispose();
  }
}

export interface TrackNode {
  id: string;
  strip: ChannelStrip;
  instrument: Instrument | null;
  patchId: string | null;
  track: Track | null;
}

export interface AudioPlayback {
  src: AudioBufferSourceNode;
  env: GainNode;
  end: number;
}

export class MixGraph {
  readonly ctx: BaseAudioContext;
  readonly master: MasterBus;
  readonly reverb: ReverbBus;
  readonly delay: DelayBus;
  readonly tracks = new Map<string, TrackNode>();
  private meters: boolean;
  private last: Project | null = null;
  private lastSolo = false;
  private sources = new Set<AudioPlayback>();

  constructor(ctx: BaseAudioContext, opts: { meters: boolean; destination?: AudioNode }) {
    this.ctx = ctx;
    this.meters = opts.meters;
    this.master = new MasterBus(ctx, opts.destination ?? ctx.destination, opts.meters);
    this.reverb = new ReverbBus(ctx);
    this.delay = new DelayBus(ctx);
    this.reverb.output.connect(this.master.input);
    this.delay.output.connect(this.master.input);
  }

  sync(p: Project, immediate = false): void {
    const prev = this.last;
    const solo = p.tracks.some((t) => t.mixer.solo);
    const tempoChanged = !prev || prev.bpm !== p.bpm;
    const seen = new Set<string>();
    for (const tr of p.tracks) {
      seen.add(tr.id);
      let node = this.tracks.get(tr.id);
      if (!node) {
        node = {
          id: tr.id,
          strip: new ChannelStrip(this.ctx, { master: this.master.input, reverb: this.reverb.input, delay: this.delay.input }, this.meters),
          instrument: null,
          patchId: null,
          track: null,
        };
        this.tracks.set(tr.id, node);
      }
      if (tr.kind === 'instrument' && tr.instrument) {
        if (node.patchId !== tr.instrument.patchId) {
          node.instrument?.allNotesOff();
          const old = node.instrument;
          if (old) setTimeout(() => old.dispose(), 300);
          node.instrument = createInstrument(this.ctx, getPatch(tr.instrument.patchId), tr.instrument.params);
          node.instrument.output.connect(node.strip.input);
          node.patchId = tr.instrument.patchId;
        } else if (node.track?.instrument?.params !== tr.instrument.params) {
          node.instrument?.setParams(tr.instrument.params);
        }
      } else if (node.instrument) {
        node.instrument.dispose();
        node.instrument = null;
        node.patchId = null;
      }
      if (!node.track || node.track.mixer !== tr.mixer || solo !== this.lastSolo || tempoChanged) {
        node.strip.apply(tr.mixer, !tr.mixer.mute && (!solo || tr.mixer.solo), p.bpm);
      }
      node.track = tr;
    }
    for (const [id, node] of this.tracks) {
      if (!seen.has(id)) {
        node.instrument?.dispose();
        node.strip.dispose();
        this.tracks.delete(id);
      }
    }
    if (!prev || prev.master !== p.master) this.master.apply(p.master);
    if (!prev || prev.buses.reverb !== p.buses.reverb) this.reverb.apply(p.buses.reverb.params, p.buses.reverb.returnDb, immediate);
    if (!prev || prev.buses.delay !== p.buses.delay || tempoChanged) this.delay.apply(p.buses.delay.params, p.buses.delay.returnDb, p.bpm);
    this.lastSolo = solo;
    this.last = p;
  }

  instrument(trackId: string): Instrument | null {
    return this.tracks.get(trackId)?.instrument ?? null;
  }

  strip(trackId: string): ChannelStrip | null {
    return this.tracks.get(trackId)?.strip ?? null;
  }

  activeFx(): InsertFx[] {
    const out: InsertFx[] = [];
    for (const n of this.tracks.values()) out.push(...n.strip.activeFx());
    return out;
  }

  playBuffer(trackId: string, buffer: AudioBuffer, when: number, offset: number, duration: number, gainDb: number, fadeIn: number, fadeOut: number): void {
    const strip = this.strip(trackId);
    if (!strip || duration <= 0.002) return;
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const late = t - when;
    const off = offset + late;
    const dur = duration - late;
    if (dur <= 0.002 || off >= buffer.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const env = ctx.createGain();
    const g = dbToGain(gainDb);
    const fi = Math.max(0.003, Math.min(fadeIn, dur / 2));
    const fo = Math.max(0.005, Math.min(fadeOut, dur / 2));
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(g, t + fi);
    env.gain.setValueAtTime(g, t + dur - fo);
    env.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(env).connect(strip.input);
    src.start(t, off, dur + 0.01);
    const pb: AudioPlayback = { src, env, end: t + dur };
    src.onended = () => {
      src.disconnect();
      env.disconnect();
      this.sources.delete(pb);
    };
    this.sources.add(pb);
  }

  stopAll(time?: number): void {
    const t = time ?? this.ctx.currentTime;
    for (const n of this.tracks.values()) n.instrument?.allNotesOff(t);
    for (const s of this.sources) {
      if (s.end <= t) continue;
      s.env.gain.cancelScheduledValues(t);
      s.env.gain.setTargetAtTime(0, t, 0.01);
      try {
        s.src.stop(t + 0.06);
      } catch {
        /* ignore */
      }
    }
    for (const fx of this.activeFx()) fx.onTransport?.(false, t);
  }

  dispose(): void {
    for (const n of this.tracks.values()) {
      n.instrument?.dispose();
      n.strip.dispose();
    }
    this.tracks.clear();
    this.reverb.dispose();
    this.delay.dispose();
    this.master.dispose();
  }
}
