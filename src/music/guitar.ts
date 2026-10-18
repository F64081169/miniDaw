// Guitar chord shapes (open + movable barre shapes) and strum rendering, so generated guitar parts
// use real fingerings instead of piano voicings.

import { CHORD_INTERVALS, type Chord, type ChordQuality } from './theory';

export const STANDARD_TUNING = [40, 45, 50, 55, 59, 64];

type Shape = number[]; // fret per string (low E → high e), -1 = muted

const OPEN: Record<string, Shape> = {
  'C:maj': [-1, 3, 2, 0, 1, 0],
  'A:maj': [-1, 0, 2, 2, 2, 0],
  'G:maj': [3, 2, 0, 0, 3, 3],
  'E:maj': [0, 2, 2, 1, 0, 0],
  'D:maj': [-1, -1, 0, 2, 3, 2],
  'A:min': [-1, 0, 2, 2, 1, 0],
  'E:min': [0, 2, 2, 0, 0, 0],
  'D:min': [-1, -1, 0, 2, 3, 1],
  'A:7': [-1, 0, 2, 0, 2, 0],
  'E:7': [0, 2, 0, 1, 0, 0],
  'D:7': [-1, -1, 0, 2, 1, 2],
  'G:7': [3, 2, 0, 0, 0, 1],
  'C:7': [-1, 3, 2, 3, 1, 0],
  'B:7': [-1, 2, 1, 2, 0, 2],
  'A:m7': [-1, 0, 2, 0, 1, 0],
  'E:m7': [0, 2, 0, 0, 0, 0],
  'D:m7': [-1, -1, 0, 2, 1, 1],
  'C:maj7': [-1, 3, 2, 0, 0, 0],
  'F:maj7': [-1, -1, 3, 2, 1, 0],
  'A:maj7': [-1, 0, 2, 1, 2, 0],
  'D:maj7': [-1, -1, 0, 2, 2, 2],
  'G:maj7': [3, 2, 0, 0, 0, 2],
  'A:sus4': [-1, 0, 2, 2, 3, 0],
  'D:sus4': [-1, -1, 0, 2, 3, 3],
  'E:sus4': [0, 2, 2, 2, 0, 0],
  'A:sus2': [-1, 0, 2, 2, 0, 0],
  'D:sus2': [-1, -1, 0, 2, 3, 0],
  'C:add9': [-1, 3, 2, 0, 3, 0],
  'G:add9': [3, 2, 0, 2, 3, 3],
};

const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Reduce extended qualities to something a guitar shape exists for. */
function shapeQuality(q: ChordQuality): 'maj' | 'min' | '7' | 'm7' | 'maj7' | 'sus4' | 'sus2' | '5' | 'm7b5' | 'dim7' | '9' | 'm9' | '6' {
  switch (q) {
    case 'maj':
    case 'add9':
    case 'aug':
      return 'maj';
    case 'min':
    case 'madd9':
    case 'mMaj7':
    case 'm6':
      return q === 'm6' ? 'min' : 'min';
    case '7':
    case '13':
    case '7#9':
    case '7b9':
      return '7';
    case '9':
      return '9';
    case '11':
    case '7sus4':
    case 'sus4':
      return 'sus4';
    case 'sus2':
      return 'sus2';
    case 'm7':
    case 'm11':
      return 'm7';
    case 'm9':
      return 'm9';
    case 'maj7':
    case 'maj9':
      return 'maj7';
    case '5':
      return '5';
    case 'm7b5':
      return 'm7b5';
    case 'dim':
    case 'dim7':
      return 'dim7';
    case '6':
      return '6';
  }
}

const E_SHAPES: Partial<Record<ReturnType<typeof shapeQuality>, number[]>> = {
  maj: [0, 2, 2, 1, 0, 0],
  min: [0, 2, 2, 0, 0, 0],
  '7': [0, 2, 0, 1, 0, 0],
  m7: [0, 2, 0, 0, 0, 0],
  maj7: [0, -99, 1, 1, 0, -99],
  sus4: [0, 2, 2, 2, 0, 0],
  '5': [0, 2, 2, -99, -99, -99],
  '9': [0, 2, 0, 1, 0, 2],
  m9: [0, 2, 0, 0, 0, 2],
  '6': [0, 2, 2, 1, 2, 0],
};

const A_SHAPES: Partial<Record<ReturnType<typeof shapeQuality>, number[]>> = {
  maj: [-99, 0, 2, 2, 2, 0],
  min: [-99, 0, 2, 2, 1, 0],
  '7': [-99, 0, 2, 0, 2, 0],
  m7: [-99, 0, 2, 0, 1, 0],
  maj7: [-99, 0, 2, 1, 2, 0],
  sus4: [-99, 0, 2, 2, 3, 0],
  sus2: [-99, 0, 2, 2, 0, 0],
  '9': [-99, 0, -1, 0, 0, 0],
  m9: [-99, 0, -2, 0, 0, 0],
  m7b5: [-99, 0, 1, 0, 1, -99],
  dim7: [-99, 0, 1, -1, 1, -99],
  '5': [-99, 0, 2, 2, -99, -99],
  '6': [-99, 0, 2, 2, 2, 2],
};

function shapeToNotes(shape: Shape): number[] {
  const out: number[] = [];
  shape.forEach((f, s) => {
    if (f >= 0) out.push(STANDARD_TUNING[s] + f);
  });
  return out;
}

function movable(base: number[], rootFret: number): Shape | null {
  const s = base.map((o) => (o <= -99 ? -1 : rootFret + o));
  if (s.some((f) => f < -1)) return null;
  if (s.some((f, i) => f < 0 && base[i] > -99)) return null;
  return s;
}

export interface GuitarVoicing {
  notes: number[]; // ascending (string order)
  position: number; // lowest fretted position (for smooth movement)
}

/** Pick a playable guitar voicing for a chord, staying close to the previous hand position. */
export function guitarVoicing(chord: Chord, prevPosition: number | null, opts: { power?: boolean; maxFret?: number } = {}): GuitarVoicing {
  const q = opts.power ? '5' : shapeQuality(chord.quality);
  const name = `${PC[chord.root]}:${q}`;
  const cands: { shape: Shape; cost: number }[] = [];
  const maxFret = opts.maxFret ?? 12;
  const open = !opts.power ? OPEN[name] : undefined;
  if (open) cands.push({ shape: open, cost: -1.5 });
  const fretE = (chord.root - 40 + 120) % 12;
  const fretA = (chord.root - 45 + 120) % 12;
  for (const [table, rootFret] of [
    [E_SHAPES, fretE],
    [E_SHAPES, fretE + 12],
    [A_SHAPES, fretA],
    [A_SHAPES, fretA + 12],
  ] as const) {
    const base = table[q] ?? table[q === 'm9' ? 'm7' : q === '9' ? '7' : 'maj'];
    if (!base || rootFret > maxFret) continue;
    const s = movable(base, rootFret);
    if (s) cands.push({ shape: s, cost: rootFret > 0 ? 1 : 0 });
  }
  let best: { shape: Shape; cost: number } | null = null;
  for (const c of cands) {
    const fretted = c.shape.filter((f) => f > 0);
    const pos = fretted.length ? Math.min(...fretted) : 0;
    let cost = c.cost + pos * 0.25;
    if (prevPosition !== null) cost += Math.abs(pos - prevPosition) * 0.45;
    if (!best || cost < best.cost) best = { shape: c.shape, cost };
  }
  if (!best) {
    // fall back: stack chord tones from the root on the A string
    const iv = CHORD_INTERVALS[chord.quality].slice(0, 4);
    let r = 45;
    while (r % 12 !== chord.root) r++;
    return { notes: iv.map((i) => r + i), position: r - 45 };
  }
  const fretted = best.shape.filter((f) => f > 0);
  return { notes: shapeToNotes(best.shape), position: fretted.length ? Math.min(...fretted) : 0 };
}

export interface StrumNote {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

/**
 * Turn a voicing into a strum: downstrokes go low → high, upstrokes high → low (top strings only),
 * with a per-string delay so it sounds like a pick crossing the strings.
 */
export function strum(
  voicing: number[],
  start: number,
  duration: number,
  dir: 'D' | 'U',
  velocity: number,
  bpm: number,
  opts: { spreadMs?: number; strings?: number } = {},
): StrumNote[] {
  const spread = ((opts.spreadMs ?? (dir === 'D' ? 11 : 8)) / 1000) * (bpm / 60);
  let notes = [...voicing];
  if (dir === 'U') notes = notes.slice(-(opts.strings ?? 4)).reverse();
  else if (opts.strings) notes = notes.slice(0, opts.strings);
  return notes.map((pitch, i) => ({
    pitch,
    start: start + i * spread,
    duration: Math.max(0.05, duration - i * spread),
    velocity: Math.max(1, Math.min(127, Math.round(velocity * (1 - i * 0.035)))),
  }));
}
