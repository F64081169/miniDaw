// Bass line generator: genre-specific rhythms that follow the chords (with approach notes,
// octave jumps, walking lines, 808 slides and pop / lo-fi / R&B lines locked to the kick, etc.).

import { bassNoteFor, chordPitchClasses, isInScale, nearestPc, type Chord } from '../theory';
import { chordAtBeat, clipToSection, humanizeNotes, nextChordAfter, rngFor, swingTime, type GenNote, type SectionCtx } from './common';

export type BassStyle =
  | 'rootQuarter'
  | 'root8'
  | 'popSync'
  | 'sustain'
  | 'walking'
  | 'house'
  | 'octave'
  | 'trap808'
  | 'funk'
  | 'reggae'
  | 'bossa'
  | 'country'
  | 'metal'
  | 'synthwave'
  | 'citypop'
  | 'lofi'
  | 'rnb'
  | 'edm';

const LOW = 28;
const HIGH = 50;

function fifthOf(root: number): number {
  return root + 7 > HIGH + 2 ? root - 5 : root + 7;
}

/** A diatonic / chromatic step leading into the next chord's bass note. */
function approach(target: number, ctx: SectionCtx, rng: () => number): number {
  const below = target - 1;
  const above = target + 1;
  const diatonicBelow = isInScale(target - 2, ctx.key.root, ctx.key.mode) ? target - 2 : target - 1;
  const r = rng();
  if (r < 0.4) return diatonicBelow;
  if (r < 0.7) return below;
  return above;
}

interface Hit {
  at: number; // beat within bar
  len: number;
  kind: 'R' | '5' | 'O' | 'A' | 'G' | '3'; // root, fifth, octave, approach, ghost, third
  vel?: number;
}

const BAR_PATTERNS: Partial<Record<BassStyle, { low: Hit[]; mid: Hit[]; high: Hit[] }>> = {
  rootQuarter: {
    low: [{ at: 0, len: 3.9, kind: 'R' }],
    mid: [
      { at: 0, len: 1.9, kind: 'R' },
      { at: 2, len: 1.9, kind: 'R' },
    ],
    high: [
      { at: 0, len: 0.9, kind: 'R' },
      { at: 1, len: 0.9, kind: 'R' },
      { at: 2, len: 0.9, kind: 'R' },
      { at: 3, len: 0.9, kind: 'A' },
    ],
  },
  popSync: {
    low: [
      { at: 0, len: 2.9, kind: 'R' },
      { at: 3, len: 0.9, kind: 'R' },
    ],
    mid: [
      { at: 0, len: 1.4, kind: 'R' },
      { at: 1.5, len: 1.4, kind: 'R' },
      { at: 3, len: 0.9, kind: '5' },
    ],
    high: [
      { at: 0, len: 1.4, kind: 'R' },
      { at: 1.5, len: 0.9, kind: 'R' },
      { at: 2.5, len: 0.45, kind: 'O' },
      { at: 3, len: 0.45, kind: '5' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
  },
  sustain: {
    low: [{ at: 0, len: 3.95, kind: 'R' }],
    mid: [{ at: 0, len: 3.95, kind: 'R' }],
    high: [
      { at: 0, len: 2.9, kind: 'R' },
      { at: 3, len: 0.95, kind: '5' },
    ],
  },
  bossa: {
    low: [{ at: 0, len: 3.9, kind: 'R' }],
    mid: [
      { at: 0, len: 1.45, kind: 'R' },
      { at: 1.5, len: 0.45, kind: '5' },
      { at: 2, len: 1.45, kind: '5' },
      { at: 3.5, len: 0.45, kind: 'R' },
    ],
    high: [
      { at: 0, len: 1.45, kind: 'R' },
      { at: 1.5, len: 0.45, kind: '5' },
      { at: 2, len: 1.45, kind: '5' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
  },
  country: {
    low: [{ at: 0, len: 3.9, kind: 'R' }],
    mid: [
      { at: 0, len: 1.9, kind: 'R' },
      { at: 2, len: 1.9, kind: '5' },
    ],
    high: [
      { at: 0, len: 0.95, kind: 'R' },
      { at: 2, len: 0.95, kind: '5' },
      { at: 3, len: 0.45, kind: '3' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
  },
  reggae: {
    low: [{ at: 0, len: 1.9, kind: 'R' }],
    mid: [
      { at: 0, len: 0.9, kind: 'R' },
      { at: 1.5, len: 0.45, kind: 'R' },
      { at: 2, len: 0.7, kind: '5' },
      { at: 3, len: 0.45, kind: '3' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
    high: [
      { at: 0, len: 0.9, kind: 'R' },
      { at: 1, len: 0.45, kind: 'O' },
      { at: 1.5, len: 0.45, kind: 'R' },
      { at: 2, len: 0.7, kind: '5' },
      { at: 3, len: 0.45, kind: '3' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
  },
  lofi: {
    low: [{ at: 0, len: 3.5, kind: 'R' }],
    mid: [
      { at: 0, len: 1.4, kind: 'R' },
      { at: 1.5, len: 0.45, kind: '5' },
      { at: 2.5, len: 1.4, kind: 'R' },
    ],
    high: [
      { at: 0, len: 1.4, kind: 'R' },
      { at: 1.5, len: 0.45, kind: '5' },
      { at: 2.5, len: 0.9, kind: 'R' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
  },
  rnb: {
    low: [{ at: 0, len: 3.5, kind: 'R' }],
    mid: [
      { at: 0, len: 1.2, kind: 'R' },
      { at: 1.5, len: 0.4, kind: 'O' },
      { at: 2.75, len: 0.7, kind: '5' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
    high: [
      { at: 0, len: 1.2, kind: 'R' },
      { at: 1.25, len: 0.2, kind: 'G' },
      { at: 1.5, len: 0.4, kind: 'O' },
      { at: 2.25, len: 0.45, kind: 'R' },
      { at: 2.75, len: 0.7, kind: '5' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
  },
  citypop: {
    low: [
      { at: 0, len: 1.9, kind: 'R' },
      { at: 2, len: 1.9, kind: 'R' },
    ],
    mid: [
      { at: 0, len: 0.7, kind: 'R' },
      { at: 0.75, len: 0.45, kind: 'O' },
      { at: 1.5, len: 0.45, kind: 'R' },
      { at: 2.5, len: 0.45, kind: 'R' },
      { at: 3, len: 0.2, kind: 'O' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
    high: [
      { at: 0, len: 0.45, kind: 'R' },
      { at: 0.5, len: 0.2, kind: 'O' },
      { at: 0.75, len: 0.45, kind: 'R' },
      { at: 1.5, len: 0.45, kind: '5' },
      { at: 2, len: 0.45, kind: 'R' },
      { at: 2.5, len: 0.2, kind: 'O' },
      { at: 2.75, len: 0.45, kind: 'R' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
  },
  funk: {
    low: [
      { at: 0, len: 0.7, kind: 'R' },
      { at: 2.5, len: 0.45, kind: 'R' },
    ],
    mid: [
      { at: 0, len: 0.45, kind: 'R', vel: 115 },
      { at: 0.75, len: 0.2, kind: 'G' },
      { at: 1, len: 0.2, kind: 'O' },
      { at: 1.75, len: 0.2, kind: 'R' },
      { at: 2.5, len: 0.45, kind: 'R' },
      { at: 3.25, len: 0.2, kind: 'G' },
      { at: 3.5, len: 0.2, kind: 'O' },
    ],
    high: [
      { at: 0, len: 0.45, kind: 'R', vel: 118 },
      { at: 0.5, len: 0.2, kind: 'G' },
      { at: 0.75, len: 0.2, kind: 'R' },
      { at: 1, len: 0.2, kind: 'O' },
      { at: 1.5, len: 0.2, kind: 'G' },
      { at: 1.75, len: 0.2, kind: '5' },
      { at: 2.5, len: 0.45, kind: 'R' },
      { at: 3, len: 0.2, kind: 'O' },
      { at: 3.25, len: 0.2, kind: 'G' },
      { at: 3.5, len: 0.45, kind: 'A' },
    ],
  },
};

function pitchFor(kind: Hit['kind'], root: number, chord: Chord, nextRoot: number | null, ctx: SectionCtx, rng: () => number): number {
  switch (kind) {
    case 'R':
    case 'G':
      return root;
    case 'O':
      return root + 12 <= HIGH + 10 ? root + 12 : root;
    case '5':
      return fifthOf(root);
    case '3': {
      const pcs = chordPitchClasses(chord);
      const third = pcs[1] ?? pcs[0];
      return nearestPc(third, root + 4);
    }
    case 'A':
      return nextRoot !== null ? approach(nextRoot, ctx, rng) : fifthOf(root);
  }
}

function patternBass(style: BassStyle, ctx: SectionCtx, rng: () => number): GenNote[] {
  const table = BAR_PATTERNS[style] ?? BAR_PATTERNS.rootQuarter!;
  const level = ctx.energy < 0.45 ? 'low' : ctx.energy < 0.8 ? 'mid' : 'high';
  const hits = table[level];
  const out: GenNote[] = [];
  let prev: number | null = null;
  const scale = ctx.barBeats / 4;
  for (let bar = 0; bar < ctx.bars; bar++) {
    for (const h of hits) {
      const at = h.at * scale;
      if (at >= ctx.barBeats - 1e-9) continue;
      const beat = bar * ctx.barBeats + at;
      const ev = chordAtBeat(ctx, beat);
      const root = bassNoteFor(ev.chord, LOW, HIGH, prev);
      // approach only makes sense right before a chord change
      const nxt = nextChordAfter(ctx, beat);
      const changeSoon = nxt && nxt.start - beat <= 1.01;
      let kind = h.kind;
      if (kind === 'A' && !changeSoon) kind = rng() < 0.5 ? '5' : 'R';
      const nextRoot = nxt ? bassNoteFor(nxt.chord, LOW, HIGH, root) : null;
      const pitch = pitchFor(kind, root, ev.chord, nextRoot, ctx, rng);
      // don't let a long note ring over the next chord
      const maxLen = ev.start + ev.length - beat;
      const len = Math.min(h.len * scale, Math.max(0.2, maxLen - 0.05));
      out.push({ pitch, start: beat, duration: kind === 'G' ? 0.12 : len, velocity: kind === 'G' ? 46 : h.vel ?? (at === 0 ? 108 : 94) });
      if (kind === 'R') prev = root;
    }
  }
  return out;
}

/** Styles whose bass plays with the kick drum once the song gets going (bass and kick lock). */
const KICK_LOCKED = new Set<BassStyle>(['popSync', 'lofi', 'rnb']);

/**
 * Bass on the kick: a root on every kick (and on every chord change), held until the next one;
 * the note before a chord change leans into it. Ghost-note kicks are left out by the caller.
 */
function kickLocked(style: BassStyle, ctx: SectionCtx, kicks: number[], rng: () => number): GenNote[] {
  const total = ctx.bars * ctx.barBeats;
  const minGap = style === 'popSync' ? 0.5 : 0.25;
  const maxLen = style === 'popSync' ? 1.5 : 2;
  const starts = [...kicks, ...ctx.chords.map((c) => c.start), ...Array.from({ length: ctx.bars }, (_, b) => b * ctx.barBeats)]
    .filter((t) => t >= 0 && t < total - 1e-6)
    .sort((a, b) => a - b);
  const hits: number[] = [];
  for (const t of starts) {
    const last = hits[hits.length - 1];
    if (last === undefined || t - last >= minGap - 1e-6) hits.push(t);
    else if (ctx.chords.some((c) => Math.abs(c.start - t) < 1e-6)) hits[hits.length - 1] = t; // the chord change wins
  }
  const out: GenNote[] = [];
  let prev: number | null = null;
  hits.forEach((at, i) => {
    const ev = chordAtBeat(ctx, at);
    const root = bassNoteFor(ev.chord, LOW, HIGH, prev);
    const next = hits[i + 1] ?? total;
    const nxt = nextChordAfter(ctx, at);
    const leadsIn = !!nxt && Math.abs(nxt.start - next) < 1e-6 && Math.abs(ev.start - at) > 1e-6;
    let pitch = root;
    if (leadsIn && ctx.energy >= 0.8 && rng() < 0.6) pitch = approach(bassNoteFor(nxt.chord, LOW, HIGH, root), ctx, rng);
    else if (leadsIn && rng() < 0.3) pitch = fifthOf(root);
    const len = Math.min(maxLen, next - at - 0.08, ev.start + ev.length - at - 0.05);
    const downbeat = Math.abs(at % ctx.barBeats) < 1e-6;
    out.push({ pitch, start: at, duration: Math.max(0.2, len), velocity: downbeat ? 108 : pitch === root ? 96 : 90 });
    prev = root;
  });
  return out;
}

function root8(ctx: SectionCtx, rng: () => number, octaves: boolean): GenNote[] {
  const out: GenNote[] = [];
  let prev: number | null = null;
  const step = 0.5;
  for (let b = 0; b < ctx.bars * ctx.barBeats - 1e-9; b += step) {
    const ev = chordAtBeat(ctx, b);
    const root = bassNoteFor(ev.chord, LOW, HIGH, prev);
    prev = root;
    const i = Math.round(b / step);
    let pitch = root;
    if (octaves && i % 2 === 1) pitch = root + 12;
    const nxt = nextChordAfter(ctx, b);
    if (!octaves && nxt && Math.abs(nxt.start - (b + step)) < 1e-6 && ctx.energy > 0.5 && rng() < 0.5) {
      pitch = approach(bassNoteFor(nxt.chord, LOW, HIGH, root), ctx, rng);
    }
    const accent = i % 2 === 0;
    out.push({ pitch, start: b, duration: step * (octaves ? 0.6 : 0.85), velocity: accent ? 104 : 88 });
  }
  if (ctx.energy < 0.45) return out.filter((_, i) => i % 2 === 0).map((n) => ({ ...n, duration: 0.95 }));
  return out;
}

function walking(ctx: SectionCtx, rng: () => number): GenNote[] {
  const out: GenNote[] = [];
  let prev: number | null = null;
  const total = ctx.bars * ctx.barBeats;
  for (let b = 0; b < total - 1e-9; b += 1) {
    const ev = chordAtBeat(ctx, b);
    const isChordStart = Math.abs(ev.start - b) < 1e-6;
    const nxt = nextChordAfter(ctx, b);
    const lastBeforeChange = nxt && Math.abs(nxt.start - (b + 1)) < 1e-6;
    const pcs = chordPitchClasses(ev.chord);
    let pitch: number;
    if (isChordStart || prev === null) {
      pitch = bassNoteFor(ev.chord, 31, 48, prev);
    } else if (lastBeforeChange && nxt) {
      const target = bassNoteFor(nxt.chord, 31, 48, prev);
      pitch = rng() < 0.6 ? target + (prev > target ? 1 : -1) : target + (rng() < 0.5 ? 7 - 12 : -1);
    } else {
      // walk through chord tones / scale steps, preferring stepwise motion
      const options: number[] = [];
      for (let d = -4; d <= 4; d++) {
        if (d === 0) continue;
        const p = prev + d;
        if (p < 31 || p > 52) continue;
        const pc = ((p % 12) + 12) % 12;
        if (pcs.includes(pc)) options.push(p, p);
        else if (isInScale(p, ctx.key.root, ctx.key.mode) && Math.abs(d) <= 2) options.push(p);
      }
      pitch = options.length ? options[Math.floor(rng() * options.length)] : prev + 2;
    }
    out.push({ pitch, start: b, duration: 0.92, velocity: Math.abs(b % ctx.barBeats) < 1e-6 ? 100 : 88 });
    prev = pitch;
  }
  return out;
}

function trap808(ctx: SectionCtx, kicks: number[], rng: () => number): GenNote[] {
  const total = ctx.bars * ctx.barBeats;
  const positions = kicks.length ? kicks : Array.from({ length: ctx.bars }, (_, i) => i * ctx.barBeats);
  const out: GenNote[] = [];
  let prev: number | null = null;
  positions.forEach((pos, i) => {
    const ev = chordAtBeat(ctx, pos);
    const root = bassNoteFor(ev.chord, 26, 44, prev);
    const next = positions[i + 1] ?? total;
    let len = Math.max(0.25, next - pos - 0.02);
    let pitch = root;
    // occasional octave jump and slide into the next hit (overlap = glide on the 808 patch)
    if (ctx.energy > 0.6 && rng() < 0.22) pitch = root + 12;
    if (ctx.energy > 0.6 && i < positions.length - 1 && rng() < 0.3) len = next - pos + 0.2;
    out.push({ pitch, start: pos, duration: len, velocity: 110 });
    prev = root;
  });
  return out;
}

function metal(ctx: SectionCtx, kicks: number[]): GenNote[] {
  const out: GenNote[] = [];
  let prev: number | null = null;
  const positions = kicks.length ? kicks : [];
  for (const pos of positions) {
    const ev = chordAtBeat(ctx, pos);
    const root = bassNoteFor(ev.chord, 28, 43, prev);
    prev = root;
    out.push({ pitch: root, start: pos, duration: 0.22, velocity: 108 });
  }
  return out;
}

function house(ctx: SectionCtx, offbeat: boolean): GenNote[] {
  const out: GenNote[] = [];
  let prev: number | null = null;
  for (let b = 0; b < ctx.bars * ctx.barBeats - 1e-9; b += 1) {
    const at = offbeat ? b + 0.5 : b;
    const ev = chordAtBeat(ctx, at);
    const root = bassNoteFor(ev.chord, 33, 50, prev);
    prev = root;
    const oct = ctx.energy > 0.85 && Math.round(b) % 4 === 3;
    out.push({ pitch: oct ? root + 12 : root, start: at, duration: 0.38, velocity: 104 });
  }
  return out;
}

export function generateBass(style: BassStyle, ctx: SectionCtx, kicks: number[] = []): GenNote[] {
  const rng = rngFor(ctx, 2);
  let notes: GenNote[];
  switch (style) {
    case 'root8':
      notes = root8(ctx, rng, false);
      break;
    case 'octave':
      notes = root8(ctx, rng, true);
      break;
    case 'synthwave':
      notes = root8(ctx, rng, ctx.energy > 0.8);
      break;
    case 'walking':
      notes = walking(ctx, rng);
      break;
    case 'trap808':
      notes = trap808(ctx, kicks, rng);
      break;
    case 'metal':
      notes = metal(ctx, kicks);
      break;
    case 'house':
      notes = house(ctx, true);
      break;
    case 'edm':
      notes = ctx.energy > 0.85 ? house(ctx, true) : patternBass('sustain', ctx, rng);
      break;
    default:
      notes = KICK_LOCKED.has(style) && kicks.length && ctx.energy >= 0.45 ? kickLocked(style, ctx, kicks, rng) : patternBass(style, ctx, rng);
  }
  notes = notes.map((n) => ({ ...n, start: swingTime(n.start, ctx.swing, ctx.swingUnit) }));
  notes = humanizeNotes(notes, ctx.humanize * 0.7, rng, style === 'trap808' || style === 'house' || style === 'edm');
  return clipToSection(notes, ctx);
}
