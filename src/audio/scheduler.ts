// Event scheduling: turns the project into timed Web Audio events.
// `scheduleRange` is shared by real-time playback (small lookahead windows) and offline bounces.

import { beatsPerBar, clickInterval } from '../core/time';
import type { MidiRegion, Project } from '../core/types';
import { getPatch } from './instruments/patches';
import type { MixGraph } from './mixer';

export interface RangeOpts {
  b0: number;
  b1: number;
  t0: number; // context time at b0
  spb: number; // seconds per beat
  isStart: boolean; // first window after start or a loop jump → chase sustained notes / audio
  loopEnd: number | null; // notes and audio are clipped here while cycling
  notesFrom: number; // nothing but clicks before this beat (count-in)
  clicks: boolean;
  clickFn?: (time: number, accent: boolean) => void;
  getAudio: (id: string) => AudioBuffer | undefined;
}

interface PendingNote {
  time: number;
  pitch: number;
  vel: number;
  dur: number;
}

export function scheduleRange(p: Project, g: MixGraph, o: RangeOpts): void {
  const timeAt = (b: number) => o.t0 + (b - o.b0) * o.spb;
  if (o.clicks && o.clickFn) {
    const ci = clickInterval(p.timeSig);
    const bar = beatsPerBar(p.timeSig);
    for (let k = Math.ceil(o.b0 / ci - 1e-9); k * ci < o.b1 - 1e-9; k++) {
      const b = k * ci;
      const inBar = ((b % bar) + bar) % bar;
      o.clickFn(timeAt(b), inBar < 1e-6 || bar - inBar < 1e-6);
    }
  }
  const nb0 = Math.max(o.b0, o.notesFrom);
  if (nb0 < o.b1) {
    const solo = p.tracks.some((t) => t.mixer.solo);
    for (const tr of p.tracks) {
      // silent tracks cost nothing: no voices are created for them
      if (tr.mixer.mute || (solo && !tr.mixer.solo)) continue;
      if (tr.kind === 'instrument') {
        const inst = g.instrument(tr.id);
        if (!inst) continue;
        const chase = getPatch(tr.instrument?.patchId).engine === 'synth';
        const pending: PendingNote[] = [];
        for (const r of tr.regions) {
          if (r.kind !== 'midi' || r.muted) continue;
          collectNotes(r, nb0, o, chase, timeAt, pending);
        }
        pending.sort((a, b) => a.time - b.time || a.pitch - b.pitch);
        for (const n of pending) inst.play(n.pitch, n.vel, n.time, n.dur);
      } else {
        for (const r of tr.regions) {
          if (r.kind !== 'audio' || r.muted) continue;
          const buf = o.getAudio(r.audioId);
          if (!buf) continue;
          const rs = r.start;
          const re = rs + r.duration / o.spb;
          const limit = o.loopEnd !== null && rs < o.loopEnd ? (o.loopEnd - rs) * o.spb : Infinity;
          if (rs >= nb0 && rs < o.b1) {
            g.playBuffer(tr.id, buf, timeAt(rs), r.offset, Math.min(r.duration, limit), r.gainDb, r.fadeIn, r.fadeOut);
          } else if (o.isStart && rs < nb0 && re > nb0 + 0.001) {
            const into = (nb0 - rs) * o.spb;
            g.playBuffer(tr.id, buf, timeAt(nb0), r.offset + into, Math.min(r.duration, limit) - into, r.gainDb, 0.005, r.fadeOut);
          }
        }
      }
    }
  }
  for (const fx of g.activeFx()) fx.scheduleBeats?.(o.b0, o.b1, timeAt, o.spb);
}

function collectNotes(r: MidiRegion, nb0: number, o: RangeOpts, chase: boolean, timeAt: (b: number) => number, out: PendingNote[]): void {
  const rs = r.start;
  const re = rs + r.length;
  if (re <= nb0 && !(o.isStart && chase)) return;
  if (rs >= o.b1) return;
  for (const n of r.notes) {
    if (n.start >= r.length || n.start < 0) continue;
    const ab = rs + n.start;
    let dur = Math.min(n.duration, r.length - n.start);
    if (o.loopEnd !== null && ab < o.loopEnd) dur = Math.min(dur, o.loopEnd - ab);
    if (ab >= nb0 && ab < o.b1) {
      out.push({ time: timeAt(ab), pitch: n.pitch, vel: n.velocity, dur: dur * o.spb });
    } else if (o.isStart && chase && ab < nb0 && ab + dur > nb0 + 0.02) {
      out.push({ time: timeAt(nb0), pitch: n.pitch, vel: n.velocity, dur: (ab + dur - nb0) * o.spb });
    }
  }
}

/** Last beat that contains any region (used for bounce length and the timeline width). */
export function projectEndBeat(p: Project): number {
  let end = 0;
  for (const t of p.tracks) {
    for (const r of t.regions) {
      const e = r.kind === 'midi' ? r.start + r.length : r.start + (r.duration * p.bpm) / 60;
      if (e > end) end = e;
    }
  }
  return end;
}

// ------------------------------------------------------------------ real-time transport clock

const TICK_WORKER = `let id=null;onmessage=e=>{if(e.data==='start'){if(id)clearInterval(id);id=setInterval(()=>postMessage(0),20)}else{clearInterval(id);id=null}}`;

interface Anchor {
  time: number;
  beat: number;
  spb: number;
}

export interface TransportDeps {
  ctx: AudioContext;
  project: () => Project;
  graph: () => MixGraph;
  getAudio: (id: string) => AudioBuffer | undefined;
  click: (time: number, accent: boolean) => void;
  clicksWanted: (recording: boolean, countingIn: boolean) => boolean;
}

export class Transport {
  playing = false;
  recording = false;
  private deps: TransportDeps;
  private nextTime = 0;
  private nextBeat = 0;
  private isStart = true;
  private anchors: Anchor[] = [];
  private notesFrom = -Infinity;
  private noLoop = false;
  private lastBpm = 0;
  private worker: Worker | null = null;
  private workerAlive = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  readonly lookahead = 0.12;

  constructor(deps: TransportDeps) {
    this.deps = deps;
    try {
      const url = URL.createObjectURL(new Blob([TICK_WORKER], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      this.worker.onmessage = () => {
        this.workerAlive = true;
        this.tick();
      };
      this.worker.onerror = () => this.useTimer();
    } catch {
      this.worker = null;
    }
  }

  /** Main-thread timer instead of the worker clock (throttled in background tabs, but always works). */
  private useTimer(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.playing && !this.interval) this.interval = setInterval(() => this.tick(), 20);
  }

  /** Start playback. Returns the context time at which `fromBeat` is reached (after any count-in). */
  start(fromBeat: number, opts: { countInBeats?: number; recording?: boolean; noLoop?: boolean } = {}): number {
    const p = this.deps.project();
    const spb = 60 / p.bpm;
    const countIn = opts.countInBeats ?? 0;
    const t0 = this.deps.ctx.currentTime + 0.08;
    this.playing = true;
    this.recording = !!opts.recording;
    this.noLoop = !!opts.noLoop;
    this.notesFrom = countIn > 0 ? fromBeat : -Infinity;
    this.nextBeat = fromBeat - countIn;
    this.nextTime = t0;
    this.isStart = true;
    this.lastBpm = p.bpm;
    this.anchors = [{ time: t0, beat: this.nextBeat, spb }];
    for (const fx of this.deps.graph().activeFx()) fx.onTransport?.(true, t0);
    this.tick();
    if (this.worker) {
      this.worker.postMessage('start');
      // without ticks only the first lookahead would ever be scheduled: fall back if it stays quiet
      if (!this.workerAlive) setTimeout(() => !this.workerAlive && this.playing && this.useTimer(), 300);
    } else this.interval = setInterval(() => this.tick(), 20);
    return t0 + countIn * spb;
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.recording = false;
    if (this.worker) this.worker.postMessage('stop');
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.deps.graph().stopAll();
  }

  /** Project beat at a context time (negative / before notesFrom during a count-in). */
  beatAt(time: number): number {
    let a = this.anchors[0];
    for (const x of this.anchors) if (x.time <= time) a = x;
    if (!a) return 0;
    return a.beat + (time - a.time) / a.spb;
  }

  get countInEnd(): number {
    return this.notesFrom;
  }

  private tick(): void {
    if (!this.playing) return;
    const ctx = this.deps.ctx;
    const p = this.deps.project();
    const g = this.deps.graph();
    const horizon = ctx.currentTime + this.lookahead;
    // tempo change: new anchor so the playhead stays continuous
    if (p.bpm !== this.lastBpm) {
      this.lastBpm = p.bpm;
      this.anchors.push({ time: this.nextTime, beat: this.nextBeat, spb: 60 / p.bpm });
    }
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 64) {
      const spb = 60 / p.bpm;
      const b0 = this.nextBeat;
      let b1 = b0 + (horizon - this.nextTime) / spb;
      const loop = p.loop;
      let wrap = false;
      const looping = loop.enabled && !this.noLoop && loop.end - loop.start >= 0.25;
      if (looping && b0 < loop.end && b1 >= loop.end && b0 >= this.notesFrom - 1e-9) {
        b1 = loop.end;
        wrap = true;
      }
      const countingIn = b0 < this.notesFrom;
      scheduleRange(p, g, {
        b0,
        b1,
        t0: this.nextTime,
        spb,
        isStart: this.isStart,
        loopEnd: looping && b0 < loop.end ? loop.end : null,
        notesFrom: this.notesFrom,
        clicks: this.deps.clicksWanted(this.recording, countingIn),
        clickFn: this.deps.click,
        getAudio: this.deps.getAudio,
      });
      if (this.isStart && b1 > this.notesFrom) this.isStart = false;
      this.nextTime += (b1 - b0) * spb;
      this.nextBeat = b1;
      if (wrap) {
        this.nextBeat = loop.start;
        this.isStart = true;
        this.anchors.push({ time: this.nextTime, beat: loop.start, spb });
      }
      // keep the anchor list short
      if (this.anchors.length > 32) this.anchors.splice(0, this.anchors.length - 32);
    }
  }
}
