// Docked bottom panel: piano roll / step sequencer / audio editor, or the mixer.

import { useEffect, useRef, useState } from 'react';
import { getPatch } from '../audio/instruments/patches';
import { clamp } from '../core/util';
import { createEmptyRegion } from '../state/actions';
import { findRegion } from '../state/ops';
import { useDaw } from '../state/store';
import { AudioEditor } from './AudioEditor';
import * as cmd from './commands';
import { dragPointer } from './controls/controls';
import { Icon } from './icons';
import { Mixer } from './Mixer';
import { PianoRoll } from './PianoRoll';
import { StepEditor } from './StepEditor';

const st = () => useDaw.getState();

function EditorPane() {
  const regionId = useDaw((s) => s.ui.editorRegionId ?? (s.ui.selectedRegionIds.length === 1 ? s.ui.selectedRegionIds[0] : null));
  const project = useDaw((s) => s.project);
  const view = useDaw((s) => s.ui.editorView);
  const selTrack = useDaw((s) => s.project.tracks.find((t) => t.id === s.ui.selectedTrackId));
  const hit = findRegion(project, regionId);
  if (!hit) {
    return (
      <div className="editor-empty">
        <p>雙擊音軌上的片段就能在這裡編輯。選取樂器軌後，在空白處雙擊可以新增 MIDI 片段。</p>
        {selTrack?.kind === 'instrument' && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const id = createEmptyRegion(selTrack.id, cmd.snapPlayhead(useDaw.getState().transport.position));
              if (id) cmd.openEditorFor(id);
            }}
          >
            <Icon name="plus" size={16} /> 在「{selTrack.name}」新增 MIDI 片段
          </button>
        )}
      </div>
    );
  }
  const { track, region } = hit;
  if (region.kind === 'audio') return <AudioEditor region={region} />;
  const isDrums = getPatch(track.instrument?.patchId).engine === 'drums';
  return (
    <div className="editor-pane">
      <div className="editor-title" style={{ ['--tc' as string]: track.color }}>
        <span className="dot" aria-hidden="true" />
        <strong>{region.name}</strong>
        <span className="muted">· {track.name}</span>
        {isDrums && (
          <div className="seg view-toggle" role="group" aria-label="檢視">
            <button type="button" className={`tbtn ${view === 'step' ? 'on' : ''}`} aria-pressed={view === 'step'} onClick={() => st().setUi({ editorView: 'step' })}>
              <Icon name="grid" size={14} />
              <span className="tbtn-text">步進格</span>
            </button>
            <button type="button" className={`tbtn ${view === 'roll' ? 'on' : ''}`} aria-pressed={view === 'roll'} onClick={() => st().setUi({ editorView: 'roll' })}>
              <Icon name="editor" size={14} />
              <span className="tbtn-text">鋼琴捲簾</span>
            </button>
          </div>
        )}
      </div>
      {isDrums && view === 'step' ? <StepEditor region={region} track={track} /> : <PianoRoll region={region} track={track} />}
    </div>
  );
}

export function BottomPanel() {
  const panel = useDaw((s) => s.ui.bottomPanel);
  const height = useDaw((s) => s.ui.bottomHeight);
  const ref = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState(600);
  useEffect(() => {
    const update = () => setMaxH(Math.max(200, window.innerHeight - 220));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  if (!panel) return null;
  const h = clamp(height, 160, maxH);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const h0 = h;
    dragPointer(e, { threshold: 0, move: (_ev, _dx, dy) => st().setUi({ bottomHeight: clamp(h0 - dy, 160, maxH) }) });
  };
  return (
    <section className="bottom" ref={ref} style={{ height: h }} onPointerDown={() => panel === 'editor' && cmd.setFocusZone('editor')} aria-label={panel === 'editor' ? '編輯器' : '混音台'}>
      <div className="splitter" onPointerDown={startResize} role="separator" aria-orientation="horizontal" title="拖曳調整高度" />
      <div className="bottom-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={panel === 'editor'} className={`tab ${panel === 'editor' ? 'on' : ''}`} onClick={() => st().setUi({ bottomPanel: 'editor' })}>
          <Icon name="editor" size={15} /> 編輯器
        </button>
        <button type="button" role="tab" aria-selected={panel === 'mixer'} className={`tab ${panel === 'mixer' ? 'on' : ''}`} onClick={() => cmd.showBottom('mixer')}>
          <Icon name="mixer" size={15} /> 混音台
        </button>
        <div className="tb-spacer" />
        <button type="button" className="btn icon-btn" title="收起" onClick={() => st().setUi({ bottomPanel: null })}>
          <Icon name="chevronDown" size={16} />
        </button>
      </div>
      <div className="bottom-body">{panel === 'editor' ? <EditorPane /> : <Mixer height={h - 40} />}</div>
    </section>
  );
}
