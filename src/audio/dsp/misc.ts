import { makeRng } from '../../core/util';
import { Biquad, OnePoleLP } from './filters';

/** Woodblock-style metronome click. Accent = downbeat. */
export function renderClick(sr: number, accent: boolean): Float32Array {
  const len = Math.floor(0.09 * sr);
  const out = new Float32Array(len);
  const f = accent ? 1760 : 1320;
  const rng = makeRng(accent ? 7 : 9);
  const bp = new Biquad('bandpass', f * 1.9, 4, sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.exp(-t / 0.018) * Math.min(1, t / 0.0004);
    out[i] = (Math.sin(2 * Math.PI * f * t) * 0.7 + bp.process(rng() * 2 - 1) * 0.6) * env * (accent ? 0.95 : 0.7);
  }
  return out;
}

export interface ReverbIRParams {
  decay: number; // seconds (RT60-ish)
  preDelay: number; // seconds
  damping: number; // 0 … 1 (1 = dark tail)
  size: number; // 0 … 1 early-reflection spread
}

/**
 * Stereo algorithmic impulse response: sparse early reflections followed by a
 * decorrelated exponentially decaying noise tail whose high end decays faster.
 */
export function renderReverbIR(sr: number, p: ReverbIRParams, seed = 3): [Float32Array, Float32Array] {
  const len = Math.floor((p.preDelay + p.decay * 1.15 + 0.05) * sr);
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  const rng = makeRng(seed);
  const pre = Math.floor(p.preDelay * sr);
  const tau = p.decay / 6.91;
  // early reflections
  const erCount = 14;
  for (let k = 0; k < erCount; k++) {
    const t = pre + Math.floor((0.004 + (k / erCount) * (0.02 + p.size * 0.06) + rng() * 0.004) * sr);
    if (t >= len) continue;
    const g = (0.55 * (1 - k / erCount) + 0.15) * (rng() < 0.5 ? -1 : 1);
    if (k % 2 === 0) left[t] += g;
    else right[t] += g;
    const t2 = Math.min(len - 1, t + Math.floor(rng() * 0.003 * sr));
    if (k % 2 === 0) right[t2] += g * 0.6;
    else left[t2] += g * 0.6;
  }
  // diffuse tail with progressive darkening
  const lpL = new OnePoleLP(12000, sr);
  const lpR = new OnePoleLP(12000, sr);
  const tailStart = pre + Math.floor(0.012 * sr);
  const fadeIn = Math.floor((0.02 + p.size * 0.04) * sr);
  for (let i = tailStart; i < len; i++) {
    const t = (i - tailStart) / sr;
    const env = Math.exp(-t / tau) * Math.min(1, (i - tailStart) / fadeIn);
    const cutoff = 12000 * Math.exp(-t * (0.5 + p.damping * 4.5)) + 600;
    if ((i & 63) === 0) {
      lpL.setFreq(cutoff, sr);
      lpR.setFreq(cutoff, sr);
    }
    left[i] += lpL.process(rng() * 2 - 1) * env * 0.5;
    right[i] += lpR.process(rng() * 2 - 1) * env * 0.5;
  }
  // energy-normalise so different decays sit at a similar loudness
  let e = 0;
  for (let i = 0; i < len; i++) e += left[i] * left[i] + right[i] * right[i];
  const g = 1 / Math.sqrt(e / 2 + 1e-9) * 0.6;
  for (let i = 0; i < len; i++) {
    left[i] *= g;
    right[i] *= g;
  }
  const fade = Math.floor(0.05 * sr);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    left[len - 1 - i] *= k;
    right[len - 1 - i] *= k;
  }
  return [left, right];
}

/** Two seconds of vinyl crackle + hiss for the Lo-Fi insert (loops seamlessly enough). */
export function renderVinylNoise(sr: number, seconds = 2.5): Float32Array {
  const len = Math.floor(seconds * sr);
  const out = new Float32Array(len);
  const rng = makeRng(4242);
  const hiss = new Biquad('bandpass', 3500, 0.5, sr);
  const crackleBp = new Biquad('highpass', 1200, 0.7, sr);
  for (let i = 0; i < len; i++) {
    let v = hiss.process(rng() * 2 - 1) * 0.04;
    if (rng() < 0.0009) v += (rng() * 2 - 1) * 0.9;
    if (rng() < 0.00008) v += (rng() < 0.5 ? -1 : 1) * 1.4;
    out[i] = crackleBp.process(v);
  }
  return out;
}
