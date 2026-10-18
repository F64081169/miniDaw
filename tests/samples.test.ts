import { describe, expect, it } from 'vitest';
import { PATCHES } from '../src/audio/instruments/patches';
import { SAMPLE_SETS } from '../src/audio/samples/library';

describe('sample sets', () => {
  it('every zone file exists', () => {
    const files = new Set(Object.keys(import.meta.glob('../src/assets/samples/*/*.mp3')));
    for (const set of Object.values(SAMPLE_SETS)) {
      for (const z of set.zones) expect(files.has(`../src/assets/samples/${z.f}`), z.f).toBe(true);
    }
  });

  it('every patch that uses samples points at an existing set', () => {
    for (const p of PATCHES) {
      if (p.samples) expect(SAMPLE_SETS[p.samples.set], p.id).toBeDefined();
      for (const k of p.kitSets ?? []) expect(SAMPLE_SETS[k], p.id).toBeDefined();
    }
  });

  it('pitched sets cover every key and velocity of the patches that play them', () => {
    for (const p of PATCHES) {
      if (!p.samples) continue;
      const zones = SAMPLE_SETS[p.samples.set].zones;
      const arts = [...new Set(zones.map((z) => z.a ?? ''))];
      for (const art of arts) {
        for (let key = p.range[0]; key <= p.range[1]; key++) {
          for (const vel of [1, 40, 64, 90, 127]) {
            const hit = zones.some((z) => (z.a ?? '') === art && key >= z.lo! && key <= z.hi! && vel >= z.vl && vel <= z.vh);
            expect(hit, `${p.id} ${art} key ${key} vel ${vel}`).toBe(true);
          }
        }
      }
    }
  });

  it('kits have the core pieces', () => {
    for (const p of PATCHES) {
      if (!p.kitSets) continue;
      const pieces = new Set(p.kitSets.flatMap((k) => SAMPLE_SETS[k].zones.map((z) => z.p)));
      for (const piece of ['kick', 'snare', 'hatC', 'ride']) expect(pieces.has(piece), `${p.id} ${piece}`).toBe(true);
    }
  });

  it('credits name an author, license and source for every set', () => {
    for (const s of Object.values(SAMPLE_SETS)) {
      expect(s.author.length).toBeGreaterThan(0);
      expect(['CC0-1.0', 'CC-BY-3.0', 'MIT']).toContain(s.license);
      expect(s.source).toMatch(/^https:\/\//);
    }
  });
});
