// Melody idea generator, following the principles melody-writing courses teach (Open Music
// Theory: "Phrase structure", "Embellishing tones", "Melodic structure in pop"; CC BY-SA):
//
// - Four-bar phrases made of two-bar ideas. Verses run statement, restatement, departure,
//   conclusion (a a′ b c); choruses repeat their hook (h h′ h c) so it sticks; pre-choruses
//   climb in sequence; bridges change register.
// - Chord tones on strong beats; passing and neighbour tones between them, always moving by
//   step; pop phrases push their downbeat an eighth early (anticipation).
// - One high point per phrase, leaps recovered by step in the other direction, no tritone or
//   wider-than-an-octave jumps.
// - Verses sit low and conversational, choruses higher with longer notes.
// - Phrases end open (on 2 or 5) while the song goes on, closed (on the tonic, stepping down
//   from 2 when it can) at the end of a chorus; a breath after every phrase.
//
// Seeded per section type, so a chorus melody comes back identically every time the chorus does.

import type { SectionType } from '../../core/types';
import { chordPitchClasses, scalePitchClasses } from '../theory';
import { chordAtBeat, clipToSection, humanizeNotes, rngFor, swingTime, type GenNote, type SectionCtx } from './common';

export type MelodyStyle = 'pop' | 'ballad' | 'edm' | 'trap' | 'lofi' | 'rock' | 'citypop' | 'rnb' | 'folk' | 'reggae' | 'jazz' | 'synthwave';

type Cell = [number, number][]; // [start, duration] in beats within two bars of 4/4

interface Profile {
  verse: Cell[];
  chorus: Cell[];
  pentatonic?: boolean; // no 4th / 7th (major) or 2nd / 6th (minor): nothing can clash
  colour?: boolean; // sevenths and ninths count as chord tones
  chromatic?: number; // chance of a chromatic approach into a strong beat
  anticipate?: number; // chance a phrase pushes its downbeat an eighth early
  repeats?: number; // same note this many times in a row at most
  legato?: boolean;
  sigh?: boolean; // the chorus climax leans in from the note above (an appoggiatura)
}

const PROFILES: Record<MelodyStyle, Profile> = {
  pop: {
    verse: [
      [[0.5, 0.5], [1, 0.5], [1.5, 1], [3, 0.5], [3.5, 0.5], [4, 1], [5, 0.5], [5.5, 0.5], [6, 1.5]],
      [[0.5, 0.5], [1, 1], [2, 0.5], [2.5, 1], [4.5, 0.5], [5, 0.5], [5.5, 0.5], [6, 2]],
      [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 1.5], [4, 0.5], [4.5, 0.5], [5, 0.5], [5.5, 0.5], [6, 1.5]],
    ],
    chorus: [
      [[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 1.5], [4, 0.5], [4.5, 0.5], [5, 0.5], [5.5, 1], [6.5, 1.5]],
      [[0, 1], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1], [4, 0.5], [4.5, 1], [5.5, 0.5], [6, 2]],
      [[0, 1.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5], [4, 1.5], [5.5, 0.5], [6, 2]],
    ],
    anticipate: 0.45,
    sigh: true,
  },
  ballad: {
    verse: [
      [[0, 1], [1, 0.5], [1.5, 0.5], [2, 2], [4, 1], [5, 1], [6, 2]],
      [[0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1.5], [4.5, 0.5], [5, 0.5], [5.5, 0.5], [6, 2]],
    ],
    chorus: [
      [[0, 0.5], [0.5, 0.5], [1, 1.5], [2.5, 0.5], [3, 1], [4, 1], [5, 0.5], [5.5, 0.5], [6, 2]],
      [[0, 1.5], [1.5, 0.5], [2, 2], [4, 1], [5, 1], [6, 2]],
    ],
    anticipate: 0.2,
    legato: true,
    sigh: true,
  },
  edm: {
    verse: [[[0, 0.75], [0.75, 0.75], [1.5, 1], [3, 0.5], [3.5, 0.5], [4, 0.75], [4.75, 0.75], [5.5, 1.5]]],
    chorus: [
      [[0, 0.5], [0.75, 0.5], [1.5, 0.5], [2, 0.5], [2.75, 0.75], [3.5, 0.5], [4, 0.5], [4.75, 0.5], [5.5, 0.5], [6, 0.5], [6.5, 1.5]],
      [[0, 0.75], [0.75, 0.75], [1.5, 0.5], [2, 1], [3, 1], [4, 0.75], [4.75, 0.75], [5.5, 0.5], [6, 2]],
    ],
    pentatonic: true,
    repeats: 3,
  },
  trap: {
    verse: [[[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2.5, 0.5], [3, 1], [4, 0.5], [4.5, 0.5], [5, 0.5], [5.75, 0.25], [6, 2]]],
    chorus: [[[0, 0.25], [0.25, 0.25], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5], [4, 0.5], [4.5, 0.5], [5, 1], [6, 0.5], [6.5, 1.5]]],
    pentatonic: true,
    repeats: 4,
  },
  lofi: {
    verse: [[[0.5, 0.75], [1.33, 0.67], [2, 1], [3.5, 0.5], [4.5, 0.5], [5, 1.5], [6.67, 1.33]]],
    chorus: [[[0, 0.5], [0.5, 1], [1.5, 0.5], [2, 1.5], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]]],
    colour: true,
    anticipate: 0.3,
  },
  rock: {
    verse: [[[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]]],
    chorus: [
      [[0, 1], [1, 1], [2, 1.5], [3.5, 0.5], [4, 1], [5, 0.5], [5.5, 0.5], [6, 2]],
      [[0, 0.5], [0.5, 1], [1.5, 0.5], [2, 2], [4, 0.5], [4.5, 1], [5.5, 0.5], [6, 2]],
    ],
    pentatonic: true,
    repeats: 3,
  },
  citypop: {
    verse: [[[0.25, 0.25], [0.5, 0.5], [1.25, 0.75], [2, 0.5], [2.75, 0.75], [3.5, 0.5], [4.5, 0.5], [5, 0.75], [5.75, 0.25], [6, 2]]],
    chorus: [[[0, 0.5], [0.5, 0.25], [0.75, 0.75], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5], [4, 0.75], [4.75, 0.75], [5.5, 0.5], [6, 2]]],
    colour: true,
    chromatic: 0.12,
    anticipate: 0.4,
  },
  rnb: {
    verse: [[[0.5, 0.25], [0.75, 0.75], [1.5, 0.5], [2.25, 0.75], [3.5, 0.5], [4.25, 0.25], [4.5, 1], [5.75, 0.25], [6, 2]]],
    chorus: [[[0, 0.75], [0.75, 0.25], [1, 1], [2.5, 0.5], [3, 1], [4, 0.75], [4.75, 0.75], [5.5, 0.5], [6, 2]]],
    colour: true,
    chromatic: 0.15,
    anticipate: 0.4,
  },
  folk: {
    verse: [[[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 1], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]]],
    chorus: [[[0, 1], [1, 0.5], [1.5, 0.5], [2, 2], [4, 1], [5, 1], [6, 2]]],
    pentatonic: true,
  },
  reggae: {
    verse: [[[0.5, 0.5], [1, 1], [2.5, 0.5], [3, 1], [4.5, 0.5], [5, 0.5], [5.5, 0.5], [6, 2]]],
    chorus: [[[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 1.5], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]]],
    pentatonic: true,
    anticipate: 0.2,
  },
  jazz: {
    verse: [[[0, 0.67], [0.67, 0.33], [1, 0.67], [1.67, 0.33], [2, 1], [3.67, 0.33], [4, 1], [5, 0.67], [5.67, 0.33], [6, 2]]],
    chorus: [[[0.67, 0.33], [1, 0.67], [1.67, 0.33], [2, 0.67], [2.67, 1.33], [4, 0.67], [4.67, 0.33], [5, 1], [6, 2]]],
    colour: true,
    chromatic: 0.3,
  },
  synthwave: {
    verse: [[[0, 1], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1], [4, 1.5], [5.5, 0.5], [6, 2]]],
    chorus: [[[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 1.5], [3, 1], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]]],
    anticipate: 0.2,
    legato: true,
  },
};

type Shape = 'arch' | 'high' | 'peak' | 'climax' | 'rise' | 'fall' | 'low';
type Ending = 'open' | 'closed';

interface Unit {
  kind: 'new' | 'vary' | 'repeat' | 'rise' | 'cadence';
  cell: 0 | 1; // which of the section's two rhythms
  shape: Shape;
  src?: number; // unit whose idea this one reuses
  end?: Ending;
}

const pc = (n: number) => ((n % 12) + 12) % 12;

/** Two-bar units of a section: the phrase plan for its role in the song (`alt` picks another
 * classic plan: a hook stated twice before it varies, or a verse that departs and returns). */
function planUnits(section: SectionType, units: number, ending: Ending, alt = false): Unit[] {
  const eight = (end: Ending, at: number): Unit[] => {
    switch (section) {
      case 'chorus':
      case 'drop':
        if (alt)
          return [
            { kind: 'new', cell: 0, shape: 'peak' },
            { kind: 'repeat', cell: 0, shape: 'peak', src: at },
            { kind: 'vary', cell: 0, shape: 'climax', src: at },
            { kind: 'cadence', cell: 0, shape: 'fall', src: at + 2, end },
          ];
        return [
          { kind: 'new', cell: 0, shape: 'peak' },
          { kind: 'vary', cell: 0, shape: 'peak', src: at },
          { kind: 'repeat', cell: 0, shape: 'peak', src: at },
          { kind: 'cadence', cell: 0, shape: 'fall', src: at + 1, end },
        ];
      case 'pre':
        return [
          { kind: 'new', cell: 0, shape: 'rise' },
          { kind: 'rise', cell: 0, shape: 'rise', src: at },
          { kind: 'rise', cell: 0, shape: 'rise', src: at + 1 },
          { kind: 'cadence', cell: 1, shape: 'high', src: at + 2, end: 'open' },
        ];
      case 'bridge':
        return [
          { kind: 'new', cell: 1, shape: 'low' },
          { kind: 'vary', cell: 1, shape: 'arch', src: at },
          { kind: 'new', cell: 0, shape: 'high' },
          { kind: 'cadence', cell: 0, shape: 'high', src: at + 2, end: 'open' },
        ];
      default: // verse, solo, intro, outro
        if (alt)
          return [
            { kind: 'new', cell: 0, shape: 'arch' },
            { kind: 'new', cell: 1, shape: 'high' },
            { kind: 'repeat', cell: 0, shape: 'arch', src: at },
            { kind: 'cadence', cell: 0, shape: 'fall', src: at, end },
          ];
        return [
          { kind: 'new', cell: 0, shape: 'arch' },
          { kind: 'vary', cell: 0, shape: 'arch', src: at },
          { kind: 'new', cell: 1, shape: 'high' },
          { kind: 'cadence', cell: 0, shape: 'fall', src: at, end },
        ];
    }
  };
  const cadence = (end: Ending): Unit => ({ kind: 'cadence', cell: 0, shape: section === 'pre' ? 'high' : 'fall', src: 0, end: section === 'pre' ? 'open' : end });
  if (units <= 1) return [{ kind: 'new', cell: 0, shape: section === 'chorus' ? 'peak' : 'arch', end: ending }];
  // a short pre-chorus climbs: its idea, then the same idea higher, held open into the chorus
  if (section === 'pre' && units === 2) return [eight('open', 0)[0], { kind: 'rise', cell: 0, shape: 'rise', src: 0, end: 'open' }];
  // a short section: its first idea (varied), then the cadence
  if (units < 4) return [...eight('open', 0).slice(0, units - 1), cadence(ending)];
  // long sections: the first eight bars close on a half cadence, the next ones restate them
  const out: Unit[] = [];
  for (let at = 0; at < units; at += 4) {
    const end = at + 4 >= units ? ending : 'open';
    const block = eight(end, 0).map((u, i) => (at === 0 || u.kind === 'cadence' ? u : { ...u, kind: 'repeat' as const, src: i }));
    out.push(...block.slice(0, units - at));
  }
  if (out[out.length - 1].kind !== 'cadence') out[out.length - 1] = cadence(ending);
  return out;
}

interface Placed {
  start: number; // beats from the section start
  len: number;
  pitch: number;
  strength: 2 | 1 | 0; // strong beat / beat / off-beat
}

export function generateMelody(style: MelodyStyle, ctx: SectionCtx, range: [number, number] = [60, 81]): GenNote[] {
  const rng = rngFor(ctx, 4);
  const prof = PROFILES[style] ?? PROFILES.pop;
  const [lo, hi] = range;
  const span = hi - lo;
  const chorusLike = ctx.section === 'chorus' || ctx.section === 'drop';
  const pool = chorusLike || ctx.section === 'solo' ? prof.chorus : prof.verse;
  const first = Math.floor(rng() * pool.length);
  const cells: [Cell, Cell] = [pool[first], pool[(first + 1) % pool.length]];
  const barScale = ctx.barBeats / 4;
  const unitLen = 2 * ctx.barBeats;
  const total = ctx.bars * ctx.barBeats;
  const units = Math.max(1, Math.ceil(ctx.bars / 2));
  const ending: Ending = ctx.section === 'chorus' || ctx.section === 'outro' || !ctx.next ? 'closed' : 'open';
  const plan = planUnits(ctx.section, units, ending, (ctx.variation ?? 0) % 2 === 1);

  // pitch material: the scale (or its pentatonic subset) inside the range
  const minorish = !['major', 'lydian', 'mixolydian'].includes(ctx.key.mode);
  let pcs = scalePitchClasses(ctx.key.root, ctx.key.mode);
  if (prof.pentatonic) pcs = pcs.filter((_, i) => (minorish ? i !== 1 && i !== 5 : i !== 3 && i !== 6));
  const tonic = ctx.key.root;
  const register: Partial<Record<SectionType, number>> = { verse: 0.32, pre: 0.42, chorus: 0.52, drop: 0.52, bridge: 0.45, solo: 0.5 };
  // each version of the song sits a little higher or lower
  const centre = lo + span * (register[ctx.section] ?? 0.42) + [0, 1.5, -1.5][(ctx.variation ?? 0) % 3];
  const amp = chorusLike ? 5 : ctx.section === 'pre' ? 6 : 3.5;

  /** Chord tones (and the scale minus notes clashing with a chromatic chord) at a beat. */
  const harmonyAt = (beat: number) => {
    const chord = chordAtBeat(ctx, beat + 0.01).chord;
    const all = chordPitchClasses(chord);
    const seventh = chord.quality === '7' || chord.quality === 'm7' || chord.quality === 'maj7';
    const tones = prof.colour ? all : all.slice(0, seventh ? 4 : 3);
    const foreign = tones.filter((t) => !pcs.includes(t));
    const scale = [...pcs.filter((s) => !foreign.some((f) => Math.abs(pc(s - f + 6) - 6) === 1)), ...foreign];
    return { tones, scale };
  };
  const shapeAt = (shape: Shape, u: number): number => {
    switch (shape) {
      case 'arch':
        return centre + amp * Math.sin(Math.PI * u);
      case 'high':
        return centre + 3 + amp * Math.sin(Math.PI * u);
      case 'peak':
        return centre + 2 + (amp + 2) * Math.sin(Math.PI * Math.min(1, u * 1.3));
      case 'climax':
        return centre + 4 + (amp + 2) * Math.sin(Math.PI * Math.min(1, u * 1.3));
      case 'rise':
        return centre - 2 + (amp + 3) * u;
      case 'fall':
        return centre + amp * (1 - u) - 1;
      case 'low':
        return centre - 3 + amp * Math.sin(Math.PI * u);
    }
  };
  const strengthOf = (at: number, len: number): 2 | 1 | 0 => {
    const inBar = at % 4;
    if (Math.abs(inBar % 2) < 1e-6 || len >= 1.5) return 2;
    return Math.abs(inBar - Math.round(inBar)) < 1e-6 ? 1 : 0;
  };

  const placed: Placed[] = [];
  const byUnit: Placed[][] = [];
  let prev = Math.round(centre);
  let prevStep = 0;
  let same = 0;

  /** Choose a pitch for one note: chord tone on strong beats, stepwise otherwise, near the contour. */
  const choose = (beat: number, strength: 2 | 1 | 0, target: number, cadence?: number[]): number => {
    const { tones, scale } = harmonyAt(beat);
    let best = prev;
    let bestCost = Infinity;
    const scored: [number, number][] = [];
    for (let p = Math.max(lo, prev - 9); p <= Math.min(hi, prev + 9); p++) {
      if (!scale.includes(pc(p))) continue;
      const iv = p - prev;
      const dist = Math.abs(iv);
      const chordTone = tones.includes(pc(p));
      let cost = 0.35 * Math.abs(p - target);
      if (!chordTone) cost += strength === 2 ? 8 : strength === 1 ? 2 : dist > 2 ? 3 : 0;
      cost += dist <= 2 ? 0 : dist <= 4 ? 0.5 : dist <= 7 ? 1.6 : 5;
      if (dist === 6) cost += 4;
      if (cadence && dist > 7) cost += 6; // phrase endings arrive, they don't jump
      if (Math.abs(prevStep) >= 5 && Math.sign(iv) === Math.sign(prevStep)) cost += 3; // recover a leap
      if (Math.abs(prevStep) >= 5 && Math.sign(iv) === -Math.sign(prevStep) && dist <= 2) cost -= 1;
      if (iv === 0) cost += same + 1 >= (prof.repeats ?? 2) ? 5 : 0.6;
      if (cadence) cost += cadence.includes(pc(p)) ? (cadence.indexOf(pc(p)) * 0.8) : 9;
      scored.push([p, cost]);
      if (cost < bestCost) {
        bestCost = cost;
        best = p;
      }
    }
    // a little choice among the near-best keeps melodies from all sounding alike
    const near = scored.filter(([, c]) => c <= bestCost + 0.6);
    if (near.length > 1) best = near[Math.floor(rng() * near.length)][0];
    return best;
  };
  const commit = (p: Placed, list: Placed[]) => {
    prevStep = p.pitch - prev;
    same = p.pitch === prev ? same + 1 : 0;
    prev = p.pitch;
    list.push(p);
  };
  const cadencePcs = (beat: number, end: Ending): number[] => {
    const { tones } = harmonyAt(beat);
    const prefer = end === 'closed' ? [0, 2, 4] : [4, 1, 6, 2, 5]; // scale degrees, best first
    const scaleDeg = scalePitchClasses(ctx.key.root, ctx.key.mode);
    const order = prefer.map((d) => scaleDeg[d]).filter((x) => tones.includes(x));
    return order.length ? order : tones;
  };

  /** Move a reused idea by whole scale steps to fit the new chords (a sequence when it moves),
   *  keeping it near the height the phrase plan wants (`target`). */
  const transposeFit = (src: Placed[], offset: number, want: 'any' | 'up', target: number): Placed[] => {
    let best: Placed[] = [];
    let bestScore = Infinity;
    for (let s = -4; s <= 4; s++) {
      if (want === 'up' && s <= 0) continue;
      const moved = src.map((n) => ({ ...n, start: n.start + offset, pitch: stepScale(n.pitch, s) }));
      const mean = moved.reduce((a, n) => a + n.pitch, 0) / moved.length;
      let score = Math.abs(s) * 0.4 + Math.abs(moved[0].pitch - prev) * 0.12 + Math.abs(mean - target) * 0.3;
      for (const n of moved) {
        if (n.pitch < lo || n.pitch > hi) score += 10;
        const { tones } = harmonyAt(n.start);
        if (!tones.includes(pc(n.pitch))) score += n.strength === 2 ? 3 : n.strength === 1 ? 1 : 0;
      }
      if (score < bestScore) {
        bestScore = score;
        best = moved;
      }
    }
    // strong beats that still miss the chord slide to the nearest chord tone
    return best.map((n) => {
      const { tones, scale } = harmonyAt(n.start);
      if (n.strength < 2 || tones.includes(pc(n.pitch))) return scale.includes(pc(n.pitch)) ? n : { ...n, pitch: nearestIn(n.pitch, scale) };
      return { ...n, pitch: nearestIn(n.pitch, tones) };
    });
  };
  /** The idea again where it can stay the same; strong beats that clash with the chord move. */
  const repeatFit = (src: Placed[], offset: number): Placed[] =>
    src.map((n) => {
      const moved = { ...n, start: n.start + offset };
      const { tones, scale } = harmonyAt(moved.start);
      if (moved.strength === 2 && !tones.includes(pc(n.pitch))) return { ...moved, pitch: nearestIn(n.pitch, tones) };
      return scale.includes(pc(n.pitch)) ? moved : { ...moved, pitch: nearestIn(n.pitch, scale) };
    });
  const nearestIn = (p: number, set: number[]) => {
    for (let d = 0; d <= 6; d++) {
      if (set.includes(pc(p - d)) && p - d >= lo) return p - d;
      if (set.includes(pc(p + d)) && p + d <= hi) return p + d;
    }
    return p;
  };
  const stepScale = (p: number, steps: number): number => {
    let q = p;
    const dir = Math.sign(steps);
    for (let k = 0; k < Math.abs(steps); k++) {
      q += dir;
      while (!pcs.includes(pc(q))) q += dir;
    }
    return q;
  };

  plan.forEach((unit, u) => {
    const base = u * unitLen;
    if (base >= total - 1e-6) return;
    const cell = cells[unit.cell];
    const notes: Placed[] = [];
    const src = unit.src !== undefined ? byUnit[unit.src] : undefined;
    if ((unit.kind === 'vary' || unit.kind === 'repeat' || unit.kind === 'rise') && src?.length) {
      const offset = base - Math.floor(src[0].start / unitLen) * unitLen;
      const moved = unit.kind === 'repeat' ? repeatFit(src, offset) : transposeFit(src, offset, unit.kind === 'rise' ? 'up' : 'any', shapeAt(unit.shape, 0.5));
      moved.forEach((n, i) => {
        if (n.start >= total - 1e-6) return;
        // a varied restatement keeps the rhythm and contour but changes its ending
        if (unit.kind === 'vary' && i === moved.length - 1 && moved.length > 2) n = { ...n, pitch: choose(n.start, n.strength, shapeAt(unit.shape, 1) + 1) };
        // a phrase that ends the section holds its last note on an open degree
        if (unit.end && i === moved.length - 1) n = { ...n, pitch: choose(n.start, 2, n.pitch, cadencePcs(n.start, unit.end)), len: Math.max(n.len, base + unitLen - n.start) };
        commit(n, notes);
      });
    } else {
      // cadence: the first bar of the reused idea, then a long final note
      const rhythm: Cell = unit.kind === 'cadence' ? [...cell.filter(([at]) => at < 4), [4, 3]] : cell;
      rhythm.forEach(([at, len], i) => {
        const start = base + at * barScale;
        if (start >= total - 1e-6) return;
        const strength = strengthOf(at, len);
        const last = i === rhythm.length - 1;
        const end = last ? unit.end : undefined;
        let pitch: number;
        if (unit.kind === 'cadence' && src && !last && src[i] && Math.abs(src[i].start - Math.floor(src[0].start / unitLen) * unitLen - at * barScale) < 1e-6) {
          pitch = src[i].pitch; // the cadence echoes its idea's opening
          if (strength === 2 && !harmonyAt(start).tones.includes(pc(pitch))) pitch = nearestIn(pitch, harmonyAt(start).tones);
        } else {
          pitch = choose(start, strength, shapeAt(unit.shape, at / 8), end ? cadencePcs(start, end) : undefined);
        }
        commit({ start, len: len * barScale, pitch, strength }, notes);
      });
    }
    byUnit[u] = notes;
    placed.push(...notes);
  });

  // a closed ending steps down into the tonic (2 → 1) when the note before allows it
  if (ending === 'closed' && placed.length >= 2) {
    const last = placed[placed.length - 1];
    const before = placed[placed.length - 2];
    const two = stepScale(last.pitch, 1);
    if (pc(last.pitch) === tonic && Math.abs(before.pitch - two) <= 4 && two <= hi) before.pitch = two;
  }
  // non-chord tones off the beat must resolve by step; otherwise take the chord tone (above or
  // below) that leads best to the next note without repeating the last one
  for (let i = 0; i < placed.length - 1; i++) {
    const n = placed[i];
    const { tones } = harmonyAt(n.start);
    if (n.strength === 2 || tones.includes(pc(n.pitch))) continue;
    const next = placed[i + 1].pitch;
    if (Math.abs(next - n.pitch) <= 2) continue;
    const before = i > 0 ? placed[i - 1].pitch : null;
    let best = n.pitch;
    let bestCost = Infinity;
    for (let q = n.pitch - 5; q <= n.pitch + 5; q++) {
      if (q < lo || q > hi || !tones.includes(pc(q))) continue;
      const cost = Math.abs(q - next) + Math.abs(q - n.pitch) * 0.5 + (q === before ? 3 : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = q;
      }
    }
    n.pitch = best;
  }
  // no note more times running than the style allows (twice, unless it chants): the one too
  // many turns into a neighbour
  const limit = prof.repeats ?? 2;
  for (let i = 1, run = 1; i < placed.length; i++) {
    const b = placed[i];
    run = b.pitch === placed[i - 1].pitch ? run + 1 : 1;
    if (run <= limit || i === placed.length - 1) continue;
    const { tones, scale } = harmonyAt(b.start);
    const set = b.strength === 2 ? tones : scale;
    const options = [stepScale(b.pitch, 1), stepScale(b.pitch, -1), b.pitch + 3, b.pitch + 4, b.pitch - 3, b.pitch - 4].filter((q) => q >= lo && q <= hi && set.includes(pc(q)));
    if (options.length) {
      b.pitch = options[0];
      run = 1;
    }
  }
  // the climax of a chorus leans in from the scale note above: a dissonance on the beat that
  // resolves down by step, the device most often found where listeners report tears
  if (chorusLike && prof.sigh) {
    let at = -1;
    placed.forEach((n, i) => {
      if (n.len >= 1 && n.strength >= 1 && (at < 0 || n.pitch > placed[at].pitch)) at = i;
    });
    const top = placed[at];
    if (top) {
      const chord = chordAtBeat(ctx, top.start + 0.01).chord;
      const upper = stepScale(top.pitch, 1);
      const clash = pc(upper - chord.root) === 1 || pc(upper - chord.bass) === 1;
      if (upper <= hi && !chordPitchClasses(chord).includes(pc(upper)) && !clash) {
        placed.splice(at, 0, { start: top.start, len: 0.5, pitch: upper, strength: top.strength });
        top.start += 0.5;
        top.len -= 0.5;
        top.strength = 0;
      }
    }
  }
  // chromatic approach tones (jazz, R&B): the off-beat before a strong beat leans into it
  for (let i = 0; i < placed.length - 1; i++) {
    const a = placed[i];
    const b = placed[i + 1];
    if (a.strength === 0 && b.strength === 2 && a.len <= 0.5 && Math.abs(b.pitch - a.pitch) <= 4 && rng() < (prof.chromatic ?? 0)) {
      a.pitch = b.pitch + (a.pitch > b.pitch ? 1 : -1);
    }
  }

  // timing: durations to the next note, a breath after every phrase, pushed downbeats
  const out: GenNote[] = [];
  const gap = prof.legato ? 0.03 : 0.06;
  placed.forEach((n, i) => {
    const next = placed[i + 1];
    const unitEnd = (Math.floor(n.start / unitLen) + 1) * unitLen;
    const phraseEnd = (Math.floor(n.start / (2 * unitLen)) + 1) * 2 * unitLen;
    let end = Math.min(n.start + n.len, next ? next.start : total);
    const lastOfPhrase = !next || next.start >= phraseEnd - 1e-6;
    if (lastOfPhrase && next) end = Math.min(end, phraseEnd - 0.5);
    else if (!next) end = Math.min(end, total - 0.25);
    else if (next.start >= unitEnd - 1e-6) end = Math.min(end, next.start - 0.25); // a short breath between ideas
    const dur = Math.max(0.15, end - n.start - gap);
    const climb = Math.max(-6, Math.min(6, (n.pitch - centre) * 0.6));
    const velocity = Math.round((chorusLike ? 100 : ctx.section === 'pre' ? 94 : 88) + (n.strength === 2 ? 6 : n.strength === 0 ? -6 : 0) + climb - (lastOfPhrase ? 4 : 0));
    out.push({ pitch: n.pitch, start: n.start, duration: dur, velocity: Math.max(40, Math.min(127, velocity)) });
  });
  // pop phrases often push the downbeat that starts them an eighth early (the note before
  // makes room when it is long enough)
  for (let i = 1; i < out.length; i++) {
    const n = out[i];
    const p = out[i - 1];
    if (Math.abs(n.start % unitLen) > 1e-6 || rng() >= (prof.anticipate ?? 0)) continue;
    const room = n.start - 0.6 - p.start;
    if (p.start + p.duration > n.start - 0.6 && room < 0.45) continue;
    p.duration = Math.min(p.duration, room);
    n.start -= 0.5;
    n.duration += 0.5;
  }
  let notes = out.map((n) => ({ ...n, start: swingTime(n.start, ctx.swing, ctx.swingUnit) }));
  notes = humanizeNotes(notes, ctx.humanize * 0.5, rng);
  return clipToSection(notes, ctx);
}
