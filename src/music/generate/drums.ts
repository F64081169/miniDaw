// Drum pattern generator: genre grooves at three energy levels, fills, build-ups, crashes and endings.

import { DRUM_NOTE, type DrumPiece } from '../../audio/dsp/drums';
import { VELOCITY, clipToSection, humanizeNotes, patternHits, rngFor, swingTime, type GenNote, type SectionCtx } from './common';

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

export function generateDrums(styleId: string, ctx: SectionCtx): GenNote[] {
  const style = DRUM_STYLES[styleId] ?? DRUM_STYLES.pop;
  const rng = rngFor(ctx, 1);
  const e = ctx.energy;
  let notes: GenNote[] = [];
  const bars = ctx.bars;

  if (ctx.section === 'build') {
    // EDM build-up: snare density doubles every quarter of the section, kick drops out at the end
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

/** Positions (beats) where the kick plays — the 808 / bass generators lock to these. */
export function kickPositions(styleId: string, ctx: SectionCtx): number[] {
  return generateDrums(styleId, { ...ctx, humanize: 0, swing: 0 })
    .filter((n) => n.pitch === DRUM_NOTE.kick)
    .map((n) => n.start)
    .sort((a, b) => a - b);
}
