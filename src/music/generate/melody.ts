// Melody idea generator: 2-bar motifs repeated with variation (A A' A B), chord tones on strong
// beats, stepwise motion in between, phrase endings on stable notes. Seeded per section type so a
// chorus melody comes back identically every time the chorus does.

import { chordPitchClasses, scalePitchClasses } from '../theory';
import { chordAtBeat, clipToSection, humanizeNotes, rngFor, swingTime, type GenNote, type SectionCtx } from './common';

export type MelodyStyle = 'pop' | 'ballad' | 'edm' | 'trap' | 'lofi' | 'rock' | 'citypop' | 'rnb' | 'folk' | 'reggae' | 'jazz' | 'synthwave';

type Cell = [number, number][]; // [start, duration] within 2 bars of 4/4

const RHYTHMS: Record<MelodyStyle, { verse: Cell[]; chorus: Cell[] }> = {
  pop: {
    verse: [
      [[0.5, 0.5], [1, 0.5], [1.5, 1], [3, 0.5], [3.5, 0.5], [4, 1], [5, 0.5], [5.5, 0.5], [6, 1.5]],
      [[0.5, 0.5], [1, 1], [2, 0.5], [2.5, 1], [4.5, 0.5], [5, 0.5], [5.5, 0.5], [6, 2]],
    ],
    chorus: [
      [[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 1.5], [4, 0.5], [4.5, 0.5], [5, 0.5], [5.5, 1], [6.5, 1.5]],
      [[0, 1], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1], [4, 0.5], [4.5, 1], [5.5, 0.5], [6, 2]],
    ],
  },
  ballad: {
    verse: [[[0, 1], [1, 0.5], [1.5, 0.5], [2, 2], [4, 1], [5, 1], [6, 2]]],
    chorus: [[[0, 0.5], [0.5, 0.5], [1, 1.5], [2.5, 0.5], [3, 1], [4, 1], [5, 0.5], [5.5, 0.5], [6, 2]]],
  },
  edm: {
    verse: [[[0, 0.75], [0.75, 0.75], [1.5, 1], [3, 0.5], [3.5, 0.5], [4, 0.75], [4.75, 0.75], [5.5, 1.5]]],
    chorus: [[[0, 0.5], [0.75, 0.5], [1.5, 0.5], [2, 0.5], [2.75, 0.75], [3.5, 0.5], [4, 0.5], [4.75, 0.5], [5.5, 0.5], [6, 0.5], [6.5, 1.5]]],
  },
  trap: {
    verse: [[[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2.5, 0.5], [3, 1], [4, 0.5], [4.5, 0.5], [5, 0.5], [5.75, 0.25], [6, 2]]],
    chorus: [[[0, 0.25], [0.25, 0.25], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5], [4, 0.5], [4.5, 0.5], [5, 1], [6, 0.5], [6.5, 1.5]]],
  },
  lofi: {
    verse: [[[0.5, 0.75], [1.33, 0.67], [2, 1], [3.5, 0.5], [4.5, 0.5], [5, 1.5], [6.67, 1.33]]],
    chorus: [[[0, 0.5], [0.5, 1], [1.5, 0.5], [2, 1.5], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]]],
  },
  rock: {
    verse: [[[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]]],
    chorus: [[[0, 1], [1, 1], [2, 1.5], [3.5, 0.5], [4, 1], [5, 0.5], [5.5, 0.5], [6, 2]]],
  },
  citypop: {
    verse: [[[0.25, 0.25], [0.5, 0.5], [1.25, 0.75], [2, 0.5], [2.75, 0.75], [3.5, 0.5], [4.5, 0.5], [5, 0.75], [5.75, 0.25], [6, 2]]],
    chorus: [[[0, 0.5], [0.5, 0.25], [0.75, 0.75], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5], [4, 0.75], [4.75, 0.75], [5.5, 0.5], [6, 2]]],
  },
  rnb: {
    verse: [[[0.5, 0.25], [0.75, 0.75], [1.5, 0.5], [2.25, 0.75], [3.5, 0.5], [4.25, 0.25], [4.5, 1], [5.75, 0.25], [6, 2]]],
    chorus: [[[0, 0.75], [0.75, 0.25], [1, 1], [2.5, 0.5], [3, 1], [4, 0.75], [4.75, 0.75], [5.5, 0.5], [6, 2]]],
  },
  folk: {
    verse: [[[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 1], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]]],
    chorus: [[[0, 1], [1, 0.5], [1.5, 0.5], [2, 2], [4, 1], [5, 1], [6, 2]]],
  },
  reggae: {
    verse: [[[0.5, 0.5], [1, 1], [2.5, 0.5], [3, 1], [4.5, 0.5], [5, 0.5], [5.5, 0.5], [6, 2]]],
    chorus: [[[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 1.5], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]]],
  },
  jazz: {
    verse: [[[0, 0.67], [0.67, 0.33], [1, 0.67], [1.67, 0.33], [2, 1], [3.67, 0.33], [4, 1], [5, 0.67], [5.67, 0.33], [6, 2]]],
    chorus: [[[0.67, 0.33], [1, 0.67], [1.67, 0.33], [2, 0.67], [2.67, 1.33], [4, 0.67], [4.67, 0.33], [5, 1], [6, 2]]],
  },
  synthwave: {
    verse: [[[0, 1], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1], [4, 1.5], [5.5, 0.5], [6, 2]]],
    chorus: [[[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 1.5], [3, 1], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]]],
  },
};

const PENTATONIC_STYLES = new Set<MelodyStyle>(['trap', 'rock', 'folk', 'reggae', 'edm']);

function scaleNotes(ctx: SectionCtx, style: MelodyStyle, lo: number, hi: number): number[] {
  let pcs = scalePitchClasses(ctx.key.root, ctx.key.mode);
  if (PENTATONIC_STYLES.has(style)) {
    // drop the 4th and 7th (major) / 2nd and 6th (minor) degrees → pentatonic, can't clash
    const minorish = ctx.key.mode !== 'major' && ctx.key.mode !== 'lydian' && ctx.key.mode !== 'mixolydian';
    pcs = pcs.filter((_, i) => (minorish ? i !== 1 && i !== 5 : i !== 3 && i !== 6));
  }
  const out: number[] = [];
  for (let p = lo; p <= hi; p++) if (pcs.includes(((p % 12) + 12) % 12)) out.push(p);
  return out;
}

function nearestIndex(arr: number[], pitch: number): number {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - pitch) < Math.abs(arr[best] - pitch)) best = i;
  return best;
}

export function generateMelody(style: MelodyStyle, ctx: SectionCtx, range: [number, number] = [60, 81]): GenNote[] {
  const rng = rngFor(ctx, 4);
  const isChorusLike = ctx.section === 'chorus' || ctx.section === 'drop' || ctx.section === 'solo';
  const pool = RHYTHMS[style] ?? RHYTHMS.pop;
  const cells = isChorusLike ? pool.chorus : pool.verse;
  const scale = scaleNotes(ctx, style, range[0], range[1]);
  if (!scale.length) return [];
  const barScale = ctx.barBeats / 4;
  const unitLen = 2 * ctx.barBeats; // a motif spans two bars
  const units = Math.max(1, Math.floor(ctx.bars / 2));
  // phrase plan: A A' A B (repeats for longer sections)
  const plan = Array.from({ length: units }, (_, i) => (i % 4 === 3 ? 'B' : i % 4 === 1 ? "A'" : 'A'));
  const cellA = cells[Math.floor(rng() * cells.length)];
  const cellB = cells[(cells.indexOf(cellA) + 1) % cells.length];
  // contour of motif A as scale steps relative to its first note
  const contourA = cellA.map((_, i) => (i === 0 ? 0 : Math.round((rng() * 2 - 1) * 2)));
  const center = isChorusLike ? scale[Math.floor(scale.length * 0.62)] : scale[Math.floor(scale.length * 0.42)];
  const out: GenNote[] = [];
  let lastPitch = center;
  plan.forEach((kind, u) => {
    const cell = kind === 'B' ? cellB : cellA;
    const base = u * unitLen;
    let idx = nearestIndex(scale, kind === 'B' ? lastPitch + 3 : center);
    cell.forEach(([at, len], i) => {
      const start = base + at * barScale;
      if (start >= ctx.bars * ctx.barBeats) return;
      const ev = chordAtBeat(ctx, start + 0.01);
      const tones = chordPitchClasses(ev.chord);
      const step = kind === 'B' ? Math.round((rng() * 2 - 1) * 2) + (i < cell.length / 2 ? 1 : -1) : contourA[i % contourA.length] ?? 0;
      idx = Math.max(0, Math.min(scale.length - 1, idx + (i === 0 ? 0 : step)));
      let pitch = scale[idx];
      const strong = Math.abs((at * barScale) % (ctx.barBeats / 2)) < 0.01 || len >= 1;
      if (strong) {
        // land on the nearest chord tone
        let bestP = pitch;
        let bestD = Infinity;
        for (const p of scale) {
          if (!tones.includes(((p % 12) + 12) % 12)) continue;
          const d = Math.abs(p - pitch) + Math.abs(p - lastPitch) * 0.2;
          if (d < bestD) {
            bestD = d;
            bestP = p;
          }
        }
        pitch = bestP;
        idx = nearestIndex(scale, pitch);
      }
      // A' changes the ending of the motif
      if (kind === "A'" && i === cell.length - 1) pitch = scale[Math.max(0, Math.min(scale.length - 1, idx + 2))];
      // avoid big leaps
      if (Math.abs(pitch - lastPitch) > 9) pitch += pitch > lastPitch ? -12 : 12;
      pitch = Math.max(range[0], Math.min(range[1], pitch));
      out.push({ pitch, start, duration: Math.max(0.15, len * barScale - 0.05), velocity: strong ? 100 : 86 });
      lastPitch = pitch;
    });
  });
  // end the section on the chord root, held
  const last = out[out.length - 1];
  if (last) {
    const ev = chordAtBeat(ctx, last.start + 0.01);
    const rootPc = ev.chord.root;
    let best = last.pitch;
    for (let d = 0; d <= 6; d++) {
      if (((last.pitch - d) % 12 + 12) % 12 === rootPc) {
        best = last.pitch - d;
        break;
      }
      if (((last.pitch + d) % 12 + 12) % 12 === rootPc) {
        best = last.pitch + d;
        break;
      }
    }
    last.pitch = Math.max(range[0], Math.min(range[1], best));
  }
  let notes = out.map((n) => ({ ...n, start: swingTime(n.start, ctx.swing, ctx.swingUnit) }));
  notes = humanizeNotes(notes, ctx.humanize * 0.5, rng);
  return clipToSection(notes, ctx);
}
