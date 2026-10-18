// Playable instruments: sample-rendered (physical models), native-oscillator synths and drum kits.

import { clamp, mtof } from '../../core/util';
import { DRUM_BY_NOTE, PIECE_PAN, type DrumPiece } from '../dsp/drums';
import type { RenderJob } from '../dsp/render';
import { renderService } from '../renderService';
import { InstrumentChain, mapControl } from './chain';
import type { PatchDef, SynthDef } from './types';

export interface VoiceHandle {
  release(time: number): void;
}

export interface Instrument {
  readonly patch: PatchDef;
  readonly output: AudioNode;
  /** Schedule a note with a known duration (sequencer playback). */
  play(pitch: number, velocity: number, time: number, duration: number): void;
  /** Start a note of unknown length (live input). */
  noteOn(pitch: number, velocity: number, time: number): VoiceHandle | null;
  /** Fade out everything (transport stop). */
  allNotesOff(time?: number): void;
  setParams(params: Record<string, number>): void;
  /** Render jobs needed for the given pitches (empty for synths). */
  jobsFor(pitches: Iterable<number>): RenderJob[];
  dispose(): void;
}

const noop: VoiceHandle = { release: () => undefined };

function velocityGain(vel: number, sens: number): number {
  const v = clamp(vel, 1, 127) / 127;
  return (1 - sens) * 0.72 + sens * Math.pow(v, 1.7);
}

// ======================================================================= sampled

interface SVoice {
  src: AudioBufferSourceNode;
  vca: GainNode;
  pitch: number;
  start: number;
  end: number; // time the voice is fully silent (Infinity while held)
  nodes: AudioNode[];
}

class SampledInstrument implements Instrument {
  readonly patch: PatchDef;
  readonly output: AudioNode;
  private ctx: BaseAudioContext;
  private chain: InstrumentChain;
  private voices: SVoice[] = [];
  private params: Record<string, number> = {};

  constructor(ctx: BaseAudioContext, patch: PatchDef) {
    this.ctx = ctx;
    this.patch = patch;
    this.chain = new InstrumentChain(ctx, patch);
    this.output = this.chain.output;
  }

  private get def() {
    return this.patch.sampled!;
  }

  private zoneOf(pitch: number): number {
    const [lo, hi] = this.patch.range;
    const step = this.def.zoneStep;
    const p = clamp(pitch, lo, hi);
    return Math.min(hi, lo + Math.round((p - lo) / step) * step);
  }

  private job(zone: number): RenderJob {
    return { kind: 'zone', spec: this.def.spec, pitch: zone, sr: this.ctx.sampleRate, seed: 1 };
  }

  jobsFor(pitches: Iterable<number>): RenderJob[] {
    const zones = new Set<number>();
    for (const p of pitches) zones.add(this.zoneOf(p));
    return [...zones].map((z) => this.job(z));
  }

  setParams(params: Record<string, number>): void {
    this.params = params;
    this.chain.setParams(params);
  }

  private releaseTime(pitch: number): number {
    const base = this.params.release !== undefined ? mapControl.release(this.params.release) : this.def.release;
    // low strings / dampers ring a little longer
    return base * (1 + clamp((60 - pitch) / 60, 0, 0.8));
  }

  private startVoice(pitch: number, velocity: number, time: number): SVoice | null {
    const ctx = this.ctx;
    const zone = this.zoneOf(pitch);
    const job = this.job(zone);
    const buffer = renderService.get(job) ?? renderService.getSync(job);
    const t = Math.max(time, ctx.currentTime);
    // same-pitch retrigger (a string can only ring once) and polyphony limit
    for (const v of this.voices) {
      if (v.end > t && v.pitch === pitch && this.def.retrigger === 'cut') this.fade(v, t, 0.012);
    }
    const max = this.def.maxVoices ?? 32;
    const alive = this.voices.filter((v) => v.end > t);
    if (alive.length >= max) this.fade(alive.sort((a, b) => a.start - b.start)[0], t, 0.01);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const rate = Math.pow(2, (pitch - zone) / 12);
    src.playbackRate.value = rate;
    const nodes: AudioNode[] = [src];
    let head: AudioNode = src;
    if (this.def.velFilter) {
      const [lo, hi] = this.def.velFilter;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.5;
      lp.frequency.value = lo * Math.pow(hi / lo, Math.pow(clamp(velocity, 1, 127) / 127, 0.8));
      head.connect(lp);
      head = lp;
      nodes.push(lp);
    }
    const vca = ctx.createGain();
    const gain = velocityGain(velocity, this.params.velocity ?? 0.8);
    const attack = this.def.attack ?? 0.002;
    vca.gain.setValueAtTime(0, t);
    vca.gain.linearRampToValueAtTime(gain, t + attack);
    head.connect(vca);
    nodes.push(vca);
    head = vca;
    if (this.def.panSpread) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = clamp(((pitch - 64) / 36) * this.def.panSpread, -1, 1);
      head.connect(pan);
      head = pan;
      nodes.push(pan);
    }
    head.connect(this.chain.input);
    src.start(t);
    const natural = t + buffer.duration / rate;
    const voice: SVoice = { src, vca, pitch, start: t, end: Infinity, nodes };
    src.onended = () => {
      for (const n of nodes) n.disconnect();
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    // the sample ends on its own if never released
    src.stop(natural + 0.01);
    this.voices.push(voice);
    return voice;
  }

  private fade(v: SVoice, t: number, tau: number): void {
    v.vca.gain.cancelScheduledValues(t);
    v.vca.gain.setTargetAtTime(0, t, tau);
    try {
      v.src.stop(t + tau * 8);
    } catch {
      /* ignore */
    }
    v.end = t + tau * 8;
  }

  private releaseVoice(v: SVoice, time: number): void {
    const t = Math.max(time, v.start + (this.def.attack ?? 0.002) + 0.001);
    const r = this.releaseTime(v.pitch);
    v.vca.gain.setTargetAtTime(0, t, r / 5);
    try {
      v.src.stop(t + r * 1.4 + 0.02);
    } catch {
      /* ignore */
    }
    v.end = t + r * 1.4;
  }

  play(pitch: number, velocity: number, time: number, duration: number): void {
    const v = this.startVoice(pitch, velocity, time);
    if (v) this.releaseVoice(v, time + Math.max(0.01, duration));
  }

  noteOn(pitch: number, velocity: number, time: number): VoiceHandle | null {
    const v = this.startVoice(pitch, velocity, time);
    if (!v) return null;
    return {
      release: (t: number) => {
        // live release: cancel nothing in the past, just start the release now
        if (v.end === Infinity) this.releaseVoice(v, Math.max(t, this.ctx.currentTime));
      },
    };
  }

  allNotesOff(time?: number): void {
    const t = time ?? this.ctx.currentTime;
    for (const v of [...this.voices]) if (v.end > t) this.fade(v, t, 0.015);
  }

  dispose(): void {
    this.allNotesOff();
    this.chain.dispose();
  }
}

// ======================================================================= drums

interface DVoice {
  src: AudioBufferSourceNode;
  vca: GainNode;
  piece: DrumPiece;
  start: number;
  end: number;
}

const ACOUSTIC_KITS = new Set(['studio', 'rock', 'jazz', 'lofi']);

class DrumInstrument implements Instrument {
  readonly patch: PatchDef;
  readonly output: AudioNode;
  private ctx: BaseAudioContext;
  private chain: InstrumentChain;
  private buses = new Map<DrumPiece, GainNode>();
  private voices: DVoice[] = [];
  private params: Record<string, number> = {};
  private kit: string;

  constructor(ctx: BaseAudioContext, patch: PatchDef) {
    this.ctx = ctx;
    this.patch = patch;
    this.kit = patch.kit ?? 'studio';
    this.chain = new InstrumentChain(ctx, patch);
    this.output = this.chain.output;
  }

  private job(piece: DrumPiece): RenderJob {
    return { kind: 'drum', kit: this.kit, piece, sr: this.ctx.sampleRate };
  }

  jobsFor(pitches: Iterable<number>): RenderJob[] {
    const pieces = new Set<DrumPiece>();
    for (const p of pitches) {
      const d = DRUM_BY_NOTE.get(p);
      if (d) pieces.add(d.piece);
    }
    return [...pieces].map((p) => this.job(p));
  }

  setParams(params: Record<string, number>): void {
    this.params = params;
    this.chain.setParams(params);
  }

  private bus(piece: DrumPiece): GainNode {
    let b = this.buses.get(piece);
    if (!b) {
      b = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = PIECE_PAN[piece] ?? 0;
      b.connect(pan).connect(this.chain.input);
      this.buses.set(piece, b);
    }
    return b;
  }

  private hit(pitch: number, velocity: number, time: number): DVoice | null {
    const entry = DRUM_BY_NOTE.get(pitch);
    if (!entry) return null;
    const ctx = this.ctx;
    const job = this.job(entry.piece);
    const buffer = renderService.get(job) ?? renderService.getSync(job);
    const t = Math.max(time, ctx.currentTime);
    // hi-hat choke group
    if (entry.piece === 'hatC' || entry.piece === 'hatP' || entry.piece === 'hatO') {
      for (const v of this.voices) {
        if (v.piece === 'hatO' && v.end > t && v.start < t) {
          v.vca.gain.cancelScheduledValues(t);
          v.vca.gain.setTargetAtTime(0, t, 0.012);
          v.end = t + 0.1;
          try {
            v.src.stop(t + 0.1);
          } catch {
            /* ignore */
          }
        }
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (ACOUSTIC_KITS.has(this.kit)) src.detune.value = (Math.random() * 2 - 1) * 9;
    const vca = ctx.createGain();
    vca.gain.value = velocityGain(velocity, this.params.velocity ?? 0.8);
    let head: AudioNode = src;
    let lp: BiquadFilterNode | null = null;
    if (ACOUSTIC_KITS.has(this.kit) && velocity < 115) {
      lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2500 * Math.pow(8, clamp(velocity, 1, 127) / 115);
      lp.Q.value = 0.4;
      src.connect(lp);
      head = lp;
    }
    head.connect(vca).connect(this.bus(entry.piece));
    src.start(t);
    const voice: DVoice = { src, vca, piece: entry.piece, start: t, end: t + buffer.duration };
    src.onended = () => {
      src.disconnect();
      lp?.disconnect();
      vca.disconnect();
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    this.voices.push(voice);
    return voice;
  }

  play(pitch: number, velocity: number, time: number): void {
    this.hit(pitch, velocity, time);
  }

  noteOn(pitch: number, velocity: number, time: number): VoiceHandle | null {
    this.hit(pitch, velocity, time);
    return noop;
  }

  allNotesOff(time?: number): void {
    const t = time ?? this.ctx.currentTime;
    for (const v of this.voices) {
      if (v.end <= t) continue;
      v.vca.gain.cancelScheduledValues(t);
      v.vca.gain.setTargetAtTime(0, t, 0.02);
      try {
        v.src.stop(t + 0.15);
      } catch {
        /* ignore */
      }
      v.end = t + 0.15;
    }
  }

  dispose(): void {
    this.allNotesOff();
    this.chain.dispose();
    this.buses.forEach((b) => b.disconnect());
  }
}

// ======================================================================= synth

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();

function organWave(ctx: BaseAudioContext, drawbars: number[]): PeriodicWave {
  let m = waveCache.get(ctx);
  if (!m) {
    m = new Map();
    waveCache.set(ctx, m);
  }
  const key = drawbars.join('');
  let w = m.get(key);
  if (!w) {
    const harmonics = [1, 3, 2, 4, 6, 8, 10, 12, 16];
    const real = new Float32Array(17);
    const imag = new Float32Array(17);
    drawbars.forEach((level, i) => {
      if (level > 0) imag[harmonics[i]] += Math.pow(10, (-(8 - level) * 3) / 20);
    });
    w = ctx.createPeriodicWave(real, imag);
    m.set(key, w);
  }
  return w;
}

const clickCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function clickBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = clickCache.get(ctx);
  if (!b) {
    const len = Math.floor(ctx.sampleRate * 0.006);
    b = new AudioBuffer({ length: len, sampleRate: ctx.sampleRate, numberOfChannels: 1 });
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len / 5));
    clickCache.set(ctx, b);
  }
  return b;
}

interface Env {
  a: number;
  d: number;
  s: number;
  r: number;
}

/** Value of an ADSR (linear attack, exponential decay) at time t. */
function envValue(t: number, t0: number, e: Env, peak: number, base: number): number {
  const dt = t - t0;
  if (dt <= 0) return base;
  if (dt < e.a) return base + ((peak - base) * dt) / e.a;
  const sus = base + (peak - base) * e.s;
  return sus + (peak - sus) * Math.exp(-(dt - e.a) / Math.max(0.001, e.d / 3));
}

function scheduleAttack(p: AudioParam, t0: number, e: Env, peak: number, base: number): void {
  p.setValueAtTime(base, t0);
  p.linearRampToValueAtTime(peak, t0 + e.a);
  p.setTargetAtTime(base + (peak - base) * e.s, t0 + e.a, Math.max(0.001, e.d / 3));
}

function scheduleRelease(p: AudioParam, t0: number, tr: number, e: Env, peak: number, base: number, now: number): void {
  if (tr < t0 + e.a) {
    // note shorter than its attack: freeze the ramp where it is, then release
    p.cancelScheduledValues(Math.max(tr, now));
    p.setValueAtTime(envValue(tr, t0, e, peak, base), Math.max(tr, now));
  }
  p.setTargetAtTime(base, Math.max(tr, now), Math.max(0.002, e.r / 5));
}

interface SynVoice {
  pitch: number;
  start: number;
  end: number; // Infinity while held
  releaseAt: number;
  oscs: OscillatorNode[];
  vca: GainNode;
  filter: BiquadFilterNode;
  nodes: AudioNode[];
  ampEnv: Env;
  filtEnv: Env;
  peak: number;
  fBase: number;
  fPeak: number;
  freqOf: (osc: OscillatorNode) => number; // multiplier per oscillator
}

class SynthInstrument implements Instrument {
  readonly patch: PatchDef;
  readonly output: AudioNode;
  private ctx: BaseAudioContext;
  private chain: InstrumentChain;
  private voices: SynVoice[] = [];
  private params: Record<string, number> = {};
  private vibrato?: { osc: OscillatorNode; depth: GainNode };

  constructor(ctx: BaseAudioContext, patch: PatchDef) {
    this.ctx = ctx;
    this.patch = patch;
    this.chain = new InstrumentChain(ctx, patch);
    this.output = this.chain.output;
    const vib = this.def.vibrato;
    if (vib) {
      const osc = ctx.createOscillator();
      osc.frequency.value = vib.rate;
      const depth = ctx.createGain();
      depth.gain.value = vib.depth;
      osc.connect(depth);
      osc.start();
      this.vibrato = { osc, depth };
    }
  }

  private get def(): SynthDef {
    return this.patch.synth!;
  }

  jobsFor(): RenderJob[] {
    return [];
  }

  setParams(params: Record<string, number>): void {
    this.params = params;
    this.chain.setParams(params);
  }

  private envs(): { amp: Env; filt: Env } {
    const d = this.def;
    const amp = { ...d.amp };
    const filt = { ...d.filter };
    if (this.params.attack !== undefined) amp.a = mapControl.attack(this.params.attack);
    if (this.params.release !== undefined) amp.r = mapControl.release(this.params.release);
    if (this.params.decay !== undefined) {
      const m = mapControl.decayMul(this.params.decay);
      amp.d *= m;
      filt.d *= m;
    }
    return { amp, filt: { a: filt.a, d: filt.d, s: filt.s, r: filt.r } };
  }

  private glideTime(): number {
    return this.params.glide !== undefined ? mapControl.glide(this.params.glide) : this.def.glide ?? 0;
  }

  private fadeVoice(v: SynVoice, t: number): void {
    v.vca.gain.cancelScheduledValues(t);
    v.vca.gain.setTargetAtTime(0, t, 0.008);
    for (const o of v.oscs) {
      try {
        o.stop(t + 0.06);
      } catch {
        /* ignore */
      }
    }
    v.end = t + 0.06;
  }

  private startVoice(pitch: number, velocity: number, time: number, legatoAllowed: boolean): SynVoice | null {
    const ctx = this.ctx;
    const d = this.def;
    const t = Math.max(time, ctx.currentTime);
    const f = mtof(pitch);

    // mono legato: glide the sounding voice to the new pitch instead of a new attack
    if (d.mono) {
      const active = this.voices.filter((v) => v.end > t);
      const legato = legatoAllowed ? active.find((v) => v.releaseAt > t + 0.0005 && v.start < t) : undefined;
      if (legato) {
        const g = this.glideTime();
        for (const o of legato.oscs) {
          const target = f * legato.freqOf(o);
          if (g > 0.001) o.frequency.setTargetAtTime(target, t, g / 3);
          else o.frequency.setValueAtTime(target, t);
        }
        // push the release out: drop the old release and keep sustaining
        legato.vca.gain.cancelScheduledValues(t);
        legato.vca.gain.setValueAtTime(envValue(t, legato.start, legato.ampEnv, legato.peak, 0), t);
        legato.vca.gain.setTargetAtTime(legato.peak * legato.ampEnv.s, t, Math.max(0.001, legato.ampEnv.d / 3));
        if (d.filter.env > 0) {
          const fp = legato.filter.frequency;
          fp.cancelScheduledValues(t);
          fp.setValueAtTime(envValue(t, legato.start, legato.filtEnv, legato.fPeak, legato.fBase), t);
          fp.setTargetAtTime(legato.fBase + (legato.fPeak - legato.fBase) * legato.filtEnv.s, t, Math.max(0.001, legato.filtEnv.d / 3));
        }
        legato.pitch = pitch;
        legato.releaseAt = Infinity;
        legato.end = Infinity;
        return legato;
      }
      for (const v of active) this.fadeVoice(v, t);
    } else {
      const max = d.maxVoices ?? 16;
      const alive = this.voices.filter((v) => v.end > t);
      if (alive.length >= max) this.fadeVoice(alive.sort((a, b) => a.start - b.start)[0], t);
    }

    const { amp, filt } = this.envs();
    const nodes: AudioNode[] = [];
    const mix = ctx.createGain();
    nodes.push(mix);
    const oscs: OscillatorNode[] = [];
    const vibGains: GainNode[] = [];
    const mult = new Map<OscillatorNode, number>();
    for (const o of d.oscs) {
      const n = o.unison ?? 1;
      const per = o.gain / Math.sqrt(n);
      for (let i = 0; i < n; i++) {
        const osc = ctx.createOscillator();
        let m = Math.pow(2, o.octave);
        if (o.wave === 'organ') {
          osc.setPeriodicWave(organWave(ctx, d.drawbars ?? [8, 8, 8, 0, 0, 0, 0, 0, 0]));
          m *= 0.5; // tonewheel wave is built on the 16' fundamental
        } else osc.type = o.wave;
        const spread = n > 1 ? ((i / (n - 1)) * 2 - 1) * (o.spread ?? 10) : 0;
        osc.detune.value = o.detune + spread;
        osc.frequency.value = f * m;
        if (d.pitchEnv) {
          const cents = d.pitchEnv.semis * 100;
          osc.detune.setValueAtTime(o.detune + spread + cents, t);
          osc.detune.linearRampToValueAtTime(o.detune + spread, t + d.pitchEnv.time);
        }
        if (this.vibrato && d.vibrato) {
          const vg = ctx.createGain();
          vg.gain.setValueAtTime(0, t);
          vg.gain.linearRampToValueAtTime(1, t + d.vibrato.delay + 0.3);
          this.vibrato.depth.connect(vg);
          vg.connect(osc.detune);
          nodes.push(vg);
          vibGains.push(vg);
        }
        const g = ctx.createGain();
        g.gain.value = per;
        osc.connect(g).connect(mix);
        nodes.push(osc, g);
        oscs.push(osc);
        mult.set(osc, m);
        osc.start(t);
      }
    }

    const filter = ctx.createBiquadFilter();
    filter.type = d.filter.type;
    const qMul = this.params.resonance !== undefined ? mapControl.qMul(this.params.resonance) : 1;
    filter.Q.value = d.filter.q * qMul;
    const cutMul = this.params.cutoff !== undefined ? mapControl.cutoffMul(this.params.cutoff) : 1;
    const v01 = clamp(velocity, 1, 127) / 127;
    const keyT = Math.pow(f / 261.6, d.filter.keyTrack);
    const fBase = clamp(d.filter.cutoff * cutMul * keyT * Math.pow(2, d.filter.velocity * (v01 - 0.7)), 30, 20000);
    const fPeak = clamp(fBase * Math.pow(2, d.filter.env), 30, 20000);
    if (d.filter.env > 0) scheduleAttack(filter.frequency, t, filt, fPeak, fBase);
    else filter.frequency.setValueAtTime(fBase, t);
    mix.connect(filter);
    nodes.push(filter);

    const vca = ctx.createGain();
    const peak = velocityGain(velocity, this.params.velocity ?? 0.6);
    scheduleAttack(vca.gain, t, amp, peak, 0);
    filter.connect(vca).connect(this.chain.input);
    nodes.push(vca);

    if (d.noise) {
      const click = ctx.createBufferSource();
      click.buffer = clickBuffer(ctx);
      const cg = ctx.createGain();
      cg.gain.value = d.noise * peak;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      click.connect(bp).connect(cg).connect(this.chain.input);
      click.start(t);
      click.onended = () => {
        click.disconnect();
        bp.disconnect();
        cg.disconnect();
      };
    }

    const voice: SynVoice = {
      pitch,
      start: t,
      end: Infinity,
      releaseAt: Infinity,
      oscs,
      vca,
      filter,
      nodes,
      ampEnv: amp,
      filtEnv: filt,
      peak,
      fBase,
      fPeak,
      freqOf: (o) => mult.get(o) ?? 1,
    };
    oscs[0].onended = () => {
      for (const n of nodes) n.disconnect();
      for (const vg of vibGains) this.vibrato?.depth.disconnect(vg);
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    this.voices.push(voice);
    return voice;
  }

  private releaseVoice(v: SynVoice, time: number): void {
    const now = this.ctx.currentTime;
    const tr = Math.max(time, now);
    v.releaseAt = tr;
    scheduleRelease(v.vca.gain, v.start, tr, v.ampEnv, v.peak, 0, now);
    if (this.def.filter.env > 0) scheduleRelease(v.filter.frequency, v.start, tr, v.filtEnv, v.fPeak, v.fBase, now);
    const stopAt = tr + v.ampEnv.r * 1.3 + 0.03;
    for (const o of v.oscs) {
      try {
        o.stop(stopAt);
      } catch {
        /* ignore */
      }
    }
    v.end = stopAt;
  }

  play(pitch: number, velocity: number, time: number, duration: number): void {
    const v = this.startVoice(pitch, velocity, time, true);
    if (v) this.releaseVoice(v, time + Math.max(0.01, duration));
  }

  noteOn(pitch: number, velocity: number, time: number): VoiceHandle | null {
    const v = this.startVoice(pitch, velocity, time, true);
    if (!v) return null;
    const startedPitch = pitch;
    return {
      release: (t: number) => {
        // in mono mode another key may have taken over this voice
        if (v.releaseAt === Infinity && v.pitch === startedPitch) this.releaseVoice(v, t);
      },
    };
  }

  allNotesOff(time?: number): void {
    const t = time ?? this.ctx.currentTime;
    for (const v of [...this.voices]) if (v.end > t) this.fadeVoice(v, t);
  }

  dispose(): void {
    this.allNotesOff();
    if (this.vibrato) {
      this.vibrato.osc.stop();
      this.vibrato.osc.disconnect();
      this.vibrato.depth.disconnect();
    }
    this.chain.dispose();
  }
}

export function createInstrument(ctx: BaseAudioContext, patch: PatchDef, params: Record<string, number>): Instrument {
  const inst: Instrument =
    patch.engine === 'drums'
      ? new DrumInstrument(ctx, patch)
      : patch.engine === 'synth'
        ? new SynthInstrument(ctx, patch)
        : new SampledInstrument(ctx, patch);
  inst.setParams(params);
  return inst;
}
