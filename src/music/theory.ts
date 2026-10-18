import type { ScaleMode } from '../core/types';

export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const SCALES: Record<ScaleMode, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

export const MODE_LABELS: Record<ScaleMode, string> = {
  major: '大調 Major',
  minor: '小調 Minor',
  dorian: '多利安 Dorian',
  mixolydian: '混合利底亞 Mixolydian',
  phrygian: '弗里吉亞 Phrygian',
  lydian: '利底亞 Lydian',
  harmonicMinor: '和聲小調 Harmonic minor',
};

const pcMod = (n: number) => ((n % 12) + 12) % 12;

export function isMinorish(mode: ScaleMode): boolean {
  return mode === 'minor' || mode === 'dorian' || mode === 'phrygian' || mode === 'harmonicMinor';
}

/** Whether a key is conventionally spelled with flats (F major, Bb major, D minor …). */
export function keyPrefersFlats(root: number, mode: ScaleMode): boolean {
  const majorRoot = isMinorish(mode) ? pcMod(root + 3) : root;
  return [5, 10, 3, 8, 1, 6].includes(majorRoot);
}

export function pcName(pc: number, flats = false): string {
  return (flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[pcMod(pc)];
}

export function noteName(midi: number, flats = false): string {
  return pcName(midi, flats) + (Math.floor(midi / 12) - 1);
}

export function keyName(root: number, mode: ScaleMode): string {
  const n = pcName(root, keyPrefersFlats(root, mode));
  if (mode === 'major') return `${n} 大調`;
  if (mode === 'minor') return `${n} 小調`;
  return `${n} ${MODE_LABELS[mode].split(' ').slice(1).join(' ')}`;
}

export function scalePitchClasses(root: number, mode: ScaleMode): number[] {
  return SCALES[mode].map((i) => pcMod(root + i));
}

export function isInScale(pitch: number, root: number, mode: ScaleMode): boolean {
  return SCALES[mode].includes(pcMod(pitch - root));
}

/** All MIDI notes of a scale inside [low, high]. */
export function scaleNotesInRange(root: number, mode: ScaleMode, low: number, high: number): number[] {
  const out: number[] = [];
  for (let p = low; p <= high; p++) if (isInScale(p, root, mode)) out.push(p);
  return out;
}

/** Nearest in-scale pitch (ties resolve downward). */
export function snapToScale(pitch: number, root: number, mode: ScaleMode): number {
  for (let d = 0; d < 7; d++) {
    if (isInScale(pitch - d, root, mode)) return pitch - d;
    if (isInScale(pitch + d, root, mode)) return pitch + d;
  }
  return pitch;
}

// ---------------------------------------------------------------- chords

export type ChordQuality =
  | 'maj'
  | 'min'
  | 'dim'
  | 'aug'
  | 'sus2'
  | 'sus4'
  | '5'
  | '6'
  | 'm6'
  | '7'
  | 'maj7'
  | 'm7'
  | 'mMaj7'
  | 'm7b5'
  | 'dim7'
  | '7sus4'
  | 'add9'
  | 'madd9'
  | '9'
  | 'maj9'
  | 'm9'
  | '11'
  | 'm11'
  | '13'
  | '7#9'
  | '7b9';

export const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '5': [0, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  mMaj7: [0, 3, 7, 11],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  '7sus4': [0, 5, 7, 10],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14],
  '11': [0, 7, 10, 14, 17],
  m11: [0, 3, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 21],
  '7#9': [0, 4, 7, 10, 15],
  '7b9': [0, 4, 7, 10, 13],
};

const QUALITY_SYMBOL: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  '5': '5',
  '6': '6',
  m6: 'm6',
  '7': '7',
  maj7: 'maj7',
  m7: 'm7',
  mMaj7: 'm(maj7)',
  m7b5: 'm7b5',
  dim7: 'dim7',
  '7sus4': '7sus4',
  add9: 'add9',
  madd9: 'm(add9)',
  '9': '9',
  maj9: 'maj9',
  m9: 'm9',
  '11': '11',
  m11: 'm11',
  '13': '13',
  '7#9': '7#9',
  '7b9': '7b9',
};

export interface Chord {
  root: number; // pitch class
  quality: ChordQuality;
  bass: number; // pitch class of the bass note (== root unless slash chord)
  numeral: string; // the source roman numeral
}

export function chordIntervals(c: Chord): number[] {
  return CHORD_INTERVALS[c.quality];
}

export function chordPitchClasses(c: Chord): number[] {
  return CHORD_INTERVALS[c.quality].map((i) => pcMod(c.root + i));
}

export function chordSymbol(c: Chord, flats = false): string {
  const s = pcName(c.root, flats) + QUALITY_SYMBOL[c.quality];
  return c.bass !== c.root ? `${s}/${pcName(c.bass, flats)}` : s;
}

/** Major-scale offsets for roman numerals; accidentals alter these (Nashville / pop analysis style). */
const NUMERAL_OFFSETS: Record<string, number> = { I: 0, II: 2, III: 4, IV: 5, V: 7, VI: 9, VII: 11 };
const NUMERAL_RE = /^([b#♭♯]*)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(.*)$/;

function accidentalShift(acc: string): number {
  let s = 0;
  for (const ch of acc) s += ch === 'b' || ch === '♭' ? -1 : 1;
  return s;
}

function qualityFromSuffix(suffix: string, upper: boolean): ChordQuality {
  const s = suffix.replace(/\s/g, '');
  if (s === '' || s === 'M') return upper ? 'maj' : 'min';
  if (s === 'm') return 'min';
  if (s === '°' || s === 'o' || s === 'dim') return 'dim';
  if (s === '°7' || s === 'o7' || s === 'dim7') return 'dim7';
  if (s === 'ø' || s === 'ø7' || s === 'm7b5') return 'm7b5';
  if (s === '+' || s === 'aug') return 'aug';
  if (s === '5') return '5';
  if (s === 'sus' || s === 'sus4') return 'sus4';
  if (s === 'sus2') return 'sus2';
  if (s === '7sus' || s === '7sus4') return '7sus4';
  if (s === '6') return upper ? '6' : 'm6';
  if (s === 'm6') return 'm6';
  if (s === '7') return upper ? '7' : 'm7';
  if (s === 'm7') return 'm7';
  if (s === 'maj7' || s === 'M7' || s === 'Δ' || s === 'Δ7') return upper ? 'maj7' : 'mMaj7';
  if (s === 'add9' || s === 'add2') return upper ? 'add9' : 'madd9';
  if (s === '9') return upper ? '9' : 'm9';
  if (s === 'm9') return 'm9';
  if (s === 'maj9' || s === 'M9' || s === 'Δ9') return 'maj9';
  if (s === '11') return upper ? '11' : 'm11';
  if (s === 'm11') return 'm11';
  if (s === '13') return '13';
  if (s === '7#9') return '7#9';
  if (s === '7b9') return '7b9';
  throw new Error(`Unknown chord suffix "${suffix}"`);
}

function parseSimpleNumeral(text: string): { offset: number; quality: ChordQuality } {
  const m = NUMERAL_RE.exec(text);
  if (!m) throw new Error(`Cannot parse roman numeral "${text}"`);
  const [, acc, num, suffix] = m;
  const upper = num === num.toUpperCase();
  return {
    offset: NUMERAL_OFFSETS[num.toUpperCase()] + accidentalShift(acc),
    quality: qualityFromSuffix(suffix, upper),
  };
}

/**
 * Parse a roman numeral relative to `keyRoot`.
 * - Degrees are measured against the major scale: in A minor write `i bVI bIII bVII`.
 * - Secondary chords: `V7/V`, `V/vi`.
 * - Slash bass by key scale degree: `I/3`, `V/7`, `IV/1`, `I/b7`.
 */
export function parseNumeral(text: string, keyRoot: number, mode: ScaleMode = 'major'): Chord {
  const raw = text.trim();
  const slash = raw.indexOf('/');
  let main = raw;
  let after = '';
  if (slash >= 0) {
    main = raw.slice(0, slash);
    after = raw.slice(slash + 1);
  }
  const { offset, quality } = parseSimpleNumeral(main);
  let root = pcMod(keyRoot + offset);
  let bass = root;
  if (after) {
    const degree = /^([b#♭♯]*)([1-7])$/.exec(after);
    if (degree) {
      const scale = SCALES[mode];
      bass = pcMod(keyRoot + scale[Number(degree[2]) - 1] + accidentalShift(degree[1]));
    } else {
      // secondary function: chord built on the target degree
      const target = parseSimpleNumeral(after);
      root = pcMod(keyRoot + target.offset + offset);
      bass = root;
    }
  }
  return { root, quality, bass, numeral: raw };
}

export interface ChordEvent {
  start: number; // beats from the progression start
  length: number; // beats
  chord: Chord;
}

/**
 * Parse a progression string: bars separated by "|", chords in a bar split it evenly.
 * Example: "I | V/7 | vi | I/5 || IV | I/3 | ii7 V7 |"
 */
export function parseProgression(text: string, keyRoot: number, mode: ScaleMode, barBeats: number): ChordEvent[] {
  const bars = text
    .split('|')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const out: ChordEvent[] = [];
  bars.forEach((bar, i) => {
    const chords = bar.split(/\s+/).filter(Boolean);
    const len = barBeats / chords.length;
    chords.forEach((c, j) => {
      if (c === '%') {
        const prev = out[out.length - 1];
        if (prev) out.push({ start: i * barBeats + j * len, length: len, chord: prev.chord });
        return;
      }
      out.push({ start: i * barBeats + j * len, length: len, chord: parseNumeral(c, keyRoot, mode) });
    });
  });
  return out;
}

export function progressionBars(text: string): number {
  return text.split('|').filter((b) => b.trim().length > 0).length;
}

/** Chord active at `beat` (progression loops). */
export function chordAt(events: ChordEvent[], beat: number): ChordEvent {
  if (events.length === 0) throw new Error('empty progression');
  const total = events[events.length - 1].start + events[events.length - 1].length;
  const b = ((beat % total) + total) % total;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].start <= b + 1e-9) return events[i];
  return events[0];
}

/** Repeat/trim a progression so it covers `beats` beats starting at 0. */
export function tileProgression(events: ChordEvent[], beats: number): ChordEvent[] {
  if (events.length === 0) return [];
  const total = events[events.length - 1].start + events[events.length - 1].length;
  const out: ChordEvent[] = [];
  for (let off = 0; off < beats - 1e-9; off += total) {
    for (const e of events) {
      const s = off + e.start;
      if (s >= beats - 1e-9) break;
      out.push({ start: s, length: Math.min(e.length, beats - s), chord: e.chord });
    }
  }
  return out;
}

// ---------------------------------------------------------------- voicing

export type VoicingStyle = 'close' | 'open' | 'drop2' | 'rootless' | 'shell' | 'triad' | 'power' | 'spread';

export interface VoicingOptions {
  low: number;
  high: number;
  style?: VoicingStyle;
  prev?: number[] | null;
  center?: number;
  maxNotes?: number;
}

function voicingTones(c: Chord, style: VoicingStyle, maxNotes: number): number[] {
  const iv = CHORD_INTERVALS[c.quality];
  const third = iv.find((i) => i === 3 || i === 4);
  const seventh = iv.find((i) => i === 10 || i === 11 || (i === 9 && c.quality === 'dim7'));
  if (style === 'power') return [0, 7];
  if (style === 'triad') return iv.filter((i) => i < 12).slice(0, 3);
  if (style === 'shell') {
    const t = [0];
    if (third !== undefined) t.push(third);
    if (seventh !== undefined) t.push(seventh);
    else t.push(7);
    return t;
  }
  if (style === 'rootless') {
    // jazz "A/B" voicings: 3-5-7-9 / 7-9-3-5, 13 for dominants
    const out: number[] = [];
    if (third !== undefined) out.push(third);
    if (c.quality === '7' || c.quality === '9' || c.quality === '13') out.push(9);
    else if (iv.includes(6)) out.push(6);
    else out.push(7);
    if (seventh !== undefined) out.push(seventh);
    out.push(iv.includes(13) ? 13 : iv.includes(15) ? 15 : 14);
    return out.map((i) => i % 12);
  }
  // close / open / drop2 / spread: use chord tones, dropping the 5th first when too many
  let tones = iv.map((i) => i % 12);
  tones = Array.from(new Set(tones));
  while (tones.length > maxNotes) {
    const fifth = tones.indexOf(7);
    if (fifth > 0 && tones.length > 3) tones.splice(fifth, 1);
    else tones.splice(tones.length - 1, 1);
  }
  return tones;
}

function voicingCost(v: number[], prev: number[] | null | undefined, center: number): number {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let cost = Math.abs(mean - center) * 0.35;
  // muddy close intervals in the low register
  for (let i = 1; i < v.length; i++) {
    const gap = v[i] - v[i - 1];
    if (v[i - 1] < 52 && gap < 5) cost += (5 - gap) * 1.2;
    if (gap > 9) cost += (gap - 9) * 0.4;
  }
  if (prev && prev.length) {
    // voice-leading distance: each new note to the nearest previous note, and vice versa
    let d = 0;
    for (const n of v) d += Math.min(...prev.map((p) => Math.abs(p - n)));
    for (const p of prev) d += Math.min(...v.map((n) => Math.abs(p - n))) * 0.5;
    cost += d;
    // keep top voice smooth
    cost += Math.abs(v[v.length - 1] - prev[prev.length - 1]) * 0.4;
  }
  return cost;
}

/**
 * Voice a chord inside [low, high] with minimal movement from the previous voicing.
 * Returns ascending MIDI notes.
 */
export function voiceChord(c: Chord, opts: VoicingOptions): number[] {
  const style = opts.style ?? 'close';
  const maxNotes = opts.maxNotes ?? 4;
  const center = opts.center ?? (opts.low + opts.high) / 2;
  const tones = voicingTones(c, style, maxNotes);
  const candidates: number[][] = [];
  for (let inv = 0; inv < tones.length; inv++) {
    const rotated = tones.slice(inv).concat(tones.slice(0, inv));
    for (let base = opts.low - 12; base <= opts.high; base++) {
      if (pcMod(base) !== pcMod(c.root + rotated[0])) continue;
      const v: number[] = [base];
      for (let i = 1; i < rotated.length; i++) {
        let n = v[i - 1] + 1;
        while (pcMod(n) !== pcMod(c.root + rotated[i])) n++;
        v.push(n);
      }
      let voiced = v;
      if (style === 'drop2' && v.length >= 4) {
        const second = v[v.length - 2] - 12;
        voiced = [second, ...v.slice(0, v.length - 2), v[v.length - 1]].sort((a, b) => a - b);
      } else if (style === 'open' && v.length >= 3) {
        voiced = [v[0], ...v.slice(2), v[1] + 12].sort((a, b) => a - b);
      } else if (style === 'spread' && v.length >= 3) {
        voiced = [v[0] - 12, ...v.slice(1)].sort((a, b) => a - b);
      } else if (style === 'power') {
        voiced = [v[0], v[0] + 7, v[0] + 12];
      }
      if (voiced[0] < opts.low || voiced[voiced.length - 1] > opts.high) continue;
      candidates.push(voiced);
    }
  }
  if (candidates.length === 0) {
    // fall back: stack upward from the lowest root in range
    let r = opts.low;
    while (pcMod(r) !== c.root) r++;
    return tones.map((t) => r + t).sort((a, b) => a - b);
  }
  let best = candidates[0];
  let bestCost = Infinity;
  for (const cand of candidates) {
    const cost = voicingCost(cand, opts.prev, center);
    if (cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }
  return best;
}

/** Bass note for a chord in [low, high], staying near the previous bass note. */
export function bassNoteFor(c: Chord, low = 28, high = 48, prev?: number | null): number {
  const target = prev ?? 36;
  let best = low;
  let bestD = Infinity;
  for (let n = low; n <= high; n++) {
    if (pcMod(n) !== c.bass) continue;
    const d = Math.abs(n - target) + (n > 45 ? (n - 45) * 0.6 : 0);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** Nearest pitch with the given pitch class to `near`. */
export function nearestPc(pc: number, near: number): number {
  const base = near - pcMod(near - pc);
  return near - base > 6 ? base + 12 : base;
}
