// Instruments that play recorded samples: pitched sets (pianos, guitars, basses, strings …)
// and drum kits. While a set is still downloading, or if it cannot be loaded, the
// synthesized version of the patch plays instead so there is never silence.

import { clamp } from '../../core/util';
import { DRUM_BY_NOTE, type DrumPiece } from '../dsp/drums';
import type { RenderJob } from '../dsp/render';
import { sampleLibrary, SAMPLE_SETS, type SampleZone } from '../samples/library';
import { InstrumentChain, mapControl } from './chain';
import type { Instrument, NoteLike, VoiceHandle } from './instrument';
import type { PatchDef } from './types';

interface Voice {
  src: AudioBufferSourceNode;
  vca: GainNode;
  key: string; // pitch or drum piece
  start: number;
  end: number; // when the voice is silent (Infinity while held)
}

const noop: VoiceHandle = { release: () => undefined };

/**
 * Gain inside a velocity layer: the recording already carries the dynamics, this only
 * smooths the step to the next layer. A set with a single layer gets the full range.
 */
function zoneGain(velocity: number, z: SampleZone, sensitivity: number): number {
  const span = Math.max(1, z.vh - z.vl);
  const pos = clamp((velocity - z.vl) / span, 0, 1);
  const share = (z.vh - z.vl + 1) / 127;
  return Math.pow(10, (-(1 - pos) * share * 26 * sensitivity) / 20);
}

/** Zones by articulation → key → velocity layer → round robins. */
class ZoneMap {
  private byArt = new Map<string, SampleZone[][]>();
  private counters = new Map<string, number>();

  constructor(zones: SampleZone[]) {
    for (const z of zones) {
      const art = z.a ?? '';
      let keys = this.byArt.get(art);
      if (!keys) {
        keys = Array.from({ length: 128 }, () => []);
        this.byArt.set(art, keys);
      }
      for (let k = z.lo ?? 0; k <= (z.hi ?? 127); k++) keys[k].push(z);
    }
  }

  find(pitch: number, velocity: number, art = ''): SampleZone | null {
    const keys = this.byArt.get(art) ?? this.byArt.values().next().value;
    if (!keys) return null;
    const p = clamp(pitch, 0, 127);
    let zs = keys[p];
    // outside the mapped range: use the nearest mapped key
    for (let d = 1; !zs.length && d < 128; d++) zs = keys[clamp(p - d, 0, 127)].length ? keys[clamp(p - d, 0, 127)] : keys[clamp(p + d, 0, 127)];
    if (!zs.length) return null;
    let layer = zs.filter((z) => velocity >= z.vl && velocity <= z.vh);
    if (!layer.length) {
      const nearest = zs.reduce((a, b) => (Math.abs(b.vh - velocity) < Math.abs(a.vh - velocity) ? b : a));
      layer = zs.filter((z) => z.vl === nearest.vl);
    }
    if (layer.length === 1) return layer[0];
    const id = `${art}|${layer[0].f}`;
    const n = (this.counters.get(id) ?? 0) + 1;
    this.counters.set(id, n);
    return layer.sort((a, b) => a.rr - b.rr)[n % layer.length];
  }
}

abstract class SampleBase implements Instrument {
  readonly patch: PatchDef;
  readonly output: GainNode;
  protected ctx: BaseAudioContext;
  protected chain: InstrumentChain;
  protected voices: Voice[] = [];
  protected params: Record<string, number> = {};
  private fallback: Instrument | null = null;
  private makeFallback: () => Instrument;
  private loading: Promise<void>;
  protected abstract sets: string[];

  constructor(ctx: BaseAudioContext, patch: PatchDef, makeFallback: () => Instrument) {
    this.ctx = ctx;
    this.patch = patch;
    this.makeFallback = makeFallback;
    this.chain = new InstrumentChain(ctx, patch);
    this.output = ctx.createGain();
    this.chain.output.connect(this.output);
    this.loading = Promise.resolve();
    queueMicrotask(() => void this.ready());
  }

  /** Resolves when the samples are loaded (or the synthesized fallback took over). */
  ready(): Promise<void> {
    this.loading = Promise.all(this.sets.map((s) => sampleLibrary.load(s))).then(
      () => undefined,
      () => void this.useFallback(),
    );
    return this.loading;
  }

  protected get loaded(): boolean {
    return this.sets.every((s) => sampleLibrary.isLoaded(s));
  }

  protected useFallback(): Instrument {
    if (!this.fallback) {
      this.fallback = this.makeFallback();
      this.fallback.setParams(this.params);
      this.fallback.output.connect(this.output);
    }
    return this.fallback;
  }

  jobsFor(notes: Iterable<NoteLike>): RenderJob[] {
    // only the synthesized fallback needs rendering, and only once the samples have failed
    return this.sets.some((s) => sampleLibrary.hasFailed(s)) ? this.useFallback().jobsFor(notes) : [];
  }

  setParams(params: Record<string, number>): void {
    this.params = params;
    this.chain.setParams(params);
    this.fallback?.setParams(params);
  }

  protected get sensitivity(): number {
    return this.params.velocity ?? 0.8;
  }

  protected startVoice(buffer: AudioBuffer, key: string, gain: number, rate: number, time: number, dest: AudioNode): Voice {
    const ctx = this.ctx;
    const t = Math.max(time, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t);
    vca.gain.linearRampToValueAtTime(gain, t + 0.0015);
    src.connect(vca).connect(dest);
    src.start(t);
    const voice: Voice = { src, vca, key, start: t, end: Infinity };
    src.onended = () => {
      src.disconnect();
      vca.disconnect();
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    src.stop(t + buffer.duration / rate + 0.02);
    this.voices.push(voice);
    return voice;
  }

  protected fade(v: Voice, t: number, tau: number): void {
    v.vca.gain.cancelScheduledValues(t);
    v.vca.gain.setTargetAtTime(0, t, tau);
    try {
      v.src.stop(t + tau * 8);
    } catch {
      /* already stopped */
    }
    v.end = t + tau * 8;
  }

  allNotesOff(time?: number): void {
    const t = time ?? this.ctx.currentTime;
    for (const v of [...this.voices]) if (v.end > t) this.fade(v, t, 0.015);
    this.fallback?.allNotesOff(time);
  }

  dispose(): void {
    this.allNotesOff();
    this.fallback?.dispose();
    this.chain.dispose();
    this.output.disconnect();
  }

  abstract play(pitch: number, velocity: number, time: number, duration: number): void;
  abstract noteOn(pitch: number, velocity: number, time: number): VoiceHandle | null;
}

// ======================================================================= pitched

export class MultiSampleInstrument extends SampleBase {
  protected sets: string[];
  private map: ZoneMap;
  private panBuses: GainNode[] = [];

  constructor(ctx: BaseAudioContext, patch: PatchDef, makeFallback: () => Instrument) {
    super(ctx, patch, makeFallback);
    const def = patch.samples!;
    this.sets = [def.set];
    this.map = new ZoneMap(SAMPLE_SETS[def.set]?.zones ?? []);
    const spread = def.panSpread ?? 0;
    if (spread > 0) {
      for (const pos of [-1, -0.5, 0, 0.5, 1]) {
        const g = ctx.createGain();
        const pan = ctx.createStereoPanner();
        pan.pan.value = pos * spread;
        g.connect(pan).connect(this.chain.input);
        this.panBuses.push(g);
      }
    }
  }

  private get def() {
    return this.patch.samples!;
  }

  private destination(pitch: number): AudioNode {
    if (!this.panBuses.length) return this.chain.input;
    return this.panBuses[Math.round((clamp((pitch - 64) / 30, -1, 1) + 1) * 2)];
  }

  private releaseTime(): number {
    return this.params.release !== undefined ? mapControl.release(this.params.release) : this.def.release;
  }

  private start(pitch: number, velocity: number, time: number, art: string): Voice | null {
    const z = this.map.find(pitch, velocity, art);
    const buffer = z && sampleLibrary.buffer(z.f);
    if (!z || !buffer) return null;
    const t = Math.max(time, this.ctx.currentTime);
    const key = String(pitch);
    if (this.def.retrigger !== 'overlap') for (const v of this.voices) if (v.key === key && v.end > t) this.fade(v, t, 0.02);
    const alive = this.voices.filter((v) => v.end > t);
    if (alive.length >= (this.def.maxVoices ?? 40)) this.fade(alive.sort((a, b) => a.start - b.start)[0], t, 0.015);
    const rate = Math.pow(2, (pitch - (z.k ?? pitch)) / 12);
    return this.startVoice(buffer, key, zoneGain(velocity, z, this.sensitivity), rate, t, this.destination(pitch));
  }

  private release(v: Voice, time: number): void {
    const t = Math.max(time, v.start + 0.004);
    const r = this.releaseTime();
    v.vca.gain.cancelScheduledValues(t);
    v.vca.gain.setTargetAtTime(0, t, r / 4);
    try {
      v.src.stop(t + r * 1.6 + 0.02);
    } catch {
      /* ended on its own */
    }
    v.end = t + r * 1.6;
  }

  play(pitch: number, velocity: number, time: number, duration: number): void {
    if (!this.loaded) {
      this.useFallback().play(pitch, velocity, time, duration);
      return;
    }
    const art = this.def.shortBelow !== undefined ? (duration < this.def.shortBelow ? 'short' : 'long') : '';
    const v = this.start(pitch, velocity, time, art);
    if (v) this.release(v, time + Math.max(0.02, duration));
  }

  noteOn(pitch: number, velocity: number, time: number): VoiceHandle | null {
    if (!this.loaded) return this.useFallback().noteOn(pitch, velocity, time);
    const v = this.start(pitch, velocity, time, this.def.shortBelow !== undefined ? 'long' : '');
    if (!v) return null;
    return { release: (t: number) => v.end === Infinity && this.release(v, Math.max(t, this.ctx.currentTime)) };
  }

  dispose(): void {
    super.dispose();
    this.panBuses.forEach((b) => b.disconnect());
  }
}

// ======================================================================= drum kits

/** Pieces a kit may not have, played from a neighbour (pitched to suit). */
const SUBSTITUTE: Partial<Record<DrumPiece, { from: DrumPiece[]; semis: number }>> = {
  tomM2: { from: ['tomH'], semis: -2 },
  tomM: { from: ['tomH'], semis: -3.5 },
  tomF2: { from: ['tomL'], semis: -2 },
  tomF: { from: ['tomL'], semis: -4 },
  crash2: { from: ['crash'], semis: -1.5 },
  bell: { from: ['ride'], semis: 0 },
  snare2: { from: ['snare'], semis: 0 },
  rim: { from: ['snare'], semis: 3 },
  hatP: { from: ['hatC'], semis: -1 },
};

const MONO_PAN: Partial<Record<DrumPiece, number>> = { tamb: 0.45, shaker: -0.45, cowbell: 0.2, clap: 0.05 };

export class SampleKitInstrument extends SampleBase {
  protected sets: string[];
  private pieces = new Map<DrumPiece, ZoneMap>();
  private buses = new Map<DrumPiece, AudioNode>();

  constructor(ctx: BaseAudioContext, patch: PatchDef, makeFallback: () => Instrument) {
    super(ctx, patch, makeFallback);
    this.sets = patch.kitSets ?? [];
    // the first set that has a piece owns it (e.g. the kit's own hats before the extra percussion)
    const zones = new Map<DrumPiece, { set: string; zones: SampleZone[] }>();
    for (const set of this.sets) {
      for (const z of SAMPLE_SETS[set]?.zones ?? []) {
        const piece = z.p as DrumPiece;
        const owned = zones.get(piece) ?? { set, zones: [] };
        if (owned.set !== set) continue;
        owned.zones.push({ ...z, lo: 0, hi: 127 });
        zones.set(piece, owned);
      }
    }
    for (const [piece, { zones: zs }] of zones) this.pieces.set(piece, new ZoneMap(zs));
  }

  private bus(piece: DrumPiece): AudioNode {
    let b = this.buses.get(piece);
    if (!b) {
      const pan = MONO_PAN[piece];
      if (pan === undefined) b = this.chain.input;
      else {
        const p = this.ctx.createStereoPanner();
        p.pan.value = pan;
        p.connect(this.chain.input);
        b = p;
      }
      this.buses.set(piece, b);
    }
    return b;
  }

  private hit(pitch: number, velocity: number, time: number): void {
    const entry = DRUM_BY_NOTE.get(pitch);
    if (!entry) return;
    let piece = entry.piece;
    let semis = 0;
    if (!this.pieces.has(piece)) {
      const sub = SUBSTITUTE[piece];
      const from = sub?.from.find((p) => this.pieces.has(p));
      if (!sub || !from) return;
      piece = from;
      semis = sub.semis;
    }
    const z = this.pieces.get(piece)!.find(60, velocity);
    const buffer = z && sampleLibrary.buffer(z.f);
    if (!z || !buffer) return;
    const t = Math.max(time, this.ctx.currentTime);
    // hi-hat choke group
    if (entry.piece === 'hatC' || entry.piece === 'hatP' || entry.piece === 'hatO') {
      for (const v of this.voices) if (v.key === 'hatO' && v.end > t && v.start < t) this.fade(v, t, 0.012);
    }
    this.startVoice(buffer, entry.piece, zoneGain(velocity, z, this.sensitivity), Math.pow(2, semis / 12), t, this.bus(entry.piece));
  }

  play(pitch: number, velocity: number, time: number, duration: number): void {
    if (!this.loaded) this.useFallback().play(pitch, velocity, time, duration);
    else this.hit(pitch, velocity, time);
  }

  noteOn(pitch: number, velocity: number, time: number): VoiceHandle | null {
    if (!this.loaded) return this.useFallback().noteOn(pitch, velocity, time);
    this.hit(pitch, velocity, time);
    return noop;
  }
}
