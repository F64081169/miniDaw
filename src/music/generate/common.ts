// Shared types and helpers for the arrangement generators.

import type { ScaleMode, SectionType } from '../../core/types';
import { makeRng } from '../../core/util';
import type { ChordEvent } from '../theory';

export interface GenNote {
  pitch: number;
  start: number; // beats from section start
  duration: number;
  velocity: number;
}

export interface SectionCtx {
  section: SectionType;
  bars: number;
  barBeats: number;
  timeSig: [number, number];
  chords: ChordEvent[]; // relative to section start, covering the whole section
  key: { root: number; mode: ScaleMode };
  energy: number; // 0 … 1
  isFirst: boolean;
  isLast: boolean;
  next: SectionType | null;
  swing: number; // 0 … 1
  swingUnit: number; // 0.25 (16ths) or 0.5 (8ths)
  humanize: number; // 0 … 1
  seed: number;
  bpm: number;
  /** This part's version: a random seed per generation (0 = the default version), the same in every section. */
  variation?: number;
  /** Where the section sits in the song. */
  index?: number;
  occurrence?: number; // 1 for the first verse, 2 for the second …
  occurrences?: number; // sections of this type in the song
  prev?: SectionType | null;
}

export const SECTION_ENERGY: Record<SectionType, number> = {
  intro: 0.35,
  verse: 0.55,
  pre: 0.7,
  chorus: 0.95,
  bridge: 0.6,
  breakdown: 0.3,
  build: 0.75,
  drop: 1,
  solo: 0.85,
  outro: 0.4,
};

export const SECTION_LABEL: Record<SectionType, string> = {
  intro: '前奏',
  verse: '主歌',
  pre: '導歌',
  chorus: '副歌',
  bridge: '橋段',
  breakdown: '間奏',
  build: '漸強',
  drop: 'Drop',
  solo: '獨奏',
  outro: '尾奏',
};

export function rngFor(ctx: SectionCtx, salt: number): () => number {
  return makeRng(ctx.seed * 7919 + salt * 104729 + ctx.bars * 31 + ctx.section.length * 977);
}

/** Delay off-beat subdivisions to create swing (1 = full triplet feel). */
export function swingTime(start: number, swing: number, unit: number): number {
  if (swing <= 0) return start;
  const pair = unit * 2;
  const pos = ((start % pair) + pair) % pair;
  if (Math.abs(pos - unit) < 1e-6) return start + (swing * unit) / 3;
  return start;
}

export const VELOCITY: Record<string, number> = { X: 118, x: 98, o: 74, g: 44, r: 82, t: 80, R: 84, m: 60 };

export interface PatternHit {
  start: number;
  ch: string;
  step: number;
}

/** Parse a step string ("x..x..x.") into hits. Patterns may span several bars and repeat. */
export function patternHits(pattern: string, stepLen: number, barSteps: number, bars: number): PatternHit[] {
  const out: PatternHit[] = [];
  const clean = pattern.replace(/\s|\|/g, '');
  const len = clean.length;
  if (!len) return out;
  const total = barSteps * bars;
  for (let s = 0; s < total; s++) {
    const ch = clean[s % len];
    if (ch !== '.' && ch !== '-') out.push({ start: s * stepLen, ch, step: s });
  }
  return out;
}

export function humanizeNotes(notes: GenNote[], amount: number, rng: () => number, keepGrid = false): GenNote[] {
  if (amount <= 0) return notes;
  return notes.map((n) => ({
    ...n,
    start: keepGrid ? n.start : Math.max(0, n.start + (rng() * 2 - 1) * 0.012 * amount),
    velocity: Math.max(1, Math.min(127, Math.round(n.velocity + (rng() * 2 - 1) * 9 * amount))),
  }));
}

export function sectionLength(ctx: SectionCtx): number {
  return ctx.bars * ctx.barBeats;
}

/** Clip notes to the section and drop anything that starts outside it. */
export function clipToSection(notes: GenNote[], ctx: SectionCtx): GenNote[] {
  const end = sectionLength(ctx);
  return notes
    .filter((n) => n.start >= -1e-6 && n.start < end - 1e-6)
    .map((n) => ({ ...n, start: Math.max(0, n.start), duration: Math.max(0.02, Math.min(n.duration, end - n.start)) }));
}

export function chordsInBar(ctx: SectionCtx, bar: number): ChordEvent[] {
  const s = bar * ctx.barBeats;
  const e = s + ctx.barBeats;
  return ctx.chords.filter((c) => c.start < e - 1e-9 && c.start + c.length > s + 1e-9);
}

export function chordAtBeat(ctx: SectionCtx, beat: number): ChordEvent {
  let cur = ctx.chords[0];
  for (const c of ctx.chords) if (c.start <= beat + 1e-9) cur = c;
  return cur;
}

export function nextChordAfter(ctx: SectionCtx, beat: number): ChordEvent | null {
  for (const c of ctx.chords) if (c.start > beat + 1e-9) return c;
  return null;
}
