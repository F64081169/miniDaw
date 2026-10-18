// Plucked-string physical model (extended Karplus–Strong) used for guitars and basses.
// Accurate tuning comes from solving the fractional delay of the loop exactly at f0.

import { makeRng, mtof } from '../../core/util';
import { Biquad, DCBlocker, OnePoleLP, normalize, trimSilence } from './filters';

export interface StringModel {
  duration: number; // seconds rendered
  t60Low: number; // decay time (s) around 82 Hz
  t60High: number; // decay time (s) around 660 Hz
  brightness: number; // 0 … 1 loop-filter brightness (1 = bright, long-ringing highs)
  pickPos: number; // pluck position as fraction of the string from the bridge
  exciteCutoff: number; // Hz, lowpass on the excitation (pick hardness)
  pickupPos?: number; // magnetic pickup position (electric instruments)
  pickNoise?: number; // amount of pick "click"
  polarization?: number; // level of the second (detuned, shorter) polarisation
  body?: 'steel' | 'nylon' | 'electric' | 'bass' | null;
  outputLowpass?: number; // Hz
  thump?: number; // low "finger thump" (basses)
}

function t60For(f0: number, m: StringModel): number {
  const t = (Math.log2(f0) - Math.log2(82)) / (Math.log2(660) - Math.log2(82));
  const tc = Math.max(-0.6, Math.min(1.8, t));
  return Math.exp(Math.log(m.t60Low) + (Math.log(m.t60High) - Math.log(m.t60Low)) * tc);
}

/** Phase delay (in samples) of a first-order allpass with coefficient c at radian frequency w. */
function allpassDelay(c: number, w: number): number {
  const phi = -Math.atan2(Math.sin(w), c + Math.cos(w)) + Math.atan2(c * Math.sin(w), 1 + c * Math.cos(w));
  return -phi / w;
}

function solveAllpass(d: number, w: number): number {
  let lo = -0.999;
  let hi = 0.999;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    // delay decreases as c grows
    if (allpassDelay(mid, w) > d) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** One polarisation of the string. Returns the raw string output. */
function runString(
  f0: number,
  sr: number,
  len: number,
  t60: number,
  brightness: number,
  excitation: Float32Array,
): Float32Array {
  const out = new Float32Array(len);
  const period = sr / f0;
  const w = (2 * Math.PI * f0) / sr;
  // one-pole loop lowpass: y = (1-a)x + a*y1
  const a = 0.02 + (1 - brightness) * 0.72;
  const re = 1 - a * Math.cos(w);
  const im = a * Math.sin(w);
  const mag = (1 - a) / Math.sqrt(re * re + im * im);
  const lfDelay = Math.atan2(im, re) / w;
  const total = period - lfDelay;
  const N = Math.max(2, Math.floor(total - 0.15));
  const d = total - N;
  const c = solveAllpass(d, w);
  const loopGain = Math.pow(10, -3 / (f0 * t60));
  const rho = Math.min(0.99995, loopGain / mag);
  const line = new Float32Array(N);
  let idx = 0;
  let apX1 = 0;
  let apY1 = 0;
  let lf = 0;
  const exLen = excitation.length;
  for (let n = 0; n < len; n++) {
    const v = line[idx];
    const ap = c * v + apX1 - c * apY1;
    apX1 = v;
    apY1 = ap;
    lf = (1 - a) * ap + a * lf;
    const y = (n < exLen ? excitation[n] : 0) + rho * lf;
    line[idx] = y;
    idx++;
    if (idx === N) idx = 0;
    out[n] = y;
  }
  return out;
}

const BODY: Record<string, { f: number; q: number; g: number }[]> = {
  steel: [
    { f: 102, q: 3.2, g: 0.55 },
    { f: 205, q: 4.0, g: 0.4 },
    { f: 395, q: 3.0, g: 0.22 },
    { f: 2900, q: 1.1, g: 0.14 },
  ],
  nylon: [
    { f: 92, q: 2.8, g: 0.55 },
    { f: 190, q: 3.2, g: 0.45 },
    { f: 310, q: 2.2, g: 0.25 },
  ],
  electric: [{ f: 1800, q: 0.9, g: 0.15 }],
  bass: [{ f: 70, q: 1.2, g: 0.25 }],
};

export function renderString(midi: number, sr: number, m: StringModel, seed = 1): Float32Array {
  const f0 = mtof(midi);
  const len = Math.floor(m.duration * sr);
  const rng = makeRng(seed * 7919 + midi * 104729);
  const period = sr / f0;
  const t60 = t60For(f0, m);

  // --- excitation: one period of filtered noise, shaped by pluck position
  const exLen = Math.max(4, Math.round(period));
  const ex = new Float32Array(exLen);
  const lp = new OnePoleLP(Math.min(m.exciteCutoff, sr * 0.45), sr);
  const lp2 = new OnePoleLP(Math.min(m.exciteCutoff * 1.5, sr * 0.45), sr);
  for (let i = 0; i < exLen; i++) ex[i] = lp2.process(lp.process(rng() * 2 - 1));
  // remove DC from the excitation so the string doesn't drift
  let mean = 0;
  for (let i = 0; i < exLen; i++) mean += ex[i];
  mean /= exLen;
  for (let i = 0; i < exLen; i++) ex[i] -= mean;
  const pickDelay = Math.max(1, Math.round(m.pickPos * period));
  const shaped = new Float32Array(exLen);
  for (let i = 0; i < exLen; i++) shaped[i] = ex[i] - (i >= pickDelay ? ex[i - pickDelay] : 0);
  // tiny raised-cosine window on the excitation edges
  const win = Math.min(16, Math.floor(exLen / 4));
  for (let i = 0; i < win; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / win);
    shaped[i] *= g;
    shaped[exLen - 1 - i] *= g;
  }

  // --- two polarisations: main + slightly detuned, faster-decaying one
  const main = runString(f0, sr, len, t60, m.brightness, shaped);
  const polLevel = m.polarization ?? 0.3;
  if (polLevel > 0) {
    const f1 = f0 * Math.pow(2, (0.9 + rng() * 0.8) / 1200);
    const second = runString(f1, sr, len, t60 * 0.55, Math.min(1, m.brightness + 0.05), shaped);
    for (let i = 0; i < len; i++) main[i] = main[i] * (1 - polLevel * 0.5) + second[i] * polLevel;
  }

  let out = main;
  // --- magnetic pickup comb (electric guitars / basses)
  if (m.pickupPos && m.pickupPos > 0) {
    const pd = Math.max(1, Math.round(m.pickupPos * period));
    const comb = new Float32Array(len);
    for (let i = 0; i < len; i++) comb[i] = out[i] - 0.85 * (i >= pd ? out[i - pd] : 0);
    out = comb;
  }

  // --- body resonances (acoustic) / pickup colouring
  if (m.body) {
    const res = BODY[m.body].map((r) => ({ bq: new Biquad('bandpass', r.f, r.q, sr), g: r.g }));
    for (let i = 0; i < len; i++) {
      const x = out[i];
      let y = x * 0.75;
      for (let k = 0; k < res.length; k++) y += res[k].bq.process(x) * res[k].g * 2.2;
      out[i] = y;
    }
  }

  // --- pick click / finger thump transients
  if (m.pickNoise && m.pickNoise > 0) {
    const n = Math.floor(0.006 * sr);
    const hp = new Biquad('highpass', 2500, 0.7, sr);
    for (let i = 0; i < n && i < len; i++) {
      const env = Math.exp(-i / (0.0012 * sr));
      out[i] += hp.process(rng() * 2 - 1) * env * m.pickNoise * 0.6;
    }
  }
  if (m.thump && m.thump > 0) {
    const n = Math.floor(0.05 * sr);
    const lpT = new Biquad('lowpass', 180, 0.8, sr);
    for (let i = 0; i < n && i < len; i++) {
      const env = Math.exp(-i / (0.012 * sr));
      out[i] += lpT.process(rng() * 2 - 1) * env * m.thump;
    }
  }

  if (m.outputLowpass) {
    const olp = new Biquad('lowpass', m.outputLowpass, 0.707, sr);
    olp.run(out);
  }
  const dc = new DCBlocker(sr, 12);
  for (let i = 0; i < len; i++) out[i] = dc.process(out[i]);
  // gentle onset to avoid a click
  const ramp = Math.floor(0.0007 * sr);
  for (let i = 0; i < ramp; i++) out[i] *= i / ramp;
  normalize(out, 0.8);
  return trimSilence(out, sr);
}

// Exposed for tests: estimate of the loop tuning error in cents.
export function stringTuningInfo(midi: number, sr: number, brightness: number): { N: number; c: number } {
  const f0 = mtof(midi);
  const w = (2 * Math.PI * f0) / sr;
  const a = 0.02 + (1 - brightness) * 0.72;
  const lfDelay = Math.atan2(a * Math.sin(w), 1 - a * Math.cos(w)) / w;
  const total = sr / f0 - lfDelay;
  const N = Math.max(2, Math.floor(total - 0.15));
  return { N, c: solveAllpass(total - N, w) };
}
