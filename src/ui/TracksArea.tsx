// Tracks area: track headers, ruler (arrangement markers, cycle, bar numbers), lanes with regions,
// playhead, marquee selection, drag / resize / copy of regions and file drops.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { audioPool } from '../audio/audioPool';
import { engine } from '../audio/engine';
import { CATEGORY_INFO, getPatch } from '../audio/instruments/patches';
import { projectEndBeat } from '../audio/scheduler';
import { beatsPerBar, floorToGrid, gridBeats, snapBeat, tidy } from '../core/time';
import type { Marker, Project, Region, SnapSetting, Track } from '../core/types';
import { clamp, uid } from '../core/util';
import {
  addAudioTrack,
  createEmptyRegion,
  deleteMarker,
  deleteRegions,
  deleteTrack,
  duplicateRegions,
  duplicateTrack,
  importAudioFile,
  importMidiFile,
  moveTrack,
  setLoop,
  setTrackColor,
  setTrackHeight,
  setVolume,
  splitRegionsAt,
  toggleArm,
  toggleLoop,
  toggleMonitor,
  toggleMute,
  toggleRegionMute,
  toggleSolo,
} from '../state/actions';
import { cloneRegion, findRegion, regionEnd, regionLengthBeats } from '../state/ops';
import { loadProjectFile } from '../state/persistence';
import { useDaw } from '../state/store';
import * as cmd from './commands';
import { dragPointer } from './controls/controls';
import { Icon } from './icons';
import { openContextMenu, MenuButton, type MenuItem } from './menu';
import { onFrame } from './raf';
import { RegionThumb } from './RegionThumb';

const st = () => useDaw.getState();
export const TRACK_COLORS = ['#f2c94c', '#ff7b54', '#ff6b9a', '#c38bff', '#a08cff', '#56ccf2', '#3ec7c2', '#4cd47a', '#d9a066', '#7fc8ff', '#e36ba6', '#5b8def'];

const view = { scrollLeft: 0, scrollTop: 0, width: 800 };

function trackIcon(t: Track): string {
  if (t.kind === 'audio') return 'mic';
  return CATEGORY_INFO[getPatch(t.instrument?.patchId).category].icon;
}

function timelineBeats(p: Project): number {
  const bar = beatsPerBar(p.timeSig);
  const markersEnd = Math.max(0, ...p.markers.map((m) => m.start + m.length));
  const end = Math.max(projectEndBeat(p), markersEnd, p.loop.enabled ? p.loop.end : 0);
  return Math.max(bar * 48, Math.ceil(end / bar) * bar + bar * 16);
}

// ------------------------------------------------------------------ region

interface RegionProps {
  region: Region;
  trackId: string;
  color: string;
  ppb: number;
  bpm: number;
  height: number;
  selected: boolean;
}

const RegionView = memo(function RegionView({ region, trackId, color, ppb, bpm, height, selected }: RegionProps) {
  const len = regionLengthBeats(region, bpm);
  const left = region.start * ppb;
  const width = Math.max(4, len * ppb);
  const c = region.color ?? color;
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const edge = Math.min(8, width / 4);
    const mode: DragMode = x <= edge ? 'resize-l' : x >= rect.width - edge ? 'resize-r' : 'move';
    beginRegionDrag(e, region.id, trackId, mode);
  };
  const menu = (e: React.MouseEvent) => {
    const s = st();
    if (!s.ui.selectedRegionIds.includes(region.id)) s.setUi({ selectedRegionIds: [region.id], selectedTrackId: trackId });
    const ids = st().ui.selectedRegionIds;
    const items: MenuItem[] = [
      { label: region.kind === 'midi' ? '在鋼琴捲簾中編輯' : '開啟音訊編輯', onClick: () => cmd.openEditorFor(region.id) },
      {
        label: '重新命名…',
        onClick: () => st().setUi({ dialog: { type: 'rename', target: 'region', id: region.id, value: region.name } }),
      },
      { separator: true },
      { label: '複製一份', shortcut: `${cmdKey}D`, onClick: () => duplicateRegions(ids) },
      { label: '重複 ×4', onClick: () => duplicateRegions(ids, 4) },
      { label: '在播放頭位置分割', shortcut: `${cmdKey}B`, onClick: () => splitRegionsAt(engine.currentBeat(), ids) },
      { label: region.muted ? '取消靜音' : '靜音片段', onClick: () => toggleRegionMute(ids) },
      ...(region.kind === 'midi' ? [{ label: '量化 (Q)', onClick: () => cmd.quantizeSelection() }] : []),
      { label: '把循環範圍設為此片段', onClick: () => setLoop(region.start, regionEnd(region, bpm)) },
      { separator: true },
      { label: '刪除', shortcut: 'Delete', danger: true, onClick: () => deleteRegions(ids) },
    ];
    openContextMenu(e, items);
  };
  return (
    <div
      className={`region region-${region.kind} ${selected ? 'selected' : ''} ${region.muted ? 'muted' : ''}`}
      style={{ left, width, height: height - 4, ['--rc' as string]: c }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        cmd.openEditorFor(region.id);
      }}
      onContextMenu={menu}
      title={region.name}
    >
      <div className="region-head">{region.name}</div>
      <RegionThumb region={region} width={width} height={Math.max(4, height - 22)} bpm={bpm} color={c} />
    </div>
  );
});

const cmdKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

type DragMode = 'move' | 'resize-l' | 'resize-r';

function laneIndexAt(clientY: number): number {
  const lanes = document.querySelector('.lanes');
  if (!lanes) return 0;
  const y = clientY - lanes.getBoundingClientRect().top;
  const tracks = st().project.tracks;
  let acc = 0;
  for (let i = 0; i < tracks.length; i++) {
    acc += tracks[i].height;
    if (y < acc) return i;
  }
  return tracks.length - 1;
}

function beginRegionDrag(e: React.PointerEvent, regionId: string, trackId: string, mode: DragMode): void {
  const s = st();
  cmd.setFocusZone('tracks');
  let sel = s.ui.selectedRegionIds;
  if (e.shiftKey) {
    sel = sel.includes(regionId) ? sel.filter((x) => x !== regionId) : [...sel, regionId];
    s.setUi({ selectedRegionIds: sel, selectedTrackId: trackId });
    return;
  }
  if (!sel.includes(regionId)) {
    sel = [regionId];
    s.setUi({ selectedRegionIds: sel, selectedTrackId: trackId });
  } else s.setUi({ selectedTrackId: trackId });
  const p = s.project;
  const ppb = s.ui.pxPerBeat;
  const grid = gridBeats(s.ui.snap, ppb, p.timeSig);
  const items = sel
    .map((id) => {
      const hit = findRegion(p, id);
      if (!hit) return null;
      return { id, region: hit.region, trackIdx: p.tracks.indexOf(hit.track) };
    })
    .filter(Boolean) as { id: string; region: Region; trackIdx: number }[];
  const primary = items.find((i) => i.id === regionId);
  if (!primary) return;
  const startLane = primary.trackIdx;
  const minStart = Math.min(...items.map((i) => i.region.start));
  let ids = items.map((i) => i.id);
  let copied = false;
  s.beginGesture();
  dragPointer(e, {
    move: (ev, dx) => {
      const snapOn = !(ev.metaKey || ev.ctrlKey);
      const g = snapOn ? grid : 0;
      if (mode === 'move') {
        if (ev.altKey && !copied) {
          copied = true;
          const copies = items.map((i) => cloneRegion(i.region, i.region.start));
          st().update('複製片段', (d) => {
            items.forEach((i, k) => d.tracks[i.trackIdx].regions.push(copies[k] as never));
          });
          ids = copies.map((c) => c.id);
          st().setUi({ selectedRegionIds: ids });
        }
        const target = snapBeat(primary.region.start + dx / ppb, g);
        const delta = Math.max(target - primary.region.start, -minStart);
        const laneDelta = laneIndexAt(ev.clientY) - startLane;
        st().update('移動片段', (d) => {
          items.forEach((it, k) => {
            const id = ids[k];
            let fromTrack = d.tracks.find((t) => t.regions.some((r) => r.id === id));
            if (!fromTrack) return;
            const idx = fromTrack.regions.findIndex((r) => r.id === id);
            const reg = fromTrack.regions[idx];
            reg.start = tidy(Math.max(0, it.region.start + delta));
            const want = clamp(it.trackIdx + laneDelta, 0, d.tracks.length - 1);
            const target = d.tracks[want];
            const compatible = (reg.kind === 'midi' && target.kind === 'instrument') || (reg.kind === 'audio' && target.kind === 'audio');
            const dest = compatible ? target : d.tracks[it.trackIdx];
            if (dest !== fromTrack) {
              fromTrack.regions.splice(idx, 1);
              dest.regions.push(reg);
              fromTrack = dest;
            }
          });
        });
      } else {
        const bpm = p.bpm;
        st().update('調整片段長度', (d) => {
          items.forEach((it) => {
            const hit = d.tracks.flatMap((t) => t.regions).find((r) => r.id === it.id);
            if (!hit) return;
            const o = it.region;
            if (mode === 'resize-r') {
              const end = snapBeat(regionEnd(o, bpm) + dx / ppb, g);
              const minLen = g || 0.25;
              if (hit.kind === 'midi' && o.kind === 'midi') hit.length = tidy(Math.max(minLen, end - o.start));
              else if (hit.kind === 'audio' && o.kind === 'audio') {
                const maxDur = audioPool.get(o.audioId)?.duration ?? o.duration + o.offset;
                hit.duration = clamp(((end - o.start) * 60) / bpm, 0.05, maxDur - o.offset);
              }
            } else {
              const ns = snapBeat(o.start + dx / ppb, g);
              const endB = regionEnd(o, bpm);
              if (hit.kind === 'midi' && o.kind === 'midi') {
                const start = clamp(ns, 0, endB - (g || 0.25));
                const shift = start - o.start;
                hit.start = tidy(start);
                hit.length = tidy(o.length - shift);
                hit.notes = o.notes.map((n) => ({ ...n, start: tidy(n.start - shift) }));
              } else if (hit.kind === 'audio' && o.kind === 'audio') {
                const minStart = o.start - (o.offset * bpm) / 60;
                const start = clamp(ns, Math.max(0, minStart), endB - 0.25);
                const shiftSec = ((start - o.start) * 60) / bpm;
                hit.start = tidy(start);
                hit.offset = Math.max(0, o.offset + shiftSec);
                hit.duration = o.duration - shiftSec;
              }
            }
          });
        });
      }
    },
    up: (_ev, moved) => {
      st().endGesture(mode === 'move' ? (copied ? '複製片段' : '移動片段') : '調整片段長度');
      if (!moved && mode === 'move' && sel.length > 1) st().setUi({ selectedRegionIds: [regionId] });
    },
  });
}

// ------------------------------------------------------------------ lane

const Lane = memo(function Lane({ track, ppb, bpm, selectedIds, y }: { track: Track; ppb: number; bpm: number; selectedIds: string[]; y: number }) {
  const onDoubleClick = (e: React.MouseEvent) => {
    if (track.kind !== 'instrument') return;
    const lanes = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    const beat = (e.clientX - lanes.left) / ppb;
    const p = st().project;
    const bar = beatsPerBar(p.timeSig);
    const id = createEmptyRegion(track.id, floorToGrid(beat, bar), bar);
    if (id) cmd.openEditorFor(id);
  };
  const onContextMenu = (e: React.MouseEvent) => {
    const lanes = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    const beat = (e.clientX - lanes.left) / ppb;
    const bar = beatsPerBar(st().project.timeSig);
    const items: MenuItem[] =
      track.kind === 'instrument'
        ? [
            { label: '在此新增 MIDI 片段', onClick: () => createEmptyRegion(track.id, floorToGrid(beat, bar), bar) },
            { label: '新增 4 小節片段', onClick: () => createEmptyRegion(track.id, floorToGrid(beat, bar), bar * 4) },
          ]
        : [{ label: '在此匯入音訊檔…', onClick: () => void cmd.importAudio(track.id) }];
    openContextMenu(e, items);
  };
  return (
    <div
      className={`lane ${track.kind}`}
      style={{ top: y, height: track.height }}
      data-track={track.id}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {track.regions.map((r) => (
        <RegionView key={r.id} region={r} trackId={track.id} color={track.color} ppb={ppb} bpm={bpm} height={track.height} selected={selectedIds.includes(r.id)} />
      ))}
    </div>
  );
});

// ------------------------------------------------------------------ header

const TrackHeader = memo(function TrackHeader({ track, selected, index }: { track: Track; selected: boolean; index: number }) {
  const patch = track.kind === 'instrument' ? getPatch(track.instrument?.patchId) : null;
  const select = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button,input')) return;
    st().setUi({ selectedTrackId: track.id });
    engine.prefetchTrackRange(track.id);
  };
  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: '重新命名…', onClick: () => st().setUi({ dialog: { type: 'rename', target: 'track', id: track.id, value: track.name } }) },
      ...(track.kind === 'instrument' ? [{ label: '更換音色…', onClick: () => st().setUi({ leftPanel: 'library', selectedTrackId: track.id }) }] : []),
      { label: '複製音軌', onClick: () => duplicateTrack(track.id) },
      { separator: true },
      ...TRACK_COLORS.slice(0, 8).map((c) => ({ label: `● 顏色 ${c}`, onClick: () => setTrackColor(track.id, c) })),
      { separator: true },
      { label: '刪除音軌', danger: true, onClick: () => deleteTrack(track.id) },
    ]);
  const startReorder = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    st().setUi({ selectedTrackId: track.id });
    const indicator = document.querySelector<HTMLElement>('.reorder-line');
    let target = index;
    dragPointer(e, {
      move: (ev) => {
        const headers = document.querySelector('.headers-inner');
        if (!headers) return;
        const y = ev.clientY - headers.getBoundingClientRect().top;
        const tracks = st().project.tracks;
        let acc = 0;
        target = tracks.length;
        for (let i = 0; i < tracks.length; i++) {
          if (y < acc + tracks[i].height / 2) {
            target = i;
            break;
          }
          acc += tracks[i].height;
        }
        let lineY = 0;
        for (let i = 0; i < target; i++) lineY += tracks[i].height;
        if (indicator) {
          indicator.hidden = false;
          indicator.style.transform = `translateY(${lineY}px)`;
        }
      },
      up: (_ev, moved) => {
        if (indicator) indicator.hidden = true;
        if (moved && target !== index && target !== index + 1) moveTrack(track.id, target > index ? target - 1 : target);
      },
    });
  };
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const h0 = track.height;
    dragPointer(e, { threshold: 0, move: (_ev, _dx, dy) => setTrackHeight(track.id, h0 + dy) });
  };
  return (
    <div className={`track-header ${selected ? 'selected' : ''}`} style={{ height: track.height, ['--tc' as string]: track.color }} onPointerDown={select} onContextMenu={menu}>
      <div className="th-color" onPointerDown={startReorder} title="拖曳以調整順序" />
      <div className="th-icon" aria-hidden="true">
        <Icon name={trackIcon(track)} size={20} />
      </div>
      <div className="th-main">
        <div className="th-name" onDoubleClick={() => st().setUi({ dialog: { type: 'rename', target: 'track', id: track.id, value: track.name } })} title={patch ? `${track.name}（${patch.name}）` : track.name}>
          {track.name}
        </div>
        <div className="th-buttons">
          <button type="button" className={`mini-btn m ${track.mixer.mute ? 'on' : ''}`} title="靜音 (M)" aria-pressed={track.mixer.mute} onClick={() => toggleMute(track.id)}>
            M
          </button>
          <button type="button" className={`mini-btn s ${track.mixer.solo ? 'on' : ''}`} title="獨奏 (S)" aria-pressed={track.mixer.solo} onClick={(e) => toggleSolo(track.id, e.altKey)}>
            S
          </button>
          <button type="button" className={`mini-btn r ${track.armed ? 'on' : ''}`} title="錄音待命" aria-pressed={track.armed} onClick={() => toggleArm(track.id)}>
            <Icon name="record" size={11} filled />
          </button>
          {track.kind === 'audio' && (
            <button type="button" className={`mini-btn i ${track.monitor ? 'on' : ''}`} title="輸入監聽（請戴耳機）" aria-pressed={track.monitor} onClick={() => toggleMonitor(track.id)}>
              <Icon name="headphones" size={11} />
            </button>
          )}
        </div>
        {track.height >= 64 && (
          <input
            className="th-volume"
            type="range"
            min={-48}
            max={6}
            step={0.5}
            value={Math.max(-48, track.mixer.volumeDb)}
            aria-label={`${track.name} 音量`}
            title={`音量 ${track.mixer.volumeDb.toFixed(1)} dB`}
            onPointerDown={() => st().beginGesture()}
            onPointerUp={() => st().endGesture('音量')}
            onChange={(e) => setVolume(track.id, Number(e.target.value) <= -48 ? -96 : Number(e.target.value))}
          />
        )}
      </div>
      <div className="th-resize" onPointerDown={startResize} title="拖曳調整高度" />
    </div>
  );
});

// ------------------------------------------------------------------ ruler

function Ruler({ width, ppb, p, innerRef }: { width: number; ppb: number; p: Project; innerRef: React.RefObject<HTMLDivElement | null> }) {
  const bar = beatsPerBar(p.timeSig);
  const barPx = bar * ppb;
  const every = barPx >= 44 ? 1 : barPx >= 22 ? 2 : barPx >= 11 ? 4 : 8;
  const bars = Math.ceil(width / barPx);
  const labels = [];
  for (let b = 0; b < bars; b += every) {
    labels.push(
      <span key={b} className="bar-num" style={{ left: b * barPx }}>
        {b + 1}
      </span>,
    );
  }
  const beatPx = ppb * (4 / p.timeSig[1]);
  const seekAt = (clientX: number, snap = true) => {
    const rect = innerRef.current!.getBoundingClientRect();
    const beat = (clientX - rect.left) / ppb;
    return snap ? cmd.snapPlayhead(beat) : Math.max(0, beat);
  };
  const onBarsDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const playing = st().transport.playing;
    const b = seekAt(e.clientX, !e.altKey);
    if (!playing) engine.seek(b);
    dragPointer(e, {
      threshold: 1,
      move: (ev) => {
        if (!st().transport.playing) engine.seek(seekAt(ev.clientX, !ev.altKey));
      },
      up: (ev) => {
        if (st().transport.playing) engine.seek(seekAt(ev.clientX, !ev.altKey));
      },
    });
  };
  const onCycleDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const rect = innerRef.current!.getBoundingClientRect();
    const beatAt = (x: number) => Math.max(0, Math.round((x - rect.left) / ppb / bar) * bar);
    const loop = p.loop;
    const x = e.clientX - rect.left;
    const ls = loop.start * ppb;
    const le = loop.end * ppb;
    const inside = x >= ls && x <= le && loop.end > loop.start;
    const mode = inside && x - ls < 8 ? 'l' : inside && le - x < 8 ? 'r' : inside ? 'move' : 'new';
    const start0 = beatAt(e.clientX);
    const clickBar = Math.max(0, Math.floor((e.clientX - rect.left) / ppb / bar) * bar);
    dragPointer(e, {
      move: (ev) => {
        const b = beatAt(ev.clientX);
        if (mode === 'new') {
          const lo = Math.min(start0, b);
          const hi = Math.max(start0, b);
          setLoop(lo, hi > lo ? hi : lo + bar);
        }
        else if (mode === 'l') setLoop(Math.min(b, loop.end - bar), loop.end);
        else if (mode === 'r') setLoop(loop.start, Math.max(b, loop.start + bar));
        else {
          const d = Math.round((ev.clientX - e.clientX) / ppb / bar) * bar;
          const len = loop.end - loop.start;
          const s0 = Math.max(0, loop.start + d);
          setLoop(s0, s0 + len);
        }
      },
      up: (_ev, moved) => {
        if (moved) return;
        // click inside the cycle toggles it, click elsewhere starts a 4-bar cycle there
        if (mode === 'new') setLoop(clickBar, clickBar + bar * 4);
        else toggleLoop();
      },
    });
  };
  return (
    <div className="ruler-inner" ref={innerRef} style={{ width }}>
      <div className="marker-lane">
        {p.markers.map((m) => (
          <MarkerView key={m.id} m={m} ppb={ppb} />
        ))}
      </div>
      <div className="cycle-lane" onPointerDown={onCycleDown} title="拖曳設定循環範圍，點一下開／關循環">
        {p.loop.end > p.loop.start && (
          <div className={`cycle-region ${p.loop.enabled ? 'on' : ''}`} style={{ left: p.loop.start * ppb, width: (p.loop.end - p.loop.start) * ppb }} />
        )}
      </div>
      <div
        className="bars-lane"
        onPointerDown={onBarsDown}
        style={{ ['--bar-px' as string]: `${barPx}px`, ['--beat-px' as string]: `${beatPx}px` }}
        title="點擊移動播放頭"
      >
        {labels}
      </div>
    </div>
  );
}

function MarkerView({ m, ppb }: { m: Marker; ppb: number }) {
  const sectionRegions = () => {
    const p = st().project;
    const end = m.start + m.length;
    return p.tracks.flatMap((t) => t.regions.filter((r) => r.start >= m.start - 1e-6 && r.start < end - 1e-6).map((r) => r.id));
  };
  const copyToEnd = () => {
    const p = st().project;
    const bar = beatsPerBar(p.timeSig);
    const end = Math.ceil(Math.max(projectEndBeat(p), ...p.markers.map((x) => x.start + x.length)) / bar) * bar;
    const shift = end - m.start;
    const ids = new Set(sectionRegions());
    st().update(`複製段落「${m.name}」`, (d) => {
      for (const t of d.tracks) {
        const copies = t.regions.filter((r) => ids.has(r.id)).map((r) => cloneRegion(r as Region, r.start + shift));
        t.regions.push(...(copies as never[]));
      }
      d.markers.push({ ...m, id: uid('m'), start: m.start + shift });
    });
  };
  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: '重新命名…', onClick: () => st().setUi({ dialog: { type: 'rename', target: 'marker', id: m.id, value: m.name } }) },
      { label: '循環播放這一段', onClick: () => setLoop(m.start, m.start + m.length) },
      { label: '選取這一段的所有片段', onClick: () => st().setUi({ selectedRegionIds: sectionRegions() }) },
      { label: '把這一段複製到歌曲結尾', onClick: copyToEnd },
      { separator: true },
      { label: '刪除段落標記', danger: true, onClick: () => deleteMarker(m.id) },
    ]);
  return (
    <div
      className="marker"
      style={{ left: m.start * ppb, width: Math.max(8, m.length * ppb - 1), ['--mc' as string]: m.color }}
      title={`${m.name}（雙擊循環播放）`}
      onContextMenu={menu}
      onDoubleClick={() => setLoop(m.start, m.start + m.length)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        engine.seek(m.start);
      }}
    >
      {m.name}
    </div>
  );
}

// ------------------------------------------------------------------ main

const SNAP_OPTIONS: { v: SnapSetting; label: string }[] = [
  { v: 'smart', label: '智慧格線' },
  { v: 'bar', label: '小節' },
  { v: '1/4', label: '1/4' },
  { v: '1/8', label: '1/8' },
  { v: '1/16', label: '1/16' },
  { v: '1/32', label: '1/32' },
  { v: '1/8t', label: '1/8 三連音' },
  { v: '1/16t', label: '1/16 三連音' },
  { v: 'off', label: '不吸附' },
];

export function TracksArea() {
  const tracks = useDaw((s) => s.project.tracks);
  const project = useDaw((s) => s.project);
  const ppb = useDaw((s) => s.ui.pxPerBeat);
  const snap = useDaw((s) => s.ui.snap);
  const selectedTrackId = useDaw((s) => s.ui.selectedTrackId);
  const selectedIds = useDaw(useShallow((s) => s.ui.selectedRegionIds));
  const scrollRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const rulerInnerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const rulerHeadRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dropHint, setDropHint] = useState(false);

  const totalBeats = timelineBeats(project);
  const width = totalBeats * ppb;
  const heights = useMemo(() => {
    let acc = 0;
    return tracks.map((t) => {
      const y = acc;
      acc += t.height;
      return y;
    });
  }, [tracks]);
  const totalH = tracks.reduce((a, t) => a + t.height, 0);

  const syncScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    view.scrollLeft = el.scrollLeft;
    view.scrollTop = el.scrollTop;
    view.width = el.clientWidth;
    if (headersRef.current) headersRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
    if (rulerInnerRef.current) rulerInnerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
  }, []);

  useLayoutEffect(() => syncScroll());

  // playhead + follow
  useEffect(
    () =>
      onFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        const s = st();
        const beat = Math.max(0, engine.countInLeft() > 0 ? s.transport.position : engine.currentBeat());
        const x = beat * s.ui.pxPerBeat;
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
        if (rulerHeadRef.current) rulerHeadRef.current.style.transform = `translateX(${x - el.scrollLeft}px)`;
        if (s.transport.playing) {
          const vw = el.clientWidth;
          if (x > el.scrollLeft + vw * 0.92 || x < el.scrollLeft) {
            el.scrollLeft = Math.max(0, x - vw * 0.08);
            syncScroll();
          }
        }
      }),
    [syncScroll],
  );

  // zoom with ctrl/cmd + wheel, keeping the beat under the pointer fixed
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const s = st();
      const old = s.ui.pxPerBeat;
      const next = clamp(old * Math.pow(1.0018, -e.deltaY), 3, 480);
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const beat = (el.scrollLeft + px) / old;
      s.setUi({ pxPerBeat: next });
      requestAnimationFrame(() => {
        el.scrollLeft = beat * next - px;
        syncScroll();
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [syncScroll]);

  const zoom = (f: number) => {
    const el = scrollRef.current;
    const s = st();
    const old = s.ui.pxPerBeat;
    const next = clamp(old * f, 3, 480);
    const center = el ? (el.scrollLeft + el.clientWidth / 2) / old : 0;
    s.setUi({ pxPerBeat: next });
    requestAnimationFrame(() => {
      if (el) el.scrollLeft = center * next - el.clientWidth / 2;
      syncScroll();
    });
  };

  // marquee selection on empty lane space
  const onLanesPointerDown = (e: React.PointerEvent) => {
    cmd.setFocusZone('tracks');
    if (e.button !== 0 || (e.target as HTMLElement).closest('.region')) return;
    const lanes = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x0 = e.clientX - lanes.left;
    const y0 = e.clientY - lanes.top;
    const additive = e.shiftKey;
    const before = additive ? st().ui.selectedRegionIds : [];
    const idx = laneIndexAt(e.clientY);
    const tr = st().project.tracks[idx];
    if (tr) st().setUi({ selectedTrackId: tr.id });
    dragPointer(e, {
      move: (ev) => {
        const x1 = ev.clientX - lanes.left;
        const y1 = ev.clientY - lanes.top;
        const r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        setMarquee(r);
        const p = st().project;
        const ppbNow = st().ui.pxPerBeat;
        const hit: string[] = [];
        let acc = 0;
        for (const t of p.tracks) {
          const top = acc;
          acc += t.height;
          if (top + t.height < r.y || top > r.y + r.h) continue;
          for (const reg of t.regions) {
            const rx = reg.start * ppbNow;
            const rw = regionLengthBeats(reg, p.bpm) * ppbNow;
            if (rx + rw >= r.x && rx <= r.x + r.w) hit.push(reg.id);
          }
        }
        st().setUi({ selectedRegionIds: Array.from(new Set([...before, ...hit])) });
      },
      up: (_ev, moved) => {
        setMarquee(null);
        if (!moved && !additive) st().setUi({ selectedRegionIds: [] });
      },
    });
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropHint(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const lanes = scrollRef.current?.querySelector('.lanes')?.getBoundingClientRect();
    const beat = lanes ? Math.max(0, (e.clientX - lanes.left) / st().ui.pxPerBeat) : 0;
    const p = st().project;
    const at = floorToGrid(beat, beatsPerBar(p.timeSig) / 4);
    const idx = laneIndexAt(e.clientY);
    const target = p.tracks[idx];
    for (const f of files) {
      try {
        if (/\.(mid|midi)$/i.test(f.name)) await importMidiFile(f);
        else if (/\.json$/i.test(f.name)) await loadProjectFile(f);
        else await importAudioFile(f, target?.kind === 'audio' ? target.id : undefined, at);
      } catch (err) {
        st().toast(`無法匯入「${f.name}」：${(err as Error).message}`, 'error');
      }
    }
  };

  const bar = beatsPerBar(project.timeSig);
  const beatW = ppb * (4 / project.timeSig[1]);
  const grid = gridBeats(snap, ppb, project.timeSig);
  const subW = grid > 0 && grid < 4 / project.timeSig[1] ? grid * ppb : 0;
  const gridStyle = {
    width,
    height: Math.max(totalH, 10),
    ['--bar-px' as string]: `${bar * ppb}px`,
    ['--beat-px' as string]: `${beatW}px`,
    ['--sub-px' as string]: subW >= 6 ? `${subW}px` : '0px',
  };

  const addMenu: MenuItem[] = [
    { label: '軟體樂器（選擇音色）…', onClick: () => st().setUi({ dialog: { type: 'newTrack' } }) },
    { label: '音訊軌（麥克風／樂器）', onClick: () => addAudioTrack() },
    { separator: true },
    { label: '匯入音訊檔…', onClick: () => void cmd.importAudio() },
    { label: '匯入 MIDI 檔…', onClick: () => void cmd.importMidi() },
  ];

  return (
    <section
      className={`tracks ${dropHint ? 'drop-hint' : ''}`}
      aria-label="音軌區"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropHint(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropHint(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="tracks-toolbar">
        <MenuButton items={addMenu} className="btn-primary" title="新增音軌">
          <Icon name="plus" size={16} />
          <span>音軌</span>
        </MenuButton>
        <label className="tb-field" title="格線吸附">
          <Icon name="magnet" size={16} />
          <select value={snap} aria-label="格線吸附" onChange={(e) => st().setUi({ snap: e.target.value as SnapSetting })}>
            {SNAP_OPTIONS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="tb-sep" />
        <button type="button" className="btn icon-btn" title="在播放頭分割 (⌘B)" onClick={cmd.splitAtPlayhead}>
          <Icon name="scissors" />
        </button>
        <button type="button" className="btn icon-btn" title="複製選取片段 (⌘D)" onClick={cmd.duplicateSelection}>
          <Icon name="copy" />
        </button>
        <button type="button" className="btn icon-btn" title="量化 (Q)" onClick={cmd.quantizeSelection}>
          <Icon name="quantize" />
        </button>
        <button type="button" className="btn icon-btn" title="刪除 (Delete)" onClick={cmd.deleteSelection}>
          <Icon name="trash" />
        </button>
        <div className="tb-spacer" />
        <button type="button" className="btn icon-btn" title="縮小" onClick={() => zoom(1 / 1.4)}>
          <Icon name="zoomOut" />
        </button>
        <input
          className="zoom-slider"
          type="range"
          min={0}
          max={100}
          value={Math.round((Math.log(ppb / 3) / Math.log(480 / 3)) * 100)}
          aria-label="水平縮放"
          onChange={(e) => {
            const v = 3 * Math.pow(480 / 3, Number(e.target.value) / 100);
            zoom(v / ppb);
          }}
        />
        <button type="button" className="btn icon-btn" title="放大" onClick={() => zoom(1.4)}>
          <Icon name="zoomIn" />
        </button>
      </div>

      <div className="tracks-body">
        <div className="tracks-corner">
          <span className="corner-label">{tracks.length} 條音軌</span>
        </div>
        <div className="ruler" ref={rulerRef}>
          <Ruler width={width} ppb={ppb} p={project} innerRef={rulerInnerRef} />
          <div className="ruler-playhead" ref={rulerHeadRef} aria-hidden="true" />
        </div>
        <div className="headers">
          <div className="headers-inner" ref={headersRef}>
            {tracks.map((t, i) => (
              <TrackHeader key={t.id} track={t} index={i} selected={t.id === selectedTrackId} />
            ))}
            <div className="reorder-line" hidden />
            <button type="button" className="add-track-row" onClick={() => st().setUi({ dialog: { type: 'newTrack' } })}>
              <Icon name="plus" size={16} /> 新增音軌
            </button>
          </div>
        </div>
        <div className="lanes-scroll" ref={scrollRef} onScroll={syncScroll}>
          <div className="lanes" style={gridStyle} onPointerDown={onLanesPointerDown}>
            {tracks.map((t, i) => (
              <Lane key={t.id} track={t} ppb={ppb} bpm={project.bpm} selectedIds={selectedIds} y={heights[i]} />
            ))}
            {project.loop.enabled && project.loop.end > project.loop.start && (
              <div className="cycle-shade" style={{ left: project.loop.start * ppb, width: (project.loop.end - project.loop.start) * ppb }} />
            )}
            <div className="playhead" ref={playheadRef} aria-hidden="true" />
            {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
          </div>
          {tracks.length === 0 && (
            <div className="tracks-empty">
              <p>還沒有音軌。新增一條樂器或音訊軌，或打開「編曲教練」選一個曲風跟著做。</p>
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={() => st().setUi({ dialog: { type: 'newTrack' } })}>
                  新增音軌
                </button>
                <button type="button" className="btn" onClick={() => st().setUi({ coachOpen: true })}>
                  打開編曲教練
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export { view as timelineView };
