// Recorded instrument samples (open-licensed libraries, see THIRD_PARTY_NOTICES.md): the
// manifest written by scripts/samples/build_samples.py, lazy loading and decoding per set.

import manifest from './sets.json';

export interface SampleZone {
  f: string; // file, relative to src/assets/samples
  vl: number; // velocity range
  vh: number;
  rr: number; // round robin index
  k?: number; // root key (pitched sets)
  lo?: number; // key range
  hi?: number;
  a?: string; // articulation ('short' / 'long')
  p?: string; // drum piece (kits)
}

export interface SampleSet {
  name: string;
  author: string;
  license: string;
  source: string;
  notes?: string;
  kind: 'pitched' | 'kit';
  zones: SampleZone[];
  bytes: number;
}

export const SAMPLE_SETS = (manifest as { sets: Record<string, SampleSet> }).sets;

const URLS = import.meta.glob('../../assets/samples/*/*.mp3', { query: '?url', import: 'default', eager: true }) as Record<
  string,
  string
>;

function urlOf(file: string): string {
  const url = URLS[`../../assets/samples/${file}`];
  if (!url) throw new Error(`missing sample ${file}`);
  return url;
}

/**
 * Decoders differ in how much encoder padding they leave before an MP3's first sample,
 * so cut anything quieter than the attack (keeping 1 ms) to keep every hit on time.
 */
function trimOnset(ctx: BaseAudioContext, b: AudioBuffer): AudioBuffer {
  const data = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
  let peak = 0;
  for (const d of data) for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const threshold = peak * 0.006; // −45 dB
  const limit = Math.min(b.length, Math.floor(b.sampleRate * 0.12));
  let onset = 0;
  search: for (; onset < limit; onset++) for (const d of data) if (Math.abs(d[onset]) > threshold) break search;
  const cut = onset - Math.floor(b.sampleRate * 0.001);
  if (cut <= Math.floor(b.sampleRate * 0.0015) || onset >= limit) return b;
  const out = ctx.createBuffer(b.numberOfChannels, b.length - cut, b.sampleRate);
  data.forEach((d, c) => out.copyToChannel(d.subarray(cut) as Float32Array<ArrayBuffer>, c));
  return out;
}

class SampleLibrary {
  private buffers = new Map<string, AudioBuffer>();
  private sets = new Map<string, Promise<void>>();
  private failed = new Set<string>();
  private decoder: BaseAudioContext | null = null;
  private pending = 0;
  private listeners = new Set<() => void>();

  /** Context used for decoding: the live one when it exists, so no resampling is needed. */
  useContext(ctx: BaseAudioContext): void {
    if (!(ctx instanceof OfflineAudioContext)) this.decoder = ctx;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Files still downloading or decoding. */
  pendingCount(): number {
    return this.pending;
  }

  isLoaded(set: string): boolean {
    return SAMPLE_SETS[set]?.zones.every((z) => this.buffers.has(z.f)) ?? false;
  }

  hasFailed(set: string): boolean {
    return this.failed.has(set);
  }

  buffer(file: string): AudioBuffer | undefined {
    return this.buffers.get(file);
  }

  load(set: string): Promise<void> {
    let p = this.sets.get(set);
    if (!p) {
      p = this.fetchSet(set);
      this.sets.set(set, p);
      p.catch(() => {
        this.failed.add(set);
        this.sets.delete(set);
      });
    }
    return p;
  }

  private async fetchSet(set: string): Promise<void> {
    const def = SAMPLE_SETS[set];
    if (!def) throw new Error(`unknown sample set ${set}`);
    const ctx = this.decoder ?? (this.decoder = new OfflineAudioContext(1, 1, 48000));
    const queue = def.zones.map((z) => z.f).filter((f) => !this.buffers.has(f));
    this.pending += queue.length;
    this.emit();
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try {
          const res = await fetch(urlOf(f));
          if (!res.ok) throw new Error(`${res.status} ${f}`);
          const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
          this.buffers.set(f, trimOnset(ctx, decoded));
        } finally {
          this.pending--;
          this.emit();
        }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: 6 }, worker));
    // files no worker got to (all of them failed) are no longer pending
    this.pending -= queue.length;
    queue.length = 0;
    this.emit();
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}

export const sampleLibrary = new SampleLibrary();
