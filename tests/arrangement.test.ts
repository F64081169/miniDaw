import { describe, expect, it } from 'vitest';
import { DRUM_NOTE } from '../src/audio/dsp/drums';
import { defaultCoachState, regionsForRole } from '../src/music/coach';
import { SECTION_ENERGY, type SectionCtx } from '../src/music/generate/common';
import { HUMAN_FEEL, generateDrums, kickPositions } from '../src/music/generate/drums';
import { generateMelody } from '../src/music/generate/melody';
import grooves from '../src/music/grooves/gmd.json';
import { GENRES } from '../src/music/genres';
import { chordAt, chordPitchClasses, parseProgression, tileProgression } from '../src/music/theory';
import { createProject } from '../src/state/project';
import type { SectionType } from '../src/core/types';

function ctxFor(section: SectionType, opts: Partial<SectionCtx> = {}): SectionCtx {
  const bars = opts.bars ?? 8;
  return {
    section,
    bars,
    barBeats: 4,
    timeSig: [4, 4],
    chords: tileProgression(parseProgression('I | V | vi | IV', 0, 'major', 4), bars * 4),
    key: { root: 0, mode: 'major' },
    energy: SECTION_ENERGY[section],
    isFirst: false,
    isLast: false,
    next: 'chorus',
    swing: 0,
    swingUnit: 0.25,
    humanize: 0.3,
    seed: 12345,
    bpm: 110,
    ...opts,
  };
}

const styles = (grooves as unknown as { styles: Record<string, { grooves: { bpm: number; main: [number, string, number][]; busy: unknown[]; fills: { from: number; notes: unknown[] }[] }[] }> }).styles;

describe('recorded drum grooves', () => {
  it.each(Object.keys(HUMAN_FEEL))('%s has grooves and fills', (style) => {
    const entry = styles[style];
    expect(entry.grooves.length).toBeGreaterThanOrEqual(2);
    expect(entry.grooves.some((g) => g.fills.length > 0)).toBe(true);
    for (const g of entry.grooves) {
      expect(g.main.length).toBeGreaterThan(8);
      for (const [t, piece, v] of g.main) {
        expect(t).toBeGreaterThanOrEqual(-0.12);
        expect(t).toBeLessThan(8);
        expect(piece in DRUM_NOTE).toBe(true);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(127);
      }
    }
  });

  it('the big sections of city pop play disco grooves', () => {
    expect(styles[HUMAN_FEEL.citypop.high!].grooves.length).toBeGreaterThan(0);
  });

  it('thins out quiet sections and opens up big ones', () => {
    const intro = generateDrums('pop', ctxFor('intro', { next: 'verse' }));
    const chorus = generateDrums('pop', ctxFor('chorus', { next: 'verse' }));
    expect(intro.some((n) => n.pitch === DRUM_NOTE.rim)).toBe(true); // cross-stick backbeat
    expect(intro.filter((n) => n.pitch === DRUM_NOTE.snare && n.start < 28).length).toBe(0);
    expect(chorus.some((n) => n.pitch === DRUM_NOTE.crash && n.start === 0)).toBe(true);
    expect(chorus.some((n) => n.pitch === DRUM_NOTE.clap)).toBe(true);
    const avg = (ns: typeof intro) => ns.reduce((a, n) => a + n.velocity, 0) / ns.length;
    expect(avg(chorus)).toBeGreaterThan(avg(intro));
  });

  it('fills the last bar before a chorus', () => {
    const verse = generateDrums('rock', ctxFor('verse', { next: 'chorus' }));
    const lastBar = verse.filter((n) => n.start >= 28);
    const toms = [DRUM_NOTE.tomH, DRUM_NOTE.tomM, DRUM_NOTE.tomL];
    const busy = lastBar.filter((n) => toms.includes(n.pitch) || n.pitch === DRUM_NOTE.snare || n.pitch === DRUM_NOTE.snare2);
    expect(busy.length).toBeGreaterThan(3);
  });

  it('ends the song on a crash', () => {
    const outro = generateDrums('pop', ctxFor('outro', { isLast: true, next: null, bars: 4 }));
    const last = outro.filter((n) => n.start >= 12);
    expect(last.map((n) => n.pitch).sort()).toEqual([DRUM_NOTE.kick, DRUM_NOTE.crash].sort());
  });

  it('moves the groove to the song swing', () => {
    const at = (swing: number) => generateDrums('lofi', ctxFor('verse', { swing, swingUnit: 0.5, bpm: 80 }));
    const straight = at(0);
    const swung = at(0.6);
    expect(swung.length).toBe(straight.length);
    // off-beat eighths move later by the same amount, downbeats stay
    const shifts = straight.map((n, i) => ({ pos: n.start % 1, d: swung[i].start - n.start }));
    const off = shifts.filter((x) => x.pos > 0.3 && x.pos < 0.7).map((x) => x.d);
    const on = shifts.filter((x) => x.pos < 0.1 || x.pos > 0.9).map((x) => x.d);
    expect(off.length).toBeGreaterThan(8);
    for (const d of off) expect(d).toBeCloseTo(0.6 * (0.5 / 3) * 0.8, 3);
    for (const d of on) expect(Math.abs(d)).toBeLessThan(1e-9);
  });

  it('reports kick positions on the 16th grid without ghost notes', () => {
    const ctx = ctxFor('verse');
    const kicks = kickPositions('pop', ctx, 60);
    expect(kicks.length).toBeGreaterThan(8);
    for (const k of kicks) expect(Math.abs(k * 4 - Math.round(k * 4))).toBeLessThan(1e-9);
  });

  it('keeps programmed patterns for electronic styles and odd meters', () => {
    const house = generateDrums('house', ctxFor('chorus'));
    expect(house.filter((n) => n.pitch === DRUM_NOTE.kick).every((n) => Math.abs(n.start - Math.round(n.start)) < 1e-9)).toBe(true);
    const waltz = generateDrums('pop', ctxFor('verse', { barBeats: 3, timeSig: [3, 4], chords: tileProgression(parseProgression('I | V', 0, 'major', 3), 24) }));
    expect(waltz.length).toBeGreaterThan(0);
  });
});

describe('melody writing', () => {
  const range: [number, number] = [60, 81];
  const melody = (section: SectionType, opts: Partial<SectionCtx> = {}) => generateMelody('pop', ctxFor(section, opts), range);

  it('puts chord tones on strong beats', () => {
    for (const section of ['verse', 'pre', 'chorus', 'bridge'] as SectionType[]) {
      const ctx = ctxFor(section);
      const notes = melody(section);
      const strong = notes.filter((n) => Math.abs(n.start % 2) < 0.03);
      const fit = strong.filter((n) => chordPitchClasses(chordAt(ctx.chords, n.start + 0.01).chord).includes(n.pitch % 12));
      expect(fit.length / strong.length).toBeGreaterThan(0.9);
    }
  });

  it('moves mostly by step, never leaps more than an octave, stays in range', () => {
    const notes = [...melody('verse'), ...melody('chorus')];
    let steps = 0;
    for (let i = 1; i < notes.length; i++) {
      const d = Math.abs(notes[i].pitch - notes[i - 1].pitch);
      expect(d).toBeLessThanOrEqual(12);
      if (d <= 2) steps++;
    }
    expect(steps / notes.length).toBeGreaterThan(0.5);
    for (const n of notes) {
      expect(n.pitch).toBeGreaterThanOrEqual(range[0]);
      expect(n.pitch).toBeLessThanOrEqual(range[1]);
    }
  });

  it('sings the chorus higher than the verse', () => {
    const mean = (ns: { pitch: number }[]) => ns.reduce((a, n) => a + n.pitch, 0) / ns.length;
    expect(mean(melody('chorus'))).toBeGreaterThan(mean(melody('verse')) + 2);
  });

  it('repeats the chorus hook and ends the chorus on the tonic', () => {
    const notes = melody('chorus', { next: 'verse' });
    const bars = (from: number) => notes.filter((n) => n.start >= from - 0.6 && n.start < from + 7.4).map((n) => n.pitch);
    const a = bars(0);
    const b = bars(16);
    const same = a.filter((p, i) => b[i] === p).length;
    expect(same / a.length).toBeGreaterThan(0.6);
    expect(notes[notes.length - 1].pitch % 12).toBe(0);
  });

  it('breathes between phrases', () => {
    const notes = melody('verse');
    for (const at of [16]) {
      const before = notes.filter((n) => n.start < at - 0.6);
      const last = before[before.length - 1];
      const next = notes.find((n) => n.start >= at - 0.6)!;
      expect(next.start - (last.start + last.duration)).toBeGreaterThanOrEqual(0.4);
    }
  });

  it('is the same every time for the same section', () => {
    expect(melody('chorus')).toEqual(melody('chorus'));
  });

  it('writes a melody for every genre lead', () => {
    for (const g of GENRES) {
      const p = createProject();
      p.bpm = g.bpm.default;
      for (const role of g.roles.filter((r) => r.kind === 'melody')) {
        const regions = regionsForRole(p, g, defaultCoachState(g), role);
        expect(regions.reduce((a, r) => a + r.notes.length, 0)).toBeGreaterThan(8);
      }
    }
  });
});
