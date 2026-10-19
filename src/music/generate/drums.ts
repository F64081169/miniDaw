// Drum pattern generator: genre grooves at three energy levels, fills, build-ups, crashes and endings.
//
// Acoustic styles play grooves and fills recorded by professional drummers (Groove MIDI Dataset,
// Google Magenta, CC BY 4.0 — see THIRD_PARTY_NOTICES.md), excerpted by
// scripts/grooves/build_grooves.py: their own accents and microtiming, thinned out for quiet
// sections and opened up for big ones. Electronic styles, metal, reggae, bossa nova and odd
// meters use the programmed patterns below.

import { DRUM_NOTE, type DrumPiece } from '../../audio/dsp/drums';
import type { SectionType } from '../../core/types';
import grooveData from '../grooves/gmd.json';
import {
  SECTION_ENERGY,
  VELOCITY,
  clipToSection,
  humanizeNotes,
  patternHits,
  rngFor,
  swingTime,
  type GenNote,
  type SectionCtx,
} from './common';

type Lanes = Partial<Record<DrumPiece, string>>;

export type FillKind = 'tom' | 'snare' | 'trap' | 'jazz' | 'house' | 'metal' | 'none';

export interface DrumStyleDef {
  low: Lanes;
  mid: Lanes;
  high: Lanes;
  breakdown?: Lanes;
  fill: FillKind;
  crash: boolean;
  quantized?: boolean; // electronic styles: never humanize timing
}

export const DRUM_STYLES: Record<string, DrumStyleDef> = {
  pop: {
    low: { kick: 'x.......x.......', rim: '....o.......o...', hatC: 'o.o.o.o.o.o.o.o.' },
    mid: { kick: 'x.....x.x.......', snare: '....x.......x...', hatC: 'x.o.x.o.x.o.x.o.' },
    high: { kick: 'x.....x.x.....x.', snare: '....X.......X...', clap: '....o.......o...', hatC: 'X.x.X.x.X.x.X...', hatO: '..............o.' },
    fill: 'tom',
    crash: true,
  },
  mandopop: {
    low: { kick: 'x.......x.......', hatC: 'o.o.o.o.o.o.o.o.', rim: '....o.......o...' },
    mid: { kick: 'x.......x..x....', snare: '....x.......x...', hatC: 'x.o.x.o.x.o.x.o.' },
    high: { kick: 'x.....x.x..x....', snare: '....X.......X...', hatC: 'X.x.X.x.X.x.X...', hatO: '..............o.' },
    fill: 'tom',
    crash: true,
  },
  rock: {
    low: { kick: 'x.......x.......', rim: '....o.......o...', hatC: 'x.x.x.x.x.x.x.x.' },
    mid: { kick: 'x.......x.x.....', snare: '....X.......X...', hatC: 'x.o.x.o.x.o.x.o.' },
    high: { kick: 'x.....x.x.x.....', snare: '....X.......X...', ride: 'X.x.X.x.X.x.X.x.' },
    fill: 'tom',
    crash: true,
  },
  boombap: {
    low: { kick: 'x.........x.....', hatC: 'x.o.x.o.x.o.x.o.' },
    mid: { kick: 'x......x..x.....', snare: '....X.......X...', hatC: 'x.o.x.o.x.o.x.og' },
    high: { kick: 'x......x..x...x.', snare: '....X.......X..g', hatC: 'x.o.x.o.x.o.x.o.', hatO: '......o.........' },
    fill: 'snare',
    crash: false,
  },
  trap: {
    low: { kick: 'x...............................', hatC: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' },
    mid: {
      kick: 'x......x..x.............x.......',
      clap: '........x...............x.......',
      hatC: 'x.x.x.x.x.x.x.x.x.x.x.x.xrx.x.tt',
    },
    high: {
      kick: 'x......x..x.......x...x.x.......',
      clap: '........X...............X.......',
      snare: '........x..............gx......g',
      hatC: 'x.x.x.xxx.x.x.x.x.x.x.x.x.xxtttR',
      hatO: '..............o.................',
    },
    breakdown: { hatC: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' },
    fill: 'trap',
    crash: true,
    quantized: true,
  },
  house: {
    low: { kick: 'x...x...x...x...', hatO: '..o...o...o...o.' },
    mid: { kick: 'x...x...x...x...', clap: '....x.......x...', hatO: '..x...x...x...x.', shaker: 'g.go.g.og.go.g.o' },
    high: { kick: 'x...x...x...x...', clap: '....X.......X...', hatO: '..x...x...x...x.', hatC: '.g.g.g.g.g.g.g.g', ride: 'o.o.o.o.o.o.o.o.' },
    breakdown: { hatO: '..o...o...o...o.', shaker: 'g.go.g.og.go.g.o' },
    fill: 'house',
    crash: true,
    quantized: true,
  },
  edm: {
    low: { kick: 'x.......x.......', hatC: '..x...x...x...x.' },
    mid: { kick: 'x...x...x...x...', clap: '....x.......x...', hatC: '..x...x...x...x.' },
    high: { kick: 'x...x...x...x...', clap: '....X.......X...', snare: '....x.......x...', hatO: '..x...x...x...x.', hatC: '.o.o.o.o.o.o.o.o' },
    breakdown: { hatC: '..o...o...o...o.' },
    fill: 'house',
    crash: true,
    quantized: true,
  },
  jazz: {
    low: { ride: 'x...x.x.x...x.x.', hatP: '....x.......x...', kick: 'g...............' },
    mid: { ride: 'x...x.x.x...x.x.', hatP: '....x.......x...', kick: 'g...g...g...g...', snare: '..........g...o.' },
    high: { ride: 'X...x.x.X...x.x.', hatP: '....x.......x...', kick: 'g...g...g...g..o', snare: '......o...g...o.' },
    fill: 'jazz',
    crash: false,
  },
  funk: {
    low: { kick: 'x.........x.....', snare: '....x.......x...', hatC: 'x.x.x.x.x.x.x.x.' },
    mid: { kick: 'x.x.......x..x..', snare: '....X..g.g..X...', hatC: 'xoxoxoxoxoxoxoxo' },
    high: { kick: 'x.x...x...x..x..', snare: '....X..g.g..X..g', hatC: 'xoxoxoxoxoxoxo..', hatO: '..............x.' },
    fill: 'snare',
    crash: true,
  },
  bossa: {
    low: { rim: 'x..x..x...x..x....x..x...x..x...', hatC: 'ogogogogogogogog' },
    mid: { kick: 'x..xx..xx..xx..x', rim: 'x..x..x...x..x....x..x...x..x...', hatC: 'ogogogogogogogog' },
    high: { kick: 'x..xx..xx..xx..x', rim: 'x..x..x...x..x....x..x...x..x...', ride: 'x.o.x.o.x.o.x.o.' },
    fill: 'none',
    crash: false,
  },
  reggae: {
    low: { rim: '........x.......', hatC: 'x.x.x.x.x.x.x.x.' },
    mid: { kick: '........x.......', rim: '........X.......', hatC: 'x.x.x.x.x.x.x.x.' },
    high: { kick: 'x...x...x...x...', snare: '........X.......', hatC: 'x.x.x.x.x.x.x.x.', hatO: '..o...o...o...o.' },
    fill: 'tom',
    crash: true,
  },
  lofi: {
    low: { kick: 'x.......x.......', hatC: 'o.o.o.o.o.o.o.o.' },
    mid: { kick: 'x......x..x.....', snare: '....x.......x...', hatC: 'x.ogx.o.x.ogx.o.' },
    high: { kick: 'x......x..x...x.', snare: '....x.......x...', hatC: 'x.ogx.ogx.ogx.o.', hatO: '..............o.' },
    fill: 'none',
    crash: false,
  },
  rnb: {
    low: { kick: 'x.......x.......', rim: '....x.......x...', hatC: 'x.o.x.o.x.o.x.o.' },
    mid: { kick: 'x.....x...x.....', snare: '....x..g....x...', hatC: 'x.xox.o.x.xox.o.' },
    high: { kick: 'x.....x...x..x..', snare: '....X..g....X...', clap: '....o.......o...', hatC: 'x.xox.xox.xox.o.', hatO: '..............o.' },
    fill: 'snare',
    crash: false,
  },
  country: {
    low: { kick: 'x.......x.......', rim: '....x.......x...', hatC: 'x.o.x.o.x.o.x.o.' },
    mid: { kick: 'x.......x.......', snare: '....x.......x...', hatC: 'x.o.x.o.x.o.x.o.', tamb: '....o.......o...' },
    high: { kick: 'x.......x.x.....', snare: '....X.......X...', ride: 'x.o.x.o.x.o.x.o.', tamb: '..o...o...o...o.' },
    fill: 'tom',
    crash: true,
  },
  metal: {
    low: { kick: 'x.......x.......', snare: '....x.......x...', hatC: 'x.x.x.x.x.x.x.x.' },
    mid: { kick: 'x.xxx.xxx.xxx.xx', snare: '....X.......X...', hatC: 'x.x.x.x.x.x.x.x.' },
    high: { kick: 'xxxxxxxxxxxxxxxx', snare: '....X.......X...', crash: 'x...x...x...x...' },
    fill: 'metal',
    crash: true,
  },
  citypop: {
    low: { kick: 'x.......x.......', hatC: 'x.o.x.o.x.o.x.o.' },
    mid: { kick: 'x.....x...x.....', snare: '....x.......x...', hatC: 'xoxoxoxoxoxoxoxo' },
    high: { kick: 'x...x...x...x...', snare: '....X.......X...', hatC: 'xoxoxoxoxoxoxo..', hatO: '..............x.', tamb: '....o.......o...' },
    fill: 'tom',
    crash: true,
  },
  ballad: {
    low: { kick: 'x.......x.......', rim: '....o.......o...', hatC: 'o.o.o.o.o.o.o.o.' },
    mid: { kick: 'x.......x.x.....', snare: '....x.......x...', hatC: 'x.o.x.o.x.o.x.o.' },
    high: { kick: 'x.....x.x.x.....', snare: '....X.......X...', ride: 'x.o.x.o.x.o.x.o.' },
    fill: 'tom',
    crash: true,
  },
  synthwave: {
    low: { kick: 'x...x...x...x...', hatC: 'x.o.x.o.x.o.x.o.' },
    mid: { kick: 'x...x...x...x...', snare: '....X.......X...', hatC: 'x.o.x.o.x.o.x.o.' },
    high: { kick: 'x...x...x...x...', snare: '....X.......X...', clap: '....o.......o...', hatC: 'xoxoxoxoxoxoxoxo' },
    fill: 'tom',
    crash: true,
    quantized: true,
  },
};

const STEP = 0.25;

function laneNotes(lanes: Lanes, ctx: SectionCtx, fromBar: number, toBar: number, velScale = 1): GenNote[] {
  const barSteps = Math.round(ctx.barBeats / STEP);
  const out: GenNote[] = [];
  for (const [piece, pattern] of Object.entries(lanes) as [DrumPiece, string][]) {
    if (!pattern) continue;
    const pitch = DRUM_NOTE[piece];
    const clean = pattern.replace(/\s|\|/g, '');
    const patBars = Math.max(1, Math.round(clean.length / 16));
    for (let bar = fromBar; bar < toBar; bar++) {
      // pick the bar of a multi-bar pattern; truncate / repeat for odd meters
      const sub = clean.slice((bar % patBars) * 16, (bar % patBars) * 16 + 16);
      const hits = patternHits(sub, STEP, barSteps, 1);
      for (const h of hits) {
        const base = bar * ctx.barBeats + h.start;
        const v = Math.round(VELOCITY[h.ch] ?? 96) * velScale;
        const count = h.ch === 'r' ? 2 : h.ch === 't' ? 3 : h.ch === 'R' ? 4 : 1;
        for (let k = 0; k < count; k++) {
          out.push({ pitch, start: base + (k * STEP) / count, duration: STEP / count, velocity: Math.min(127, Math.round(v * (count > 1 ? 0.8 + (0.2 * k) / count : 1))) });
        }
      }
    }
  }
  return out;
}

function fillNotes(kind: FillKind, ctx: SectionCtx, bar: number, energy: number): { notes: GenNote[]; from: number } {
  const b = bar * ctx.barBeats;
  const n = (piece: DrumPiece, beat: number, vel: number, dur = 0.25): GenNote => ({ pitch: DRUM_NOTE[piece], start: b + beat, duration: dur, velocity: vel });
  const last = ctx.barBeats;
  const out: GenNote[] = [];
  const big = energy > 0.6;
  switch (kind) {
    case 'tom': {
      const from = big ? last - 2 : last - 1;
      const seq: DrumPiece[] = big ? ['snare', 'snare', 'tomH', 'tomH', 'tomM', 'tomM', 'tomL', 'tomF'] : ['snare', 'tomH', 'tomM', 'tomF'];
      seq.forEach((p, i) => out.push(n(p, from + i * 0.25, 82 + i * 4)));
      out.push(n('kick', from, 96));
      return { notes: out, from };
    }
    case 'snare': {
      const from = last - 1;
      [0, 0.25, 0.5, 0.75].forEach((o, i) => out.push(n('snare', from + o, 66 + i * 14)));
      out.push(n('kick', from, 90));
      return { notes: out, from };
    }
    case 'house': {
      const from = last - 1;
      [0, 0.25, 0.5, 0.75].forEach((o, i) => out.push(n('snare', from + o, 70 + i * 12)));
      return { notes: out, from };
    }
    case 'trap': {
      const from = last - 2;
      for (let i = 0; i < 12; i++) out.push(n('hatC', from + i / 6, 70 + i * 3, 1 / 6));
      out.push(n('snare', from + 1.5, 90), n('snare', from + 1.75, 104));
      return { notes: out, from };
    }
    case 'jazz': {
      const from = last - 2;
      [0, 0.67, 1.33].forEach((o) => out.push(n('snare', from + o, 74)));
      out.push(n('tomL', from + 1.67, 84), n('kick', from + 1.67, 84), n('snare', from + 1.83, 92));
      out.push(n('ride', from, 80), n('hatP', from + 1, 70));
      return { notes: out, from };
    }
    case 'metal': {
      const from = last - 2;
      const seq: DrumPiece[] = ['snare', 'snare', 'snare', 'snare', 'tomH', 'tomH', 'tomM', 'tomM'];
      seq.forEach((p, i) => out.push(n(p, from + i * 0.25, 100 + (i % 2) * 8)));
      for (let i = 0; i < 8; i++) out.push(n('kick', from + i * 0.25, 100));
      return { notes: out, from };
    }
    case 'none':
      return { notes: [], from: last };
  }
}

/** EDM build-up: snare density doubles every quarter of the section, kick drops out at the end. */
function buildUp(ctx: SectionCtx): GenNote[] {
  const notes: GenNote[] = [];
  const bars = ctx.bars;
  for (let bar = 0; bar < bars; bar++) {
    const phase = bar / bars;
    const div = phase < 0.25 ? 1 : phase < 0.5 ? 0.5 : phase < 0.75 ? 0.25 : 0.125;
    for (let t = 0; t < ctx.barBeats - 1e-9; t += div) {
      const prog = (bar * ctx.barBeats + t) / (bars * ctx.barBeats);
      notes.push({ pitch: DRUM_NOTE.snare, start: bar * ctx.barBeats + t, duration: div, velocity: Math.round(55 + prog * 65) });
    }
    if (bar < bars - 1) for (let t = 0; t < ctx.barBeats; t += 1) notes.push({ pitch: DRUM_NOTE.kick, start: bar * ctx.barBeats + t, duration: 0.25, velocity: 100 });
  }
  return clipToSection(notes, ctx);
}

export function generateDrums(styleId: string, ctx: SectionCtx): GenNote[] {
  if (ctx.section === 'build') return buildUp(ctx);
  return humanDrums(styleId, ctx) ?? programmedDrums(styleId, ctx);
}

function programmedDrums(styleId: string, ctx: SectionCtx): GenNote[] {
  const style = DRUM_STYLES[styleId] ?? DRUM_STYLES.pop;
  const rng = rngFor(ctx, 1);
  const e = ctx.energy;
  let notes: GenNote[] = [];
  const bars = ctx.bars;

  const lanes = ctx.section === 'breakdown' ? style.breakdown ?? { ...style.low, kick: undefined, snare: undefined } : e < 0.45 ? style.low : e < 0.8 ? style.mid : style.high;
  const ending = ctx.isLast && ctx.section === 'outro';
  const fillBar = !ending && ctx.next && bars >= 2 && style.fill !== 'none' && ctx.section !== 'breakdown' ? bars - 1 : -1;
  notes = laneNotes(lanes, ctx, 0, ending ? bars - 1 : bars, ctx.section === 'intro' ? 0.85 : 1);

  if (fillBar >= 0) {
    const fill = fillNotes(style.fill, ctx, fillBar, e);
    const cut = fillBar * ctx.barBeats + fill.from;
    // the fill replaces the groove from its start (cymbal patterns keep going on jazz fills)
    notes = notes.filter((n) => n.start < cut - 1e-6 || (style.fill === 'jazz' && n.pitch === DRUM_NOTE.ride));
    notes.push(...fill.notes);
  }
  if (ending) {
    const b = (bars - 1) * ctx.barBeats;
    notes.push({ pitch: DRUM_NOTE.crash, start: b, duration: 2, velocity: 112 }, { pitch: DRUM_NOTE.kick, start: b, duration: 0.5, velocity: 112 });
  }
  if (style.crash && (e >= 0.85 || (ctx.section === 'verse' && ctx.isFirst === false && rng() < 0.4)) && !ending) {
    notes = notes.filter((n) => !(n.start < 0.01 && (n.pitch === DRUM_NOTE.hatC || n.pitch === DRUM_NOTE.ride)));
    notes.push({ pitch: DRUM_NOTE.crash, start: 0, duration: 1, velocity: e >= 0.85 ? 112 : 92 });
    if (!notes.some((n) => n.pitch === DRUM_NOTE.kick && n.start < 0.01)) notes.push({ pitch: DRUM_NOTE.kick, start: 0, duration: 0.25, velocity: 104 });
  }
  // groove: swing and humanize (electronic styles stay on the grid)
  notes = notes.map((n) => ({ ...n, start: swingTime(n.start, ctx.swing, ctx.swingUnit) }));
  notes = humanizeNotes(notes, style.quantized ? ctx.humanize * 0.3 : ctx.humanize, rng, !!style.quantized);
  return clipToSection(notes, ctx);
}

/**
 * Positions (beats, on the 16th grid) where the kick plays — the 808 / bass generators lock to
 * these; `minVelocity` leaves out ghost notes.
 */
export function kickPositions(styleId: string, ctx: SectionCtx, minVelocity = 0): number[] {
  const at = generateDrums(styleId, { ...ctx, humanize: 0, swing: 0 })
    .filter((n) => n.pitch === DRUM_NOTE.kick && n.velocity >= minVelocity)
    .map((n) => Math.round(n.start * 4) / 4);
  return [...new Set(at)].sort((a, b) => a - b);
}

// ------------------------------------------------------------------ human grooves

type Hit = [number, string, number]; // beat, drum piece, velocity
interface HumanFill {
  from: number; // beat where the fill leaves the groove
  notes: Hit[]; // the whole bar
}
interface HumanGroove {
  src: string;
  bpm: number;
  main: Hit[]; // two bars
  busy: Hit[]; // a busier two bars of the same performance
  fills: HumanFill[];
}

const HUMAN = (grooveData as unknown as { styles: Record<string, { grooves: HumanGroove[] }> }).styles;

type Level = 'low' | 'mid' | 'high' | 'break';

interface HumanFeel {
  /** How quiet sections thin the groove out: cross-stick for the backbeat, no snare, or just softer. */
  low: 'stick' | 'noSnare' | 'soft';
  ride?: boolean; // big sections move from the hi-hat to the ride
  openHat?: boolean; // big sections open the hi-hat at the end of every other bar
  clap?: boolean; // big sections layer a clap on the backbeat
  tamb?: Partial<Record<'mid' | 'high', string>>; // tambourine lane (16 steps)
  high?: string; // big sections play another style's groove (city pop → disco)
  levels?: Partial<Record<SectionType, Level>>; // sections that ignore the energy rule
}

/** Styles played from recorded grooves, and how each arranges them (see the genre notes). */
export const HUMAN_FEEL: Record<string, HumanFeel> = {
  pop: { low: 'stick', openHat: true, clap: true },
  mandopop: { low: 'stick', levels: { pre: 'low' } },
  ballad: { low: 'stick', ride: true },
  rock: { low: 'stick', ride: true },
  country: { low: 'stick', ride: true, tamb: { mid: '....o.......o...', high: '..o...o...o...o.' } },
  boombap: { low: 'noSnare' },
  lofi: { low: 'noSnare' },
  rnb: { low: 'stick', clap: true },
  funk: { low: 'soft' },
  citypop: { low: 'stick', high: 'disco', tamb: { high: '....o.......o...' } },
  jazz: { low: 'soft' },
};

const EDGE = 0.12; // a hit this much early still belongs to the next beat
const CYMBALS = new Set(['hatC', 'hatO', 'ride', 'bell', 'hatP']);
const SNARES = new Set(['snare', 'snare2', 'rim']);
const BIG_NEXT = new Set<SectionType>(['chorus', 'drop', 'solo']);

/** The performance recorded closest to the song's tempo; other versions may play another
 * drummer's take recorded at a nearby tempo. */
function grooveFor(style: string, bpm: number, variation = 0): HumanGroove | null {
  const grooves = HUMAN[style]?.grooves;
  if (!grooves?.length) return null;
  const dist = (g: HumanGroove) => Math.abs(Math.log(g.bpm / bpm));
  const sorted = [...grooves].sort((a, b) => dist(a) - dist(b));
  const near = sorted.filter((g) => dist(g) < 0.2);
  return variation && near.length > 1 ? near[variation % near.length] : sorted[0];
}

/** Hits of one bar (0 or 1) of a two-bar groove, relative to the bar. */
function barOf(hits: Hit[], bar: number, from = 0, to = 4): Hit[] {
  const s = bar * 4;
  return hits.filter(([t]) => t >= s + from - EDGE && t < s + to - EDGE).map(([t, p, v]) => [t - s, p, v]);
}

/** Swing of the groove's off-beats (0 straight … 1 triplet), so it can be moved to the song's. */
function measuredSwing(hits: Hit[], unit: number): number {
  const offs: number[] = [];
  for (const [t] of hits) {
    const pos = (((t % (unit * 2)) + unit * 2) % (unit * 2)) - unit;
    if (pos > -unit * 0.5 && pos < unit * 0.75) offs.push(pos / (unit / 3));
  }
  if (offs.length < 4) return 0;
  offs.sort((a, b) => a - b);
  return Math.max(0, Math.min(1.2, offs[offs.length >> 1]));
}

function thin(hits: Hit[], level: Level, feel: HumanFeel): Hit[] {
  if (level === 'break') return hits.filter(([, p]) => CYMBALS.has(p) || p === 'rim').map(([t, p, v]) => [t, p === 'hatO' ? 'hatC' : p, v * 0.8]);
  if (level !== 'low') return hits;
  const out: Hit[] = [];
  for (const [t, p, v] of hits) {
    if (p === 'tomH' || p === 'tomM' || p === 'tomL' || p === 'crash' || p === 'crash2') continue;
    if (SNARES.has(p)) {
      if (feel.low === 'noSnare') continue;
      if (feel.low === 'stick') {
        if (v >= 60) out.push([t, 'rim', v * 0.85]); // ghost notes drop out
        continue;
      }
    }
    if (p === 'hatO' && feel.low !== 'soft') out.push([t, 'hatC', v * 0.85]);
    else out.push([t, p, v * (p === 'kick' ? 0.9 : 0.85)]);
  }
  return out;
}

/** Big sections: ride instead of hi-hat (eighths, with the hi-hat foot on the backbeat), open hats, claps. */
function openUp(hits: Hit[], bar: number, feel: HumanFeel): Hit[] {
  let out = hits;
  if (feel.ride) {
    out = [];
    for (const [t, p, v] of hits) {
      if (p !== 'hatC' && p !== 'hatO') out.push([t, p, v]);
      else if (Math.abs(t * 2 - Math.round(t * 2)) < 0.24) out.push([t, 'ride', Math.min(127, v * 0.95)]);
    }
    for (const [t, p, v] of hits) if ((p === 'snare' || p === 'snare2') && v >= 70) out.push([t, 'hatP', 58]);
  }
  if (feel.openHat && bar % 2 === 1) {
    const last = out.reduce<number>((best, [t, p], i) => (p === 'hatC' && Math.abs(t - 3.5) < 0.2 ? i : best), -1);
    if (last >= 0) out = out.map((h, i) => (i === last ? [h[0], 'hatO', Math.max(h[2], 84)] : h));
  }
  if (feel.clap) {
    const claps: Hit[] = [];
    for (const [t, p, v] of out) if ((p === 'snare' || p === 'snare2') && v >= 80 && Math.abs(t - Math.round(t)) < 0.15 && Math.round(t) % 2 === 1) claps.push([t + 0.006, 'clap', v * 0.72]);
    out = [...out, ...claps];
  }
  return out;
}

function humanDrums(styleId: string, ctx: SectionCtx): GenNote[] | null {
  const feel = HUMAN_FEEL[styleId];
  if (!feel || ctx.barBeats !== 4 || ctx.timeSig[1] !== 4) return null;
  const groove = grooveFor(styleId, ctx.bpm, ctx.variation);
  if (!groove) return null;
  const style = DRUM_STYLES[styleId];
  const rng = rngFor(ctx, 5);
  const e = ctx.energy;
  const level: Level = feel.levels?.[ctx.section] ?? (ctx.section === 'breakdown' ? 'break' : e < 0.45 ? 'low' : e < 0.8 ? 'mid' : 'high');
  const big = (level === 'high' && feel.high && grooveFor(feel.high, ctx.bpm, ctx.variation)) || groove;
  const source = level === 'high' ? big.busy : groove.main;
  const bars = ctx.bars;
  const ending = ctx.isLast && ctx.section === 'outro';

  // fills: one of the two biggest into a chorus (or the final hit), a short one elsewhere;
  // each kind of section has its own
  const pickFill = (wantBig: boolean, salt = 0): HumanFill | null => {
    const all = big.fills.length ? big.fills : groove.fills;
    if (!all.length) return null;
    const size = (f: HumanFill) => (4 - f.from) * 100 + f.notes.length;
    const pool = wantBig ? [...all].sort((a, b) => size(b) - size(a)).slice(0, 2) : all.filter((f) => f.from >= 2);
    const list = pool.length ? pool : all;
    const f = list[(ctx.seed + salt) % list.length];
    return wantBig ? f : { from: Math.max(2, f.from), notes: f.notes };
  };
  const nextBig = !!ctx.next && (BIG_NEXT.has(ctx.next) || SECTION_ENERGY[ctx.next] >= e + 0.25);
  const fills = new Map<number, HumanFill>();
  if (ending && bars >= 3) {
    const f = pickFill(true);
    if (f) fills.set(bars - 2, f);
  } else if (!ending && ctx.next && bars >= 2 && level !== 'break') {
    const f = pickFill(nextBig);
    if (f) fills.set(bars - 1, f);
  }
  // long sections: a short fill closing each eight-bar phrase inside them
  for (let bar = 7; bar < bars - 1; bar += 8) {
    const f = level !== 'break' && pickFill(false, 1);
    if (f) fills.set(bar, { from: Math.max(3, f.from), notes: f.notes });
  }

  const vel = 0.84 + 0.18 * e;
  const hits: Hit[] = [];
  for (let bar = 0; bar < bars; bar++) {
    if (ending && bar === bars - 1) {
      hits.push([bar * 4, 'crash', 112], [bar * 4, 'kick', 112]);
      continue;
    }
    // the last bar of each four-bar phrase takes the drummer's own variation
    const variation = bar % 4 === 3 && source === groove.main && groove.busy !== groove.main;
    let barHits = thin(variation ? barOf(groove.busy, 1) : barOf(source, bar % 2), level, feel);
    if (level === 'high') barHits = openUp(barHits, bar, feel);
    const fill = fills.get(bar);
    if (fill) {
      // the fill as played (softer in quiet sections, on the ride when the groove is)
      const toRide = level === 'high' && feel.ride;
      const played = barOf(fill.notes, 0, fill.from).map(([t, p, v]): Hit => [t, toRide && (p === 'hatC' || p === 'hatO') ? 'ride' : p, level === 'low' ? v * 0.88 : v]);
      barHits = [...barHits.filter(([t]) => t < fill.from - EDGE), ...played];
    }
    const lane = level === 'high' ? feel.tamb?.high : level === 'mid' ? feel.tamb?.mid : undefined;
    if (lane) for (const h of patternHits(lane, 0.25, 16, 1)) barHits.push([h.start, 'tamb', VELOCITY[h.ch] ?? 74]);
    for (const [t, p, v] of barHits) hits.push([bar * 4 + t, p, v]);
  }

  // crash on the downbeat of big sections (and of every eight bars in them), now and then on
  // the downbeat of the others
  const crashAt = (beat: number, velocity: number) => {
    for (let i = hits.length - 1; i >= 0; i--) {
      const [t, p] = hits[i];
      if (Math.abs(t - beat) < EDGE && (p === 'hatC' || p === 'hatO' || p === 'ride' || p === 'crash')) hits.splice(i, 1);
    }
    hits.push([beat, 'crash', velocity]);
    const kick = hits.find(([t, p]) => p === 'kick' && Math.abs(t - beat) < EDGE);
    if (kick) kick[2] = Math.max(kick[2], 104);
    else hits.push([beat, 'kick', 104]);
  };
  if (style?.crash && level !== 'break') {
    if (level === 'high') for (let bar = 0; bar < bars - (ending ? 1 : 0); bar += 8) crashAt(bar * 4, 112);
    else if (!ctx.isFirst && level === 'mid' && rng() < 0.5) crashAt(0, 94);
  }

  // the groove's swing moves to the song's, keeping each hit's own push and drag
  const unit = ctx.swingUnit;
  const shift = (ctx.swing - measuredSwing(source, unit)) * (unit / 3) * 0.8;
  const notes: GenNote[] = hits.map(([t, p, v]) => {
    const pos = (((t % (unit * 2)) + unit * 2) % (unit * 2)) - unit;
    const off = pos > -unit * 0.5 && pos < unit * 0.75;
    const piece = (p in DRUM_NOTE ? p : 'snare') as DrumPiece;
    return {
      pitch: DRUM_NOTE[piece],
      start: Math.max(0, t + (off ? shift : 0)),
      duration: piece === 'crash' || piece === 'crash2' ? 1 : 0.25,
      velocity: Math.max(1, Math.min(127, Math.round(v * (piece === 'crash' ? 1 : vel)))),
    };
  });
  return clipToSection(notes, ctx);
}
