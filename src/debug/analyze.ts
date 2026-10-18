// Mix-balance analysis used during development (loaded on demand from the console handle).

import { produce } from 'immer';
import { bounce } from '../audio/export';
import { applyAll, selectGenre } from '../music/coach';
import { useDaw } from '../state/store';

/** Integrated loudness (ITU-R BS.1770 K-weighting, ungated) and sample peak of a 48 kHz buffer. */
export function loudness(b: AudioBuffer): { lufs: number; peak: number } {
  // K-weighting at 48 kHz: high shelf, then RLB high-pass
  const s1 = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
  const s2 = [1, -2, 1, -1.99004745483398, 0.99007225036621];
  let power = 0;
  let peak = 0;
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      const a = Math.abs(x);
      if (a > peak) peak = a;
      const y = s1[0] * x + s1[1] * x1 + s1[2] * x2 - s1[3] * y1 - s1[4] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const z = s2[0] * y + s2[1] * u1 + s2[2] * u2 - s2[3] * z1 - s2[4] * z2;
      u2 = u1; u1 = y; z2 = z1; z1 = z;
      sum += z * z;
    }
    power += sum / d.length;
  }
  return { lufs: +(-0.691 + 10 * Math.log10(power + 1e-12)).toFixed(1), peak: +(20 * Math.log10(peak + 1e-9)).toFixed(1) };
}

/** Generate a genre arrangement, bounce its first chorus / drop and measure the mix and every track. */
export async function analyzeGenre(id: string) {
  selectGenre(id);
  applyAll();
  const p = useDaw.getState().project;
  const sec = p.markers.find((m) => m.section === 'chorus' || m.section === 'drop') ?? p.markers[0];
  const range = { start: sec.start, end: sec.start + sec.length, sampleRate: 48000, tail: 0.3 };
  const t0 = performance.now();
  const mix = loudness(await bounce(p, range));
  const mixMs = Math.round(performance.now() - t0);
  const tracks = [];
  for (const t of p.tracks) {
    const l = loudness(await bounce(p, { ...range, soloTrackId: t.id }));
    tracks.push({ name: t.name, patch: t.instrument?.patchId ?? 'audio', fader: t.mixer.volumeDb, ...l });
  }
  const t2 = performance.now();
  await bounce(produce(p, (d) => void d.tracks.forEach((t) => (t.mixer.mute = true))), range);
  const silentMs = Math.round(performance.now() - t2);
  const seconds = +(((range.end - range.start) * 60) / p.bpm).toFixed(1);
  return { genre: id, seconds, mixMs, silentMs, mix, tracks };
}
