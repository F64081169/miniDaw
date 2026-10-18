// Mix-balance analysis used during development (loaded on demand from the console handle).

import { produce } from 'immer';
import { bounce } from '../audio/export';
import { defaultFxParams } from '../audio/fx/registry';
import type { InsertType } from '../core/types';
import { applyAll, selectGenre } from '../music/coach';
import { createInstrumentTrack, createMidiRegion, createProject } from '../state/project';
import { useDaw } from '../state/store';

/**
 * Integrated loudness per ITU-R BS.1770-4 (K-weighting, 400 ms blocks with 75 % overlap,
 * absolute −70 LUFS and relative −10 LU gates) and sample peak, for a 48 kHz buffer.
 * The gates make sparse parts (a lead that only plays a few notes) read at their playing level.
 */
export function loudness(b: AudioBuffer): { lufs: number; peak: number } {
  // K-weighting at 48 kHz: high shelf, then RLB high-pass
  const s1 = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
  const s2 = [1, -2, 1, -1.99004745483398, 0.99007225036621];
  const n = b.length;
  const energy = new Float64Array(n + 1); // prefix sums of the channel-summed K-weighted power
  let peak = 0;
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const x = d[i];
      const a = Math.abs(x);
      if (a > peak) peak = a;
      const y = s1[0] * x + s1[1] * x1 + s1[2] * x2 - s1[3] * y1 - s1[4] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const z = s2[0] * y + s2[1] * u1 + s2[2] * u2 - s2[3] * z1 - s2[4] * z2;
      u2 = u1; u1 = y; z2 = z1; z1 = z;
      acc += z * z;
      energy[i + 1] += acc;
    }
  }
  const block = Math.round(0.4 * b.sampleRate);
  const hop = Math.round(0.1 * b.sampleRate);
  const blocks: number[] = [];
  for (let s = 0; s + block <= n; s += hop) blocks.push((energy[s + block] - energy[s]) / block);
  const lk = (e: number) => -0.691 + 10 * Math.log10(e + 1e-15);
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
  const abs = blocks.filter((e) => lk(e) > -70);
  const rel = lk(mean(abs)) - 10;
  const gated = abs.filter((e) => lk(e) > rel);
  const lufs = gated.length ? lk(mean(gated)) : -120;
  return { lufs: +lufs.toFixed(1), peak: +(20 * Math.log10(peak + 1e-9)).toFixed(1) };
}

/** Generate a genre's full arrangement into the current project. */
export function generate(id: string): void {
  selectGenre(id);
  applyAll();
}

/** Generate a genre arrangement, bounce its first chorus / drop and measure the mix and every track. */
export async function analyzeGenre(id: string) {
  generate(id);
  const p = useDaw.getState().project;
  const chorus = p.markers.find((m) => m.section === 'chorus' || m.section === 'drop') ?? p.markers[0];
  const rangeOf = (m: { start: number; length: number }) => ({ start: m.start, end: m.start + m.length, sampleRate: 48000, tail: 0.3 });
  const t0 = performance.now();
  const mix = loudness(await bounce(p, rangeOf(chorus)));
  const mixMs = Math.round(performance.now() - t0);
  const tracks = [];
  for (const t of p.tracks) {
    // measure each part where it plays: the chorus if it is in it, otherwise its first section
    const plays = (m: { start: number; length: number }) =>
      t.regions.some((r) => r.kind === 'midi' && r.notes.some((n) => r.start + n.start >= m.start && r.start + n.start < m.start + m.length));
    const sec = [chorus, ...p.markers].find(plays);
    if (!sec) continue;
    const l = loudness(await bounce(p, { ...rangeOf(sec), soloTrackId: t.id }));
    tracks.push({ name: t.name, role: t.role, patch: t.instrument?.patchId ?? 'audio', fader: t.mixer.volumeDb, section: sec.section, ...l });
  }
  const t2 = performance.now();
  await bounce(produce(p, (d) => void d.tracks.forEach((t) => (t.mixer.mute = true))), rangeOf(chorus));
  const silentMs = Math.round(performance.now() - t2);
  const seconds = +(((chorus.length) * 60) / p.bpm).toFixed(1);
  return { genre: id, seconds, mixMs, silentMs, mix, tracks };
}

type PhraseNote = { pitch: number; start: number; duration: number; velocity: number };

export { referencePhrase };

/** A four-bar reference phrase in the way each kind of patch is typically played. */
function referencePhrase(patchId: string): PhraseNote[] {
  const out: PhraseNote[] = [];
  const bars = [0, 1, 2, 3];
  const chords = [
    [48, 55, 60, 64],
    [45, 52, 57, 60],
    [41, 48, 53, 57],
    [43, 50, 55, 59],
  ];
  const add = (pitch: number, start: number, duration: number, velocity: number) => out.push({ pitch, start, duration, velocity });
  if (patchId.startsWith('drums.')) {
    for (const b of bars) {
      for (const k of [0, 2, 2.5]) add(36, b * 4 + k, 0.25, 110);
      for (const s of [1, 3]) add(38, b * 4 + s, 0.25, 108);
      for (let h = 0; h < 8; h++) add(42, b * 4 + h / 2, 0.25, h % 2 ? 68 : 84);
    }
    add(49, 0, 1, 104);
  } else if (patchId.startsWith('bass.')) {
    const roots = [40, 43, 38, 41];
    for (const b of bars) for (let i = 0; i < 8; i++) add(roots[b], b * 4 + i / 2, 0.45, 100);
  } else if (['eg.lead', 'synth.lead', 'mallet.bell'].includes(patchId)) {
    const line = [72, 71, 69, 67, 69, 71, 72, 74];
    for (const b of bars) line.forEach((p, i) => add(p - (b % 2) * 2, b * 4 + i / 2, 0.45, 100));
  } else if (['strings.ensemble', 'synth.pad', 'synth.supersaw'].includes(patchId)) {
    for (const b of bars) for (const p of chords[b].slice(1)) add(p + 12, b * 4, 3.9, 96);
  } else if (patchId === 'synth.pluck') {
    for (const b of bars) for (let i = 0; i < 16; i++) add(chords[b][1 + (i % 3)] + 12, b * 4 + i / 4, 0.2, 96);
  } else {
    const dur = patchId === 'brass.section' ? 0.5 : 0.9;
    for (const b of bars) for (let q = 0; q < 4; q++) for (const p of chords[b]) add(p, b * 4 + q, dur, 96);
  }
  return out;
}

/** Loudness of a patch playing a phrase at a 0 dB fader, dry (no sends, no inserts). */
export async function measurePhrase(
  id: string,
  notes: PhraseNote[],
  beats = 16,
  params: Record<string, number> = {},
  inserts: { type: InsertType; params?: Record<string, number> }[] = [],
) {
  const p = createProject('measure');
  p.bpm = 100;
  const t = createInstrumentTrack(id);
  Object.assign(t.instrument!.params, params);
  t.mixer.volumeDb = 0;
  t.mixer.sends = { reverb: 0, delay: 0 };
  for (const ins of t.mixer.inserts) ins.enabled = false;
  for (const x of inserts) t.mixer.inserts.push({ id: `fx${t.mixer.inserts.length}`, type: x.type, enabled: true, params: { ...defaultFxParams(x.type), ...x.params } });
  t.regions = [createMidiRegion(0, beats, notes)];
  p.tracks = [t];
  return loudness(await bounce(p, { start: 0, end: beats, sampleRate: 48000, tail: 1 }));
}

/** Loudness of every patch playing its reference phrase. */
export async function measurePatches(ids: string[]) {
  const res: Record<string, { lufs: number; peak: number }> = {};
  for (const id of ids) res[id] = await measurePhrase(id, referencePhrase(id));
  return res;
}

/** The notes a genre role plays in its first chorus (to reproduce a part in isolation). */
export function roleNotes(tag: string): PhraseNote[] {
  const p = useDaw.getState().project;
  const t = p.tracks.find((x) => x.role === tag);
  const chorus = p.markers.find((m) => m.section === 'chorus' || m.section === 'drop') ?? p.markers[0];
  if (!t || !chorus) return [];
  return t.regions.flatMap((r) =>
    r.kind === 'midi'
      ? r.notes
          .map((n) => ({ pitch: n.pitch, start: r.start + n.start - chorus.start, duration: n.duration, velocity: n.velocity }))
          .filter((n) => n.start >= 0 && n.start < chorus.length)
      : [],
  );
}
export { autoMakeup } from '../audio/dsp/compressor';
export { sampleLibrary, SAMPLE_SETS } from '../audio/samples/library';
