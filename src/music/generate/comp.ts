// Chord accompaniment generator: piano/EP/organ comping, guitar strums and picking, pads, arps,
// stabs and horn hits — all with voice-led voicings.

import { guitarVoicing, strum } from '../guitar';
import { bassNoteFor, chordPitchClasses, voiceChord, type ChordEvent, type VoicingStyle } from '../theory';
import { chordAtBeat, clipToSection, humanizeNotes, patternHits, rngFor, swingTime, type GenNote, type SectionCtx } from './common';

export type CompStyle =
  | 'blockQuarter'
  | 'popPiano'
  | 'balladPiano'
  | 'arpeggio'
  | 'sustain'
  | 'stabs'
  | 'houseStab'
  | 'skank'
  | 'funkChop'
  | 'jazzComp'
  | 'bossaGuitar'
  | 'strumPop'
  | 'strumCountry'
  | 'fingerpick'
  | 'powerChords'
  | 'metalChug'
  | 'citypopComp'
  | 'lofiChords'
  | 'rnbChords'
  | 'arp16'
  | 'supersaw'
  | 'brassStabs'
  | 'organGospel';

export interface CompOptions {
  voicing?: VoicingStyle;
  range?: [number, number];
  guitar?: boolean;
  kicks?: number[];
}

interface Voicer {
  (ev: ChordEvent): number[];
}

function keysVoicer(opts: CompOptions, defaultStyle: VoicingStyle, defaultRange: [number, number]): Voicer {
  let prev: number[] | null = null;
  const range = opts.range ?? defaultRange;
  return (ev) => {
    const v = voiceChord(ev.chord, { low: range[0], high: range[1], style: opts.voicing ?? defaultStyle, prev, maxNotes: 4 });
    prev = v;
    return v;
  };
}

function guitarVoicer(power = false): Voicer {
  let pos: number | null = null;
  return (ev) => {
    const g = guitarVoicing(ev.chord, pos, { power });
    pos = g.position;
    return g.notes;
  };
}

function chordNotes(v: number[], start: number, duration: number, velocity: number, roll = 0): GenNote[] {
  return v.map((pitch, i) => ({ pitch, start: start + i * roll, duration: Math.max(0.05, duration - i * roll), velocity: Math.round(velocity * (1 - i * 0.02)) }));
}

/** Rhythm hits from a 16-step string, each lasting until the next hit (capped). */
function rhythm(pattern: string, ctx: SectionCtx, maxLen: number, gap = 0.04): { start: number; len: number; ch: string }[] {
  const barSteps = Math.round(ctx.barBeats / 0.25);
  const hits = patternHits(pattern, 0.25, barSteps, ctx.bars);
  const total = ctx.bars * ctx.barBeats;
  return hits.map((h, i) => {
    const next = hits[i + 1]?.start ?? total;
    return { start: h.start, len: Math.max(0.1, Math.min(maxLen, next - h.start - gap)), ch: h.ch };
  });
}

function eachChordSlice(ctx: SectionCtx, start: number, len: number): { ev: ChordEvent; start: number; len: number }[] {
  // split a hit if a chord change happens inside it
  const ev = chordAtBeat(ctx, start);
  const end = Math.min(start + len, ev.start + ev.length);
  return [{ ev, start, len: Math.max(0.05, end - start) }];
}

const VEL = (ch: string) => (ch === 'X' || ch === 'D' ? 104 : ch === 'x' ? 88 : ch === 'U' ? 78 : ch === 'o' ? 70 : ch === 'm' ? 44 : 80);

function patterned(pattern: string, ctx: SectionCtx, voice: Voicer, maxLen: number, opts: { guitar?: boolean; roll?: number } = {}): GenNote[] {
  const out: GenNote[] = [];
  for (const h of rhythm(pattern, ctx, maxLen)) {
    for (const s of eachChordSlice(ctx, h.start, h.len)) {
      const v = voice(s.ev);
      if (opts.guitar) {
        if (h.ch === 'm') {
          out.push(...strum(v, s.start, 0.06, 'D', 40, ctx.bpm, { spreadMs: 6 }));
        } else out.push(...strum(v, s.start, s.len, h.ch === 'U' ? 'U' : 'D', VEL(h.ch), ctx.bpm));
      } else out.push(...chordNotes(v, s.start, s.len, VEL(h.ch), opts.roll ?? 0));
    }
  }
  return out;
}

function sustainChords(ctx: SectionCtx, voice: Voicer, vel: number, roll = 0, delay = 0): GenNote[] {
  const out: GenNote[] = [];
  for (const ev of ctx.chords) {
    const v = voice(ev);
    out.push(...chordNotes(v, ev.start + delay, ev.length - 0.04 - delay, vel, roll));
  }
  return out;
}

function arpeggio(ctx: SectionCtx, rng: () => number, high: boolean): GenNote[] {
  // ballad-style broken chords: low root, then 5–8–10–12 … held like a sustain pedal
  const out: GenNote[] = [];
  let prevBass: number | null = null;
  const sixEight = ctx.timeSig[1] === 8;
  const step = 0.5;
  for (const ev of ctx.chords) {
    const bass = bassNoteFor(ev.chord, 36, 50, prevBass);
    prevBass = bass;
    const pcs = chordPitchClasses(ev.chord);
    const third = pcs[1] ?? pcs[0];
    const fifth = pcs[2] ?? pcs[0];
    const up = (pc: number, above: number) => {
      let p = above + 1;
      while (((p % 12) + 12) % 12 !== pc) p++;
      return p;
    };
    const p5 = up(fifth, bass);
    const p8 = bass + 12;
    const p10 = up(third, p8);
    const p12 = up(fifth, p10);
    const seq = sixEight ? [bass, p5, p8, p10, p8, p5] : high ? [bass, p5, p8, p10, p12, p10, p8, p5] : [bass, p5, p8, p10, p8, p5, p8, p10];
    const end = ev.start + ev.length;
    let i = 0;
    for (let b = ev.start; b < end - 1e-9; b += step, i++) {
      const pitch = seq[i % seq.length];
      out.push({ pitch, start: b, duration: Math.max(0.3, end - b - 0.05), velocity: i === 0 ? 88 : 66 + Math.round(rng() * 10) });
    }
  }
  return out;
}

function jazzComp(ctx: SectionCtx, voice: Voicer, rng: () => number): GenNote[] {
  const cells = [
    [
      [0, 1],
      [1.5, 0.5],
    ],
    [
      [0.5, 0.5],
      [2.5, 1],
    ],
    [
      [1, 0.5],
      [2.5, 0.5],
      [3.5, 0.5],
    ],
    [
      [0, 0.67],
      [2, 0.67],
      [3.5, 0.5],
    ],
  ];
  const out: GenNote[] = [];
  for (let bar = 0; bar < ctx.bars; bar++) {
    const cell = cells[Math.floor(rng() * cells.length)];
    for (const [at, len] of cell) {
      if (at >= ctx.barBeats) continue;
      const start = bar * ctx.barBeats + at;
      const ev = chordAtBeat(ctx, start + 0.01);
      out.push(...chordNotes(voice(ev), start, len, 70 + Math.round(rng() * 16)));
    }
  }
  return out;
}

function bossaGuitar(ctx: SectionCtx, rng: () => number): GenNote[] {
  const voice = guitarVoicer();
  const out: GenNote[] = [];
  const fingers = ['x..x..x.........', '..x..x....x.....'];
  for (let bar = 0; bar < ctx.bars; bar++) {
    const b0 = bar * ctx.barBeats;
    const ev = chordAtBeat(ctx, b0);
    const v = voice(ev);
    // thumb: bass on 1 and 3 (root, then fifth)
    const bass = v[0];
    const fifth = v.find((p) => p > bass && (p - bass) % 12 === 7) ?? bass + 7;
    out.push({ pitch: bass, start: b0, duration: 1.9, velocity: 86 }, { pitch: fifth - (fifth - bass > 12 ? 12 : 0), start: b0 + 2, duration: 1.9, velocity: 80 });
    // fingers: top three strings, syncopated
    const top = v.slice(-3);
    for (const h of patternHits(fingers[bar % 2], 0.25, 16, 1)) {
      const at = b0 + h.start;
      const evAt = chordAtBeat(ctx, at);
      const tv = evAt === ev ? top : voice(evAt).slice(-3);
      out.push(...strum(tv, at, 0.45, 'U', 72 + Math.round(rng() * 8), ctx.bpm, { spreadMs: 6, strings: 3 }));
    }
  }
  return out;
}

function strumCountry(ctx: SectionCtx, voice: Voicer): GenNote[] {
  const out: GenNote[] = [];
  for (let bar = 0; bar < ctx.bars; bar++) {
    for (let beat = 0; beat < ctx.barBeats; beat++) {
      const at = bar * ctx.barBeats + beat;
      const ev = chordAtBeat(ctx, at);
      const v = voice(ev);
      if (beat % 2 === 0) {
        const bass = beat % 4 === 0 ? v[0] : v[1] ?? v[0];
        out.push({ pitch: bass, start: at, duration: 0.9, velocity: 92 });
      } else {
        out.push(...strum(v.slice(2), at, 0.45, 'D', 84, ctx.bpm, { spreadMs: 8 }));
        if (ctx.energy > 0.7) out.push(...strum(v.slice(2), at + 0.5, 0.4, 'U', 66, ctx.bpm));
      }
    }
  }
  return out;
}

function fingerpick(ctx: SectionCtx, voice: Voicer): GenNote[] {
  // Travis-style picking: thumb alternates bass strings, fingers pick the top strings in between
  const out: GenNote[] = [];
  const order = [0, 3, 1, 4, 0, 5, 1, 4];
  for (const ev of ctx.chords) {
    const v = voice(ev);
    const end = ev.start + ev.length;
    let i = 0;
    for (let b = ev.start; b < end - 1e-9; b += 0.5, i++) {
      const idx = Math.min(v.length - 1, order[i % order.length]);
      out.push({ pitch: v[idx], start: b, duration: Math.max(0.4, Math.min(1.5, end - b - 0.05)), velocity: i % 2 === 0 ? 84 : 70 });
    }
  }
  return out;
}

function arp16(ctx: SectionCtx, rng: () => number, range: [number, number]): GenNote[] {
  const out: GenNote[] = [];
  let prev: number[] | null = null;
  for (const ev of ctx.chords) {
    const v = voiceChord(ev.chord, { low: range[0], high: range[1] - 12, style: 'close', prev, maxNotes: 4 });
    prev = v;
    const tones = [...v, v[0] + 12, ...(ctx.energy > 0.8 ? [v[1] + 12] : [])];
    const pattern = ctx.energy > 0.8 ? [...tones, ...tones.slice(1, -1).reverse()] : tones;
    let i = 0;
    for (let b = ev.start; b < ev.start + ev.length - 1e-9; b += 0.25, i++) {
      out.push({ pitch: pattern[i % pattern.length], start: b, duration: 0.2, velocity: i % 4 === 0 ? 100 : 76 + Math.round(rng() * 8) });
    }
  }
  return out;
}

function metalChug(ctx: SectionCtx, kicks: number[]): GenNote[] {
  const voice = guitarVoicer(true);
  const out: GenNote[] = [];
  const pos = kicks.length ? kicks : Array.from({ length: ctx.bars * ctx.barBeats * 2 }, (_, i) => i * 0.5);
  for (const p of pos) {
    const v = voice(chordAtBeat(ctx, p));
    out.push(...strum(v, p, 0.2, 'D', 96, ctx.bpm, { spreadMs: 4 }));
  }
  if (ctx.energy > 0.85) {
    // big sustained power chord on each chord change in the chorus
    for (const ev of ctx.chords) out.push(...strum(voice(ev), ev.start, Math.min(ev.length, 2) - 0.05, 'D', 110, ctx.bpm));
  }
  return out;
}

export function generateComp(style: CompStyle, ctx: SectionCtx, opts: CompOptions = {}): GenNote[] {
  const rng = rngFor(ctx, 3);
  const e = ctx.energy;
  // each version of the song picks one of a style's rhythms (the same in every section)
  const pick = <T,>(options: T[]): T => options[(ctx.variation ?? 0) % options.length];
  const guitar = !!opts.guitar;
  const keys = (vs: VoicingStyle, range: [number, number]) => (guitar ? guitarVoicer() : keysVoicer(opts, vs, range));
  let notes: GenNote[] = [];
  switch (style) {
    case 'blockQuarter': {
      const v = keys('close', [55, 76]);
      notes = e < 0.45 ? sustainChords(ctx, v, 80) : patterned(e < 0.8 ? 'x.......x.......' : 'X...x...x...x...', ctx, v, e < 0.8 ? 1.9 : 0.9);
      break;
    }
    case 'popPiano': {
      const v = keys(pick<VoicingStyle>(['close', 'open', 'close']), [55, 77]);
      const rh = pick([
        e < 0.45 ? 'x.......x.......' : e < 0.8 ? 'x.....x.x.......' : 'X.....x.x.....x.',
        e < 0.45 ? 'x...............' : e < 0.8 ? 'x..x..x.x.......' : 'X..x..x.x..x..x.',
        e < 0.45 ? 'x.......x.......' : e < 0.8 ? 'x...x...x...x...' : 'X.x.x.x.X.x.x.x.',
      ]);
      notes = patterned(rh, ctx, v, 1.5);
      // left hand octaves
      let prev: number | null = null;
      for (const ev of ctx.chords) {
        const b = bassNoteFor(ev.chord, 36, 52, prev);
        prev = b;
        notes.push({ pitch: b, start: ev.start, duration: ev.length - 0.05, velocity: 82 });
        if (e > 0.6) notes.push({ pitch: b + 12, start: ev.start, duration: ev.length - 0.05, velocity: 70 });
      }
      break;
    }
    case 'balladPiano':
      notes = e > 0.8 ? [...arpeggio(ctx, rng, true), ...sustainChords(ctx, keys('open', [60, 84]), 74)] : arpeggio(ctx, rng, e > 0.6);
      break;
    case 'arpeggio':
      notes = arpeggio(ctx, rng, e > 0.6);
      break;
    case 'sustain':
      notes = sustainChords(ctx, keys(opts.voicing ?? 'open', opts.range ?? [52, 79]), e > 0.8 ? 92 : 76);
      break;
    case 'lofiChords':
      notes = sustainChords(ctx, keys('drop2', [50, 74]), 72, 0.035, 0.06);
      if (e > 0.6) {
        // a lazy re-strike halfway through long chords
        for (const ev of ctx.chords) {
          if (ev.length >= 4) notes.push(...chordNotes(keys('drop2', [50, 74])(ev).slice(1), ev.start + 2.5, ev.length - 2.6, 58, 0.03));
        }
      }
      break;
    case 'rnbChords': {
      const v = keys('drop2', [50, 76]);
      notes = patterned(pick(e < 0.6 ? ['x...............', 'x.......x.......', 'x...........x...'] : ['x......o..x.....', 'x.....x...x..x..', 'x...x.....x.....']), ctx, v, 3, { roll: 0.02 });
      break;
    }
    case 'stabs':
      notes = patterned('..x...x...x...x.', ctx, keys('close', [57, 79]), 0.22);
      break;
    case 'houseStab':
      notes = patterned(e < 0.8 ? 'x..x..x.........' : 'x..x..x...x..x..', ctx, keys('close', [57, 81]), 0.4);
      break;
    case 'skank':
      notes = patterned('..x...x...x...x.', ctx, guitar ? guitarVoicer() : keys('close', [60, 79]), 0.18, { guitar });
      if (guitar) notes = notes.map((n) => (n.pitch < 55 ? { ...n, velocity: 0 } : n)).filter((n) => n.velocity > 0);
      break;
    case 'funkChop': {
      const v = guitar ? guitarVoicer() : keys('close', [60, 80]);
      const pat = e < 0.6 ? pick(['....x.......x...', '..x...x...x...x.']) : pick(['x..mx.m.x.mx..m.', 'x.mxm.x.mxm.x.m.', '..x...x...x.x.x.']);
      notes = patterned(pat, ctx, (ev) => v(ev).slice(-4), 0.14, { guitar });
      break;
    }
    case 'jazzComp':
      notes = jazzComp(ctx, keysVoicer(opts, 'rootless', [50, 74]), rng);
      break;
    case 'bossaGuitar':
      notes = bossaGuitar(ctx, rng);
      break;
    case 'strumPop': {
      const v = guitarVoicer();
      const pat = pick([
        e < 0.45 ? 'D.......D.......' : e < 0.8 ? 'D...D.U...U.D.U.' : 'D.D.D.UDU.U.D.UD',
        e < 0.45 ? 'D.......D...D...' : e < 0.8 ? 'D..D..D.D.U.D.U.' : 'D.UD.UD.D.UD.UDU',
      ]);
      notes = patterned(pat, ctx, v, 1.8, { guitar: true });
      break;
    }
    case 'strumCountry':
      notes = strumCountry(ctx, guitarVoicer());
      break;
    case 'fingerpick':
      notes = fingerpick(ctx, guitarVoicer());
      break;
    case 'powerChords': {
      const v = guitarVoicer(true);
      notes = e < 0.8 ? patterned(pick(['x.x.x.x.x.x.x.x.', 'x..x..x.x..x..x.']), ctx, v, 0.4, { guitar: true }) : patterned(pick(['X.......X.......', 'X.....X.X.......']), ctx, v, 1.9, { guitar: true });
      if (e < 0.8) notes = notes.map((n) => ({ ...n, duration: Math.min(n.duration, 0.3), velocity: Math.round(n.velocity * 0.85) }));
      break;
    }
    case 'metalChug':
      notes = metalChug(ctx, opts.kicks ?? []);
      break;
    case 'citypopComp':
      notes = patterned(e < 0.6 ? pick(['x.......x.......', 'x.....x.........']) : pick(['x.....x...x..x..', 'x..x..x...x.x...', 'x...x.x...x...x.']), ctx, keys('drop2', [55, 79]), 1.4);
      break;
    case 'arp16':
      notes = arp16(ctx, rng, opts.range ?? [57, 88]);
      break;
    case 'supersaw': {
      const v = keys('spread', [48, 84]);
      notes = ctx.section === 'build' ? patterned('x.x.x.x.x.x.x.x.', ctx, v, 0.4) : sustainChords(ctx, v, e > 0.8 ? 100 : 80);
      break;
    }
    case 'brassStabs':
      notes = patterned(e < 0.8 ? '............x...' : '....x..x......x.', ctx, keys('close', [60, 82]), 0.3);
      break;
    case 'organGospel':
      notes = e < 0.6 ? sustainChords(ctx, keys('close', [55, 79]), 80) : patterned(pick(['x...x.x.x...x.x.', 'x..x..x.x..x..x.']), ctx, keys('close', [55, 79]), 0.9);
      break;
  }
  notes = notes.map((n) => ({ ...n, start: swingTime(n.start, ctx.swing, ctx.swingUnit) }));
  notes = humanizeNotes(notes, ctx.humanize * 0.6, rng);
  return clipToSection(notes, ctx);
}
