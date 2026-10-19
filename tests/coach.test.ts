import { describe, expect, it, vi } from 'vitest';
import { GENRES } from '../src/music/genres';
import { applyAll, applyStep, buildSteps, defaultCoachState, patchForRole, patchOptions, regionsForRole, selectGenre, songSections } from '../src/music/coach';
import { useDaw } from '../src/state/store';
import { createProject } from '../src/state/project';
import { PATCH_BY_ID } from '../src/audio/instruments/patches';
import { DRUM_STYLES } from '../src/music/generate/drums';
import { parseProgression } from '../src/music/theory';

describe('genre definitions', () => {
  it('has many genres with unique ids', () => {
    expect(GENRES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(GENRES.map((g) => g.id)).size).toBe(GENRES.length);
  });
  it.each(GENRES.map((g) => [g.id, g] as const))('%s is consistent', (_id, g) => {
    expect(g.bpm.min).toBeLessThanOrEqual(g.bpm.default);
    expect(g.bpm.default).toBeLessThanOrEqual(g.bpm.max);
    for (const p of g.progressions) {
      expect(() => parseProgression(p.prog, 0, 'major', 4)).not.toThrow();
      if (p.chorus) expect(() => parseProgression(p.chorus!, 0, 'major', 4)).not.toThrow();
    }
    for (const r of g.roles) {
      expect(PATCH_BY_ID.has(r.patch)).toBe(true);
      for (const alt of r.alts ?? []) expect(PATCH_BY_ID.has(alt.patch)).toBe(true);
      if (r.kind === 'drums') expect(DRUM_STYLES[r.style]).toBeDefined();
    }
    expect(new Set(g.roles.map((r) => r.id)).size).toBe(g.roles.length);
    expect(g.roles.some((r) => r.step === 'harmony')).toBe(true);
  });
});

describe('arrangement generation', () => {
  it.each(GENRES.map((g) => [g.id, g] as const))('%s generates every role for every progression', (_id, g) => {
    const p = createProject();
    p.timeSig = g.timeSig;
    p.bpm = g.bpm.default;
    for (let pi = 0; pi < g.progressions.length; pi++) {
      const s = { ...defaultCoachState(g), progressionIndex: pi };
      const sections = songSections(p, g, s);
      expect(sections.length).toBeGreaterThan(1);
      for (const role of g.roles) {
        const regions = regionsForRole(p, g, s, role);
        expect(regions.length).toBeGreaterThan(0);
        for (const r of regions) {
          expect(r.notes.length).toBeGreaterThan(0);
          for (const n of r.notes) {
            expect(n.start).toBeGreaterThanOrEqual(0);
            expect(n.start).toBeLessThan(r.length);
            expect(n.duration).toBeGreaterThan(0);
            expect(n.pitch).toBeGreaterThanOrEqual(0);
            expect(n.pitch).toBeLessThanOrEqual(127);
            expect(n.velocity).toBeGreaterThanOrEqual(1);
            expect(n.velocity).toBeLessThanOrEqual(127);
            expect(Number.isFinite(n.start + n.duration + n.pitch + n.velocity)).toBe(true);
          }
        }
      }
    }
    const steps = buildSteps(g, defaultCoachState(g));
    expect(steps.length).toBeGreaterThanOrEqual(9);
  });

  it('808 bass locks to the trap kick', () => {
    const g = GENRES.find((x) => x.id === 'trap')!;
    const p = createProject();
    const s = defaultCoachState(g);
    const bass = regionsForRole(p, g, s, g.roles.find((r) => r.id === 'bass')!);
    const drums = regionsForRole(p, g, s, g.roles.find((r) => r.id === 'drums')!);
    const kickStarts = new Set(drums.flatMap((r) => r.notes.filter((n) => n.pitch === 36).map((n) => (r.start + n.start).toFixed(3))));
    const bassStarts = bass.flatMap((r) => r.notes.map((n) => (r.start + n.start).toFixed(3)));
    const matched = bassStarts.filter((b) => kickStarts.has(b)).length;
    expect(matched / bassStarts.length).toBeGreaterThan(0.9);
  });

  it('chorus melodies repeat identically', () => {
    const g = GENRES.find((x) => x.id === 'pop')!;
    const p = createProject();
    const s = defaultCoachState(g);
    const lead = regionsForRole(p, g, s, g.roles.find((r) => r.id === 'lead')!);
    const choruses = lead.filter((r) => r.name === '副歌');
    expect(choruses.length).toBeGreaterThanOrEqual(2);
    const sig = (r: (typeof lead)[0]) => r.notes.map((n) => `${n.pitch}@${n.start.toFixed(2)}`).join(',');
    expect(sig(choruses[0])).toBe(sig(choruses[1]));
  });
});

describe('regenerating the melody', () => {
  it('new versions take turns between the part\'s instruments', () => {
    const lead = GENRES.find((g) => g.id === 'pop')!.roles.find((r) => r.id === 'lead')!;
    expect(patchForRole(lead)).toBe(lead.patch);
    const used = new Set(Array.from({ length: 40 }, (_, i) => patchForRole(lead, { lead: i + 1 })));
    expect([...used].sort()).toEqual(patchOptions(lead).sort());
  });

  it('parts that follow the melody follow a regenerated one', () => {
    let a = 7;
    const random = vi.spyOn(Math, 'random').mockImplementation(() => (a = (a * 16807) % 2147483647) / 2147483647);
    const g = GENRES.find((x) => x.id === 'pop')!;
    selectGenre('pop');
    applyAll();
    applyStep('melody');
    const st = useDaw.getState();
    const s = st.project.coach!;
    for (const id of ['keys', 'pad']) {
      const role = g.roles.find((r) => r.id === id)!;
      const t = st.project.tracks.find((x) => x.role === `pop:${id}`)!;
      const notes = (rs: { notes: { pitch: number; start: number }[] }[]) => rs.flatMap((r) => r.notes.map((n) => `${n.pitch}@${n.start.toFixed(3)}`));
      expect(notes(t.regions as { notes: { pitch: number; start: number }[] }[])).toEqual(notes(regionsForRole(st.project, g, s, role)));
    }
    random.mockRestore();
  });

  it('regenerating changes the instrument but keeps one the user picked', () => {
    let a = 1;
    const random = vi.spyOn(Math, 'random').mockImplementation(() => (a = (a * 16807) % 2147483647) / 2147483647);
    const leadPatch = () => useDaw.getState().project.tracks.find((t) => t.role === 'pop:lead')!.instrument!.patchId;
    selectGenre('pop');
    applyAll();
    const used = new Set<string>();
    for (let i = 0; i < 12; i++) {
      applyStep('melody');
      used.add(leadPatch());
    }
    expect(used.size).toBeGreaterThan(1);
    useDaw.getState().update('pick', (d) => {
      d.tracks.find((t) => t.role === 'pop:lead')!.instrument!.patchId = 'piano.grand';
    });
    for (let i = 0; i < 4; i++) applyStep('melody');
    expect(leadPatch()).toBe('piano.grand');
    random.mockRestore();
  });
});
