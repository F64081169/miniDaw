// Per-instrument effect chain (amp sim, tremolo, chorus, rotary, tone, body, room …) driven by Smart Controls.

import { renderReverbIR } from '../dsp/misc';
import type { ChainDef, PatchDef } from './types';

export const mapControl = {
  tone: (v: number) => 500 * Math.pow(40, v),
  room: (v: number) => v * 0.75,
  attack: (v: number) => 0.002 + 3 * v * v * v,
  release: (v: number) => 0.02 + 5 * v * v * v,
  cutoffMul: (v: number) => Math.pow(2, (v - 0.5) * 6),
  qMul: (v: number) => Math.pow(2, (v - 0.5) * 3),
  glide: (v: number) => v * v * 0.3,
  decayMul: (v: number) => Math.pow(2, (v - 0.5) * 4),
  rate: (v: number) => 1 + v * 8,
};

const irCache = new Map<string, AudioBuffer>();

export function getImpulse(sampleRate: number, decay: number, damping: number, preDelay = 0.008, size = 0.4): AudioBuffer {
  const key = `${sampleRate}|${decay.toFixed(2)}|${damping.toFixed(2)}|${preDelay.toFixed(3)}|${size.toFixed(2)}`;
  let buf = irCache.get(key);
  if (!buf) {
    const [l, r] = renderReverbIR(sampleRate, { decay, preDelay, damping, size });
    buf = new AudioBuffer({ length: l.length, sampleRate, numberOfChannels: 2 });
    buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
    irCache.set(key, buf);
  }
  return buf;
}

const curveCache = new Map<string, Float32Array<ArrayBuffer>>();

/** tanh soft-clip curve with a little asymmetry (even harmonics, like a tube stage). */
export function driveCurve(gain: number, asym = 0.12): Float32Array<ArrayBuffer> {
  const key = `${gain.toFixed(2)}|${asym}`;
  let curve = curveCache.get(key);
  if (!curve) {
    const n = 2048;
    curve = new Float32Array(n);
    const norm = Math.tanh(gain);
    const bias = Math.tanh(asym * gain);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = (Math.tanh(gain * x + asym * gain) - bias) / (norm + 1e-6);
    }
    curveCache.set(key, curve);
  }
  return curve;
}

interface Lfo {
  osc: OscillatorNode;
  depth: GainNode;
}

function makeLfo(ctx: BaseAudioContext, rate: number, depth: number, type: OscillatorType = 'sine'): Lfo {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = rate;
  const g = ctx.createGain();
  g.gain.value = depth;
  osc.connect(g);
  osc.start();
  return { osc, depth: g };
}

export class InstrumentChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private ctx: BaseAudioContext;
  private def: ChainDef;
  private nodes: AudioNode[] = [];
  private lfos: Lfo[] = [];
  // controllable stages
  private ampShaper?: WaveShaperNode;
  private ampPost?: GainNode;
  private satShaper?: WaveShaperNode;
  private satPost?: GainNode;
  private tremPan?: StereoPannerNode;
  private tremVca?: GainNode;
  private tremLfo?: Lfo;
  private chorusWet?: GainNode;
  private rotLfos?: { horn: Lfo; hornPan: Lfo; drum: Lfo; drumPan: Lfo };
  private toneFilter: BiquadFilterNode;
  private bodyFilter?: BiquadFilterNode;
  private comp?: DynamicsCompressorNode;
  private compMakeup?: GainNode;
  private widthWet?: GainNode;
  private widthDryPan?: StereoPannerNode;
  private widthWetPan?: StereoPannerNode;
  private roomWet?: GainNode;
  private baseDrive: number;
  private trackLevel: number;

  constructor(ctx: BaseAudioContext, patch: PatchDef) {
    this.ctx = ctx;
    this.def = patch.chain;
    this.baseDrive = patch.chain.amp?.drive ?? 0;
    this.trackLevel = Math.pow(10, patch.level / 20);
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.output.gain.value = this.trackLevel;
    let cur: AudioNode = this.input;
    const chain = (n: AudioNode) => {
      cur.connect(n);
      this.nodes.push(n);
      cur = n;
      return n;
    };
    const d = this.def;

    if (d.amp) {
      const pre = chain(ctx.createGain()) as GainNode;
      pre.gain.value = 0.38;
      if (d.amp.cabinet !== 'none') {
        const hp = chain(ctx.createBiquadFilter()) as BiquadFilterNode;
        hp.type = 'highpass';
        hp.frequency.value = d.amp.cabinet === 'bass' ? 30 : 85;
      }
      this.ampShaper = chain(ctx.createWaveShaper()) as WaveShaperNode;
      this.ampShaper.oversample = '4x';
      if (d.amp.cabinet === 'guitar') {
        const low = chain(ctx.createBiquadFilter()) as BiquadFilterNode;
        low.type = 'peaking';
        low.frequency.value = 115;
        low.Q.value = 0.8;
        low.gain.value = 2;
        const pres = chain(ctx.createBiquadFilter()) as BiquadFilterNode;
        pres.type = 'peaking';
        pres.frequency.value = 1900;
        pres.Q.value = 0.9;
        pres.gain.value = d.amp.presence;
        const lp1 = chain(ctx.createBiquadFilter()) as BiquadFilterNode;
        lp1.type = 'lowpass';
        lp1.frequency.value = 5200;
        lp1.Q.value = 0.9;
        const lp2 = chain(ctx.createBiquadFilter()) as BiquadFilterNode;
        lp2.type = 'lowpass';
        lp2.frequency.value = 7800;
        lp2.Q.value = 0.6;
      } else if (d.amp.cabinet === 'bass') {
        const low = chain(ctx.createBiquadFilter()) as BiquadFilterNode;
        low.type = 'peaking';
        low.frequency.value = 80;
        low.Q.value = 0.8;
        low.gain.value = 2.5;
        const lp = chain(ctx.createBiquadFilter()) as BiquadFilterNode;
        lp.type = 'lowpass';
        lp.frequency.value = 4800;
        lp.Q.value = 0.7;
      }
      this.ampPost = chain(ctx.createGain()) as GainNode;
    }

    if (d.saturate) {
      this.satShaper = chain(ctx.createWaveShaper()) as WaveShaperNode;
      this.satShaper.oversample = '2x';
      this.satPost = chain(ctx.createGain()) as GainNode;
    }

    if (d.tremolo) {
      if (d.tremolo.stereo) {
        this.tremPan = chain(ctx.createStereoPanner()) as StereoPannerNode;
        this.tremLfo = makeLfo(ctx, d.tremolo.rate, 0);
        this.tremLfo.depth.connect(this.tremPan.pan);
      } else {
        this.tremVca = chain(ctx.createGain()) as GainNode;
        this.tremLfo = makeLfo(ctx, d.tremolo.rate, 0);
        this.tremLfo.depth.connect(this.tremVca.gain);
      }
      this.lfos.push(this.tremLfo);
    }

    if (d.chorus) {
      const split = ctx.createGain();
      cur.connect(split);
      const sum = ctx.createGain();
      split.connect(sum); // dry
      const merger = ctx.createChannelMerger(2);
      const wet = ctx.createGain();
      wet.gain.value = 0.3;
      const mk = (delay: number, ch: number, phase: number) => {
        const dl = ctx.createDelay(0.05);
        dl.delayTime.value = delay;
        const lfo = makeLfo(ctx, 0.55 + phase * 0.12, 0.0022);
        lfo.depth.connect(dl.delayTime);
        split.connect(dl);
        dl.connect(merger, 0, ch);
        this.lfos.push(lfo);
        this.nodes.push(dl);
      };
      mk(0.011, 0, 0);
      mk(0.0145, 1, 1);
      merger.connect(wet);
      wet.connect(sum);
      this.chorusWet = wet;
      this.nodes.push(split, sum, merger, wet);
      cur = sum;
    }

    if (d.rotary) {
      const sum = ctx.createGain();
      const hornHp = ctx.createBiquadFilter();
      hornHp.type = 'highpass';
      hornHp.frequency.value = 850;
      const hornDelay = ctx.createDelay(0.02);
      hornDelay.delayTime.value = 0.003;
      const hornPan = ctx.createStereoPanner();
      const drumLp = ctx.createBiquadFilter();
      drumLp.type = 'lowpass';
      drumLp.frequency.value = 850;
      const drumAmp = ctx.createGain();
      const drumPan = ctx.createStereoPanner();
      cur.connect(hornHp);
      hornHp.connect(hornDelay).connect(hornPan).connect(sum);
      cur.connect(drumLp);
      drumLp.connect(drumAmp).connect(drumPan).connect(sum);
      const horn = makeLfo(ctx, 0.8, 0.0007);
      horn.depth.connect(hornDelay.delayTime);
      const hornPanL = makeLfo(ctx, 0.8, 0.65);
      hornPanL.depth.connect(hornPan.pan);
      const drum = makeLfo(ctx, 0.7, 0.22);
      drum.depth.connect(drumAmp.gain);
      const drumPanL = makeLfo(ctx, 0.7, 0.3);
      drumPanL.depth.connect(drumPan.pan);
      this.rotLfos = { horn, hornPan: hornPanL, drum, drumPan: drumPanL };
      this.lfos.push(horn, hornPanL, drum, drumPanL);
      this.nodes.push(sum, hornHp, hornDelay, hornPan, drumLp, drumAmp, drumPan);
      cur = sum;
    }

    if (d.bodyEq) {
      this.bodyFilter = chain(ctx.createBiquadFilter()) as BiquadFilterNode;
      this.bodyFilter.type = 'peaking';
      this.bodyFilter.frequency.value = 210;
      this.bodyFilter.Q.value = 0.9;
    }

    this.toneFilter = chain(ctx.createBiquadFilter()) as BiquadFilterNode;
    this.toneFilter.type = 'lowpass';
    this.toneFilter.Q.value = 0.55;

    if (d.punch) {
      this.comp = chain(ctx.createDynamicsCompressor()) as DynamicsCompressorNode;
      this.comp.attack.value = 0.012;
      this.comp.release.value = 0.12;
      this.comp.knee.value = 6;
      this.compMakeup = chain(ctx.createGain()) as GainNode;
    }

    if (d.width) {
      const sum = ctx.createGain();
      this.widthDryPan = ctx.createStereoPanner();
      this.widthWetPan = ctx.createStereoPanner();
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = 0.014;
      this.widthWet = ctx.createGain();
      cur.connect(this.widthDryPan).connect(sum);
      cur.connect(delay).connect(this.widthWet).connect(this.widthWetPan).connect(sum);
      this.nodes.push(sum, this.widthDryPan, this.widthWetPan, delay, this.widthWet);
      cur = sum;
    }

    if (d.room) {
      const conv = ctx.createConvolver();
      conv.normalize = false;
      conv.buffer = getImpulse(ctx.sampleRate, d.room.decay, d.room.damping);
      this.roomWet = ctx.createGain();
      cur.connect(conv).connect(this.roomWet).connect(this.output);
      this.nodes.push(conv, this.roomWet);
    }
    cur.connect(this.output);
  }

  setParams(params: Record<string, number>): void {
    const t = this.ctx.currentTime;
    const get = (id: string, fallback: number) => (params[id] ?? fallback);
    const smooth = (p: AudioParam, v: number, tau = 0.03) => p.setTargetAtTime(v, t, tau);

    if (this.ampShaper && this.ampPost) {
      // 'drive' control moves the amp around its base drive
      const dv = params.drive !== undefined ? params.drive : this.baseDrive;
      const g = 1 + 30 * dv * dv;
      this.ampShaper.curve = driveCurve(g, 0.08);
      smooth(this.ampPost.gain, 1 / Math.pow(g, 0.4));
    }
    if (this.satShaper && this.satPost) {
      const dv = get('drive', 0.3);
      const g = 1 + dv * 6;
      this.satShaper.curve = driveCurve(g, 0.05);
      smooth(this.satPost.gain, 1 / Math.pow(g, 0.5));
    }
    if (this.tremLfo) {
      const depth = get('tremolo', 0.3);
      smooth(this.tremLfo.osc.frequency, mapControl.rate(get('rate', 0.45)), 0.05);
      if (this.tremPan) smooth(this.tremLfo.depth.gain, depth * 0.85);
      if (this.tremVca) {
        smooth(this.tremVca.gain, 1 - depth * 0.45);
        smooth(this.tremLfo.depth.gain, depth * 0.45);
      }
    }
    if (this.chorusWet) smooth(this.chorusWet.gain, get('chorus', 0.3) * 0.7);
    if (this.rotLfos) {
      const fast = get('rotary', 0.2) >= 0.5;
      const r = this.rotLfos;
      r.horn.osc.frequency.setTargetAtTime(fast ? 6.8 : 0.8, t, fast ? 0.5 : 0.9);
      r.hornPan.osc.frequency.setTargetAtTime(fast ? 6.8 : 0.8, t, fast ? 0.5 : 0.9);
      r.drum.osc.frequency.setTargetAtTime(fast ? 5.9 : 0.7, t, fast ? 1.4 : 2.2);
      r.drumPan.osc.frequency.setTargetAtTime(fast ? 5.9 : 0.7, t, fast ? 1.4 : 2.2);
    }
    if (this.bodyFilter) smooth(this.bodyFilter.gain, (get('body', 0.5) - 0.5) * 12);
    smooth(this.toneFilter.frequency, Math.min(20000, mapControl.tone(get('tone', 1))), 0.04);
    if (this.comp && this.compMakeup) {
      const v = get('punch', 0.4);
      smooth(this.comp.threshold, -8 - v * 22);
      smooth(this.comp.ratio, 1.5 + v * 4.5);
      smooth(this.compMakeup.gain, 1 + v * 0.9);
    }
    if (this.widthWet && this.widthDryPan && this.widthWetPan) {
      const w = get('width', 0.5);
      smooth(this.widthWet.gain, w * 0.75);
      smooth(this.widthDryPan.pan, -w * 0.55);
      smooth(this.widthWetPan.pan, w * 0.75);
    }
    if (this.roomWet) smooth(this.roomWet.gain, mapControl.room(get('room', 0.2)));
  }

  dispose(): void {
    for (const l of this.lfos) {
      try {
        l.osc.stop();
      } catch {
        /* already stopped */
      }
      l.osc.disconnect();
      l.depth.disconnect();
    }
    for (const n of this.nodes) n.disconnect();
    this.input.disconnect();
    this.output.disconnect();
  }
}
