// Drum step sequencer view: one row per kit piece, one column per 16th note.

import { useMemo, useRef } from 'react';
import { DRUM_MAP } from '../audio/dsp/drums';
import { beatsPerBar } from '../core/time';
import type { MidiRegion, Track } from '../core/types';
import { uid } from '../core/util';
import { editMidiRegion } from '../state/actions';
import { useDaw } from '../state/store';
import { engine } from '../audio/engine';
import { dragPointer } from './controls/controls';
import { velocityColor } from './PianoRoll';
import { onFrame } from './raf';
import { useEffect } from 'react';
import * as cmd from './commands';

const ROWS = ['kick', 'snare', 'clap', 'rim', 'snare2', 'hatC', 'hatP', 'hatO', 'tomH', 'tomM', 'tomL', 'tomF', 'crash', 'ride', 'bell', 'tamb', 'shaker', 'cowbell'];
const STEP = 0.25;

export function StepEditor({ region, track }: { region: MidiRegion; track: Track }) {
  const timeSig = useDaw((s) => s.project.timeSig);
  const bar = beatsPerBar(timeSig);
  const steps = Math.max(1, Math.round(region.length / STEP));
  const rows = useMemo(() => {
    const used = new Set(region.notes.map((n) => n.pitch));
    return ROWS.map((piece) => DRUM_MAP.find((d) => d.piece === piece)!).filter((d) => d && (used.has(d.note) || !['bell', 'tamb', 'shaker', 'cowbell', 'snare2', 'tomM'].includes(d.piece)));
  }, [region.notes]);
  const grid = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of region.notes) {
      const step = Math.round(n.start / STEP);
      const k = `${n.pitch}:${step}`;
      m.set(k, Math.max(m.get(k) ?? 0, n.velocity));
    }
    return m;
  }, [region.notes]);
  const playRef = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      onFrame(() => {
        const el = playRef.current;
        if (!el) return;
        const b = engine.currentBeat() - region.start;
        const on = useDaw.getState().transport.playing && b >= 0 && b < region.length;
        el.hidden = !on;
        if (on) el.style.setProperty('--step', String(Math.floor(b / STEP)));
      }),
    [region.start, region.length],
  );

  const setCell = (pitch: number, step: number, velocity: number | null) => {
    editMidiRegion(region.id, velocity ? '新增鼓點' : '刪除鼓點', (r) => {
      r.notes = r.notes.filter((n) => !(n.pitch === pitch && Math.round(n.start / STEP) === step));
      if (velocity) r.notes.push({ id: uid('n'), pitch, start: step * STEP, duration: STEP, velocity });
    });
  };

  const onCellDown = (e: React.PointerEvent, pitch: number, step: number) => {
    e.preventDefault();
    cmd.setFocusZone('editor');
    const cur = grid.get(`${pitch}:${step}`);
    const vel = e.shiftKey ? 122 : e.altKey ? 50 : 100;
    const turnOn = !cur || ((e.shiftKey || e.altKey) && cur !== vel);
    const s = useDaw.getState();
    s.beginGesture();
    setCell(pitch, step, turnOn ? vel : null);
    if (turnOn) engine.previewNote(track.id, pitch, vel, 0.4);
    const painted = new Set([`${pitch}:${step}`]);
    dragPointer(e, {
      threshold: 0,
      move: (ev) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const cell = el?.closest<HTMLElement>('[data-cell]');
        if (!cell) return;
        const [p, st2] = cell.dataset.cell!.split(':').map(Number);
        const k = `${p}:${st2}`;
        if (painted.has(k)) return;
        painted.add(k);
        setCell(p, st2, turnOn ? vel : null);
      },
      up: () => s.endGesture(turnOn ? '新增鼓點' : '刪除鼓點'),
    });
  };

  const barSteps = Math.round(bar / STEP);
  return (
    <div className="steps" role="grid" aria-label="鼓組步進編輯器">
      <div className="steps-help">點格子新增／刪除鼓點 · Shift＋點擊＝重音 · Option＋點擊＝鬼音 · 拖曳可以連續畫</div>
      <div className="steps-scroll">
        <div className="steps-grid" style={{ ['--cols' as string]: steps, ['--bar-steps' as string]: barSteps }}>
          <div className="steps-play" ref={playRef} hidden aria-hidden="true" />
          {rows.map((d) => (
            <div className="steps-row" key={d.note} role="row">
              <button type="button" className="steps-label" onClick={() => engine.previewNote(track.id, d.note, 110, 0.5)} title={`${d.name}（點擊試聽）`}>
                {d.name.split(' ')[0]}
              </button>
              {Array.from({ length: steps }, (_, i) => {
                const v = grid.get(`${d.note}:${i}`);
                return (
                  <div
                    key={i}
                    role="gridcell"
                    aria-selected={!!v}
                    data-cell={`${d.note}:${i}`}
                    className={`step ${v ? 'on' : ''} ${i % barSteps === 0 ? 'bar' : i % 4 === 0 ? 'beat' : ''}`}
                    style={v ? { background: velocityColor(v, false), opacity: 0.45 + (v / 127) * 0.55 } : undefined}
                    onPointerDown={(e) => onCellDown(e, d.note, i)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
