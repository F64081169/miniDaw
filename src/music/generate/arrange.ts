// Song-level arranging: how a song breathes. The part generators write each section's notes;
// this plans how the song moves between them, the way songwriting and production guides teach
// it (see the coach's references):
//
// - Energy rises across the song: the first verse is the sparsest, later verses add a little,
//   the last chorus is the biggest moment and the outro winds down.
// - Dynamics move inside sections: a pre-chorus crescendos into the chorus, phrases swell and
//   relax, the song can fade on its last section.
// - Space: the band can stop on the last beat before a chorus so its downbeat lands, intros let
//   instruments enter one at a time, new layers join halfway through the first verse, the last
//   chorus can start stripped down and then open up.
// - Conversation: an instrument answers the melody in the gaps between its phrases, and pads
//   double the hook an octave down in the last chorus.
// - The masters' moves (./moves): borrowed and secondary chords, a bass that walks up into the
//   chorus or holds a pedal under the pre-chorus, a half-time bridge, stop-time, a
//   countermelody in the last chorus — a few per version, as often as the genre uses them.

import { DRUM_NOTE } from '../../audio/dsp/drums';
import type { SectionType } from '../../core/types';
import { chordPitchClasses, isInScale, type Chord, type ChordEvent } from '../theory';
import { SECTION_ENERGY, chordAtBeat, type GenNote, type SectionCtx } from './common';
import {
  isMinorChord,
  minorFour,
  picardy,
  pickMoves,
  secondaryDominant,
  suspendDominant,
  walkNotes,
  walksChromatically,
  type ChordMove,
  type MoveId,
  type WalkUp,
} from './moves';

export type Part = 'drums' | 'bass' | 'harmony' | 'layers' | 'melody';

/** How a genre breathes. */
export interface BreathProfile {
  stop: number; // chance the band stops on the last beat before a chorus (otherwise a fill carries in)
  intro: 'solo' | 'layered' | 'full'; // chords alone / drums and bass join halfway / everyone
  firstVerseDrums: 'all' | 'half' | 'none'; // drums in the first verse
  dropDown: number; // chance the last chorus starts stripped down
  answer: boolean; // an instrument answers the melody in its gaps
  ramp: number; // depth of crescendos and phrase swells (1 = normal)
  dropGap: number; // chance of a silent beat between a build-up and the drop
  kickOut: boolean; // long sections drop the kick (and the bass with it) for their third four bars
  preDominant: boolean; // the pre-chorus ends on the dominant (V), pulling into the chorus
  bridgeTurn: boolean; // the bridge turns to chords the song has not used yet
  modulate: number; // chance the last chorus steps up a key (a whole or a half step)
}

const DEFAULT_BREATH: BreathProfile = {
  stop: 0.3,
  intro: 'layered',
  firstVerseDrums: 'all',
  dropDown: 0,
  answer: false,
  ramp: 1,
  dropGap: 0.6,
  kickOut: false,
  preDominant: false,
  bridgeTurn: false,
  modulate: 0,
};

export const BREATH: Record<string, Partial<BreathProfile>> = {
  pop: { stop: 0.5, intro: 'layered', dropDown: 0.7, answer: true, preDominant: true, bridgeTurn: true, modulate: 0.35 },
  mandopop: { stop: 0.4, intro: 'solo', firstVerseDrums: 'none', dropDown: 0.7, answer: true, ramp: 1.2, preDominant: true, bridgeTurn: true, modulate: 0.5 },
  ballad: { stop: 0.35, intro: 'solo', dropDown: 0.6, answer: true, ramp: 1.4, preDominant: true, bridgeTurn: true, modulate: 0.5 },
  rock: { stop: 0.5, intro: 'layered', dropDown: 0.5, answer: true, ramp: 0.9, preDominant: true, bridgeTurn: true },
  metal: { stop: 0.6, intro: 'full', ramp: 0.7 },
  country: { stop: 0.3, intro: 'layered', dropDown: 0.5, answer: true, ramp: 0.9, preDominant: true, modulate: 0.3 },
  hiphop: { stop: 0.6, intro: 'layered', ramp: 0.6, kickOut: true },
  trap: { stop: 0.6, intro: 'layered', ramp: 0.6, kickOut: true },
  lofi: { stop: 0.2, intro: 'layered', ramp: 0.6, kickOut: true },
  rnb: { stop: 0.4, intro: 'layered', dropDown: 0.5, answer: true, preDominant: true, modulate: 0.25 },
  house: { stop: 0, intro: 'layered', ramp: 0.8, dropGap: 0.7 },
  edm: { stop: 0, intro: 'layered', ramp: 0.8, dropGap: 0.85 },
  synthwave: { stop: 0.3, intro: 'layered', answer: true, ramp: 0.8 },
  jazz: { stop: 0.1, intro: 'full', answer: true, ramp: 0.8 },
  bossa: { stop: 0.1, intro: 'solo', answer: true, ramp: 0.8 },
  funk: { stop: 0.6, intro: 'layered', answer: true, ramp: 0.8 },
  citypop: { stop: 0.4, intro: 'full', dropDown: 0.5, answer: true, preDominant: true, modulate: 0.3 },
  reggae: { stop: 0.3, intro: 'layered', answer: true, ramp: 0.7 },
};

export function breathOf(genreId: string): BreathProfile {
  return { ...DEFAULT_BREATH, ...BREATH[genreId] };
}

export interface SectionPlan {
  energy: number;
  dyn: [number, number]; // velocity scale at the start and the end of the section
  swell: number; // depth of the phrase swells
  stop: number | null; // beat where the band stops (silent until the next section)
  kickOut: [number, number] | null; // bars without kick (and bass)
  enter: Partial<Record<Part, number>>; // first bar a part plays
  dropDown: number; // bars at the start played stripped down
  lift: boolean; // the song's biggest section
  fade: boolean; // the song fades out over this section
  shift: number; // semitones up: the key change into the last chorus (and what follows it)
  // the masters' moves (planSong fills these in)
  chords?: ChordEvent[]; // the section's chords as played (default: the context's)
  moves?: MoveUse[]; // the moves the section uses, for the emotion map
  walkUp?: WalkUp | null; // the bass walks up into the next section in the last beats
  pedal?: number | null; // pitch class the bass holds under the section's chords
  halfTime?: boolean; // the drums play half-time (the backbeat on 3) until the last bar
  stopTime?: number; // bars at the start where the band only hits the downbeats
  counter?: boolean; // the sustained part plays a countermelody instead of doubling the hook
}

/** One of the masters' moves in a section: where it happens and, for chord moves, the chords. */
export interface MoveUse {
  id: MoveId;
  at: number; // beat in the section
  from?: Chord;
  to?: Chord;
}

const CHORUS_LIKE = new Set<SectionType>(['chorus', 'drop']);

/** Small deterministic PRNG for planning (mulberry32). */
function rngOf(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The song's shape: energy, dynamics, stops and entrances for every section. */
export function planSong(genreId: string, ctxs: SectionCtx[], seed = 0): SectionPlan[] {
  const p = breathOf(genreId);
  const rng = rngOf(seed * 2654435761 + genreId.length * 977 + ctxs.length);
  const choruses = ctxs.filter((c) => CHORUS_LIKE.has(c.section)).length;
  // the last chorus can step up a key (whole steps lift more, half steps sound brighter)
  const lastChorus = ctxs.map((c) => CHORUS_LIKE.has(c.section)).lastIndexOf(true);
  const keyChange = p.modulate > 0 && choruses > 1 && rng() < p.modulate ? (rng() < 0.6 ? 2 : 1) : 0;
  let chorusSeen = 0;
  const plans = ctxs.map((c, i) => {
    const occ = c.occurrence ?? 1;
    const bars = c.bars;
    let energy = SECTION_ENERGY[c.section];
    let dyn: [number, number] = [0.93, 0.95];
    const plan: SectionPlan = { energy, dyn, swell: 0.06 * p.ramp, stop: null, kickOut: null, enter: {}, dropDown: 0, lift: false, fade: false, shift: i >= lastChorus ? keyChange : 0 };
    switch (c.section) {
      case 'intro':
        dyn = [0.8, 0.92];
        if (p.intro === 'solo') plan.enter = { drums: bars, bass: bars, layers: bars };
        else if (p.intro === 'layered' && bars >= 4) plan.enter = { drums: bars / 2, bass: bars / 2, layers: bars };
        break;
      case 'verse':
        // the first verse is the sparsest; each later one adds a little
        energy += occ === 1 ? -0.12 : 0.03 * Math.min(2, occ - 1);
        dyn = occ === 1 ? [0.88, 0.92] : [0.92, 0.95];
        if (occ === 1 && bars >= 8) plan.enter.layers = bars / 2;
        if (occ === 1 && p.firstVerseDrums === 'half' && bars >= 8) plan.enter.drums = bars / 2;
        if (occ === 1 && p.firstVerseDrums === 'none') plan.enter.drums = bars;
        break;
      case 'pre':
        energy += occ > 1 ? 0.03 : 0;
        dyn = [0.86, 1.04];
        break;
      case 'chorus':
      case 'drop':
        chorusSeen++;
        energy += chorusSeen === 1 ? -0.03 : chorusSeen === choruses && choruses > 1 ? 0.05 : 0;
        // a chorus that hands over to a verse eases off at its end, so the verse can climb again
        dyn = c.next === 'verse' ? [1, 0.95] : [1, 1];
        if (chorusSeen === choruses && choruses > 1) {
          plan.lift = true;
          dyn = [1.03, 1.05];
          if (bars >= 8 && rng() < p.dropDown) plan.dropDown = 4;
        }
        break;
      case 'bridge':
        dyn = [0.84, 1];
        break;
      case 'breakdown':
        dyn = [0.8, 0.84];
        break;
      case 'build':
        dyn = [0.8, 1.06];
        break;
      case 'solo':
        dyn = [0.95, 1];
        break;
      case 'outro':
        dyn = c.isLast ? [0.94, 0.6] : [0.9, 0.9];
        plan.fade = c.isLast;
        break;
    }
    // crescendos and decrescendos scale with how dramatic the genre is
    plan.dyn = [1 + (dyn[0] - 1) * p.ramp, 1 + (dyn[1] - 1) * p.ramp];
    plan.energy = Math.max(0, Math.min(1, energy));
    // a breath before the chorus: everyone stops on the last beat (a pickup in the melody stays);
    // a build-up leaves a silent beat before the drop
    const gap = c.section === 'build' ? p.dropGap : c.section === 'breakdown' ? 0 : p.stop;
    if (c.next && CHORUS_LIKE.has(c.next) && bars >= 2 && rng() < gap) {
      plan.stop = bars * c.barBeats - (c.bpm < 80 ? 0.5 : 1);
    }
    // hip-hop takes the kick out for the third four bars of a long verse, then brings it back
    if (p.kickOut && bars >= 16 && (c.section === 'verse' || c.section === 'chorus') && rng() < 0.7) plan.kickOut = [8, 12];
    return plan;
  });
  // the moves are rolled apart from the rest, so they leave the song's other choices as they were
  applyMoves(genreId, ctxs, plans, pickMoves(genreId, rngOf(seed * 40503 + genreId.length * 131 + 17)));
  return plans;
}

const pcOf = (n: number) => ((n % 12) + 12) % 12;

/** The masters' moves this version uses, placed where the song has room for them. */
function applyMoves(genreId: string, ctxs: SectionCtx[], plans: SectionPlan[], moves: Set<MoveId>): void {
  const minorSong = ctxs.some((c) => c.chords.some((e) => e.chord.root === c.key.root && isMinorChord(e.chord)));
  // chord moves first: the walk-up goes to the next section's chords as played
  ctxs.forEach((c, i) => {
    const plan = plans[i];
    const uses: MoveUse[] = [];
    let chords = c.chords;
    const use = (id: MoveId, m: ChordMove | null) => {
      if (!m) return;
      chords = m.chords;
      uses.push({ id, at: m.at, from: m.from, to: m.to });
    };
    if (CHORUS_LIKE.has(c.section)) {
      if (moves.has('secondary')) use('secondary', secondaryDominant(chords, c.key, c.barBeats));
      if (moves.has('minorIV')) use('minorIV', minorFour(chords, c.key, c.barBeats));
    }
    if (moves.has('sus4') && c.section === 'pre' && c.next && CHORUS_LIKE.has(c.next)) use('sus4', suspendDominant(chords, c.key, c.barBeats));
    if (moves.has('picardy') && minorSong && i === ctxs.length - 1) use('picardy', picardy(chords, c.key, c.barBeats));
    plan.chords = chords;
    plan.moves = uses;
  });
  const chromatic = walksChromatically(genreId);
  ctxs.forEach((c, i) => {
    const plan = plans[i];
    const next = ctxs[i + 1];
    const intoChorus = !!next && CHORUS_LIKE.has(next.section);
    // a dominant pedal under the pre-chorus, resolved by the chorus
    if (moves.has('pedal') && c.section === 'pre' && intoChorus) {
      plan.pedal = pcOf(c.key.root + 7);
      plan.moves!.push({ id: 'pedal', at: 0 });
    }
    // the bass walks up to the chorus's first note (not where the band stops or the bass holds)
    if (moves.has('walkUp') && intoChorus && plan.stop === null && plan.pedal == null && c.bars >= 2) {
      // into the chorus's key: a key change is walked into by half steps
      const up = plans[i + 1].shift - plan.shift;
      const to = plans[i + 1].chords![0].chord.bass;
      plan.walkUp = { to: pcOf(to + up), key: pcOf(c.key.root + up), chromatic: chromatic || up !== 0 };
      plan.moves!.push({ id: 'walkUp', at: c.bars * c.barBeats - walkSteps(c) });
    }
    // a half-time bridge: the song breathes before the last chorus
    if (moves.has('halfTime') && c.section === 'bridge' && c.barBeats === 4 && c.bars >= 4) {
      plan.halfTime = true;
      plan.moves!.push({ id: 'halfTime', at: 0 });
    }
  });
  // stop-time opens the second verse (or the only one)
  if (moves.has('stopTime')) {
    const verses = ctxs.flatMap((c, i) => (c.section === 'verse' && c.bars >= 8 ? [i] : []));
    const i = verses[1] ?? verses[0];
    if (i !== undefined) {
      plans[i].stopTime = 2;
      plans[i].moves!.push({ id: 'stopTime', at: 0 });
    }
  }
  // a countermelody in the biggest chorus
  const lift = plans.findIndex((p) => p.lift);
  if (moves.has('counter') && lift >= 0) {
    plans[lift].counter = true;
    plans[lift].moves!.push({ id: 'counter', at: plans[lift].dropDown * ctxs[lift].barBeats });
  }
}

/** Beats a walk-up takes: the last three of a 4/4 bar (two in 3/4). */
export function walkSteps(ctx: SectionCtx): number {
  return Math.min(3, ctx.barBeats - 1);
}

const DRUM_KEEP_DROPDOWN = new Set<number>([DRUM_NOTE.kick, DRUM_NOTE.hatC, DRUM_NOTE.hatP, DRUM_NOTE.ride]);

export interface ShapeOptions {
  crash?: boolean; // the drum style marks section starts with a crash
  melody?: GenNote[]; // the section's melody, for answers and doubling
  answer?: boolean; // this part answers the melody in its gaps
  double?: boolean; // this part doubles the hook in the song's biggest chorus
  range?: [number, number]; // register for answers / doubling
}

/** Apply a section's plan to one part's notes. */
export function shapePart(notes: GenNote[], part: Part, ctx: SectionCtx, plan: SectionPlan, opts: ShapeOptions = {}): GenNote[] {
  const bb = ctx.barBeats;
  const len = ctx.bars * bb;
  let out = notes.map((n) => ({ ...n }));

  // entrances: this part waits for its bar (drums come in on a crash)
  const enter = plan.enter[part] ?? 0;
  if (enter > 0) {
    out = out.filter((n) => n.start >= enter * bb - 1e-6);
    if (part === 'drums' && enter < ctx.bars && opts.crash) out.push(hit(DRUM_NOTE.crash, enter * bb, 100, 1), hit(DRUM_NOTE.kick, enter * bb, 100));
  }

  // the last chorus starts stripped down, then the band comes back in
  if (plan.dropDown > 0 && part !== 'melody') {
    const cut = plan.dropDown * bb;
    const early = out.filter((n) => n.start < cut - 1e-6);
    const late = out.filter((n) => n.start >= cut - 1e-6);
    let kept: GenNote[] = [];
    if (part === 'drums') {
      kept = early.filter((n) => DRUM_KEEP_DROPDOWN.has(n.pitch)).map((n) => ({ ...n, velocity: n.velocity * 0.75 }));
      // a snare build in the last bar of the quiet half, then a crash as everyone comes back
      const from = cut - bb + 1;
      for (let t = from, k = 0; t < cut - 1e-6; t += 0.5, k++) kept.push(hit(DRUM_NOTE.snare, t, 58 + k * 9));
      late.push(hit(DRUM_NOTE.crash, cut, 112, 1), hit(DRUM_NOTE.kick, cut, 108));
    } else if (part === 'bass') {
      kept = early.filter((n) => Math.abs(n.start % bb) < 0.02).map((n) => ({ ...n, duration: Math.max(n.duration, bb - 0.1), velocity: n.velocity * 0.85 }));
    } else if (part === 'harmony') {
      kept = early.map((n) => ({ ...n, velocity: n.velocity * 0.85 }));
    }
    out = [...kept, ...late];
  }

  // the kick (and the bass locked to it) sits out a few bars
  if (plan.kickOut && (part === 'drums' || part === 'bass')) {
    const [a, b] = plan.kickOut.map((bar) => bar * bb);
    out = out.filter((n) => !(n.start >= a - 1e-6 && n.start < b - 1e-6 && (part === 'bass' || n.pitch === DRUM_NOTE.kick)));
  }

  // the bass holds a pedal under the changing chords; the drums go half-time
  if (plan.pedal != null && part === 'bass') out = pedal(out, ctx, plan.pedal);
  if (plan.halfTime && part === 'drums' && bb === 4) out = halfTime(out, ctx.bars - 1);

  // a breath before the next section: everyone but the melody stops
  if (plan.stop !== null && part !== 'melody') {
    const at = plan.stop;
    out = out.filter((n) => n.start < at - 1e-6).map((n) => (n.start + n.duration > at - 0.05 ? { ...n, duration: Math.max(0.1, at - 0.05 - n.start) } : n));
  }
  // or the bass walks up into it
  if (plan.walkUp && part === 'bass') out = walkUp(out, ctx, plan.walkUp);

  // the biggest chorus: pads double the hook an octave down (or play a countermelody against
  // it); drums add a crash halfway
  if (plan.lift && opts.double && opts.melody?.length) {
    const [lo, hi] = opts.range ?? [48, 84];
    if (plan.counter) {
      // the part makes room for its new line: no chord note on it or a step from it, the rest softer
      const from = plan.dropDown * bb;
      const line = countermelody(opts.melody, ctx, from, [lo, hi]);
      const overlaps = (a: GenNote, b: GenNote) => a.start < b.start + b.duration - 0.05 && b.start < a.start + a.duration - 0.05;
      out = out
        .filter((n) => !line.some((c) => overlaps(c, n) && Math.abs(c.pitch - n.pitch) <= 2))
        .map((n) => (n.start >= from - 1e-6 ? { ...n, velocity: n.velocity * 0.85 } : n));
      out.push(...line);
    } else {
      for (const m of opts.melody) {
        let p = m.pitch - 12;
        while (p < lo) p += 12;
        if (p > hi) continue;
        if (m.start >= plan.dropDown * bb) out.push({ pitch: p, start: m.start, duration: m.duration, velocity: m.velocity * 0.6 });
      }
    }
  }
  if (plan.lift && part === 'drums' && opts.crash && ctx.bars >= 8) out.push(hit(DRUM_NOTE.crash, 4 * bb, 96, 1));

  // an answer to the melody in the gaps between its phrases
  if (opts.answer && opts.melody?.length && part !== 'melody') out.push(...answers(opts.melody, ctx, plan, opts.range ?? [55, 79]));

  // stop-time: the band only hits the downbeats, the melody carries on alone
  if (plan.stopTime && part !== 'melody') out = stopTime(out, part, ctx, plan.stopTime, !!opts.crash);

  // the song lets its last chord ring
  if (plan.fade && part !== 'drums') {
    const ring = Math.max((ctx.bars - 1) * bb, chordAtBeat(ctx, len - 0.01).start);
    out = out.map((n) => (n.start >= ring - 1e-6 ? { ...n, duration: Math.max(n.duration, len - n.start - 0.05) } : n));
  }

  // dynamics: the section's crescendo / decrescendo and a swell over every four-bar phrase
  const depth = plan.swell * (part === 'drums' ? 0.5 : part === 'melody' ? 0.6 : 1);
  const melodyScale = part === 'melody' ? 0.5 : 1;
  out = out.map((n) => {
    const u = Math.max(0, Math.min(1, n.start / len));
    let m = plan.dyn[0] + (plan.dyn[1] - plan.dyn[0]) * u;
    m = 1 + (m - 1) * melodyScale;
    const phrase = ((n.start / (4 * bb)) % 1 + 1) % 1;
    m *= 1 + depth * (Math.sin(Math.PI * phrase) - 0.35);
    return { ...n, velocity: Math.max(1, Math.min(127, Math.round(n.velocity * m))) };
  });
  return out.filter((n) => n.start >= -1e-6 && n.start < len - 1e-6).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function hit(pitch: number, start: number, velocity: number, duration = 0.25): GenNote {
  return { pitch, start, duration, velocity };
}

/** Distance between two pitch classes (0 … 6). */
function pcDist(a: number, b: number): number {
  const d = pcOf(a - b);
  return Math.min(d, 12 - d);
}

/**
 * A pedal: every bass note becomes the pedal note (the line keeps its rhythm and its octave
 * jumps), except under a chord with a tone a half step from it, where the line stays.
 */
function pedal(notes: GenNote[], ctx: SectionCtx, pc: number): GenNote[] {
  if (!notes.length) return notes;
  // the pedal note nearest the middle of the line; notes the line plays an octave up stay up
  const mid = notes.map((n) => n.pitch).sort((a, b) => a - b)[notes.length >> 1];
  let base = mid + ((pcOf(pc - mid) + 6) % 12) - 6;
  if (base < 28) base += 12;
  return notes.map((n) => {
    const tones = chordPitchClasses(chordAtBeat(ctx, n.start + 0.01).chord);
    if (tones.some((t) => pcDist(t, pc) === 1)) return n;
    return { ...n, pitch: n.pitch - mid >= 7 ? base + 12 : base };
  });
}

const BACKBEAT = new Set<number>([DRUM_NOTE.snare, DRUM_NOTE.rim, DRUM_NOTE.clap]);

/**
 * Half-time: the backbeat moves from beats 2 and 4 to beat 3 (keeping its push or drag) and
 * the kick on 3 makes room for it, until bar `until` (the fill that leads out stays).
 */
function halfTime(notes: GenNote[], until: number): GenNote[] {
  const barOf = (n: GenNote) => Math.floor((n.start + 0.12) / 4);
  const posOf = (n: GenNote) => n.start - barOf(n) * 4;
  const backbeat = (n: GenNote) => BACKBEAT.has(n.pitch) && n.velocity >= 50 && (Math.abs(posOf(n) - 1) < 0.15 || Math.abs(posOf(n) - 3) < 0.15);
  const moved = new Map<string, GenNote>();
  for (const n of notes) {
    if (barOf(n) >= until || !backbeat(n)) continue;
    const key = `${barOf(n)}:${n.pitch}`;
    const was = moved.get(key);
    if (!was || was.velocity < n.velocity) moved.set(key, { ...n, start: n.start + (posOf(n) < 2 ? 1 : -1) });
  }
  const bars = new Set([...moved.values()].map(barOf));
  const kept = notes.filter((n) => {
    if (!bars.has(barOf(n))) return true;
    if (backbeat(n)) return false;
    return !(Math.abs(posOf(n) - 2) < 0.15 && (n.pitch === DRUM_NOTE.kick || BACKBEAT.has(n.pitch)));
  });
  return [...kept, ...moved.values()];
}

/** A walk-up: the last beats climb step by step to the next section's first bass note. */
function walkUp(notes: GenNote[], ctx: SectionCtx, w: WalkUp): GenNote[] {
  const len = ctx.bars * ctx.barBeats;
  const steps = walkNotes(w, ctx.key.mode, walkSteps(ctx));
  if (!steps.length) return notes;
  const from = len - steps.length;
  const before = notes.filter((n) => n.start < from - 0.1);
  const last = before.reduce<GenNote | null>((a, n) => (!a || n.start > a.start ? n : a), null);
  // only where the bass is playing at the end of the section
  if (!last || last.start < len - 2 * ctx.barBeats) return notes;
  const kept = before.map((n) => (n.start + n.duration > from - 0.05 ? { ...n, duration: Math.max(0.15, from - 0.05 - n.start) } : n));
  const vel = Math.max(84, Math.min(108, last.velocity));
  return [...kept, ...steps.map((pitch, k) => ({ pitch, start: from + k, duration: 0.8, velocity: Math.round(vel * (0.9 + 0.05 * k)) }))];
}

/**
 * Stop-time: for the first bars the band hits only the downbeats together (short; the drums
 * with the kick and a crash, or a snare where the style has no crash), and a snare pickup
 * brings the groove back.
 */
function stopTime(notes: GenNote[], part: Part, ctx: SectionCtx, bars: number, crash: boolean): GenNote[] {
  const bb = ctx.barBeats;
  const end = Math.min(bars, ctx.bars) * bb;
  if (!notes.some((n) => n.start < end - 1e-6)) return notes; // the part isn't playing yet
  const out = notes.filter((n) => n.start >= end - 1e-6);
  for (let t = 0; t < end - 1e-6; t += bb) {
    if (part === 'drums') {
      const kick = notes.find((n) => n.pitch === DRUM_NOTE.kick && Math.abs(n.start - t) < 0.15);
      out.push(hit(DRUM_NOTE.kick, t, Math.max(100, kick?.velocity ?? 0)), crash ? hit(DRUM_NOTE.crash, t, 104, 1.5) : hit(DRUM_NOTE.snare, t, 100));
    } else {
      for (const n of notes) if (n.start >= t - 0.05 && n.start < t + 0.15) out.push({ ...n, duration: Math.min(n.duration, 0.6) });
    }
  }
  if (part === 'drums') out.push(hit(DRUM_NOTE.snare, end - 0.5, 84), hit(DRUM_NOTE.snare, end - 0.25, 96));
  return out;
}

/**
 * A countermelody: a second line in half notes on chord tones (thirds and sevenths first),
 * below the melody and out of its way, moving against it. Where the melody is busy it holds;
 * where the melody holds, it moves (a passing note into its next note).
 */
function countermelody(melody: GenNote[], ctx: SectionCtx, from: number, [lo, hi]: [number, number]): GenNote[] {
  const len = ctx.bars * ctx.barBeats;
  const slot = ctx.barBeats / 2;
  const mel = [...melody].sort((a, b) => a.start - b.start);
  if (!mel.length) return [];
  const sung = (t: number) => mel.filter((n) => n.start <= t + 0.05).at(-1) ?? null;
  const mean = mel.reduce((a, n) => a + n.pitch, 0) / mel.length;
  const centre = Math.max(lo + 3, Math.min(hi - 3, mean - 9));
  const line: { pitch: number; start: number; end: number; busy: number }[] = [];
  let prevMel: number | null = null;
  for (let t = from; t < len - 1e-6; t += slot) {
    const chord = chordAtBeat(ctx, t + 0.01).chord;
    const tones = chordPitchClasses(chord);
    const colour = [tones[1], tones[3]];
    const m = sung(t);
    const busy = mel.filter((n) => n.start >= t - 1e-6 && n.start < t + slot - 1e-6).length;
    const prev = line.at(-1);
    // the melody is busy: the counter holds while its note still belongs to the chord
    if (prev && busy >= 3 && tones.includes(pcOf(prev.pitch))) {
      prev.end = Math.min(len, t + slot);
      prevMel = m?.pitch ?? prevMel;
      continue;
    }
    let best = Math.round(centre);
    let bestCost = Infinity;
    for (let p = lo; p <= hi; p++) {
      if (!tones.includes(pcOf(p))) continue;
      let cost = Math.abs(p - centre) * 0.12 + (colour.includes(pcOf(p)) ? 0 : pcOf(p) === chord.root ? 1 : 0.6);
      if (prev) {
        const d = Math.abs(p - prev.pitch);
        cost += d === 0 ? 1.5 : d <= 2 ? 0 : d <= 4 ? 0.7 : d <= 7 ? 2 : 6;
        // contrary motion: the melody climbs, the counter falls (and the other way round)
        if (m && prevMel !== null && m.pitch !== prevMel && Math.sign(p - prev.pitch) === Math.sign(m.pitch - prevMel)) cost += 1;
      }
      if (m) {
        if (m.pitch - p < 3) cost += 8; // below the melody, never on top of it
        if ((m.pitch - p) % 12 === 0) cost += 3; // and not in octaves with it
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = p;
      }
    }
    line.push({ pitch: best, start: t, end: Math.min(len, t + slot), busy });
    prevMel = m?.pitch ?? prevMel;
  }
  const vel = Math.round((mel.reduce((a, n) => a + n.velocity, 0) / mel.length) * 0.85);
  const out: GenNote[] = [];
  line.forEach((n, k) => {
    const next = line[k + 1];
    const half = (n.end - n.start) / 2;
    if (next && n.busy <= 1 && Math.abs(next.pitch - n.pitch) >= 3 && Math.abs(next.pitch - n.pitch) <= 4) {
      // the scale note between this one and the next, unless it rubs against the chord
      const dir = Math.sign(next.pitch - n.pitch);
      let pass = n.pitch + dir;
      while (!isInScale(pass, ctx.key.root, ctx.key.mode)) pass += dir;
      const tones = chordPitchClasses(chordAtBeat(ctx, n.start + half + 0.01).chord);
      if (pass !== next.pitch && !tones.some((t) => !isInScale(t, ctx.key.root, ctx.key.mode) && pcDist(t, pass) === 1)) {
        out.push({ pitch: n.pitch, start: n.start, duration: half - 0.05, velocity: vel }, { pitch: pass, start: n.start + half, duration: half - 0.05, velocity: vel - 4 });
        return;
      }
    }
    out.push({ pitch: n.pitch, start: n.start, duration: n.end - n.start - 0.05, velocity: vel });
  });
  return out;
}

/**
 * Call and response: where the melody rests for a beat and a half or more (the end of a phrase),
 * the instrument echoes the phrase's last notes in its own register, moved onto the chord.
 */
function answers(melody: GenNote[], ctx: SectionCtx, plan: SectionPlan, [lo, hi]: [number, number]): GenNote[] {
  const bb = ctx.barBeats;
  const len = ctx.bars * bb;
  const notes = [...melody].sort((a, b) => a.start - b.start);
  const out: GenNote[] = [];
  const stopAt = plan.stop ?? len;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const end = n.start + n.duration;
    const next = notes[i + 1]?.start ?? len;
    const gap = Math.min(next, stopAt) - end;
    if (gap < 1.5) continue;
    // only at phrase ends (bars 2 and 4 of a phrase), so the answer is an event
    const bar = Math.floor(end / bb);
    if (bar % 2 === 0 && next < len) continue;
    if (n.start < plan.dropDown * bb) continue;
    const motif = notes.slice(Math.max(0, i - 2), i + 1);
    if (motif.length < 2) continue;
    const span = motif[motif.length - 1].start - motif[0].start;
    const start = Math.ceil((end + 0.25) * 2) / 2;
    const room = Math.min(next, stopAt) - start - 0.25;
    if (room < 0.75) continue;
    const squeeze = span > 0 ? Math.min(1, (room - 0.5) / span) : 1;
    // the instrument's octave: as close to the melody as its range allows, below it if possible
    let shift = -12;
    while (motif.some((m) => m.pitch + shift > hi)) shift -= 12;
    while (motif.some((m) => m.pitch + shift < lo)) shift += 12;
    motif.forEach((m, k) => {
      const t = start + (m.start - motif[0].start) * squeeze;
      if (t >= Math.min(next, stopAt) - 0.25) return;
      let pitch = m.pitch + shift;
      const tones = chordPitchClasses(chordAtBeat(ctx, t + 0.01).chord);
      if (k === motif.length - 1 && !tones.includes(((pitch % 12) + 12) % 12)) {
        // the answer ends on a chord tone
        for (let d = 1; d <= 3; d++) {
          if (tones.includes((((pitch - d) % 12) + 12) % 12)) {
            pitch -= d;
            break;
          }
          if (tones.includes((((pitch + d) % 12) + 12) % 12)) {
            pitch += d;
            break;
          }
        }
      }
      const dur = k === motif.length - 1 ? Math.min(1.5, Math.min(next, stopAt) - t - 0.1) : Math.max(0.2, Math.min(m.duration, 0.75) * squeeze);
      out.push({ pitch, start: t, duration: Math.max(0.15, dur), velocity: Math.round(m.velocity * 0.78) });
    });
  }
  return out;
}
