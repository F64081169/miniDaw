// Synthesised drum kits. Every piece is rendered once per kit into a mono buffer.

import { makeRng } from '../../core/util';
import { Biquad, normalize, trimSilence } from './filters';

export type DrumPiece =
  | 'kick'
  | 'rim'
  | 'snare'
  | 'clap'
  | 'snare2'
  | 'tomF'
  | 'hatC'
  | 'tomF2'
  | 'hatP'
  | 'tomL'
  | 'hatO'
  | 'tomM'
  | 'tomM2'
  | 'crash'
  | 'tomH'
  | 'ride'
  | 'bell'
  | 'tamb'
  | 'cowbell'
  | 'crash2'
  | 'shaker';

export interface DrumMapEntry {
  note: number;
  piece: DrumPiece;
  name: string;
  short: string;
}

/** General MIDI drum map subset (note numbers match GM so MIDI files import/export cleanly). */
export const DRUM_MAP: DrumMapEntry[] = [
  { note: 36, piece: 'kick', name: '大鼓 Kick', short: 'Kick' },
  { note: 37, piece: 'rim', name: '邊擊 Side Stick', short: 'Stick' },
  { note: 38, piece: 'snare', name: '小鼓 Snare', short: 'Snare' },
  { note: 39, piece: 'clap', name: '拍手 Clap', short: 'Clap' },
  { note: 40, piece: 'snare2', name: '小鼓重擊 Rimshot', short: 'Rimshot' },
  { note: 41, piece: 'tomF', name: '落地鼓 Floor Tom', short: 'Floor' },
  { note: 42, piece: 'hatC', name: '閉合鈸 Closed Hat', short: 'HH Cl' },
  { note: 43, piece: 'tomF2', name: '落地鼓 2 Floor Tom 2', short: 'Floor2' },
  { note: 44, piece: 'hatP', name: '踩鈸 Pedal Hat', short: 'HH Ped' },
  { note: 45, piece: 'tomL', name: '低音筒鼓 Low Tom', short: 'Tom L' },
  { note: 46, piece: 'hatO', name: '開鈸 Open Hat', short: 'HH Op' },
  { note: 47, piece: 'tomM', name: '中音筒鼓 Mid Tom', short: 'Tom M' },
  { note: 48, piece: 'tomM2', name: '中高筒鼓 Hi-Mid Tom', short: 'Tom HM' },
  { note: 49, piece: 'crash', name: '碎音鈸 Crash', short: 'Crash' },
  { note: 50, piece: 'tomH', name: '高音筒鼓 High Tom', short: 'Tom H' },
  { note: 51, piece: 'ride', name: '疊音鈸 Ride', short: 'Ride' },
  { note: 53, piece: 'bell', name: '鈸心 Ride Bell', short: 'Bell' },
  { note: 54, piece: 'tamb', name: '鈴鼓 Tambourine', short: 'Tamb' },
  { note: 56, piece: 'cowbell', name: '牛鈴 Cowbell', short: 'Cowbell' },
  { note: 57, piece: 'crash2', name: '碎音鈸 2 Crash 2', short: 'Crash2' },
  { note: 70, piece: 'shaker', name: '沙鈴 Shaker', short: 'Shaker' },
];

export const DRUM_NOTE: Record<DrumPiece, number> = Object.fromEntries(DRUM_MAP.map((d) => [d.piece, d.note])) as Record<
  DrumPiece,
  number
>;

export const DRUM_BY_NOTE = new Map(DRUM_MAP.map((d) => [d.note, d]));

// ------------------------------------------------------------------ building blocks

interface KickP {
  f0: number;
  f1: number;
  pTau: number;
  aTau: number;
  click: number;
  clickHz: number;
  drive: number;
  dur: number;
}
interface SnareP {
  t1: number;
  t2: number;
  toneTau: number;
  toneMix: number;
  noiseTau: number;
  hp: number;
  lp: number;
  noiseMix: number;
  snap: number;
  drive: number;
  dur: number;
  brush?: boolean;
}
interface HatP {
  scale: number;
  metalMix: number;
  bp: number;
  hp: number;
  closed: number;
  pedal: number;
  open: number;
}
interface TomP {
  freqs: Record<'tomF' | 'tomF2' | 'tomL' | 'tomM' | 'tomM2' | 'tomH', number>;
  bend: number;
  tau: number;
  noise: number;
}
interface CymbalP {
  metal: boolean; // square-bank (electronic) instead of sine partials
  crashTau: number;
  rideTau: number;
  bright: number;
}

export interface KitSpec {
  id: string;
  kick: KickP;
  snare: SnareP;
  rimshotBoost: number;
  hat: HatP;
  tom: TomP;
  cymbal: CymbalP;
  clapTail: number;
  cowbell: [number, number];
  post?: { lowpass?: number; bits?: number; drive?: number };
}

const TWO_PI = Math.PI * 2;

function bandlimitedSquare(phase: number, dt: number): number {
  const blep = (t: number) => {
    if (t < dt) {
      t /= dt;
      return t + t - t * t - 1;
    }
    if (t > 1 - dt) {
      t = (t - 1) / dt;
      return t * t + t + t + 1;
    }
    return 0;
  };
  let v = phase < 0.5 ? 1 : -1;
  v += blep(phase);
  v -= blep((phase + 0.5) % 1);
  return v;
}

const METAL_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800];

function metalBank(len: number, sr: number, scale: number, rng: () => number): Float32Array {
  const out = new Float32Array(len);
  const phases = METAL_FREQS.map(() => rng());
  const incs = METAL_FREQS.map((f) => (f * scale) / sr);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let k = 0; k < 6; k++) {
      s += bandlimitedSquare(phases[k], incs[k]);
      phases[k] += incs[k];
      if (phases[k] >= 1) phases[k] -= 1;
    }
    out[i] = s / 6;
  }
  return out;
}

function kick(p: KickP, sr: number, rng: () => number): Float32Array {
  const len = Math.floor(p.dur * sr);
  const out = new Float32Array(len);
  const bp = new Biquad('bandpass', p.clickHz, 0.8, sr);
  let ph = 0;
  const norm = Math.tanh(p.drive);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const f = p.f1 + (p.f0 - p.f1) * Math.exp(-t / p.pTau);
    ph += (TWO_PI * f) / sr;
    const env = Math.exp(-t / p.aTau) * Math.min(1, t / 0.0006);
    const body = Math.sin(ph) * env;
    const click = bp.process(rng() * 2 - 1) * Math.exp(-t / 0.0035) * p.click * 1.6;
    out[i] = Math.tanh(p.drive * (body + click)) / norm;
  }
  return out;
}

function snare(p: SnareP, sr: number, rng: () => number, boost = 0): Float32Array {
  const len = Math.floor(p.dur * sr);
  const out = new Float32Array(len);
  const hp = new Biquad('highpass', p.hp, 0.7, sr);
  const lp = new Biquad('lowpass', p.lp, 0.7, sr);
  const snapHp = new Biquad('highpass', 3200, 0.7, sr);
  const toneMix = Math.min(1, p.toneMix + boost * 0.3);
  const snapAmt = p.snap + boost * 0.5;
  const drive = p.drive + boost;
  const norm = Math.tanh(drive);
  let ph1 = 0;
  let ph2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    ph1 += (TWO_PI * p.t1 * (1 + 0.18 * Math.exp(-t / 0.012))) / sr;
    ph2 += (TWO_PI * p.t2) / sr;
    const tone = (Math.sin(ph1) * 0.65 + Math.sin(ph2) * 0.35) * Math.exp(-t / p.toneTau);
    const nAtk = p.brush ? Math.min(1, t / 0.012) : Math.min(1, t / 0.0005);
    const noise = lp.process(hp.process(rng() * 2 - 1)) * Math.exp(-t / p.noiseTau) * nAtk;
    const snap = snapHp.process(rng() * 2 - 1) * Math.exp(-t / 0.0028);
    out[i] = Math.tanh(drive * (tone * toneMix + noise * p.noiseMix * 1.4 + snap * snapAmt)) / norm;
  }
  return out;
}

function rim(sr: number, rng: () => number): Float32Array {
  const len = Math.floor(0.18 * sr);
  const out = new Float32Array(len);
  const bp = new Biquad('bandpass', 2300, 3, sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    out[i] =
      (Math.sin(TWO_PI * 1650 * t) * 0.45 + bp.process(rng() * 2 - 1) * 1.6) * Math.exp(-t / 0.011) +
      Math.sin(TWO_PI * 460 * t) * Math.exp(-t / 0.022) * 0.45;
  }
  return out;
}

function clap(tail: number, sr: number, rng: () => number): Float32Array {
  const len = Math.floor((0.05 + tail * 5) * sr);
  const out = new Float32Array(len);
  const bp = new Biquad('bandpass', 1150, 1.1, sr);
  const hp = new Biquad('highpass', 600, 0.7, sr);
  const offsets = [0, 0.0105, 0.0205, 0.031];
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let env = 0;
    for (const o of offsets) if (t >= o) env = Math.max(env, Math.exp(-(t - o) / 0.0042));
    if (t >= offsets[3]) env = Math.max(env, 0.75 * Math.exp(-(t - offsets[3]) / tail));
    out[i] = hp.process(bp.process(rng() * 2 - 1)) * env * 2.2;
  }
  return out;
}

function hat(p: HatP, tau: number, dur: number, sr: number, rng: () => number): Float32Array {
  const len = Math.floor(dur * sr);
  const metal = metalBank(len, sr, p.scale, rng);
  const out = new Float32Array(len);
  const bp = new Biquad('bandpass', p.bp, 0.9, sr);
  const hp = new Biquad('highpass', p.hp, 0.7, sr);
  const hp2 = new Biquad('highpass', p.hp, 0.7, sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const src = metal[i] * p.metalMix + (rng() * 2 - 1) * (1 - p.metalMix);
    const env = Math.exp(-t / tau) * Math.min(1, t / 0.0004);
    out[i] = hp2.process(hp.process(bp.process(src))) * env * 3;
  }
  return out;
}

function tom(freq: number, p: TomP, sr: number, rng: () => number): Float32Array {
  const tau = p.tau * (freq < 100 ? 1.35 : 1);
  const len = Math.floor(Math.min(1.6, tau * 5) * sr);
  const out = new Float32Array(len);
  const bp = new Biquad('bandpass', freq * 3.2, 1.2, sr);
  let ph = 0;
  let ph2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const f = freq * (1 + p.bend * Math.exp(-t / 0.06));
    ph += (TWO_PI * f) / sr;
    ph2 += (TWO_PI * f * 1.52) / sr;
    const body = (Math.sin(ph) + Math.sin(ph2) * 0.18 * Math.exp(-t / (tau * 0.4))) * Math.exp(-t / tau);
    const stick = bp.process(rng() * 2 - 1) * Math.exp(-t / 0.008) * p.noise;
    out[i] = Math.tanh(1.3 * (body + stick));
  }
  return out;
}

function cymbal(kind: 'crash' | 'ride' | 'bell', p: CymbalP, sr: number, rng: () => number): Float32Array {
  const dur = kind === 'crash' ? 3.2 : 2.6;
  const len = Math.floor(dur * sr);
  const out = new Float32Array(len);
  const tau = kind === 'crash' ? p.crashTau : p.rideTau * (kind === 'bell' ? 1.3 : 1);
  // inharmonic partial cluster
  const count = kind === 'crash' ? 30 : kind === 'ride' ? 18 : 10;
  const lo = kind === 'bell' ? 620 : kind === 'ride' ? 1700 : 420;
  const hi = kind === 'bell' ? 3600 : kind === 'ride' ? 7500 : 9800;
  const partialMix = kind === 'crash' ? 0.35 : kind === 'ride' ? 0.55 : 0.85;
  const noiseMix = kind === 'crash' ? 0.9 : kind === 'ride' ? 0.4 : 0.15;
  if (p.metal) {
    const metal = metalBank(len, sr, kind === 'bell' ? 2.6 : 3.4, rng);
    for (let i = 0; i < len; i++) out[i] = metal[i] * partialMix;
  } else {
    for (let k = 0; k < count; k++) {
      const f = lo * Math.pow(hi / lo, (k + rng() * 0.7) / count);
      const w = (TWO_PI * f) / sr;
      const amp = (1 / Math.sqrt(k + 1)) * (0.6 + rng() * 0.4) * partialMix;
      const kTau = tau * (0.7 + rng() * 0.6);
      const kd = Math.exp(-1 / (kTau * sr));
      let ph = rng() * TWO_PI;
      let env = amp;
      for (let i = 0; i < len; i++) {
        out[i] += Math.sin(ph) * env;
        ph += w;
        env *= kd;
      }
    }
  }
  const hpN = new Biquad('highpass', kind === 'crash' ? 4200 : 6000, 0.7, sr);
  const hpAll = new Biquad('highpass', kind === 'bell' ? 500 : 350, 0.7, sr);
  const shelf = new Biquad('highshelf', 8000, 0.7, sr, (p.bright - 0.5) * 8);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.exp(-t / tau) * Math.min(1, t / 0.0015);
    const burst = 1 + (kind === 'crash' ? 1.4 : 0.6) * Math.exp(-t / 0.05);
    const noise = hpN.process(rng() * 2 - 1) * noiseMix;
    out[i] = shelf.process(hpAll.process((out[i] * (p.metal ? env : 1) + noise * env) * burst));
  }
  if (!p.metal) {
    // the sine partials already decay on their own; add the stick "ping"
    const pingLen = Math.floor(0.01 * sr);
    const bp = new Biquad('bandpass', kind === 'bell' ? 3000 : 5200, 2, sr);
    for (let i = 0; i < pingLen; i++) out[i] += bp.process(rng() * 2 - 1) * Math.exp(-i / (0.002 * sr)) * 0.5;
  }
  return out;
}

function tambourine(sr: number, rng: () => number): Float32Array {
  const len = Math.floor(0.45 * sr);
  const out = new Float32Array(len);
  const hp = new Biquad('highpass', 6800, 0.7, sr);
  const jingles = [5200, 6150, 7300, 8800, 9900];
  const ph = jingles.map(() => rng() * TWO_PI);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.max(Math.exp(-t / 0.11), t > 0.012 ? 0.7 * Math.exp(-(t - 0.012) / 0.13) : 0) * Math.min(1, t / 0.001);
    let s = 0;
    for (let k = 0; k < jingles.length; k++) {
      ph[k] += (TWO_PI * jingles[k]) / sr;
      s += Math.sin(ph[k]);
    }
    out[i] = (hp.process(rng() * 2 - 1) * 1.2 + s * 0.08) * env;
  }
  return out;
}

function shaker(sr: number, rng: () => number): Float32Array {
  const len = Math.floor(0.2 * sr);
  const out = new Float32Array(len);
  const bp = new Biquad('bandpass', 6500, 0.8, sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.008) * Math.exp(-Math.max(0, t - 0.008) / 0.045);
    out[i] = bp.process(rng() * 2 - 1) * env * 2;
  }
  return out;
}

function cowbell(freqs: [number, number], sr: number): Float32Array {
  const len = Math.floor(0.55 * sr);
  const out = new Float32Array(len);
  const bp = new Biquad('bandpass', 2640, 0.9, sr);
  let p1 = 0;
  let p2 = 0;
  const i1 = freqs[0] / sr;
  const i2 = freqs[1] / sr;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const s = bandlimitedSquare(p1, i1) + bandlimitedSquare(p2, i2);
    p1 = (p1 + i1) % 1;
    p2 = (p2 + i2) % 1;
    const env = 0.55 * Math.exp(-t / 0.012) + 0.45 * Math.exp(-t / 0.11);
    out[i] = bp.process(s) * env * 2.4;
  }
  return out;
}

// ------------------------------------------------------------------ kits

const ACOUSTIC_TOMS: TomP['freqs'] = { tomF: 82, tomF2: 98, tomL: 110, tomM: 131, tomM2: 147, tomH: 175 };

export const KITS: Record<string, KitSpec> = {
  studio: {
    id: 'studio',
    kick: { f0: 112, f1: 52, pTau: 0.034, aTau: 0.22, click: 0.55, clickHz: 3200, drive: 1.7, dur: 0.6 },
    snare: { t1: 182, t2: 330, toneTau: 0.075, toneMix: 0.55, noiseTau: 0.16, hp: 1400, lp: 9500, noiseMix: 0.75, snap: 0.45, drive: 1.6, dur: 0.55 },
    rimshotBoost: 0.9,
    hat: { scale: 1.75, metalMix: 0.35, bp: 10000, hp: 6500, closed: 0.042, pedal: 0.022, open: 0.45 },
    tom: { freqs: ACOUSTIC_TOMS, bend: 0.35, tau: 0.28, noise: 0.35 },
    cymbal: { metal: false, crashTau: 0.95, rideTau: 1.1, bright: 0.55 },
    clapTail: 0.1,
    cowbell: [562, 845],
  },
  rock: {
    id: 'rock',
    kick: { f0: 120, f1: 47, pTau: 0.032, aTau: 0.3, click: 0.75, clickHz: 3600, drive: 2.4, dur: 0.7 },
    snare: { t1: 175, t2: 320, toneTau: 0.095, toneMix: 0.65, noiseTau: 0.2, hp: 1200, lp: 9000, noiseMix: 0.8, snap: 0.6, drive: 2.3, dur: 0.65 },
    rimshotBoost: 1.1,
    hat: { scale: 1.7, metalMix: 0.4, bp: 9500, hp: 6000, closed: 0.05, pedal: 0.025, open: 0.55 },
    tom: { freqs: { tomF: 73, tomF2: 87, tomL: 98, tomM: 117, tomM2: 131, tomH: 156 }, bend: 0.4, tau: 0.34, noise: 0.4 },
    cymbal: { metal: false, crashTau: 1.15, rideTau: 1.2, bright: 0.6 },
    clapTail: 0.1,
    cowbell: [562, 845],
  },
  jazz: {
    id: 'jazz',
    kick: { f0: 98, f1: 63, pTau: 0.04, aTau: 0.19, click: 0.22, clickHz: 2500, drive: 1.2, dur: 0.6 },
    snare: { t1: 212, t2: 360, toneTau: 0.045, toneMix: 0.25, noiseTau: 0.24, hp: 800, lp: 5600, noiseMix: 0.85, snap: 0.08, drive: 1.0, dur: 0.6, brush: true },
    rimshotBoost: 0.4,
    hat: { scale: 1.6, metalMix: 0.3, bp: 8500, hp: 5500, closed: 0.05, pedal: 0.03, open: 0.5 },
    tom: { freqs: { tomF: 98, tomF2: 110, tomL: 131, tomM: 147, tomM2: 165, tomH: 196 }, bend: 0.25, tau: 0.3, noise: 0.25 },
    cymbal: { metal: false, crashTau: 1.1, rideTau: 1.5, bright: 0.45 },
    clapTail: 0.09,
    cowbell: [562, 845],
  },
  tr808: {
    id: 'tr808',
    kick: { f0: 118, f1: 48, pTau: 0.05, aTau: 0.55, click: 0.08, clickHz: 2200, drive: 1.35, dur: 1.6 },
    snare: { t1: 238, t2: 476, toneTau: 0.06, toneMix: 0.7, noiseTau: 0.12, hp: 2000, lp: 12000, noiseMix: 0.55, snap: 0.1, drive: 1.2, dur: 0.5 },
    rimshotBoost: 0.5,
    hat: { scale: 1.55, metalMix: 0.92, bp: 8500, hp: 7000, closed: 0.035, pedal: 0.02, open: 0.3 },
    tom: { freqs: { tomF: 70, tomF2: 82, tomL: 98, tomM: 123, tomM2: 139, tomH: 165 }, bend: 0.15, tau: 0.4, noise: 0.05 },
    cymbal: { metal: true, crashTau: 1.0, rideTau: 0.9, bright: 0.5 },
    clapTail: 0.17,
    cowbell: [540, 800],
  },
  tr909: {
    id: 'tr909',
    kick: { f0: 235, f1: 50, pTau: 0.018, aTau: 0.3, click: 0.75, clickHz: 4500, drive: 2.3, dur: 0.75 },
    snare: { t1: 200, t2: 345, toneTau: 0.05, toneMix: 0.45, noiseTau: 0.18, hp: 1200, lp: 14000, noiseMix: 0.9, snap: 0.3, drive: 1.8, dur: 0.55 },
    rimshotBoost: 0.7,
    hat: { scale: 2.0, metalMix: 0.6, bp: 11000, hp: 7500, closed: 0.05, pedal: 0.025, open: 0.32 },
    tom: { freqs: { tomF: 80, tomF2: 95, tomL: 110, tomM: 135, tomM2: 150, tomH: 180 }, bend: 0.3, tau: 0.3, noise: 0.2 },
    cymbal: { metal: true, crashTau: 1.0, rideTau: 0.95, bright: 0.7 },
    clapTail: 0.13,
    cowbell: [540, 800],
  },
  lofi: {
    id: 'lofi',
    kick: { f0: 105, f1: 50, pTau: 0.04, aTau: 0.24, click: 0.3, clickHz: 2400, drive: 2.0, dur: 0.6 },
    snare: { t1: 190, t2: 330, toneTau: 0.07, toneMix: 0.5, noiseTau: 0.17, hp: 1000, lp: 7000, noiseMix: 0.7, snap: 0.25, drive: 1.8, dur: 0.5 },
    rimshotBoost: 0.6,
    hat: { scale: 1.6, metalMix: 0.3, bp: 8000, hp: 5000, closed: 0.04, pedal: 0.02, open: 0.35 },
    tom: { freqs: ACOUSTIC_TOMS, bend: 0.3, tau: 0.26, noise: 0.25 },
    cymbal: { metal: false, crashTau: 0.8, rideTau: 0.9, bright: 0.25 },
    clapTail: 0.1,
    cowbell: [562, 845],
    post: { lowpass: 5200, bits: 10, drive: 1.6 },
  },
};

export function renderDrumPiece(kitId: string, piece: DrumPiece, sr: number, seed = 1): Float32Array {
  const kit = KITS[kitId] ?? KITS.studio;
  const rng = makeRng(seed * 65537 + DRUM_NOTE[piece] * 7 + kitId.length * 131);
  let buf: Float32Array;
  switch (piece) {
    case 'kick':
      buf = kick(kit.kick, sr, rng);
      break;
    case 'snare':
      buf = snare(kit.snare, sr, rng);
      break;
    case 'snare2':
      buf = snare(kit.snare, sr, rng, kit.rimshotBoost);
      break;
    case 'rim':
      buf = rim(sr, rng);
      break;
    case 'clap':
      buf = clap(kit.clapTail, sr, rng);
      break;
    case 'hatC':
      buf = hat(kit.hat, kit.hat.closed, 0.25, sr, rng);
      break;
    case 'hatP':
      buf = hat({ ...kit.hat, bp: kit.hat.bp * 0.8 }, kit.hat.pedal, 0.15, sr, rng);
      break;
    case 'hatO':
      buf = hat(kit.hat, kit.hat.open, Math.min(1.6, kit.hat.open * 4), sr, rng);
      break;
    case 'tomF':
    case 'tomF2':
    case 'tomL':
    case 'tomM':
    case 'tomM2':
    case 'tomH':
      buf = tom(kit.tom.freqs[piece], kit.tom, sr, rng);
      break;
    case 'crash':
      buf = cymbal('crash', kit.cymbal, sr, rng);
      break;
    case 'crash2':
      buf = cymbal('crash', { ...kit.cymbal, crashTau: kit.cymbal.crashTau * 0.8, bright: kit.cymbal.bright + 0.15 }, sr, rng);
      break;
    case 'ride':
      buf = cymbal('ride', kit.cymbal, sr, rng);
      break;
    case 'bell':
      buf = cymbal('bell', kit.cymbal, sr, rng);
      break;
    case 'tamb':
      buf = tambourine(sr, rng);
      break;
    case 'shaker':
      buf = shaker(sr, rng);
      break;
    case 'cowbell':
      buf = cowbell(kit.cowbell, sr);
      break;
  }
  if (kit.post) {
    const { lowpass, bits, drive } = kit.post;
    const lp = lowpass ? new Biquad('lowpass', lowpass, 0.7, sr) : null;
    const lp2 = lowpass ? new Biquad('lowpass', lowpass * 1.2, 0.6, sr) : null;
    const steps = bits ? Math.pow(2, bits - 1) : 0;
    const d = drive ?? 1;
    const norm = Math.tanh(d);
    for (let i = 0; i < buf.length; i++) {
      let x = buf[i];
      if (lp && lp2) x = lp2.process(lp.process(x));
      x = Math.tanh(x * d) / norm;
      if (steps) x = Math.round(x * steps) / steps;
      buf[i] = x;
    }
  }
  const gain = PIECE_GAIN[piece] ?? 0.8;
  normalize(buf, gain);
  return trimSilence(buf, sr, 0.0001);
}

/** Relative levels so a kit is roughly balanced out of the box. */
const PIECE_GAIN: Partial<Record<DrumPiece, number>> = {
  kick: 0.95,
  snare: 0.85,
  snare2: 0.9,
  clap: 0.75,
  rim: 0.6,
  hatC: 0.42,
  hatP: 0.32,
  hatO: 0.42,
  crash: 0.55,
  crash2: 0.5,
  ride: 0.42,
  bell: 0.45,
  tamb: 0.4,
  shaker: 0.32,
  cowbell: 0.45,
  tomF: 0.8,
  tomF2: 0.8,
  tomL: 0.8,
  tomM: 0.78,
  tomM2: 0.76,
  tomH: 0.74,
};

/** Default stereo placement (drummer's perspective, like most mixes). */
export const PIECE_PAN: Partial<Record<DrumPiece, number>> = {
  hatC: 0.3,
  hatP: 0.3,
  hatO: 0.3,
  tomH: 0.25,
  tomM2: 0.12,
  tomM: 0,
  tomL: -0.12,
  tomF: -0.3,
  tomF2: -0.25,
  crash: 0.35,
  crash2: -0.4,
  ride: -0.35,
  bell: -0.35,
  tamb: 0.45,
  shaker: -0.45,
  cowbell: 0.2,
};
