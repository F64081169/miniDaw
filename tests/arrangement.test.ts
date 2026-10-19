import { describe, expect, it } from 'vitest';
import { DRUM_NOTE } from '../src/audio/dsp/drums';
import { defaultCoachState, emotionMap, regionsForRole, songSections } from '../src/music/coach';
import { planSong, shapePart } from '../src/music/generate/arrange';
import classics from '../src/music/genres/classics.json';
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
      const tones = (at: number) => chordPitchClasses(chordAt(ctx.chords, at + 0.01).chord);
      // an appoggiatura (a dissonance on the beat that steps down into a chord tone) is intended
      const sigh = (n: (typeof notes)[number]) => {
        const next = notes[notes.indexOf(n) + 1];
        return !!next && n.pitch - next.pitch > 0 && n.pitch - next.pitch <= 2 && next.start - n.start <= 1 && tones(next.start).includes(next.pitch % 12);
      };
      const fit = strong.filter((n) => tones(n.start).includes(n.pitch % 12) || sigh(n));
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

describe('song shape (breathing)', () => {
  const genre = (id: string) => GENRES.find((g) => g.id === id)!;
  const song = (id: string, seeds?: Record<string, number>) => {
    const g = genre(id);
    const p = createProject();
    p.bpm = g.bpm.default;
    const s = { ...defaultCoachState(g), seeds };
    const sections = songSections(p, g, s);
    return { g, p, s, sections, part: (roleId: string) => regionsForRole(p, g, s, g.roles.find((r) => r.id === roleId)!) };
  };

  it('plans more energy as the song goes on, the last chorus the biggest', () => {
    const g = genre('pop');
    const p = createProject();
    const s = defaultCoachState(g);
    const sections = songSections(p, g, s);
    const ctxs = sections.map((sec, i) => ({ ...ctxFor(sec.type, { bars: sec.bars, next: sections[i + 1]?.type ?? null, isLast: i === sections.length - 1 }), occurrence: sections.slice(0, i + 1).filter((x) => x.type === sec.type).length }));
    const plans = planSong('pop', ctxs, 0);
    const verses = plans.filter((_, i) => sections[i].type === 'verse');
    const choruses = plans.filter((_, i) => sections[i].type === 'chorus');
    expect(verses[0].energy).toBeLessThan(verses[1].energy);
    expect(choruses[choruses.length - 1].lift).toBe(true);
    expect(choruses[choruses.length - 1].energy).toBeGreaterThan(choruses[0].energy);
    const pre = plans[sections.findIndex((x) => x.type === 'pre')];
    expect(pre.dyn[1]).toBeGreaterThan(pre.dyn[0]); // crescendo into the chorus
  });

  it('every generation is a new version, and choruses stay the same inside one', () => {
    const a = song('pop', { drums: 11, lead: 11, '@song': 11 });
    const b = song('pop', { drums: 22, lead: 22, '@song': 22 });
    const sig = (r: { notes: { pitch: number; start: number }[] }) => r.notes.map((n) => `${n.pitch}@${n.start.toFixed(2)}`).join(',');
    expect(a.part('lead').map(sig).join('|')).not.toBe(b.part('lead').map(sig).join('|'));
    expect(a.part('drums').map(sig).join('|')).not.toBe(b.part('drums').map(sig).join('|'));
    // the same seeds give the same song
    expect(a.part('lead').map(sig)).toEqual(song('pop', { drums: 11, lead: 11, '@song': 11 }).part('lead').map(sig));
    const choruses = a.part('lead').filter((r) => r.name === '副歌');
    expect(sig(choruses[0])).toBe(sig(choruses[1]));
  });

  it('the band can stop for a breath before a chorus', () => {
    const ctx = ctxFor('pre', { bars: 4, next: 'chorus' });
    const plan = { energy: 0.7, dyn: [1, 1] as [number, number], swell: 0, stop: 15, kickOut: null, enter: {}, dropDown: 0, lift: false, fade: false, shift: 0 };
    const notes = generateDrums('pop', ctx);
    const shaped = shapePart(notes, 'drums', ctx, plan);
    expect(shaped.every((n) => n.start < 15)).toBe(true);
    const melody = [{ pitch: 72, start: 15.5, duration: 0.5, velocity: 90 }];
    expect(shapePart(melody, 'melody', ctx, plan)).toHaveLength(1); // the pickup stays
  });

  it('the last chorus can start stripped down and open up', () => {
    const ctx = ctxFor('chorus', { next: null });
    const plan = { energy: 1, dyn: [1, 1] as [number, number], swell: 0, stop: null, kickOut: null, enter: {}, dropDown: 4, lift: true, fade: false, shift: 0 };
    const drums = shapePart(generateDrums('pop', ctx), 'drums', ctx, plan, { crash: true });
    const early = drums.filter((n) => n.start < 12);
    expect(early.some((n) => n.pitch === DRUM_NOTE.crash)).toBe(false);
    expect(early.filter((n) => n.pitch === DRUM_NOTE.snare).length).toBeLessThanOrEqual(6); // only the build
    expect(drums.some((n) => n.pitch === DRUM_NOTE.crash && Math.abs(n.start - 16) < 1e-9)).toBe(true);
    const layers = shapePart([{ pitch: 60, start: 1, duration: 2, velocity: 80 }, { pitch: 60, start: 17, duration: 2, velocity: 80 }], 'layers', ctx, plan);
    expect(layers.map((n) => n.start)).toEqual([17]);
  });

  it('first verses are sparse: drums wait in Mandopop, layers join halfway', () => {
    const m = song('mandopop');
    const verse1 = m.sections.find((x) => x.type === 'verse')!;
    expect(m.part('drums').some((r) => r.start === verse1.start)).toBe(false);
    const pop = song('pop');
    const v1 = pop.sections.find((x) => x.type === 'verse')!;
    const guitar = pop.part('guitar').find((r) => r.start === v1.start)!;
    expect(Math.min(...guitar.notes.map((n) => n.start))).toBeGreaterThanOrEqual(16);
  });

  it('an instrument answers the melody in its gaps', () => {
    const ctx = ctxFor('verse');
    const plan = { energy: 0.6, dyn: [1, 1] as [number, number], swell: 0, stop: null, kickOut: null, enter: {}, dropDown: 0, lift: false, fade: false, shift: 0 };
    // a phrase ending in its second bar, then a rest until bar 4
    const melody = [
      { pitch: 72, start: 4, duration: 0.5, velocity: 90 },
      { pitch: 74, start: 4.5, duration: 0.5, velocity: 90 },
      { pitch: 76, start: 5, duration: 1, velocity: 90 },
      { pitch: 74, start: 12, duration: 1, velocity: 90 },
    ];
    const shaped = shapePart([], 'harmony', ctx, plan, { melody, answer: true, range: [55, 79] });
    expect(shaped.filter((n) => n.start >= 6 && n.start < 12).length).toBeGreaterThanOrEqual(2);
    for (const n of shaped) {
      // answers only sound while the melody rests
      expect(melody.some((m) => n.start >= m.start - 1e-9 && n.start < m.start + m.duration)).toBe(false);
      expect(n.pitch).toBeLessThanOrEqual(79);
      expect(n.pitch).toBeGreaterThanOrEqual(55);
    }
  });

  it('the last section fades out', () => {
    const ctx = ctxFor('outro', { bars: 4, next: null, isLast: true });
    const [plan] = planSong('pop', [ctx], 0);
    const notes = Array.from({ length: 16 }, (_, i) => ({ pitch: 60, start: i, duration: 0.9, velocity: 100 }));
    const shaped = shapePart(notes, 'harmony', ctx, plan);
    expect(shaped[shaped.length - 1].velocity).toBeLessThan(shaped[0].velocity - 15);
  });
});

describe('emotional devices', () => {
  const genre = (id: string) => GENRES.find((g) => g.id === id)!;
  const setup = (id: string, seed: number) => {
    const g = genre(id);
    const p = createProject();
    p.bpm = g.bpm.default;
    const s = { ...defaultCoachState(g), seeds: Object.fromEntries(['@song', ...g.roles.map((r) => r.id)].map((k, i) => [k, seed * 1000 + i + 1])) };
    const sections = songSections(p, g, s);
    const part = (roleId: string) => regionsForRole(p, g, s, g.roles.find((r) => r.id === roleId)!);
    return { g, p, s, sections, part };
  };
  const bassIn = (regions: { start: number; notes: { pitch: number; start: number }[] }[], beat: number) => {
    for (const r of regions) for (const n of r.notes) if (Math.abs(r.start + n.start - beat) < 0.3) return n.pitch % 12;
    return null;
  };

  it('ends the pre-chorus on the dominant and turns the bridge to new chords', () => {
    const { s, sections, part } = setup('mandopop', 7);
    const bass = part('bass');
    const pre = sections.find((x) => x.type === 'pre')!;
    expect(bassIn(bass, pre.start + (pre.bars - 1) * 4)).toBe((s.keyRoot + 7) % 12);
    const bridge = sections.find((x) => x.type === 'bridge')!;
    expect(bassIn(bass, bridge.start)).toBe((s.keyRoot + 9) % 12); // vi
  });

  it('a key change lifts the whole last chorus, the same melody higher', () => {
    let found = false;
    for (let seed = 1; seed < 40 && !found; seed++) {
      const { g, p, s, sections, part } = setup('mandopop', seed);
      const map = emotionMap(p, g, s);
      const at = map.findIndex((e) => e.devices.some((d) => d.startsWith('升 Key')));
      if (at < 0) continue;
      found = true;
      const choruses = sections.map((x, i) => [x, i] as const).filter(([x]) => x.type === 'chorus');
      const [first] = choruses[0];
      const [last, lastIdx] = choruses[choruses.length - 1];
      expect(lastIdx).toBe(at);
      const lead = part('lead');
      const notes = (sec: { start: number }) => lead.find((r) => r.start === sec.start)!.notes.map((n) => n.pitch);
      const a = notes(first);
      const b = notes(last);
      const shift = b[b.length - 1] - a[a.length - 1];
      expect([1, 2]).toContain(shift);
      expect(b).toEqual(a.map((x) => x + shift));
    }
    expect(found).toBe(true);
  });

  it('leans into a chorus climax with an appoggiatura when the melody allows it', () => {
    let sighs = 0;
    for (const seed of [3, 5, 7, 11, 13, 17, 19, 23]) {
      const { g, p, s } = setup('ballad', seed);
      if (emotionMap(p, g, s).some((e) => e.devices.some((d) => d.startsWith('倚音')))) sighs++;
    }
    expect(sighs).toBeGreaterThan(0);
  });

  it('maps every section to an emotional role, the last chorus as the high point', () => {
    const { g, p, s, sections } = setup('pop', 11);
    const map = emotionMap(p, g, s);
    expect(map).toHaveLength(sections.length);
    const lastChorus = sections.map((x) => x.type).lastIndexOf('chorus');
    expect(map[lastChorus].role).toContain('最後一擊');
    expect(map.every((e) => e.role.length > 0)).toBe(true);
    expect(map[0].devices[0]).toMatch(/^只有/);
  });
});

describe('classic songs', () => {
  it.each(GENRES.map((g) => [g.id] as const))('%s has three classic songs to learn from', (id) => {
    const c = (classics as Record<string, { songs: { title: string; why: string; listen: string[]; sources: string[] }[]; lessons: string[]; verified?: boolean }>)[id];
    expect(c.songs).toHaveLength(3);
    expect(c.lessons.length).toBeGreaterThanOrEqual(2);
    for (const song of c.songs) {
      expect(song.why.length).toBeGreaterThan(10);
      expect(song.listen.length).toBeGreaterThanOrEqual(2);
      if (c.verified !== false) expect(song.sources.length).toBeGreaterThan(0);
    }
  });
});
