import { describe, expect, it } from 'vitest';
import { renderString } from '../src/audio/dsp/strings';
import { renderEPiano, renderMallet, renderPiano } from '../src/audio/dsp/keys';
import { DRUM_MAP, renderDrumPiece, KITS } from '../src/audio/dsp/drums';
import { renderReverbIR } from '../src/audio/dsp/misc';
import { PATCHES } from '../src/audio/instruments/patches';
import { runJob } from '../src/audio/dsp/render';
import { mtof } from '../src/core/util';

const SR = 48000;

/** Fundamental estimate via normalised autocorrelation + parabolic interpolation. */
function estimateF0(buf: Float32Array, sr: number, expected: number): number {
  const start = Math.floor(0.15 * sr);
  const n = 8192;
  const seg = buf.subarray(start, start + n);
  const period = sr / expected;
  const minLag = Math.floor(period * 0.8);
  const maxLag = Math.ceil(period * 1.25);
  let best = minLag;
  let bestVal = -Infinity;
  const corr = (lag: number) => {
    let s = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < seg.length; i++) {
      s += seg[i] * seg[i + lag];
      e1 += seg[i] * seg[i];
      e2 += seg[i + lag] * seg[i + lag];
    }
    return s / Math.sqrt(e1 * e2 + 1e-12);
  };
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = corr(lag);
    if (v > bestVal) {
      bestVal = v;
      best = lag;
    }
  }
  const y0 = corr(best - 1);
  const y1 = corr(best);
  const y2 = corr(best + 1);
  const shift = (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2);
  return sr / (best + shift);
}

const cents = (f: number, ref: number) => 1200 * Math.log2(f / ref);

function assertSane(buf: Float32Array) {
  let peak = 0;
  let finite = true;
  for (let i = 0; i < buf.length; i++) {
    if (!Number.isFinite(buf[i])) finite = false;
    peak = Math.max(peak, Math.abs(buf[i]));
  }
  expect(finite).toBe(true);
  expect(peak).toBeGreaterThan(0.1);
  expect(peak).toBeLessThanOrEqual(1);
}

describe('plucked string model', () => {
  const guitar = PATCHES.find((p) => p.id === 'ag.steel')!.sampled!.spec;
  const bass = PATCHES.find((p) => p.id === 'bass.finger')!.sampled!.spec;
  it.each([40, 45, 52, 57, 64, 69, 76, 84])('guitar note %i is in tune', (midi) => {
    if (guitar.type !== 'string') throw new Error();
    const buf = renderString(midi, SR, guitar.model);
    assertSane(buf);
    const f = estimateF0(buf, SR, mtof(midi));
    expect(Math.abs(cents(f, mtof(midi)))).toBeLessThan(6);
  });
  it.each([28, 33, 40, 45, 52])('bass note %i is in tune', (midi) => {
    if (bass.type !== 'string') throw new Error();
    const buf = renderString(midi, SR, bass.model);
    assertSane(buf);
    const f = estimateF0(buf, SR, mtof(midi));
    expect(Math.abs(cents(f, mtof(midi)))).toBeLessThan(6);
  });
});

describe('keyboard models', () => {
  it.each([33, 48, 60, 72, 84, 96])('piano note %i renders in tune', (midi) => {
    const t0 = performance.now();
    const buf = renderPiano(midi, SR, { duration: 6, brightness: 0.55, hammer: 0.5, detune: 1 });
    const ms = performance.now() - t0;
    assertSane(buf);
    expect(ms).toBeLessThan(1500);
    if (midi >= 48 && midi <= 84) {
      const f = estimateF0(buf, SR, mtof(midi));
      expect(Math.abs(cents(f, mtof(midi)))).toBeLessThan(8);
    }
  });
  it.each(['tine', 'dx', 'wurli'] as const)('e-piano %s renders in tune', (variant) => {
    for (const midi of [48, 60, 72]) {
      const buf = renderEPiano(midi, SR, { variant, duration: 5, bark: 0.4, bell: 0.7 });
      assertSane(buf);
      const f = estimateF0(buf, SR, mtof(midi));
      expect(Math.abs(cents(f, mtof(midi)))).toBeLessThan(8);
    }
  });
  it('mallets render', () => {
    const buf = renderMallet(72, SR, { duration: 3, ratios: [1, 4], gains: [1, 0.2], decay: 3, hardness: 0.5 });
    assertSane(buf);
  });
});

describe('drum kits', () => {
  it.each(Object.keys(KITS))('kit %s renders every piece', (kit) => {
    for (const d of DRUM_MAP) {
      const buf = renderDrumPiece(kit, d.piece, SR);
      assertSane(buf);
      expect(buf.length).toBeLessThan(SR * 3.5);
    }
  });
});

describe('patches', () => {
  it('every sampled patch renders its lowest and highest zone', () => {
    for (const p of PATCHES) {
      if (p.engine !== 'sampled') continue;
      for (const pitch of [p.range[0], p.range[1]]) {
        const buf = runJob({ kind: 'zone', spec: p.sampled!.spec, pitch, sr: SR, seed: 1 });
        assertSane(buf);
      }
    }
  });
  it('controls have unique ids per patch', () => {
    for (const p of PATCHES) {
      const ids = p.controls.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('reverb IR', () => {
  it('is finite and decays', () => {
    const [l, r] = renderReverbIR(SR, { decay: 2, preDelay: 0.02, damping: 0.5, size: 0.5 });
    expect(l.length).toBe(r.length);
    let early = 0;
    let late = 0;
    const n = l.length;
    for (let i = 0; i < Math.floor(n / 4); i++) early += l[i] * l[i];
    for (let i = Math.floor((3 * n) / 4); i < n; i++) late += l[i] * l[i];
    expect(early).toBeGreaterThan(late * 10);
  });
});
