// Offline bounce (mixdown / stems) using the same mixer graph and scheduler as live playback.

import { produce } from 'immer';
import type { Project } from '../core/types';
import { audioPool } from './audioPool';
import type { RenderJob } from './dsp/render';
import { MixGraph } from './mixer';
import { renderService } from './renderService';
import { projectEndBeat, scheduleRange } from './scheduler';

export interface BounceOptions {
  start: number; // beats
  end: number; // beats
  sampleRate: number;
  tail: number; // seconds of reverb tail
  soloTrackId?: string;
  normalize?: boolean;
  onPhase?: (text: string) => void;
}

export function defaultBounceRange(p: Project): { start: number; end: number } {
  if (p.loop.enabled && p.loop.end > p.loop.start) return { start: p.loop.start, end: p.loop.end };
  return { start: 0, end: Math.max(1, projectEndBeat(p)) };
}

export async function bounce(project: Project, o: BounceOptions): Promise<AudioBuffer> {
  let p = project;
  if (o.soloTrackId) {
    p = produce(p, (d) => {
      for (const t of d.tracks) {
        t.mixer.solo = t.id === o.soloTrackId;
        if (t.id === o.soloTrackId) t.mixer.mute = false;
      }
    });
  }
  const spb = 60 / p.bpm;
  const seconds = (o.end - o.start) * spb + o.tail;
  const length = Math.max(1, Math.ceil(seconds * o.sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: o.sampleRate });
  const graph = new MixGraph(ctx, { meters: false });
  graph.sync(p, true);

  o.onPhase?.('準備音色…');
  const jobs: RenderJob[] = [];
  for (const t of p.tracks) {
    const inst = graph.instrument(t.id);
    if (!inst) continue;
    jobs.push(...inst.jobsFor(t.regions.flatMap((r) => (r.kind === 'midi' ? r.notes : []))));
  }
  await renderService.ensureAll(jobs);
  // recorded instruments must be loaded (or have fallen back) before rendering
  await Promise.race([
    Promise.all(p.tracks.map((t) => graph.instrument(t.id)?.ready?.())),
    new Promise((r) => setTimeout(r, 60000)),
  ]);

  o.onPhase?.('混音輸出中…');
  for (const fx of graph.activeFx()) fx.onTransport?.(true, 0);
  scheduleRange(p, graph, {
    b0: o.start,
    b1: o.end,
    t0: 0,
    spb,
    isStart: true,
    loopEnd: null,
    notesFrom: -Infinity,
    clicks: false,
    getAudio: (id) => audioPool.get(id),
  });
  const out = await ctx.startRendering();
  graph.dispose();
  if (o.normalize) normalizeBuffer(out, 0.966); // −0.3 dBFS
  return out;
}

export function peakOf(b: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

export function normalizeBuffer(b: AudioBuffer, target: number): void {
  const peak = peakOf(b);
  if (peak <= 0) return;
  const g = target / peak;
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
}
