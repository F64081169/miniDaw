// Left side panel: instrument library (patch browser with audition) and the inspector
// (region parameters, smart controls, channel strip).

import { useMemo, useState } from 'react';
import { engine } from '../audio/engine';
import { CATEGORY_INFO, CATEGORY_ORDER, CONTROL_LABELS, PATCHES, getPatch } from '../audio/instruments/patches';
import type { PatchCategory } from '../audio/instruments/types';
import { beatsPerBar, formatBarBeat } from '../core/time';
import type { MidiRegion, Track } from '../core/types';
import { clamp } from '../core/util';
import { auditionPhrase } from '../music/coach';
import { addInstrumentTrack, editMidiRegion, setInstrumentParam, setTrackPatch, toggleRegionMute, transposeNotes } from '../state/actions';
import { findRegion } from '../state/ops';
import { useDaw } from '../state/store';
import * as cmd from './commands';
import { Knob } from './controls/controls';
import { Icon } from './icons';
import { TrackStrip } from './Mixer';

const st = () => useDaw.getState();

export function Library() {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<PatchCategory | 'all'>('all');
  const selTrack = useDaw((s) => s.project.tracks.find((t) => t.id === s.ui.selectedTrackId));
  const current = selTrack?.kind === 'instrument' ? selTrack.instrument?.patchId : undefined;
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PATCHES.filter((p) => (cat === 'all' || p.category === cat) && (!q || `${p.name} ${p.nameEn} ${p.description} ${CATEGORY_INFO[p.category].name}`.toLowerCase().includes(q)));
  }, [query, cat]);
  const choose = (patchId: string) => {
    if (selTrack && selTrack.kind === 'instrument') setTrackPatch(selTrack.id, patchId);
    else addInstrumentTrack(patchId);
  };
  return (
    <div className="library">
      <div className="panel-head">
        <h2>音色庫</h2>
        <span className="panel-sub">{selTrack?.kind === 'instrument' ? `套用到「${selTrack.name}」` : '點選音色會新增一條樂器軌'}</span>
      </div>
      <input className="search" type="search" placeholder="搜尋音色，例如：鋼琴、808、Bossa" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜尋音色" />
      <div className="cat-chips" role="tablist" aria-label="音色類別">
        <button type="button" role="tab" aria-selected={cat === 'all'} className={`chip ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>
          全部
        </button>
        {CATEGORY_ORDER.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={cat === c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)} style={{ ['--cc' as string]: CATEGORY_INFO[c].color }}>
            {CATEGORY_INFO[c].name}
          </button>
        ))}
      </div>
      <ul className="patch-list">
        {list.map((p) => (
          <li key={p.id} className={`patch ${p.id === current ? 'current' : ''}`} style={{ ['--cc' as string]: CATEGORY_INFO[p.category].color }}>
            <button type="button" className="patch-main" onClick={() => choose(p.id)} title={p.id === current ? '目前使用中' : '套用這個音色'}>
              <span className="patch-icon" aria-hidden="true">
                <Icon name={CATEGORY_INFO[p.category].icon} size={18} />
              </span>
              <span className="patch-text">
                <span className="patch-name">
                  {p.name} <span className="patch-en">{p.nameEn}</span>
                </span>
                <span className="patch-desc">{p.description}</span>
              </span>
            </button>
            <button type="button" className="btn icon-btn patch-play" title={`試聽 ${p.name}`} onClick={() => void engine.auditionPatch(p.id, auditionPhrase(p.category))}>
              <Icon name="play" size={14} filled />
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="empty">找不到符合「{query}」的音色。</li>}
      </ul>
    </div>
  );
}

function RegionInspector({ track, regionId }: { track: Track; regionId: string }) {
  const p = useDaw((s) => s.project);
  const hit = findRegion(p, regionId);
  if (!hit) return null;
  const r = hit.region;
  const bar = beatsPerBar(p.timeSig);
  return (
    <section className="insp-section">
      <h3>片段</h3>
      <dl className="kv">
        <dt>名稱</dt>
        <dd>
          <button type="button" className="link" onClick={() => st().setUi({ dialog: { type: 'rename', target: 'region', id: r.id, value: r.name } })}>
            {r.name}
          </button>
        </dd>
        <dt>位置</dt>
        <dd className="num">{formatBarBeat(r.start, p.timeSig)}</dd>
        <dt>長度</dt>
        <dd className="num">{r.kind === 'midi' ? `${Math.round((r.length / bar) * 100) / 100} 小節` : `${r.duration.toFixed(2)} 秒`}</dd>
        {r.kind === 'midi' && (
          <>
            <dt>音符</dt>
            <dd className="num">{r.notes.length}</dd>
          </>
        )}
      </dl>
      <div className="row wrap">
        <button type="button" className={`btn ${r.muted ? 'btn-on' : ''}`} onClick={() => toggleRegionMute([r.id])}>
          {r.muted ? '已靜音' : '靜音'}
        </button>
        <button type="button" className="btn" onClick={() => cmd.openEditorFor(r.id)}>
          編輯
        </button>
        {r.kind === 'midi' && track.kind === 'instrument' && (
          <>
            <button type="button" className="btn" onClick={() => cmd.quantizeSelection()}>
              量化
            </button>
            <button type="button" className="btn" onClick={() => transposeNotes(r.id, null, -1)} title="整段降半音">
              −1
            </button>
            <button type="button" className="btn" onClick={() => transposeNotes(r.id, null, 1)} title="整段升半音">
              +1
            </button>
            <button
              type="button"
              className="btn"
              title="整段力度 −10"
              onClick={() =>
                editMidiRegion(r.id, '力度 −10', (d: MidiRegion) => {
                  d.notes.forEach((n) => (n.velocity = clamp(n.velocity - 10, 1, 127)));
                })
              }
            >
              力度−
            </button>
            <button
              type="button"
              className="btn"
              title="整段力度 +10"
              onClick={() =>
                editMidiRegion(r.id, '力度 +10', (d: MidiRegion) => {
                  d.notes.forEach((n) => (n.velocity = clamp(n.velocity + 10, 1, 127)));
                })
              }
            >
              力度+
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function SmartControls({ track }: { track: Track }) {
  if (track.kind !== 'instrument' || !track.instrument) return null;
  const patch = getPatch(track.instrument.patchId);
  return (
    <section className="insp-section">
      <h3>
        音色控制 <span className="h-sub">{patch.name}</span>
      </h3>
      <div className="smart-knobs">
        {patch.controls.map((c) => (
          <Knob
            key={c.id}
            label={CONTROL_LABELS[c.id]}
            value={track.instrument!.params[c.id] ?? c.default}
            def={c.default}
            onChange={(v) => setInstrumentParam(track.id, c.id, v)}
            format={(v) => `${Math.round(v * 100)}`}
            gestureLabel={CONTROL_LABELS[c.id]}
          />
        ))}
      </div>
      <button type="button" className="btn wide" onClick={() => st().setUi({ leftPanel: 'library' })}>
        <Icon name="library" size={16} /> 更換音色
      </button>
    </section>
  );
}

export function Inspector() {
  const track = useDaw((s) => s.project.tracks.find((t) => t.id === s.ui.selectedTrackId) ?? null);
  const regionId = useDaw((s) => (s.ui.selectedRegionIds.length === 1 ? s.ui.selectedRegionIds[0] : null));
  if (!track) {
    return (
      <div className="inspector">
        <div className="panel-head">
          <h2>檢閱器</h2>
        </div>
        <p className="muted">選擇一條音軌或片段，這裡會顯示它的設定。</p>
      </div>
    );
  }
  return (
    <div className="inspector">
      <div className="panel-head">
        <h2>檢閱器</h2>
        <span className="panel-sub">{track.name}</span>
      </div>
      {regionId && <RegionInspector track={track} regionId={regionId} />}
      <SmartControls track={track} />
      <section className="insp-section insp-strip">
        <h3>頻道條</h3>
        <TrackStrip track={track} height={150} />
      </section>
    </div>
  );
}
