// Small offline DSP toolkit used by the instrument renderers (runs in a worker or on the main thread).

export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'lowshelf' | 'highshelf' | 'notch';

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(kind: BiquadKind, freq: number, q: number, sampleRate: number, gainDb = 0) {
    this.set(kind, freq, q, sampleRate, gainDb);
  }

  set(kind: BiquadKind, freq: number, q: number, sampleRate: number, gainDb = 0): void {
    const f = Math.min(Math.max(freq, 10), sampleRate * 0.49);
    const w0 = (2 * Math.PI * f) / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * Math.max(q, 0.0001));
    const A = Math.pow(10, gainDb / 40);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (kind) {
      case 'lowpass':
        b0 = (1 - cos) / 2;
        b1 = 1 - cos;
        b2 = (1 - cos) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cos) / 2;
        b1 = -(1 + cos);
        b2 = (1 + cos) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1;
        b1 = -2 * cos;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'peaking':
        b0 = 1 + alpha * A;
        b1 = -2 * cos;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cos;
        a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const sa = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
        b0 = A * (A + 1 - (A - 1) * cos + sa);
        b1 = 2 * A * (A - 1 - (A + 1) * cos);
        b2 = A * (A + 1 - (A - 1) * cos - sa);
        a0 = A + 1 + (A - 1) * cos + sa;
        a1 = -2 * (A - 1 + (A + 1) * cos);
        a2 = A + 1 + (A - 1) * cos - sa;
        break;
      }
      case 'highshelf': {
        const sa = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
        b0 = A * (A + 1 + (A - 1) * cos + sa);
        b1 = -2 * A * (A - 1 + (A + 1) * cos);
        b2 = A * (A + 1 + (A - 1) * cos - sa);
        a0 = A + 1 - (A - 1) * cos + sa;
        a1 = 2 * (A - 1 - (A + 1) * cos);
        a2 = A + 1 - (A - 1) * cos - sa;
        break;
      }
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  run(buf: Float32Array, from = 0, to = buf.length): Float32Array {
    for (let i = from; i < to; i++) buf[i] = this.process(buf[i]);
    return buf;
  }

  reset(): void {
    this.z1 = this.z2 = 0;
  }
}

export class OnePoleLP {
  private y = 0;
  private a: number;
  constructor(freq: number, sampleRate: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * freq) / sampleRate);
  }
  setFreq(freq: number, sampleRate: number): void {
    this.a = 1 - Math.exp((-2 * Math.PI * freq) / sampleRate);
  }
  process(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

export class DCBlocker {
  private x1 = 0;
  private y1 = 0;
  private r: number;
  constructor(sampleRate: number, freq = 15) {
    this.r = 1 - (2 * Math.PI * freq) / sampleRate;
  }
  process(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

export function peak(buf: Float32Array): number {
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > m) m = a;
  }
  return m;
}

export function normalize(buf: Float32Array, target = 0.9): Float32Array {
  const p = peak(buf);
  if (p > 0) {
    const g = target / p;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  return buf;
}

export function scale(buf: Float32Array, g: number): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

/** Short fade at the end so truncated renders never click. */
export function fadeOutTail(buf: Float32Array, sampleRate: number, seconds = 0.05): Float32Array {
  const n = Math.min(buf.length, Math.floor(seconds * sampleRate));
  const start = buf.length - n;
  for (let i = 0; i < n; i++) buf[start + i] *= 1 - i / n;
  return buf;
}

/**
 * Trim trailing near-silence to save memory (keeps a short safety tail). Renders that are
 * still ringing at the end get a longer fade so a held note never ends with a click.
 */
export function trimSilence(buf: Float32Array, sampleRate: number, threshold = 0.00012): Float32Array {
  let end = buf.length - 1;
  while (end > 0 && Math.abs(buf[end]) < threshold) end--;
  const keep = Math.min(buf.length, end + Math.floor(0.02 * sampleRate));
  if (keep >= buf.length - 64) return fadeOutTail(buf, sampleRate, 0.3);
  const out = buf.slice(0, Math.max(keep, 64));
  return fadeOutTail(out, sampleRate, 0.01);
}

export const softClip = (x: number): number => Math.tanh(x);
