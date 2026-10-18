// Insert effects for channel strips plus the reverb / delay send buses.

import type { InsertType } from '../../core/types';
import { dbToGain } from '../../core/util';
import { renderVinylNoise } from '../dsp/misc';
import { driveCurve, getImpulse } from '../instruments/chain';

export interface InsertFx {
  readonly type: InsertType;
  readonly input: AudioNode;
  readonly output: AudioNode;
  setParams(p: Record<string, number>, bpm: number): void;
  /** Tempo-synced effects schedule their automation for beats in [b0, b1). */
  scheduleBeats?(b0: number, b1: number, timeAt: (beat: number) => number, spb: number): void;
  onTransport?(playing: boolean, time: number): void;
  dispose(): void;
}

const smooth = (p: AudioParam, v: number, t: number, tau = 0.02) => p.setTargetAtTime(v, t, tau);

// ------------------------------------------------------------------ EQ

export class EqFx implements InsertFx {
  readonly type = 'eq' as const;
  readonly input: BiquadFilterNode;
  readonly output: BiquadFilterNode;
  readonly filters: BiquadFilterNode[];
  private ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    const mk = (type: BiquadFilterType) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      return f;
    };
    const lowCut = mk('highpass');
    lowCut.Q.value = 0.707;
    const low = mk('lowshelf');
    const mid = mk('peaking');
    const high = mk('highshelf');
    const highCut = mk('lowpass');
    highCut.Q.value = 0.707;
    lowCut.connect(low).connect(mid).connect(high).connect(highCut);
    this.filters = [lowCut, low, mid, high, highCut];
    this.input = lowCut;
    this.output = highCut;
  }

  setParams(p: Record<string, number>): void {
    const t = this.ctx.currentTime;
    const [lowCut, low, mid, high, highCut] = this.filters;
    const nyq = this.ctx.sampleRate / 2;
    smooth(lowCut.frequency, p.lowCut <= 21 ? 5 : p.lowCut, t);
    smooth(low.frequency, p.lowFreq, t);
    smooth(low.gain, p.lowGain, t);
    smooth(mid.frequency, p.midFreq, t);
    smooth(mid.gain, p.midGain, t);
    smooth(mid.Q, p.midQ, t);
    smooth(high.frequency, p.highFreq, t);
    smooth(high.gain, p.highGain, t);
    smooth(highCut.frequency, p.highCut >= 19900 ? nyq * 0.999 : p.highCut, t);
  }

  dispose(): void {
    this.filters.forEach((f) => f.disconnect());
  }
}

/** Magnitude response (dB) of an EQ setting — computed with throwaway nodes, used by the EQ editor. */
export function eqResponse(ctx: BaseAudioContext, p: Record<string, number>, freqs: Float32Array<ArrayBuffer>): Float32Array {
  const eq = new EqFx(ctx);
  const [lowCut, low, mid, high, highCut] = eq.filters;
  const nyq = ctx.sampleRate / 2;
  lowCut.frequency.value = p.lowCut <= 21 ? 5 : p.lowCut;
  low.frequency.value = p.lowFreq;
  low.gain.value = p.lowGain;
  mid.frequency.value = p.midFreq;
  mid.gain.value = p.midGain;
  mid.Q.value = p.midQ;
  high.frequency.value = p.highFreq;
  high.gain.value = p.highGain;
  highCut.frequency.value = p.highCut >= 19900 ? nyq * 0.999 : p.highCut;
  const total = new Float32Array(freqs.length).fill(0);
  const mag = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);
  for (const f of eq.filters) {
    f.getFrequencyResponse(freqs, mag, phase);
    for (let i = 0; i < freqs.length; i++) total[i] += 20 * Math.log10(Math.max(1e-6, mag[i]));
  }
  eq.dispose();
  return total;
}

// ------------------------------------------------------------------ compressor

export class CompFx implements InsertFx {
  readonly type = 'comp' as const;
  readonly input: DynamicsCompressorNode;
  readonly output: GainNode;
  private ctx: BaseAudioContext;
  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createDynamicsCompressor();
    this.output = ctx.createGain();
    this.input.connect(this.output);
  }
  get reduction(): number {
    return this.input.reduction;
  }
  setParams(p: Record<string, number>): void {
    const t = this.ctx.currentTime;
    smooth(this.input.threshold, p.threshold, t);
    smooth(this.input.ratio, p.ratio, t);
    smooth(this.input.attack, p.attack / 1000, t);
    smooth(this.input.release, p.release / 1000, t);
    smooth(this.input.knee, p.knee, t);
    smooth(this.output.gain, dbToGain(p.makeup), t);
  }
  dispose(): void {
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ------------------------------------------------------------------ drive

export class DriveFx implements InsertFx {
  readonly type = 'drive' as const;
  readonly input: GainNode;
  readonly output: GainNode;
  private ctx: BaseAudioContext;
  private pre: GainNode;
  private shaper: WaveShaperNode;
  private tone: BiquadFilterNode;
  private wet: GainNode;
  private dry: GainNode;
  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.pre = ctx.createGain();
    this.pre.gain.value = 0.5;
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.input.connect(this.pre).connect(this.shaper).connect(this.tone).connect(this.wet).connect(this.output);
    this.input.connect(this.dry).connect(this.output);
  }
  setParams(p: Record<string, number>): void {
    const t = this.ctx.currentTime;
    const g = 1 + 40 * p.drive * p.drive;
    this.shaper.curve = driveCurve(g, 0.1);
    smooth(this.tone.frequency, p.tone, t);
    smooth(this.wet.gain, p.mix / Math.pow(g, 0.35), t);
    smooth(this.dry.gain, 1 - p.mix, t);
    smooth(this.output.gain, dbToGain(p.output), t);
  }
  dispose(): void {
    [this.input, this.output, this.pre, this.shaper, this.tone, this.wet, this.dry].forEach((n) => n.disconnect());
  }
}

// ------------------------------------------------------------------ chorus

export class ChorusFx implements InsertFx {
  readonly type = 'chorus' as const;
  readonly input: GainNode;
  readonly output: GainNode;
  private ctx: BaseAudioContext;
  private wet: GainNode;
  private lfos: OscillatorNode[] = [];
  private depths: GainNode[] = [];
  private nodes: AudioNode[] = [];
  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wet = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    this.input.connect(this.output);
    [0.012, 0.017].forEach((base, ch) => {
      const d = ctx.createDelay(0.05);
      d.delayTime.value = base;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.6;
      const depth = ctx.createGain();
      lfo.connect(depth).connect(d.delayTime);
      lfo.start();
      this.input.connect(d);
      d.connect(merger, 0, ch);
      this.lfos.push(lfo);
      this.depths.push(depth);
      this.nodes.push(d, lfo, depth);
    });
    merger.connect(this.wet).connect(this.output);
    this.nodes.push(merger);
  }
  setParams(p: Record<string, number>): void {
    const t = this.ctx.currentTime;
    this.lfos.forEach((l, i) => smooth(l.frequency, p.rate * (i ? 1.13 : 1), t));
    this.depths.forEach((d, i) => smooth(d.gain, p.depth * 0.004 * (i ? -1 : 1), t));
    smooth(this.wet.gain, p.mix, t);
    smooth(this.output.gain, 1 / (1 + p.mix * 0.4), t);
  }
  dispose(): void {
    this.lfos.forEach((l) => l.stop());
    [this.input, this.output, this.wet, ...this.nodes].forEach((n) => n.disconnect());
  }
}

// ------------------------------------------------------------------ tremolo / auto-pan

export class TremoloFx implements InsertFx {
  readonly type = 'tremolo' as const;
  readonly input: GainNode;
  readonly output: StereoPannerNode;
  private ctx: BaseAudioContext;
  private lfo: OscillatorNode;
  private ampDepth: GainNode;
  private panDepth: GainNode;
  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createStereoPanner();
    this.input.connect(this.output);
    this.lfo = ctx.createOscillator();
    this.ampDepth = ctx.createGain();
    this.panDepth = ctx.createGain();
    this.lfo.connect(this.ampDepth).connect(this.input.gain);
    this.lfo.connect(this.panDepth).connect(this.output.pan);
    this.lfo.start();
  }
  setParams(p: Record<string, number>): void {
    const t = this.ctx.currentTime;
    smooth(this.lfo.frequency, p.rate, t);
    const stereo = p.stereo >= 0.5;
    smooth(this.ampDepth.gain, stereo ? 0 : p.depth * 0.5, t);
    smooth(this.input.gain, stereo ? 1 : 1 - p.depth * 0.5, t);
    smooth(this.panDepth.gain, stereo ? p.depth : 0, t);
  }
  dispose(): void {
    this.lfo.stop();
    [this.input, this.output, this.lfo, this.ampDepth, this.panDepth].forEach((n) => n.disconnect());
  }
}

// ------------------------------------------------------------------ tempo pump (sidechain imitation)

export class PumpFx implements InsertFx {
  readonly type = 'pump' as const;
  readonly input: GainNode;
  readonly output: GainNode;
  private p: Record<string, number> = { depth: 0.65, release: 0.45, division: 1 };
  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = this.input;
  }
  setParams(p: Record<string, number>): void {
    this.p = p;
  }
  scheduleBeats(b0: number, b1: number, timeAt: (beat: number) => number, spb: number): void {
    const div = this.p.division || 1;
    const g = this.input.gain;
    const rel = Math.max(0.03, this.p.release * div * spb);
    for (let k = Math.ceil(b0 / div - 1e-9); k * div < b1 - 1e-9; k++) {
      const t = timeAt(k * div);
      g.setTargetAtTime(1 - this.p.depth, t, 0.0025);
      g.setTargetAtTime(1, t + 0.012, rel / 3.2);
    }
  }
  onTransport(playing: boolean, time: number): void {
    if (!playing) {
      this.input.gain.cancelScheduledValues(time);
      this.input.gain.setTargetAtTime(1, time, 0.02);
    }
  }
  dispose(): void {
    this.input.disconnect();
  }
}

// ------------------------------------------------------------------ lo-fi

const vinylCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function vinylBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = vinylCache.get(ctx);
  if (!b) {
    const data = renderVinylNoise(ctx.sampleRate);
    b = new AudioBuffer({ length: data.length, sampleRate: ctx.sampleRate, numberOfChannels: 1 });
    b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    vinylCache.set(ctx, b);
  }
  return b;
}

const crushCache = new Map<number, Float32Array<ArrayBuffer>>();
function crushCurve(bits: number): Float32Array<ArrayBuffer> {
  const b = Math.round(bits);
  let c = crushCache.get(b);
  if (!c) {
    const n = 8192;
    c = new Float32Array(n);
    const steps = Math.pow(2, b - 1);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.round(x * steps) / steps;
    }
    crushCache.set(b, c);
  }
  return c;
}

export class LoFiFx implements InsertFx {
  readonly type = 'lofi' as const;
  readonly input: GainNode;
  readonly output: GainNode;
  private ctx: BaseAudioContext;
  private sat: WaveShaperNode;
  private crush: WaveShaperNode;
  private lp: BiquadFilterNode;
  private wowDelay: DelayNode;
  private wowLfo: OscillatorNode;
  private flutterLfo: OscillatorNode;
  private wowDepth: GainNode;
  private flutterDepth: GainNode;
  private noise: AudioBufferSourceNode;
  private noiseGain: GainNode;
  private noiseLevel = 0;
  private playing = false;
  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.sat = ctx.createWaveShaper();
    this.crush = ctx.createWaveShaper();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.6;
    this.wowDelay = ctx.createDelay(0.05);
    this.wowDelay.delayTime.value = 0.008;
    this.wowLfo = ctx.createOscillator();
    this.wowLfo.frequency.value = 0.55;
    this.flutterLfo = ctx.createOscillator();
    this.flutterLfo.frequency.value = 6.3;
    this.wowDepth = ctx.createGain();
    this.flutterDepth = ctx.createGain();
    this.wowLfo.connect(this.wowDepth).connect(this.wowDelay.delayTime);
    this.flutterLfo.connect(this.flutterDepth).connect(this.wowDelay.delayTime);
    this.wowLfo.start();
    this.flutterLfo.start();
    this.input.connect(this.sat).connect(this.crush).connect(this.lp).connect(this.wowDelay).connect(this.output);
    this.noise = ctx.createBufferSource();
    this.noise.buffer = vinylBuffer(ctx);
    this.noise.loop = true;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noise.connect(this.noiseGain).connect(this.output);
    this.noise.start();
  }
  setParams(p: Record<string, number>): void {
    const t = this.ctx.currentTime;
    this.sat.curve = driveCurve(1 + p.drive * 5, 0.06);
    this.crush.curve = crushCurve(p.bits);
    smooth(this.lp.frequency, p.lowpass, t);
    smooth(this.wowDepth.gain, p.wow * 0.0022, t);
    smooth(this.flutterDepth.gain, p.wow * 0.00025, t);
    this.noiseLevel = p.noise * 0.22;
    smooth(this.noiseGain.gain, this.playing ? this.noiseLevel : 0, t, 0.1);
  }
  onTransport(playing: boolean, time: number): void {
    this.playing = playing;
    this.noiseGain.gain.setTargetAtTime(playing ? this.noiseLevel : 0, time, 0.15);
  }
  dispose(): void {
    this.noise.stop();
    this.wowLfo.stop();
    this.flutterLfo.stop();
    [this.input, this.output, this.sat, this.crush, this.lp, this.wowDelay, this.wowLfo, this.flutterLfo, this.wowDepth, this.flutterDepth, this.noise, this.noiseGain].forEach((n) =>
      n.disconnect(),
    );
  }
}

// ------------------------------------------------------------------ tempo delay network (insert & bus)

export class TempoDelay {
  readonly input: GainNode;
  readonly output: GainNode; // wet only
  private ctx: BaseAudioContext;
  private dl: DelayNode;
  private dr: DelayNode;
  private fbL: GainNode;
  private fbR: GainNode;
  private toneL: BiquadFilterNode;
  private toneR: BiquadFilterNode;
  private hp: BiquadFilterNode;
  private merger: ChannelMergerNode;
  private pingpong: boolean | null = null;
  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 160;
    this.dl = ctx.createDelay(4);
    this.dr = ctx.createDelay(4);
    this.fbL = ctx.createGain();
    this.fbR = ctx.createGain();
    this.toneL = ctx.createBiquadFilter();
    this.toneR = ctx.createBiquadFilter();
    this.toneL.type = this.toneR.type = 'lowpass';
    this.merger = ctx.createChannelMerger(2);
    this.merger.connect(this.output);
    this.input.connect(this.hp);
  }
  private wire(pingpong: boolean): void {
    if (this.pingpong === pingpong) return;
    this.pingpong = pingpong;
    [this.hp, this.dl, this.dr, this.toneL, this.toneR, this.fbL, this.fbR].forEach((n) => n.disconnect());
    this.hp.connect(this.dl);
    this.dl.connect(this.toneL).connect(this.fbL);
    this.dl.connect(this.merger, 0, 0);
    if (pingpong) {
      this.fbL.connect(this.dr);
      this.dr.connect(this.toneR).connect(this.fbR).connect(this.dl);
      this.dr.connect(this.merger, 0, 1);
    } else {
      this.fbL.connect(this.dl);
      this.dl.connect(this.merger, 0, 1);
    }
  }
  setParams(p: Record<string, number>, bpm: number): void {
    const t = this.ctx.currentTime;
    this.wire(p.pingpong >= 0.5);
    const time = Math.min(3.9, (p.time * 60) / bpm);
    smooth(this.dl.delayTime, time, t, 0.05);
    smooth(this.dr.delayTime, time, t, 0.05);
    smooth(this.fbL.gain, p.feedback, t);
    smooth(this.fbR.gain, p.feedback, t);
    smooth(this.toneL.frequency, p.tone, t);
    smooth(this.toneR.frequency, p.tone, t);
  }
  dispose(): void {
    [this.input, this.output, this.hp, this.dl, this.dr, this.fbL, this.fbR, this.toneL, this.toneR, this.merger].forEach((n) => n.disconnect());
  }
}

export class DelayFx implements InsertFx {
  readonly type = 'delay' as const;
  readonly input: GainNode;
  readonly output: GainNode;
  private ctx: BaseAudioContext;
  private delay: TempoDelay;
  private wet: GainNode;
  private dry: GainNode;
  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.delay = new TempoDelay(ctx);
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.delay.input);
    this.delay.output.connect(this.wet).connect(this.output);
  }
  setParams(p: Record<string, number>, bpm: number): void {
    const t = this.ctx.currentTime;
    this.delay.setParams(p, bpm);
    smooth(this.wet.gain, p.mix, t);
    smooth(this.dry.gain, 1 - p.mix * 0.5, t);
  }
  dispose(): void {
    this.delay.dispose();
    [this.input, this.output, this.wet, this.dry].forEach((n) => n.disconnect());
  }
}

export function createInsert(ctx: BaseAudioContext, type: InsertType): InsertFx {
  switch (type) {
    case 'eq':
      return new EqFx(ctx);
    case 'comp':
      return new CompFx(ctx);
    case 'drive':
      return new DriveFx(ctx);
    case 'chorus':
      return new ChorusFx(ctx);
    case 'tremolo':
      return new TremoloFx(ctx);
    case 'pump':
      return new PumpFx(ctx);
    case 'lofi':
      return new LoFiFx(ctx);
    case 'delay':
      return new DelayFx(ctx);
  }
}

// ------------------------------------------------------------------ send buses

export class ReverbBus {
  readonly input: GainNode;
  readonly output: GainNode;
  private ctx: BaseAudioContext;
  private hp: BiquadFilterNode;
  private conv: ConvolverNode;
  private irKey = '';
  private pendingIr: ReturnType<typeof setTimeout> | null = null;
  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.conv = ctx.createConvolver();
    this.conv.normalize = false;
    this.input.connect(this.hp).connect(this.conv).connect(this.output);
  }
  apply(params: Record<string, number>, returnDb: number, immediate = false): void {
    const t = this.ctx.currentTime;
    smooth(this.hp.frequency, params.lowcut ?? 180, t);
    smooth(this.output.gain, dbToGain(returnDb), t);
    const key = `${(params.decay ?? 2.2).toFixed(2)}|${(params.predelay ?? 0.02).toFixed(3)}|${(params.damping ?? 0.5).toFixed(2)}`;
    if (key === this.irKey) return;
    this.irKey = key;
    const build = () => {
      this.pendingIr = null;
      this.conv.buffer = getImpulse(this.ctx.sampleRate, params.decay ?? 2.2, params.damping ?? 0.5, params.predelay ?? 0.02, 0.6);
    };
    if (immediate || !this.conv.buffer) build();
    else {
      if (this.pendingIr) clearTimeout(this.pendingIr);
      this.pendingIr = setTimeout(build, 120);
    }
  }
  dispose(): void {
    if (this.pendingIr) clearTimeout(this.pendingIr);
    [this.input, this.output, this.hp, this.conv].forEach((n) => n.disconnect());
  }
}

export class DelayBus {
  readonly input: GainNode;
  readonly output: GainNode;
  private ctx: BaseAudioContext;
  private delay: TempoDelay;
  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.delay = new TempoDelay(ctx);
    this.input.connect(this.delay.input);
    this.delay.output.connect(this.output);
  }
  apply(params: Record<string, number>, returnDb: number, bpm: number): void {
    this.delay.setParams(params, bpm);
    smooth(this.output.gain, dbToGain(returnDb), this.ctx.currentTime);
  }
  dispose(): void {
    this.delay.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}
