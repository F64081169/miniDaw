// Application shell: layout, global keyboard shortcuts, toasts.

import { useEffect } from 'react';
import { engine } from '../audio/engine';
import { gridBeats } from '../core/time';
import { editMidiRegion, toggleMute, toggleSolo, transposeNotes } from '../state/actions';
import { useDaw } from '../state/store';
import { BottomPanel } from './BottomPanel';
import { CoachPanel } from './Coach';
import * as cmd from './commands';
import { ControlBar } from './ControlBar';
import { DialogHost } from './Dialogs';
import { Inspector, Library } from './LeftPanel';
import { releaseAllTyping, typingKeyDown, typingKeyUp } from './liveInput';
import { ContextMenuHost } from './menu';
import { MusicalTyping } from './MusicalTyping';
import { TracksArea } from './TracksArea';

const st = () => useDaw.getState();

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || el.isContentEditable) return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['range', 'checkbox', 'radio', 'button'].includes(type);
  }
  return tag === 'SELECT';
}

function selectAdjacentTrack(dir: number): void {
  const s = st();
  const tracks = s.project.tracks;
  if (!tracks.length) return;
  const i = tracks.findIndex((t) => t.id === s.ui.selectedTrackId);
  const next = tracks[Math.max(0, Math.min(tracks.length - 1, (i < 0 ? 0 : i) + dir))];
  s.setUi({ selectedTrackId: next.id });
}

function nudgeNotes(dir: number): boolean {
  const s = st();
  if (cmd.focusZone !== 'editor' || !s.ui.editorRegionId || !s.ui.selectedNoteIds.length) return false;
  const g = gridBeats(s.ui.snap, s.ui.editorPxPerBeat, s.project.timeSig) || 0.25;
  const ids = new Set(s.ui.selectedNoteIds);
  editMidiRegion(s.ui.editorRegionId, '移動音符', (r) => {
    for (const n of r.notes) if (ids.has(n.id)) n.start = Math.max(0, Math.round((n.start + dir * g) * 960) / 960);
  });
  return true;
}

function onKeyDown(e: KeyboardEvent): void {
  if (isEditable(e.target)) return;
  const s = st();
  if (s.ui.dialog) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod && typingKeyDown(e)) {
    e.preventDefault();
    return;
  }
  const k = e.key;
  const handled = (() => {
    if (k === ' ') {
      void engine.togglePlay();
      return true;
    }
    if (mod) {
      switch (k.toLowerCase()) {
        case 'z':
          if (e.shiftKey) s.redo();
          else s.undo();
          return true;
        case 'y':
          s.redo();
          return true;
        case 'd':
          cmd.duplicateSelection();
          return true;
        case 'b':
          cmd.splitAtPlayhead();
          return true;
        case 'a':
          cmd.selectAll();
          return true;
        case 's':
          void cmd.saveProject();
          return true;
        case 'k':
          s.setUi({ typingOpen: !s.ui.typingOpen });
          return true;
      }
      return false;
    }
    if (e.altKey) return false;
    switch (k) {
      case 'Enter':
      case 'Home':
        if ((e.target as HTMLElement)?.tagName === 'BUTTON' && k === 'Enter') return false;
        cmd.toStart();
        return true;
      case 'r':
      case 'R':
        void engine.record();
        return true;
      case 'c':
      case 'C':
        cmd.toggleLoop();
        return true;
      case 'k':
      case 'K':
        cmd.toggleMetronome();
        return true;
      case ',':
        cmd.moveBars(-1);
        return true;
      case '.':
        cmd.moveBars(1);
        return true;
      case 'Delete':
      case 'Backspace':
        cmd.deleteSelection();
        return true;
      case 'q':
      case 'Q':
        cmd.quantizeSelection();
        return true;
      case 'm':
      case 'M':
        if (s.ui.selectedTrackId) toggleMute(s.ui.selectedTrackId);
        return true;
      case 's':
      case 'S':
        if (s.ui.selectedTrackId) toggleSolo(s.ui.selectedTrackId);
        return true;
      case 'e':
      case 'E':
      case 'p':
      case 'P':
        cmd.toggleBottom('editor');
        return true;
      case 'x':
      case 'X':
        cmd.toggleBottom('mixer');
        return true;
      case 'y':
      case 'Y':
        cmd.toggleLeft('library');
        return true;
      case 'i':
      case 'I':
        cmd.toggleLeft('inspector');
        return true;
      case 'g':
      case 'G':
        s.setUi({ coachOpen: !s.ui.coachOpen });
        return true;
      case '1':
        s.setUi({ tool: 'pointer' });
        return true;
      case '2':
        s.setUi({ tool: 'pencil' });
        return true;
      case '3':
        s.setUi({ tool: 'eraser' });
        return true;
      case '?':
        s.setUi({ dialog: { type: 'shortcuts' } });
        return true;
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = k === 'ArrowUp' ? 1 : -1;
        if (cmd.focusZone === 'editor' && s.ui.editorRegionId && s.ui.selectedNoteIds.length) {
          transposeNotes(s.ui.editorRegionId, s.ui.selectedNoteIds, dir * (e.shiftKey ? 12 : 1));
          return true;
        }
        selectAdjacentTrack(-dir);
        return true;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = k === 'ArrowLeft' ? -1 : 1;
        if (nudgeNotes(dir)) return true;
        cmd.moveBars(dir);
        return true;
      }
      case 'Escape':
        if (s.ui.typingOpen) s.setUi({ typingOpen: false });
        else s.setUi({ selectedRegionIds: [], selectedNoteIds: [] });
        return true;
    }
    return false;
  })();
  if (handled) e.preventDefault();
}

function onKeyUp(e: KeyboardEvent): void {
  if (typingKeyUp(e)) e.preventDefault();
}

function Toasts() {
  const toasts = useDaw((s) => s.ui.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const left = useDaw((s) => s.ui.leftPanel);
  const coachOpen = useDaw((s) => s.ui.coachOpen);
  const typingOpen = useDaw((s) => s.ui.typingOpen);
  const recording = useDaw((s) => s.transport.recording);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', releaseAllTyping);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', releaseAllTyping);
    };
  }, []);

  return (
    <div className={`app ${left ? 'has-left' : ''} ${coachOpen ? 'has-coach' : ''} ${recording ? 'is-recording' : ''}`}>
      <ControlBar />
      <div className="workspace">
        {left && (
          <aside className="leftpanel" aria-label={left === 'library' ? '音色庫' : '檢閱器'}>
            <div className="leftpanel-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={left === 'library'} className={`tab ${left === 'library' ? 'on' : ''}`} onClick={() => st().setUi({ leftPanel: 'library' })}>
                音色庫
              </button>
              <button type="button" role="tab" aria-selected={left === 'inspector'} className={`tab ${left === 'inspector' ? 'on' : ''}`} onClick={() => st().setUi({ leftPanel: 'inspector' })}>
                檢閱器
              </button>
              <button type="button" className="btn icon-btn panel-close" title="關閉" onClick={() => st().setUi({ leftPanel: null })}>
                ×
              </button>
            </div>
            <div className="leftpanel-body">{left === 'library' ? <Library /> : <Inspector />}</div>
          </aside>
        )}
        <main className="main">
          <TracksArea />
          <BottomPanel />
        </main>
        {coachOpen && <CoachPanel />}
      </div>
      {typingOpen && <MusicalTyping />}
      <DialogHost />
      <ContextMenuHost />
      <Toasts />
    </div>
  );
}
