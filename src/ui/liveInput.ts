// Live note input: computer-keyboard "musical typing" and Web MIDI keyboards.

import { engine } from '../audio/engine';
import { getProject, useDaw } from '../state/store';

export const TYPING_KEYS: { code: string; label: string; offset: number }[] = [
  { code: 'KeyA', label: 'A', offset: 0 },
  { code: 'KeyW', label: 'W', offset: 1 },
  { code: 'KeyS', label: 'S', offset: 2 },
  { code: 'KeyE', label: 'E', offset: 3 },
  { code: 'KeyD', label: 'D', offset: 4 },
  { code: 'KeyF', label: 'F', offset: 5 },
  { code: 'KeyT', label: 'T', offset: 6 },
  { code: 'KeyG', label: 'G', offset: 7 },
  { code: 'KeyY', label: 'Y', offset: 8 },
  { code: 'KeyH', label: 'H', offset: 9 },
  { code: 'KeyU', label: 'U', offset: 10 },
  { code: 'KeyJ', label: 'J', offset: 11 },
  { code: 'KeyK', label: 'K', offset: 12 },
  { code: 'KeyO', label: 'O', offset: 13 },
  { code: 'KeyL', label: 'L', offset: 14 },
  { code: 'KeyP', label: 'P', offset: 15 },
  { code: 'Semicolon', label: ';', offset: 16 },
  { code: 'Quote', label: "'", offset: 17 },
];

const OFFSET_BY_CODE = new Map(TYPING_KEYS.map((k) => [k.code, k.offset]));

/** Track that receives live notes: the selected instrument track, else an armed one, else the first one. */
export function liveTarget(): string | null {
  const p = getProject();
  const sel = p.tracks.find((t) => t.id === useDaw.getState().ui.selectedTrackId);
  if (sel?.kind === 'instrument') return sel.id;
  const armed = p.tracks.find((t) => t.kind === 'instrument' && t.armed);
  if (armed) return armed.id;
  return p.tracks.find((t) => t.kind === 'instrument')?.id ?? null;
}

const held = new Map<string, { trackId: string; pitch: number }>();
const listeners = new Set<() => void>();
export function onHeldChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function heldPitches(): Set<number> {
  return new Set([...held.values()].map((h) => h.pitch));
}

/** Returns true when the key was consumed by musical typing. */
export function typingKeyDown(e: KeyboardEvent): boolean {
  const s = useDaw.getState();
  if (!s.ui.typingOpen || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.code === 'KeyZ' || e.code === 'KeyX') {
    if (!e.repeat) s.setUi({ typingOctave: Math.max(0, Math.min(8, s.ui.typingOctave + (e.code === 'KeyZ' ? -1 : 1))) });
    return true;
  }
  if (e.code === 'KeyC' || e.code === 'KeyV') {
    s.setUi({ typingVelocity: Math.max(10, Math.min(127, s.ui.typingVelocity + (e.code === 'KeyC' ? -10 : 10))) });
    return true;
  }
  if (e.code === 'Tab') {
    const t = liveTarget();
    if (t && !e.repeat) engine.setSustain(t, true);
    return true;
  }
  const off = OFFSET_BY_CODE.get(e.code);
  if (off === undefined) return false;
  if (e.repeat || held.has(e.code)) return true;
  const trackId = liveTarget();
  if (!trackId) {
    s.toast('先新增一條樂器軌才能用鍵盤演奏');
    return true;
  }
  const pitch = Math.max(0, Math.min(127, (s.ui.typingOctave + 1) * 12 + off));
  held.set(e.code, { trackId, pitch });
  engine.noteOn(trackId, pitch, s.ui.typingVelocity);
  listeners.forEach((l) => l());
  return true;
}

export function typingKeyUp(e: KeyboardEvent): boolean {
  if (e.code === 'Tab') {
    const t = liveTarget();
    if (t) engine.setSustain(t, false);
    return useDaw.getState().ui.typingOpen;
  }
  const h = held.get(e.code);
  if (!h) return false;
  held.delete(e.code);
  engine.noteOff(h.trackId, h.pitch);
  listeners.forEach((l) => l());
  return true;
}

export function releaseAllTyping(): void {
  for (const h of held.values()) engine.noteOff(h.trackId, h.pitch);
  held.clear();
  listeners.forEach((l) => l());
}

// ------------------------------------------------------------------ Web MIDI

let midiAccess: MIDIAccess | null = null;
const midiHeld = new Map<number, string>();

function onMidiMessage(e: MIDIMessageEvent): void {
  const d = e.data;
  if (!d || d.length < 2) return;
  const status = d[0] & 0xf0;
  const trackId = liveTarget();
  if (!trackId) return;
  if (status === 0x90 && d[2] > 0) {
    midiHeld.set(d[1], trackId);
    engine.noteOn(trackId, d[1], d[2]);
  } else if (status === 0x80 || (status === 0x90 && d[2] === 0)) {
    engine.noteOff(midiHeld.get(d[1]) ?? trackId, d[1]);
    midiHeld.delete(d[1]);
  } else if (status === 0xb0 && d[1] === 64) {
    engine.setSustain(trackId, d[2] >= 64);
  }
}

export async function enableMidi(): Promise<number> {
  if (!navigator.requestMIDIAccess) throw new Error('這個瀏覽器不支援 Web MIDI（建議使用 Chrome 或 Edge）');
  midiAccess = await navigator.requestMIDIAccess();
  const hook = () => {
    midiAccess?.inputs.forEach((input) => {
      input.onmidimessage = onMidiMessage;
    });
  };
  hook();
  midiAccess.onstatechange = hook;
  return midiAccess.inputs.size;
}

export function disableMidi(): void {
  midiAccess?.inputs.forEach((input) => {
    input.onmidimessage = null;
  });
  midiAccess = null;
}
