// Mixer: channel strips with inserts, sends, pan, fader and meters; FX returns and master.
// Also the plug-in editor window for inserts (with an EQ curve and compressor gain reduction).

import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { eqResponse } from '../audio/fx/effects';
import { DELAY_BUS_PARAMS, FX_DEFS, INSERT_TYPES, REVERB_PARAMS, formatParam, type FxParamDef } from '../audio/fx/registry';
import { getPatch } from '../audio/instruments/patches';
import type { InsertType, Track } from '../core/types';
import { formatDb } from '../core/util';
import {
  addInsert,
  removeInsert,
  setBusParam,
  setBusReturn,
  setInsertParam,
  setInsertParams,
  setMasterVolume,
  setPan,
  setSend,
  setVolume,
  toggleArm,
  toggleInsert,
  toggleLimiter,
  toggleMonitor,
  toggleMute,
  toggleSolo,
} from '../state/actions';
import { useDaw } from '../state/store';
import { Fader, Knob, Meter, MeterScale } from './controls/controls';
import { Icon } from './icons';
import { MenuButton } from './menu';
import { onFrame } from './raf';
import { cssVar, setupCanvas } from './theme';

const st = () => useDaw.getState();

export const panLabel = (v: number) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);

function InsertSlots({ track, compact = false }: { track: Track; compact?: boolean }) {
  return (
    <div className="inserts">
      {track.mixer.inserts.map((ins) => (
        <div key={ins.id} className={`insert ${ins.enabled ? 'on' : ''}`}>
          <button type="button" className="insert-power" aria-pressed={ins.enabled} title={ins.enabled ? '關閉效果器' : '開啟效果器'} onClick={() => toggleInsert(track.id, ins.id)} />
          <button type="button" className="insert-name" title={`編輯 ${FX_DEFS[ins.type].name}`} onClick={() => st().setUi({ dialog: { type: 'fx', trackId: track.id, insertId: ins.id } })}>
            {compact ? FX_DEFS[ins.type].short : FX_DEFS[ins.type].name}
          </button>
          <button type="button" className="insert-remove" title="移除" onClick={() => removeInsert(track.id, ins.id)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <MenuButton className="insert-add" title="新增效果器" items={() => INSERT_TYPES.map((t) => ({ label: FX_DEFS[t].name, onClick: () => {
        const id = addInsert(track.id, t as InsertType);
        st().setUi({ dialog: { type: 'fx', trackId: track.id, insertId: id } });
      } }))}>
        <Icon name="plus" size={12} /> 效果器
      </MenuButton>
    </div>
  );
}

export function TrackStrip({ track, height = 168, compact = false }: { track: Track; height?: number; compact?: boolean }) {
  const selected = useDaw((s) => s.ui.selectedTrackId === track.id);
  const patch = track.kind === 'instrument' ? getPatch(track.instrument?.patchId) : null;
  const m = track.mixer;
  return (
    <div className={`strip ${selected ? 'selected' : ''}`} style={{ ['--tc' as string]: track.color }} onPointerDown={() => st().setUi({ selectedTrackId: track.id })}>
      <div className="strip-top">
        <div className="strip-patch" title={patch?.name ?? '音訊輸入'}>
          {patch ? patch.name : '音訊輸入'}
        </div>
        <InsertSlots track={track} compact={compact} />
        <div className="strip-sends">
          <Knob label="殘響" size={24} value={m.sends.reverb} def={0} onChange={(v) => setSend(track.id, 'reverb', v)} format={(v) => `${Math.round(v * 100)}%`} gestureLabel="殘響傳送" />
          <Knob label="延遲" size={24} value={m.sends.delay} def={0} onChange={(v) => setSend(track.id, 'delay', v)} format={(v) => `${Math.round(v * 100)}%`} gestureLabel="延遲傳送" />
          <Knob label={`聲像 ${panLabel(m.pan)}`} size={24} value={m.pan} min={-1} max={1} def={0} bipolar onChange={(v) => setPan(track.id, v)} format={panLabel} gestureLabel="聲像" />
        </div>
      </div>
      <div className="strip-fader">
        <MeterScale height={height} />
        <Fader db={m.volumeDb} height={height} onChange={(db) => setVolume(track.id, db)} label={`${track.name} 音量`} />
        <Meter id={track.id} height={height} />
      </div>
      <div className="strip-db">{formatDb(m.volumeDb)}</div>
      <div className="strip-buttons">
        <button type="button" className={`mini-btn m ${m.mute ? 'on' : ''}`} aria-pressed={m.mute} title="靜音" onClick={() => toggleMute(track.id)}>
          M
        </button>
        <button type="button" className={`mini-btn s ${m.solo ? 'on' : ''}`} aria-pressed={m.solo} title="獨奏" onClick={(e) => toggleSolo(track.id, e.altKey)}>
          S
        </button>
        <button type="button" className={`mini-btn r ${track.armed ? 'on' : ''}`} aria-pressed={track.armed} title="錄音待命" onClick={() => toggleArm(track.id)}>
          <Icon name="record" size={10} filled />
        </button>
        {track.kind === 'audio' && (
          <button type="button" className={`mini-btn i ${track.monitor ? 'on' : ''}`} aria-pressed={track.monitor} title="輸入監聽" onClick={() => toggleMonitor(track.id)}>
            <Icon name="headphones" size={10} />
          </button>
        )}
      </div>
      <div className="strip-name" title={track.name}>
        {track.name}
      </div>
    </div>
  );
}

const UNIT_SUFFIX: Record<string, string> = { Hz: 'Hz', dB: 'dB', ms: 'ms', ':1': ':1', s: 's', 拍: '拍' };

function ParamControl({ def, value, onChange, size = 34 }: { def: FxParamDef; value: number; onChange: (v: number) => void; size?: number }) {
  if (def.options) {
    return (
      <label className="param-select">
        <span>{def.label}</span>
        <select value={String(value)} onChange={(e) => onChange(Number(e.target.value))} aria-label={def.label}>
          {def.options.map((o) => (
            <option key={o.value} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <Knob
      label={def.label}
      size={size}
      value={value}
      min={def.min}
      max={def.max}
      def={def.default}
      log={def.scale === 'log'}
      bipolar={def.min < 0 && def.max > 0}
      step={def.id === 'bits' ? 1 : undefined}
      onChange={onChange}
      format={(v) => `${formatParam(def, v)}${def.unit ? UNIT_SUFFIX[def.unit] ?? '' : ''}`}
      gestureLabel={def.label}
    />
  );
}

function BusStrip({ bus, height }: { bus: 'reverb' | 'delay'; height: number }) {
  const b = useDaw((s) => s.project.buses[bus]);
  const defs = bus === 'reverb' ? REVERB_PARAMS : DELAY_BUS_PARAMS;
  return (
    <div className="strip bus">
      <div className="strip-top">
        <div className="strip-patch">{bus === 'reverb' ? '殘響（傳送）' : '延遲（傳送）'}</div>
        <div className="bus-params">
          {defs.map((d) => (
            <ParamControl key={d.id} def={d} size={28} value={b.params[d.id] ?? d.default} onChange={(v) => setBusParam(bus, d.id, v)} />
          ))}
        </div>
      </div>
      <div className="strip-fader">
        <MeterScale height={height} />
        <Fader db={b.returnDb} height={height} onChange={(db) => setBusReturn(bus, db)} label={bus === 'reverb' ? '殘響返回' : '延遲返回'} />
      </div>
      <div className="strip-db">{formatDb(b.returnDb)}</div>
      <div className="strip-name">{bus === 'reverb' ? 'Reverb' : 'Delay'}</div>
    </div>
  );
}

function MasterStrip({ height }: { height: number }) {
  const master = useDaw((s) => s.project.master);
  const grRef = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      onFrame(() => {
        if (!grRef.current || !engine.graph) return;
        const gr = engine.graph.master.reduction;
        grRef.current.textContent = master.limiter ? `限幅 ${gr < -0.05 ? gr.toFixed(1) : '0.0'} dB` : '限幅器關';
      }),
    [master.limiter],
  );
  return (
    <div className="strip master">
      <div className="strip-top">
        <div className="strip-patch">主輸出</div>
        <button type="button" className={`btn ${master.limiter ? 'btn-on' : ''}`} aria-pressed={master.limiter} onClick={toggleLimiter} title="母帶限幅器：防止輸出爆音">
          限幅器
        </button>
        <span className="gr" ref={grRef} />
      </div>
      <div className="strip-fader">
        <MeterScale height={height} />
        <Fader db={master.volumeDb} height={height} onChange={setMasterVolume} label="主音量" />
        <Meter id="master" height={height} width={18} />
      </div>
      <div className="strip-db">{formatDb(master.volumeDb)}</div>
      <div className="strip-name">Stereo Out</div>
    </div>
  );
}

export function Mixer({ height }: { height: number }) {
  const tracks = useDaw((s) => s.project.tracks);
  const faderH = Math.max(70, Math.min(240, height - 196));
  return (
    <div className="mixer">
      <div className="mixer-strips">
        {tracks.map((t) => (
          <TrackStrip key={t.id} track={t} height={faderH} compact />
        ))}
        {tracks.length === 0 && <div className="editor-empty">還沒有音軌。</div>}
      </div>
      <div className="mixer-buses">
        <BusStrip bus="reverb" height={faderH} />
        <BusStrip bus="delay" height={faderH} />
        <MasterStrip height={faderH} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ plug-in window

const FX_PRESETS: Partial<Record<InsertType, { name: string; params: Record<string, number> }[]>> = {
  eq: [
    { name: '人聲清晰', params: { lowCut: 90, lowFreq: 200, lowGain: -2, midFreq: 3000, midGain: 2.5, midQ: 0.9, highFreq: 10000, highGain: 3, highCut: 20000 } },
    { name: '切掉低頻', params: { lowCut: 150, lowGain: 0, midGain: 0, highGain: 0, highCut: 20000 } },
    { name: '大鼓有力', params: { lowCut: 30, lowFreq: 60, lowGain: 4, midFreq: 400, midGain: -4, midQ: 1.2, highFreq: 4000, highGain: 3, highCut: 20000 } },
    { name: '溫暖復古', params: { lowCut: 40, lowFreq: 150, lowGain: 2, midFreq: 2500, midGain: -1.5, midQ: 0.8, highFreq: 8000, highGain: -4, highCut: 9000 } },
    { name: '電話效果', params: { lowCut: 500, lowGain: 0, midFreq: 1500, midGain: 6, midQ: 1, highGain: 0, highCut: 3500 } },
  ],
  comp: [
    { name: '人聲', params: { threshold: -20, ratio: 3, attack: 8, release: 120, knee: 8, makeup: 4 } },
    { name: '鼓組黏合', params: { threshold: -16, ratio: 4, attack: 25, release: 150, knee: 6, makeup: 3 } },
    { name: '貝斯穩定', params: { threshold: -22, ratio: 5, attack: 6, release: 100, knee: 4, makeup: 5 } },
    { name: '強力壓縮', params: { threshold: -30, ratio: 10, attack: 2, release: 80, knee: 2, makeup: 9 } },
  ],
  pump: [
    { name: '輕微呼吸', params: { depth: 0.4, release: 0.4, division: 1 } },
    { name: 'EDM 強抽', params: { depth: 0.85, release: 0.55, division: 1 } },
  ],
  lofi: [
    { name: '舊唱片', params: { bits: 10, lowpass: 4200, wow: 0.45, noise: 0.4, drive: 0.35 } },
    { name: '錄音帶', params: { bits: 14, lowpass: 7000, wow: 0.7, noise: 0.15, drive: 0.4 } },
    { name: '8-bit 遊戲', params: { bits: 6, lowpass: 9000, wow: 0, noise: 0, drive: 0.2 } },
  ],
};

function EqCurve({ params }: { params: Record<string, number> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = c.parentElement!.clientWidth;
    const h = 150;
    const ctx = setupCanvas(c, w, h);
    if (!ctx) return;
    const n = Math.max(64, Math.floor(w / 2));
    const freqs = new Float32Array(n);
    for (let i = 0; i < n; i++) freqs[i] = 20 * Math.pow(1000, i / (n - 1));
    const offline = new OfflineAudioContext(1, 128, 48000);
    const db = eqResponse(offline, params, freqs);
    ctx.fillStyle = cssVar('--surface-2');
    ctx.fillRect(0, 0, w, h);
    const yOf = (d: number) => h / 2 - (d / 24) * (h / 2 - 8);
    ctx.fillStyle = cssVar('--grid-beat');
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = (Math.log(f / 20) / Math.log(1000)) * w;
      ctx.fillRect(x, 0, 1, h);
    }
    for (const d of [-12, 0, 12]) ctx.fillRect(0, yOf(d), w, 1);
    ctx.fillStyle = cssVar('--fg-3');
    ctx.font = `10px ${cssVar('--font-mono')}`;
    for (const [f, label] of [
      [100, '100'],
      [1000, '1k'],
      [10000, '10k'],
    ] as const) {
      ctx.fillText(label, (Math.log(f / 20) / Math.log(1000)) * w + 3, h - 4);
    }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = yOf(Math.max(-30, Math.min(30, db[i])));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(w, h / 2);
    ctx.lineTo(0, h / 2);
    ctx.closePath();
    ctx.fillStyle = cssVar('--accent-soft');
    ctx.fill();
  }, [params]);
  return (
    <div className="eq-curve">
      <canvas ref={ref} aria-label="等化器頻率響應曲線" />
    </div>
  );
}

function GainReduction({ trackId, insertId }: { trackId: string; insertId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      onFrame(() => {
        const el = ref.current;
        if (!el) return;
        const gr = Math.min(0, engine.insertReduction(trackId, insertId));
        el.style.width = `${Math.min(100, (-gr / 24) * 100)}%`;
        el.dataset.value = gr.toFixed(1);
      }),
    [trackId, insertId],
  );
  return (
    <div className="gr-meter" title="增益衰減">
      <span>壓縮量</span>
      <div className="gr-track">
        <div className="gr-bar" ref={ref} />
      </div>
    </div>
  );
}

export function FxWindow({ trackId, insertId }: { trackId: string; insertId: string }) {
  const track = useDaw((s) => s.project.tracks.find((t) => t.id === trackId));
  const ins = track?.mixer.inserts.find((i) => i.id === insertId);
  if (!track || !ins) return <p>這個效果器已經被移除了。</p>;
  const def = FX_DEFS[ins.type];
  const presets = FX_PRESETS[ins.type];
  return (
    <div className="fx-window" style={{ ['--tc' as string]: track.color }}>
      <p className="fx-desc">{def.description}</p>
      <div className="fx-row">
        <button type="button" className={`btn ${ins.enabled ? 'btn-on' : ''}`} aria-pressed={ins.enabled} onClick={() => toggleInsert(track.id, ins.id)}>
          {ins.enabled ? '已開啟' : '已旁通'}
        </button>
        {presets && (
          <div className="presets" role="group" aria-label="預設">
            {presets.map((p) => (
              <button key={p.name} type="button" className="chip" onClick={() => setInsertParams(track.id, ins.id, p.params, `${def.name}：${p.name}`)}>
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {ins.type === 'eq' && <EqCurve params={ins.params} />}
      {ins.type === 'comp' && <GainReduction trackId={track.id} insertId={ins.id} />}
      <div className="fx-params">
        {def.params.map((p) => (
          <ParamControl key={p.id} def={p} value={ins.params[p.id] ?? p.default} onChange={(v) => setInsertParam(track.id, ins.id, p.id, v)} />
        ))}
      </div>
    </div>
  );
}
