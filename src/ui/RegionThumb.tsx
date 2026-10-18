// Mini preview drawn inside arrangement regions: MIDI notes or the audio waveform.

import { memo, useEffect, useRef, useState } from 'react';
import { audioPool } from '../audio/audioPool';
import type { Region } from '../core/types';
import { setupCanvas } from './theme';

export const RegionThumb = memo(function RegionThumb({ region, width, height, bpm, color }: { region: Region; width: number; height: number; bpm: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [poolTick, setPoolTick] = useState(0);
  useEffect(() => audioPool.onChange(() => setPoolTick((t) => t + 1)), []);
  useEffect(() => {
    const c = ref.current;
    if (!c || width < 2 || height < 4) return;
    // very wide regions are drawn at reduced resolution and stretched
    const w = Math.min(width, 4000);
    const ctx = setupCanvas(c, w, height);
    if (!ctx) return;
    c.style.width = `${width}px`;
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = color;
    if (region.kind === 'midi') {
      const notes = region.notes.filter((n) => n.start < region.length);
      if (!notes.length) return;
      let lo = 127;
      let hi = 0;
      for (const n of notes) {
        lo = Math.min(lo, n.pitch);
        hi = Math.max(hi, n.pitch);
      }
      const span = Math.max(12, hi - lo + 1);
      const mid = (lo + hi) / 2;
      lo = mid - span / 2;
      const rowH = Math.max(1, Math.min(4, (height - 4) / span));
      const used = rowH * span;
      const top = (height - used) / 2;
      const ppb = w / region.length;
      for (const n of notes) {
        const x = n.start * ppb;
        const nw = Math.max(1.5, Math.min(n.duration, region.length - n.start) * ppb - 0.5);
        const y = top + (lo + span - 1 - n.pitch) * rowH;
        ctx.globalAlpha = 0.45 + (n.velocity / 127) * 0.55;
        ctx.fillRect(x, y, nw, Math.max(1, rowH - 0.4));
      }
      ctx.globalAlpha = 1;
    } else {
      const peaks = audioPool.peaks(region.audioId);
      const buf = audioPool.get(region.audioId);
      if (!peaks || !buf) {
        ctx.globalAlpha = 0.5;
        ctx.fillRect(0, height / 2 - 0.5, w, 1);
        return;
      }
      const sr = buf.sampleRate;
      const secPerPx = region.duration / w;
      const mid = height / 2;
      const amp = (height / 2 - 2) * Math.pow(10, region.gainDb / 20);
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const t0 = region.offset + x * secPerPx;
        const i0 = Math.floor((t0 * sr) / peaks.samplesPerPeak);
        const i1 = Math.max(i0 + 1, Math.floor(((t0 + secPerPx) * sr) / peaks.samplesPerPeak));
        let mn = 0;
        let mx = 0;
        for (let i = i0; i < i1 && i < peaks.min.length; i++) {
          if (peaks.min[i] < mn) mn = peaks.min[i];
          if (peaks.max[i] > mx) mx = peaks.max[i];
        }
        ctx.rect(x, mid - Math.min(1, mx) * amp, 1, Math.max(1, (Math.min(1, mx) - Math.max(-1, mn)) * amp));
      }
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }, [region, width, height, bpm, color, poolTick]);
  return <canvas ref={ref} className="region-thumb" aria-hidden="true" />;
});
