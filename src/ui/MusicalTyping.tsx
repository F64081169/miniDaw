// Floating "Musical Typing" keyboard (like Logic's): computer keys play the selected instrument.

import { useEffect, useState } from 'react';
import { engine } from '../audio/engine';
import { noteName } from '../music/theory';
import { useDaw } from '../state/store';
import { dragPointer } from './controls/controls';
import { Icon } from './icons';
import { heldPitches, liveTarget, onHeldChange, TYPING_KEYS } from './liveInput';

const BLACK = new Set([1, 3, 6, 8, 10]);

export function MusicalTyping() {
  const octave = useDaw((s) => s.ui.typingOctave);
  const velocity = useDaw((s) => s.ui.typingVelocity);
  const target = useDaw((s) => s.project.tracks.find((t) => t.id === liveTarget()));
  const setUi = useDaw((s) => s.setUi);
  const [held, setHeld] = useState<Set<number>>(new Set());
  const [mouseNote, setMouseNote] = useState<number | null>(null);
  useEffect(() => onHeldChange(() => setHeld(heldPitches())), []);
  const base = (octave + 1) * 12;
  const whites = TYPING_KEYS.filter((k) => !BLACK.has(k.offset % 12));
  const play = (pitch: number) => {
    const t = liveTarget();
    if (!t) return;
    engine.noteOn(t, pitch, velocity);
    setMouseNote(pitch);
    const stop = () => {
      engine.noteOff(t, pitch);
      setMouseNote(null);
    };
    dragPointer({ clientX: 0, clientY: 0 }, { threshold: 1e9, move: () => undefined, up: stop });
  };
  return (
    <div className="typing" role="dialog" aria-label="電腦鍵盤演奏">
      <div className="typing-head">
        <strong>
          <Icon name="keyboard" size={16} /> 鍵盤演奏
        </strong>
        <span className="muted small">{target ? `→ ${target.name}` : '先選一條樂器軌'}</span>
        <button type="button" className="btn icon-btn" title="關閉" onClick={() => setUi({ typingOpen: false })}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="typing-keys">
        {whites.map((k) => {
          const pitch = base + k.offset;
          return (
            <button
              key={k.code}
              type="button"
              className={`tkey white ${held.has(pitch) || mouseNote === pitch ? 'down' : ''}`}
              onPointerDown={(e) => {
                e.preventDefault();
                play(pitch);
              }}
            >
              <span className="tkey-letter">{k.label}</span>
              {pitch % 12 === 0 && <span className="tkey-note">{noteName(pitch)}</span>}
            </button>
          );
        })}
        {TYPING_KEYS.filter((k) => BLACK.has(k.offset % 12)).map((k) => {
          const pitch = base + k.offset;
          // position black keys between the white keys
          const whiteIndex = whites.filter((w) => w.offset < k.offset).length;
          return (
            <button
              key={k.code}
              type="button"
              className={`tkey black ${held.has(pitch) || mouseNote === pitch ? 'down' : ''}`}
              style={{ left: `calc(${whiteIndex} * (100% / ${whites.length}) - (100% / ${whites.length}) * 0.32)` }}
              onPointerDown={(e) => {
                e.preventDefault();
                play(pitch);
              }}
            >
              <span className="tkey-letter">{k.label}</span>
            </button>
          );
        })}
      </div>
      <div className="typing-foot small">
        <span>
          <kbd>Z</kbd>/<kbd>X</kbd> 八度 {noteName(base)}
        </span>
        <span>
          <kbd>C</kbd>/<kbd>V</kbd> 力度 {velocity}
        </span>
        <span>
          <kbd>Tab</kbd> 延音踏板
        </span>
        <span>
          <kbd>R</kbd> 錄音
        </span>
      </div>
    </div>
  );
}
