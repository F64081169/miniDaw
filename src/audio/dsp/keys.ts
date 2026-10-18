// Keyboard instrument renderers: additive acoustic piano, FM electric pianos and a mallet model.

import { makeRng, mtof } from '../../core/util';
import { Biquad, DCBlocker, normalize, trimSilence } from './filters';

export interface PianoModel {
  duration: number; // seconds at the bottom of the keyboard (shorter in the treble)
  brightness: number; // 0 … 1
  hammer: number; // 0 … 1 hammer noise amount
  detune: number; // unison detune in cents (string beating)
}

function inharmonicity(midi: number): number {
  if (midi >= 45) return 0.00012 * Math.pow(2, ((midi - 45) / 12) * 0.75);
  return 0.00012 + (45 - midi) * 0.00001;
}

/**
 * Additive piano: inharmonic partials with hammer-position spectrum, frequency-dependent
 * two-stage ("prompt" + "aftersound") decay, unison-string beating and hammer/thump noise.
 */
export function renderPiano(midi: number, sr: number, m: PianoModel, seed = 1): Float32Array {
  const f0 = mtof(midi);
  const rng = makeRng(seed * 31337 + midi * 977);
  const dur = Math.max(1.2, Math.min(m.duration, m.duration * Math.pow(2, -(midi - 40) / 30)));
  const len = Math.floor(dur * sr);
  const out = new Float64Array(len);
  const B = inharmonicity(midi);
  const t60f = 22 * Math.pow(2, -(midi - 21) / 22);
  const r0 = 60 / t60f; // dB/s for the fundamental
  const fc = (1600 + 42 * (midi - 21)) * (0.55 + m.brightness * 0.9);
  const x0 = 1 / 8.3 + (rng() - 0.5) * 0.01; // hammer strike position
  const nyq = Math.min(sr * 0.45, 16000);
  const detune = m.detune * (0.7 + rng() * 0.6);
  const twoPi = 2 * Math.PI;
  let maxA = 0;
  const partialAmp = (n: number, fn: number) => {
    let amp = (0.18 + 0.82 * Math.abs(Math.sin(Math.PI * n * x0))) / Math.pow(n, 0.55);
    amp /= 1 + Math.pow(fn / fc, 2.2);
    amp *= fn / (fn + 70); // weak radiation of the lowest frequencies
    if (n === 1 && midi < 40) amp *= 0.7;
    return amp;
  };
  // Stretch compensation: inharmonic upper partials pull the perceived pitch sharp, so lower the
  // nominal f0 until the energy-weighted "virtual pitch" lands on the target frequency.
  let wSum = 0;
  let sSum = 0;
  for (let n = 1; n <= 16; n++) {
    const fn = n * f0;
    if (fn >= nyq) break;
    const w = partialAmp(n, fn) ** 2;
    wSum += w;
    sSum += w * Math.sqrt(1 + B * n * n);
  }
  const fBase = f0 / (wSum > 0 ? sSum / wSum : 1);
  const partials: { f: number; amp: number; a1: number; a2: number; beat: number; phase: number; bphase: number }[] = [];
  for (let n = 1; n <= 72; n++) {
    const fn = n * fBase * Math.sqrt(1 + B * n * n);
    if (fn >= nyq) break;
    const amp = partialAmp(n, fn);
    const rate = r0 + 9.5 * Math.pow(fn / 1000, 1.15); // dB/s
    const alpha = rate / 8.686; // nepers/s
    const beat = fn * (Math.pow(2, detune / 1200) - 1) * (0.6 + rng() * 0.8);
    partials.push({ f: fn, amp, a1: alpha * 1.7, a2: alpha * 0.42, beat, phase: rng() * twoPi, bphase: rng() * twoPi });
    if (amp > maxA) maxA = amp;
  }
  const w2 = 0.24; // aftersound share
  const floor = maxA * 1.5e-5;
  for (const p of partials) {
    const w = (twoPi * p.f) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let re = Math.cos(p.phase);
    let im = Math.sin(p.phase);
    const bw = (twoPi * p.beat) / sr;
    const cb = Math.cos(bw);
    const sb = Math.sin(bw);
    let bre = Math.cos(p.bphase);
    let bim = Math.sin(p.bphase);
    const k1 = Math.exp(-p.a1 / sr);
    const k2 = Math.exp(-p.a2 / sr);
    let e1 = p.amp * (1 - w2);
    let e2 = p.amp * w2;
    const depth = 0.32;
    for (let i = 0; i < len; i++) {
      const env = e1 + e2;
      if (env < floor) break;
      const beatAmp = 1 - depth + depth * bre;
      out[i] += im * env * beatAmp;
      const nre = re * cw - im * sw;
      im = re * sw + im * cw;
      re = nre;
      const nb = bre * cb - bim * sb;
      bim = bre * sb + bim * cb;
      bre = nb;
      e1 *= k1;
      e2 *= k2;
    }
  }
  // hammer knock + felt noise
  const res = new Float32Array(len);
  for (let i = 0; i < len; i++) res[i] = out[i];
  const hammerLen = Math.min(len, Math.floor(0.08 * sr));
  const thumpLp = new Biquad('lowpass', 220 + midi * 2, 0.9, sr);
  const clickBp = new Biquad('bandpass', 2200 + midi * 25, 0.9, sr);
  const level = maxA * 2.2;
  for (let i = 0; i < hammerLen; i++) {
    const t = i / sr;
    const noise = rng() * 2 - 1;
    res[i] += thumpLp.process(noise) * Math.exp(-t / 0.022) * level * 0.5;
    res[i] += clickBp.process(noise) * Math.exp(-t / 0.004) * level * m.hammer * 0.35;
  }
  const attack = Math.floor(0.0012 * sr);
  for (let i = 0; i < attack; i++) res[i] *= i / attack;
  normalize(res, 0.82);
  return trimSilence(res, sr, 0.00008);
}

export interface EPianoModel {
  variant: 'tine' | 'dx' | 'wurli';
  duration: number;
  bark: number; // 0 … 1 modulation index (growl)
  bell: number; // 0 … 1 tine attack level
}

/** Two-operator-pair FM electric piano with pickup asymmetry (even harmonics). */
export function renderEPiano(midi: number, sr: number, m: EPianoModel, seed = 1): Float32Array {
  const f = mtof(midi);
  const rng = makeRng(seed * 4099 + midi * 131);
  const dur = Math.max(1.4, m.duration * Math.pow(2, -(midi - 48) / 36));
  const len = Math.floor(dur * sr);
  const out = new Float32Array(len);
  const t60 = Math.max(1.1, Math.min(9, 7.5 * Math.pow(2, -(midi - 48) / 22)));
  const ampTau = t60 / 6.91;
  const twoPi = 2 * Math.PI;
  const variant = m.variant;
  // operator ratios
  const bodyRatio = variant === 'wurli' ? 1 : 1;
  const tineRatio = variant === 'dx' ? 14 : variant === 'wurli' ? 3 : 14;
  const tineOk = f * tineRatio < sr * 0.42;
  const detune = Math.pow(2, (rng() * 2 - 1) * 1.5 / 1200);
  const iBody0 = variant === 'wurli' ? 1.6 + m.bark * 2.2 : 0.6 + m.bark * 2.4;
  const iBodySus = variant === 'wurli' ? 0.5 : 0.18;
  const iTine0 = (variant === 'dx' ? 3.2 : 1.6) * m.bell;
  const tineAmp = variant === 'dx' ? 0.42 : variant === 'wurli' ? 0.12 : 0.28;
  const tineTau = variant === 'dx' ? 0.35 : 0.18;
  let pc = rng() * twoPi;
  let pm = 0;
  let pc2 = rng() * twoPi;
  let pm2 = 0;
  const dc = new DCBlocker(sr, 10);
  const wc = (twoPi * f) / sr;
  const wm = (twoPi * f * bodyRatio * detune) / sr;
  const wc2 = (twoPi * f) / sr;
  const wm2 = (twoPi * f * tineRatio) / sr;
  // register-scaled modulation decay: lower notes growl longer
  const modTau = 0.25 + Math.max(0, (72 - midi) / 72) * 0.5;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.exp(-t / ampTau) * (1 - Math.exp(-t / 0.0015));
    const iBody = iBodySus + (iBody0 - iBodySus) * Math.exp(-t / modTau);
    const body = Math.sin(pc + iBody * Math.sin(pm));
    let tine = 0;
    if (tineOk) {
      const iT = iTine0 * Math.exp(-t / 0.035);
      tine = Math.sin(pc2 + iT * Math.sin(pm2)) * Math.exp(-t / tineTau);
    }
    let x = body * (1 - tineAmp * 0.5) + tine * tineAmp;
    // pickup non-linearity: adds the characteristic even-harmonic "bark"
    x = x + (variant === 'wurli' ? 0.32 : 0.18) * x * x;
    out[i] = dc.process(x * env);
    pc += wc;
    pm += wm;
    pc2 += wc2;
    pm2 += wm2;
    if (pc > twoPi) pc -= twoPi;
    if (pm > twoPi) pm -= twoPi;
    if (pc2 > twoPi) pc2 -= twoPi;
    if (pm2 > twoPi) pm2 -= twoPi;
  }
  // soft key-down thunk
  const thunk = Math.floor(0.03 * sr);
  const lp = new Biquad('lowpass', 400, 0.7, sr);
  for (let i = 0; i < thunk; i++) out[i] += lp.process(rng() * 2 - 1) * Math.exp(-i / (0.006 * sr)) * 0.08;
  const attack = Math.floor(0.001 * sr);
  for (let i = 0; i < attack; i++) out[i] *= i / attack;
  normalize(out, 0.8);
  return trimSilence(out, sr);
}

export interface MalletModel {
  duration: number;
  ratios: number[]; // inharmonic mode ratios
  gains: number[];
  decay: number; // base T60 seconds
  hardness: number; // 0 … 1
}

/** Modal bar model (vibraphone / marimba / bells). */
export function renderMallet(midi: number, sr: number, m: MalletModel, seed = 1): Float32Array {
  const f = mtof(midi);
  const rng = makeRng(seed * 211 + midi * 17);
  const len = Math.floor(Math.max(0.8, m.duration * Math.pow(2, -(midi - 60) / 24)) * sr);
  const out = new Float32Array(len);
  const twoPi = 2 * Math.PI;
  m.ratios.forEach((ratio, k) => {
    const fk = f * ratio;
    if (fk > sr * 0.45) return;
    const t60 = (m.decay * Math.pow(2, -(midi - 60) / 30)) / (1 + k * 1.6);
    const kd = Math.exp(-6.91 / (t60 * sr));
    const w = (twoPi * fk) / sr;
    let ph = rng() * twoPi;
    let env = m.gains[k] * (k === 0 ? 1 : m.hardness);
    for (let i = 0; i < len; i++) {
      out[i] += Math.sin(ph) * env;
      ph += w;
      env *= kd;
      if (env < 1e-6) break;
    }
  });
  const click = Math.floor(0.004 * sr);
  for (let i = 0; i < click; i++) out[i] += (rng() * 2 - 1) * Math.exp(-i / (0.0008 * sr)) * 0.15 * m.hardness;
  const attack = Math.floor(0.0008 * sr);
  for (let i = 0; i < attack; i++) out[i] *= i / attack;
  normalize(out, 0.8);
  return trimSilence(out, sr);
}
