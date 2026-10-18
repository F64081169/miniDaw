// Recorded / imported audio lives here (outside the undoable project state), keyed by id.

import { uid } from '../core/util';

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  samplesPerPeak: number;
}

const buffers = new Map<string, AudioBuffer>();
const peaks = new Map<string, Peaks>();
const listeners = new Set<() => void>();

export const audioPool = {
  add(buffer: AudioBuffer, id = uid('a')): string {
    buffers.set(id, buffer);
    peaks.delete(id);
    listeners.forEach((l) => l());
    return id;
  },
  get(id: string): AudioBuffer | undefined {
    return buffers.get(id);
  },
  has(id: string): boolean {
    return buffers.has(id);
  },
  ids(): string[] {
    return [...buffers.keys()];
  },
  remove(id: string): void {
    buffers.delete(id);
    peaks.delete(id);
  },
  clear(): void {
    buffers.clear();
    peaks.clear();
  },
  onChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Min/max overview used for waveform drawing (computed once, cached). */
  peaks(id: string): Peaks | null {
    const cached = peaks.get(id);
    if (cached) return cached;
    const buf = buffers.get(id);
    if (!buf) return null;
    const spp = 128;
    const n = Math.ceil(buf.length / spp);
    const min = new Float32Array(n);
    const max = new Float32Array(n);
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    for (let i = 0; i < n; i++) {
      let lo = 0;
      let hi = 0;
      const end = Math.min(buf.length, (i + 1) * spp);
      for (let s = i * spp; s < end; s++) {
        let v = 0;
        for (const c of chans) v += c[s];
        v /= chans.length;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[i] = lo;
      max[i] = hi;
    }
    const p = { min, max, samplesPerPeak: spp };
    peaks.set(id, p);
    return p;
  },
};
