// Renders and caches instrument sample buffers. Work runs in Web Workers (falls back to the
// main thread), high-priority jobs (needed for playback right now) jump the queue, and the
// cache is LRU-bounded so long sessions don't grow without limit.

import { jobKey, runJob, type RenderJob } from './dsp/render';
import RenderWorker from './renderWorker?worker&inline';

interface Pending {
  key: string;
  job: RenderJob;
  priority: number;
  waiters: { resolve: (b: AudioBuffer) => void; reject: (e: unknown) => void }[];
}

interface Slot {
  worker: Worker;
  busy: Pending | null;
  ids: number;
}

const MEMORY_BUDGET = 480 * 1024 * 1024; // bytes of float samples

function makeBuffer(data: Float32Array, sampleRate: number): AudioBuffer {
  const buf = new AudioBuffer({ length: Math.max(1, data.length), sampleRate, numberOfChannels: 1 });
  buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
  return buf;
}

export class RenderService {
  private cache = new Map<string, AudioBuffer>();
  private bytes = 0;
  private queue: Pending[] = [];
  private inflight = new Map<string, Pending>();
  private slots: Slot[] = [];
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  constructor() {
    if (typeof Worker === 'undefined') return;
    const count = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    try {
      for (let i = 0; i < count; i++) {
        const worker = new RenderWorker();
        const slot: Slot = { worker, busy: null, ids: 0 };
        worker.onmessage = (e: MessageEvent<{ id: number; data?: Float32Array; error?: string }>) => this.onResult(slot, e.data);
        worker.onerror = () => this.dropWorker(slot);
        this.slots.push(slot);
      }
    } catch {
      this.slots = [];
    }
  }

  /** Called whenever a buffer finishes rendering (UI uses it for the "loading sounds" indicator). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  pendingCount(): number {
    return this.queue.length + this.inflight.size;
  }

  get(job: RenderJob): AudioBuffer | undefined {
    const key = jobKey(job);
    const b = this.cache.get(key);
    if (b) {
      this.cache.delete(key);
      this.cache.set(key, b);
    }
    return b;
  }

  /** Get a buffer now, rendering on the calling thread if it isn't ready yet. */
  getSync(job: RenderJob): AudioBuffer {
    const hit = this.get(job);
    if (hit) return hit;
    const key = jobKey(job);
    const buf = makeBuffer(runJob(job), job.sr);
    this.store(key, buf);
    // satisfy anybody already waiting for this job
    const queued = this.queue.findIndex((p) => p.key === key);
    if (queued >= 0) {
      const p = this.queue.splice(queued, 1)[0];
      p.waiters.forEach((w) => w.resolve(buf));
    }
    return buf;
  }

  ensure(job: RenderJob, priority = 1): Promise<AudioBuffer> {
    const hit = this.get(job);
    if (hit) return Promise.resolve(hit);
    const key = jobKey(job);
    return new Promise((resolve, reject) => {
      const existing = this.inflight.get(key) ?? this.queue.find((p) => p.key === key);
      if (existing) {
        existing.waiters.push({ resolve, reject });
        if (priority > existing.priority) {
          existing.priority = priority;
          this.sortQueue();
        }
        return;
      }
      this.queue.push({ key, job, priority, waiters: [{ resolve, reject }] });
      this.sortQueue();
      this.pump();
    });
  }

  /** Low-priority background warm-up. */
  prefetch(jobs: RenderJob[]): void {
    for (const j of jobs) void this.ensure(j, 0).catch(() => undefined);
  }

  async ensureAll(jobs: RenderJob[], onProgress?: (done: number, total: number) => void): Promise<void> {
    let done = 0;
    const total = jobs.length;
    await Promise.all(
      jobs.map((j) =>
        this.ensure(j, 2).then(() => {
          done++;
          onProgress?.(done, total);
        }),
      ),
    );
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  private store(key: string, buf: AudioBuffer): void {
    if (this.cache.has(key)) return;
    this.cache.set(key, buf);
    this.bytes += buf.length * 4 * buf.numberOfChannels;
    while (this.bytes > MEMORY_BUDGET && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value as string;
      const ob = this.cache.get(oldest)!;
      this.cache.delete(oldest);
      this.bytes -= ob.length * 4 * ob.numberOfChannels;
    }
    this.listeners.forEach((l) => l());
  }

  private pump(): void {
    if (this.slots.length === 0) {
      this.pumpMainThread();
      return;
    }
    for (const slot of this.slots) {
      if (slot.busy || this.queue.length === 0) continue;
      const p = this.queue.shift()!;
      if (this.cache.has(p.key)) {
        const b = this.cache.get(p.key)!;
        p.waiters.forEach((w) => w.resolve(b));
        continue;
      }
      slot.busy = p;
      this.inflight.set(p.key, p);
      slot.ids = this.nextId++;
      slot.worker.postMessage({ id: slot.ids, job: p.job });
    }
  }

  private pumpMainThread(): void {
    if (this.idleTimer || this.queue.length === 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const p = this.queue.shift();
      if (p) {
        try {
          const buf = this.cache.get(p.key) ?? makeBuffer(runJob(p.job), p.job.sr);
          this.store(p.key, buf);
          p.waiters.forEach((w) => w.resolve(buf));
        } catch (err) {
          p.waiters.forEach((w) => w.reject(err));
        }
      }
      this.pumpMainThread();
    }, 0);
  }

  private onResult(slot: Slot, msg: { id: number; data?: Float32Array; error?: string }): void {
    const p = slot.busy;
    slot.busy = null;
    if (p) {
      this.inflight.delete(p.key);
      if (msg.data) {
        const buf = this.cache.get(p.key) ?? makeBuffer(msg.data, p.job.sr);
        this.store(p.key, buf);
        p.waiters.forEach((w) => w.resolve(buf));
      } else {
        p.waiters.forEach((w) => w.reject(new Error(msg.error ?? 'render failed')));
      }
    }
    this.pump();
  }

  private dropWorker(slot: Slot): void {
    slot.worker.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
    if (slot.busy) {
      this.inflight.delete(slot.busy.key);
      this.queue.unshift(slot.busy);
      slot.busy = null;
    }
    this.pump();
  }
}

export const renderService = new RenderService();
