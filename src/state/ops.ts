// Pure helpers that operate on project data (safe to use on immer drafts).

import { tidy } from '../core/time';
import type { AudioRegion, MidiRegion, Note, Project, Region, Track } from '../core/types';
import { uid } from '../core/util';

export function findTrack(p: Project, id: string | null | undefined): Track | undefined {
  return id ? p.tracks.find((t) => t.id === id) : undefined;
}

export function findRegion(p: Project, regionId: string | null | undefined): { track: Track; region: Region } | null {
  if (!regionId) return null;
  for (const track of p.tracks) {
    const region = track.regions.find((r) => r.id === regionId);
    if (region) return { track, region };
  }
  return null;
}

export function regionLengthBeats(r: Region, bpm: number): number {
  return r.kind === 'midi' ? r.length : (r.duration * bpm) / 60;
}

export function regionEnd(r: Region, bpm: number): number {
  return r.start + regionLengthBeats(r, bpm);
}

export function cloneRegion<R extends Region>(r: R, start: number): R {
  if (r.kind === 'midi') {
    return { ...r, id: uid('r'), start, notes: r.notes.map((n) => ({ ...n, id: uid('n') })) } as R;
  }
  return { ...r, id: uid('r'), start } as R;
}

export function splitMidiRegion(r: MidiRegion, at: number): [MidiRegion, MidiRegion] | null {
  const rel = tidy(at - r.start);
  if (rel <= 0.001 || rel >= r.length - 0.001) return null;
  const left: MidiRegion = { ...r, length: rel, notes: r.notes.filter((n) => n.start < rel) };
  const right: MidiRegion = {
    ...r,
    id: uid('r'),
    start: tidy(at),
    length: tidy(r.length - rel),
    notes: r.notes.filter((n) => n.start >= rel).map((n) => ({ ...n, id: uid('n'), start: tidy(n.start - rel) })),
  };
  return [left, right];
}

export function splitAudioRegion(r: AudioRegion, at: number, bpm: number): [AudioRegion, AudioRegion] | null {
  const relSec = ((at - r.start) * 60) / bpm;
  if (relSec <= 0.01 || relSec >= r.duration - 0.01) return null;
  const left: AudioRegion = { ...r, duration: relSec, fadeOut: 0.005 };
  const right: AudioRegion = { ...r, id: uid('r'), start: tidy(at), offset: r.offset + relSec, duration: r.duration - relSec, fadeIn: 0.005 };
  return [left, right];
}

/** Quantize note starts (and optionally ends) toward a grid with a strength (0 … 1) and swing (0 … 1). */
export function quantizeNotes(notes: Note[], grid: number, strength = 1, swing = 0, ends = false): Note[] {
  if (grid <= 0) return notes;
  return notes.map((n) => {
    const idx = Math.round(n.start / grid);
    let target = idx * grid;
    if (swing > 0 && idx % 2 === 1) target += grid * swing * 0.5;
    const start = tidy(n.start + (target - n.start) * strength);
    let duration = n.duration;
    if (ends) {
      const endTarget = Math.max(grid, Math.round((n.start + n.duration) / grid) * grid) - target;
      duration = Math.max(grid / 2, tidy(n.duration + (endTarget - n.duration) * strength));
    }
    return { ...n, start: Math.max(0, start), duration };
  });
}

export function regionNotesInRange(r: MidiRegion): Note[] {
  return r.notes.filter((n) => n.start < r.length && n.start >= 0);
}

/** Absolute time span covered by the notes of a list of regions. */
export function notesSpan(regions: MidiRegion[]): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const r of regions) {
    for (const n of r.notes) {
      start = Math.min(start, r.start + n.start);
      end = Math.max(end, r.start + n.start + n.duration);
    }
  }
  return Number.isFinite(start) ? { start, end } : null;
}
