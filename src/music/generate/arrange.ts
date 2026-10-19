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

import { DRUM_NOTE } from '../../audio/dsp/drums';
import type { SectionType } from '../../core/types';
import { chordPitchClasses } from '../theory';
import { SECTION_ENERGY, chordAtBeat, type GenNote, type SectionCtx } from './common';

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
}

const DEFAULT_BREATH: BreathProfile = { stop: 0.3, intro: 'layered', firstVerseDrums: 'all', dropDown: 0, answer: false, ramp: 1, dropGap: 0.6, kickOut: false };

export const BREATH: Record<string, Partial<BreathProfile>> = {
  pop: { stop: 0.5, intro: 'layered', dropDown: 0.7, answer: true },
  mandopop: { stop: 0.4, intro: 'solo', firstVerseDrums: 'none', dropDown: 0.7, answer: true, ramp: 1.2 },
  ballad: { stop: 0.35, intro: 'solo', dropDown: 0.6, answer: true, ramp: 1.4 },
  rock: { stop: 0.5, intro: 'layered', dropDown: 0.5, answer: true, ramp: 0.9 },
  metal: { stop: 0.6, intro: 'full', ramp: 0.7 },
  country: { stop: 0.3, intro: 'layered', dropDown: 0.5, answer: true, ramp: 0.9 },
  hiphop: { stop: 0.6, intro: 'layered', ramp: 0.6, kickOut: true },
  trap: { stop: 0.6, intro: 'layered', ramp: 0.6, kickOut: true },
  lofi: { stop: 0.2, intro: 'layered', ramp: 0.6, kickOut: true },
  rnb: { stop: 0.4, intro: 'layered', dropDown: 0.5, answer: true },
  house: { stop: 0, intro: 'layered', ramp: 0.8, dropGap: 0.7 },
  edm: { stop: 0, intro: 'layered', ramp: 0.8, dropGap: 0.85 },
  synthwave: { stop: 0.3, intro: 'layered', answer: true, ramp: 0.8 },
  jazz: { stop: 0.1, intro: 'full', answer: true, ramp: 0.8 },
  bossa: { stop: 0.1, intro: 'solo', answer: true, ramp: 0.8 },
  funk: { stop: 0.6, intro: 'layered', answer: true, ramp: 0.8 },
  citypop: { stop: 0.4, intro: 'full', dropDown: 0.5, answer: true },
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
  let chorusSeen = 0;
  return ctxs.map((c) => {
    const occ = c.occurrence ?? 1;
    const bars = c.bars;
    let energy = SECTION_ENERGY[c.section];
    let dyn: [number, number] = [0.93, 0.95];
    const plan: SectionPlan = { energy, dyn, swell: 0.06 * p.ramp, stop: null, kickOut: null, enter: {}, dropDown: 0, lift: false, fade: false };
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

  // a breath before the next section: everyone but the melody stops
  if (plan.stop !== null && part !== 'melody') {
    const at = plan.stop;
    out = out.filter((n) => n.start < at - 1e-6).map((n) => (n.start + n.duration > at - 0.05 ? { ...n, duration: Math.max(0.1, at - 0.05 - n.start) } : n));
  }

  // the biggest chorus: pads double the hook an octave down; drums add a crash halfway
  if (plan.lift && opts.double && opts.melody?.length) {
    const [lo, hi] = opts.range ?? [48, 84];
    for (const m of opts.melody) {
      let p = m.pitch - 12;
      while (p < lo) p += 12;
      if (p > hi) continue;
      if (m.start >= plan.dropDown * bb) out.push({ pitch: p, start: m.start, duration: m.duration, velocity: m.velocity * 0.6 });
    }
  }
  if (plan.lift && part === 'drums' && opts.crash && ctx.bars >= 8) out.push(hit(DRUM_NOTE.crash, 4 * bb, 96, 1));

  // an answer to the melody in the gaps between its phrases
  if (opts.answer && opts.melody?.length && part !== 'melody') out.push(...answers(opts.melody, ctx, plan, opts.range ?? [55, 79]));

  // the song lets its last chord ring
  if (plan.fade && part !== 'drums') {
    const lastBar = (ctx.bars - 1) * bb;
    out = out.map((n) => (n.start >= lastBar - 1e-6 ? { ...n, duration: Math.max(n.duration, len - n.start - 0.05) } : n));
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
