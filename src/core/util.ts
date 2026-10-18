let counter = 0;

/** Short, collision-resistant id (time + counter + random), good enough for local projects. */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 1679616; // 36^4
  return (
    prefix +
    Date.now().toString(36).slice(-5) +
    counter.toString(36).padStart(4, '0') +
    Math.floor(Math.random() * 1679616)
      .toString(36)
      .padStart(4, '0')
  );
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** dB → linear gain. Anything at or below -96 dB is treated as silence. */
export function dbToGain(db: number): number {
  return db <= -96 ? 0 : Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 0.0000158 ? -96 : 20 * Math.log10(gain);
}

export function mtof(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function formatDb(db: number): string {
  if (db <= -96) return '-∞';
  return (db > 0 ? '+' : '') + db.toFixed(1);
}

/** Small deterministic PRNG (mulberry32) so generated parts and synthesized sounds are reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  const run = () => {
    timer = null;
    if (lastArgs) {
      const a = lastArgs;
      lastArgs = null;
      fn(...a);
    }
  };
  const d = (...args: A) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  d.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  d.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  return d;
}
