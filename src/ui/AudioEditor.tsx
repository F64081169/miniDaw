// Audio region editor: waveform, gain, fades and normalise.

import { useEffect, useRef } from 'react';
import { audioPool } from '../audio/audioPool';
import { formatClock } from '../core/time';
import type { AudioRegion } from '../core/types';
import { clamp, formatDb, gainToDb } from '../core/util';
import { setLoop } from '../state/actions';
import { regionEnd } from '../state/ops';
import { useDaw } from '../state/store';
import { Knob } from './controls/controls';
import { cssVar, onThemeChange, setupCanvas } from './theme';

function editAudio(id: string, label: string, fn: (r: AudioRegion) => void, coalesce?: string) {
  useDaw.getState().update(label, (d) => {
    for (const t of d.tracks) for (const r of t.regions) if (r.id === id && r.kind === 'audio') fn(r as AudioRegion);
  }, coalesce ? { coalesce } : undefined);
}

export function AudioEditor({ region }: { region: AudioRegion }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bpm = useDaw((s) => s.project.bpm);
  const buf = audioPool.get(region.audioId);

  useEffect(() => {
    const draw = () => {
      const c = ref.current;
      const w = wrapRef.current;
      if (!c || !w) return;
      const width = w.clientWidth;
      const height = w.clientHeight;
      const ctx = setupCanvas(c, width, height);
      const peaks = audioPool.peaks(region.audioId);
      if (!ctx || !peaks || !buf) return;
      ctx.fillStyle = cssVar('--lane');
      ctx.fillRect(0, 0, width, height);
      const total = buf.duration;
      const toX = (sec: number) => (sec / total) * width;
      // the part of the recording used by the region
      ctx.fillStyle = cssVar('--sel-soft');
      ctx.fillRect(toX(region.offset), 0, toX(region.duration), height);
      ctx.fillStyle = cssVar('--wave');
      const mid = height / 2;
      const amp = (height / 2 - 4) * Math.pow(10, region.gainDb / 20);
      const perPx = peaks.min.length / width;
      for (let x = 0; x < width; x++) {
        let mn = 0;
        let mx = 0;
        const i0 = Math.floor(x * perPx);
        const i1 = Math.max(i0 + 1, Math.floor((x + 1) * perPx));
        for (let i = i0; i < i1; i++) {
          mn = Math.min(mn, peaks.min[i]);
          mx = Math.max(mx, peaks.max[i]);
        }
        ctx.fillRect(x, mid - Math.min(1, mx) * amp, 1, Math.max(1, (Math.min(1, mx) - Math.max(-1, mn)) * amp));
      }
      // fades
      ctx.strokeStyle = cssVar('--accent');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const s = toX(region.offset);
      const e = toX(region.offset + region.duration);
      ctx.moveTo(s, height);
      ctx.lineTo(s + toX(region.fadeIn), 4);
      ctx.lineTo(e - toX(region.fadeOut), 4);
      ctx.lineTo(e, height);
      ctx.stroke();
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (wrapRef.current) ro.observe(wrapRef.current);
    const off = onThemeChange(draw);
    return () => {
      ro.disconnect();
      off();
    };
  }, [region, buf]);

  if (!buf) return <div className="editor-empty">找不到這段錄音的音訊資料。</div>;

  const normalize = () => {
    let peak = 0;
    const startI = Math.floor(region.offset * buf.sampleRate);
    const endI = Math.min(buf.length, Math.floor((region.offset + region.duration) * buf.sampleRate));
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = startI; i < endI; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    if (peak > 0) editAudio(region.id, '標準化音量', (r) => (r.gainDb = clamp(Math.round((-1 - gainToDb(peak)) * 10) / 10, -24, 24)));
  };

  return (
    <div className="audio-editor">
      <div className="editor-toolbar">
        <span className="editor-info">
          {region.name} · 長度 {formatClock(region.duration)} · 原始錄音 {formatClock(buf.duration)} · {buf.sampleRate} Hz · {buf.numberOfChannels === 1 ? '單聲道' : '立體聲'}
        </span>
        <div className="tb-spacer" />
        <button type="button" className="btn" onClick={normalize} title="把峰值調整到 −1 dBFS">
          標準化
        </button>
        <button type="button" className="btn" onClick={() => setLoop(region.start, regionEnd(region, bpm))}>
          循環這一段
        </button>
      </div>
      <div className="audio-body">
        <div className="audio-wave" ref={wrapRef}>
          <canvas ref={ref} aria-label="波形" />
        </div>
        <div className="audio-knobs">
          <Knob label="增益" value={region.gainDb} min={-24} max={24} def={0} bipolar onChange={(v) => editAudio(region.id, '片段增益', (r) => (r.gainDb = Math.round(v * 10) / 10), `gain:${region.id}`)} format={(v) => `${formatDb(v)} dB`} />
          <Knob label="淡入" value={region.fadeIn} min={0.003} max={Math.max(0.01, region.duration / 2)} log def={0.005} onChange={(v) => editAudio(region.id, '淡入', (r) => (r.fadeIn = v), `fi:${region.id}`)} format={(v) => `${v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(1) + 's'}`} />
          <Knob label="淡出" value={region.fadeOut} min={0.005} max={Math.max(0.01, region.duration / 2)} log def={0.01} onChange={(v) => editAudio(region.id, '淡出', (r) => (r.fadeOut = v), `fo:${region.id}`)} format={(v) => `${v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(1) + 's'}`} />
        </div>
      </div>
    </div>
  );
}
