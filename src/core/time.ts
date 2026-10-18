import type { SnapSetting } from './types';

/** Length of one bar in quarter-note beats (6/8 → 3, 3/4 → 3, 4/4 → 4). */
export function beatsPerBar(timeSig: [number, number]): number {
  return (timeSig[0] * 4) / timeSig[1];
}

/** Metronome click spacing in quarter-note beats (4/4 → 1, 6/8 → 0.5). */
export function clickInterval(timeSig: [number, number]): number {
  return 4 / timeSig[1];
}

export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm;
}

export function secondsToBeats(sec: number, bpm: number): number {
  return (sec * bpm) / 60;
}

/** Bar / beat / division / tick readout like Logic's LCD ("12 3 2 120"). */
export function formatBBT(beat: number, timeSig: [number, number]): { bar: number; beat: number; div: number; tick: number } {
  const b = Math.max(0, beat);
  const bpb = beatsPerBar(timeSig);
  const unit = 4 / timeSig[1]; // length of one displayed beat
  const bar = Math.floor(b / bpb + 1e-9);
  const inBar = b - bar * bpb;
  const beatIdx = Math.floor(inBar / unit + 1e-9);
  const inBeat = inBar - beatIdx * unit;
  const divLen = unit / 4;
  const div = Math.floor(inBeat / divLen + 1e-9);
  const tick = Math.floor(((inBeat - div * divLen) / divLen) * 240 + 1e-6);
  return { bar: bar + 1, beat: beatIdx + 1, div: div + 1, tick: Math.min(239, tick) + 1 };
}

export function formatBarBeat(beat: number, timeSig: [number, number]): string {
  const p = formatBBT(beat, timeSig);
  return `${p.bar}.${p.beat}`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const ms = Math.floor((rest - whole) * 1000);
  return `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

const SNAP_BEATS: Record<Exclude<SnapSetting, 'smart' | 'bar' | 'off'>, number> = {
  '1/4': 1,
  '1/8': 0.5,
  '1/16': 0.25,
  '1/32': 0.125,
  '1/8t': 1 / 3,
  '1/16t': 1 / 6,
};

/**
 * Grid size in beats for a snap setting. "smart" picks the finest straight division
 * that is still at least `minPx` pixels wide at the current zoom (like Logic's Smart snap).
 */
export function gridBeats(snap: SnapSetting, pxPerBeat: number, timeSig: [number, number], minPx = 14): number {
  if (snap === 'off') return 0;
  if (snap === 'bar') return beatsPerBar(timeSig);
  if (snap === 'smart') {
    const bar = beatsPerBar(timeSig);
    const candidates = [0.0625, 0.125, 0.25, 0.5, 1, bar, bar * 2, bar * 4, bar * 8];
    for (const c of candidates) if (c * pxPerBeat >= minPx) return c;
    return bar * 16;
  }
  return SNAP_BEATS[snap];
}

export function snapBeat(beat: number, grid: number): number {
  if (grid <= 0) return Math.round(beat * 960) / 960;
  return Math.round(beat / grid + 1e-9) * grid;
}

export function floorToGrid(beat: number, grid: number): number {
  if (grid <= 0) return beat;
  return Math.floor(beat / grid + 1e-9) * grid;
}

/** Round to the internal resolution (960 PPQ) to keep floating point positions tidy. */
export function tidy(beat: number): number {
  return Math.round(beat * 960) / 960;
}
