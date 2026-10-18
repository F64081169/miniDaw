// Global application state: the project (undoable, immutable via immer), UI state and transport state.

import { produce, type Draft } from 'immer';
import { create } from 'zustand';
import type { Project, SnapSetting } from '../core/types';
import { createStarterProject } from './project';

export type LeftPanel = 'library' | 'inspector' | null;
export type BottomPanel = 'editor' | 'mixer' | null;
export type EditorTool = 'pointer' | 'pencil' | 'eraser';

export type Dialog =
  | { type: 'newTrack' }
  | { type: 'settings' }
  | { type: 'export' }
  | { type: 'welcome' }
  | { type: 'shortcuts' }
  | { type: 'fx'; trackId: string | 'master' | 'reverb' | 'delay'; insertId?: string }
  | { type: 'rename'; target: 'track' | 'region' | 'marker' | 'project'; id: string; value: string };

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}

export interface UiState {
  selectedTrackId: string | null;
  selectedRegionIds: string[];
  editorRegionId: string | null;
  selectedNoteIds: string[];
  pxPerBeat: number;
  snap: SnapSetting;
  leftPanel: LeftPanel;
  bottomPanel: BottomPanel;
  bottomHeight: number;
  coachOpen: boolean;
  typingOpen: boolean;
  tool: EditorTool;
  editorPxPerBeat: number;
  editorRowHeight: number;
  editorView: 'roll' | 'step';
  scaleGuide: boolean;
  dialog: Dialog | null;
  toasts: Toast[];
  theme: 'auto' | 'dark' | 'light';
  typingOctave: number;
  typingVelocity: number;
  recordOffsetMs: number;
  inputDeviceId: string;
  midiEnabled: boolean;
}

export interface TransportState {
  playing: boolean;
  recording: boolean;
  countingIn: boolean;
  position: number; // playhead (beats) while stopped / last locate
  preparing: boolean;
  inputLevel: number;
}

export interface UpdateOpts {
  undoable?: boolean;
  coalesce?: string; // merge rapid edits with the same key into one undo step
}

export interface DawState {
  project: Project;
  past: { project: Project; label: string }[];
  future: { project: Project; label: string }[];
  gestureBase: Project | null;
  lastCoalesce: { key: string; time: number } | null;
  ui: UiState;
  transport: TransportState;
  update(label: string, recipe: (draft: Draft<Project>) => void, opts?: UpdateOpts): void;
  loadProject(p: Project): void;
  undo(): void;
  redo(): void;
  beginGesture(): void;
  endGesture(label: string): void;
  setUi(patch: Partial<UiState> | ((ui: UiState) => Partial<UiState>)): void;
  setTransport(patch: Partial<TransportState>): void;
  toast(text: string, kind?: Toast['kind']): void;
}

const PREFS_KEY = 'minidaw.prefs.v1';

function loadPrefs(): Partial<UiState> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<UiState>) : {};
  } catch {
    return {};
  }
}

export function savePrefs(ui: UiState): void {
  try {
    const keep: Partial<UiState> = {
      theme: ui.theme,
      leftPanel: ui.leftPanel,
      bottomHeight: ui.bottomHeight,
      snap: ui.snap,
      scaleGuide: ui.scaleGuide,
      recordOffsetMs: ui.recordOffsetMs,
      inputDeviceId: ui.inputDeviceId,
      typingVelocity: ui.typingVelocity,
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify(keep));
  } catch {
    /* storage unavailable */
  }
}

const defaultUi: UiState = {
  selectedTrackId: null,
  selectedRegionIds: [],
  editorRegionId: null,
  selectedNoteIds: [],
  pxPerBeat: 28,
  snap: 'smart',
  leftPanel: 'library',
  bottomPanel: null,
  bottomHeight: 340,
  coachOpen: true,
  typingOpen: false,
  tool: 'pointer',
  editorPxPerBeat: 90,
  editorRowHeight: 14,
  editorView: 'step',
  scaleGuide: true,
  dialog: null,
  toasts: [],
  theme: 'auto',
  typingOctave: 4,
  typingVelocity: 96,
  recordOffsetMs: 0,
  inputDeviceId: '',
  midiEnabled: false,
};

/** Fields that are not part of undo history: restoring a snapshot keeps their current values. */
function carryTransient(target: Project, current: Project): Project {
  return produce(target, (d) => {
    d.metronome = current.metronome;
    d.loop = current.loop;
    for (const t of d.tracks) {
      const cur = current.tracks.find((c) => c.id === t.id);
      if (cur) {
        t.armed = cur.armed;
        t.monitor = cur.monitor;
      }
    }
  });
}

let toastId = 1;

export const useDaw = create<DawState>((set, get) => ({
  project: createStarterProject(),
  past: [],
  future: [],
  gestureBase: null,
  lastCoalesce: null,
  ui: { ...defaultUi, ...loadPrefs() },
  transport: { playing: false, recording: false, countingIn: false, position: 0, preparing: false, inputLevel: 0 },

  update(label, recipe, opts = {}) {
    const s = get();
    const prev = s.project;
    const next = produce(prev, recipe);
    if (next === prev) return;
    if (opts.undoable === false || s.gestureBase) {
      set({ project: next });
      return;
    }
    const now = performance.now();
    if (opts.coalesce && s.lastCoalesce && s.lastCoalesce.key === opts.coalesce && now - s.lastCoalesce.time < 1500) {
      set({ project: next, lastCoalesce: { key: opts.coalesce, time: now } });
      return;
    }
    set({
      project: next,
      past: [...s.past, { project: prev, label }].slice(-200),
      future: [],
      lastCoalesce: opts.coalesce ? { key: opts.coalesce, time: now } : null,
    });
  },

  loadProject(p) {
    set({
      project: p,
      past: [],
      future: [],
      gestureBase: null,
      lastCoalesce: null,
      ui: { ...get().ui, selectedTrackId: p.tracks[0]?.id ?? null, selectedRegionIds: [], editorRegionId: null, selectedNoteIds: [] },
      transport: { ...get().transport, position: 0 },
    });
  },

  undo() {
    const s = get();
    const last = s.past[s.past.length - 1];
    if (!last) return;
    set({
      project: carryTransient(last.project, s.project),
      past: s.past.slice(0, -1),
      future: [...s.future, { project: s.project, label: last.label }],
      lastCoalesce: null,
    });
    get().toast(`復原：${last.label}`);
  },

  redo() {
    const s = get();
    const next = s.future[s.future.length - 1];
    if (!next) return;
    set({
      project: carryTransient(next.project, s.project),
      future: s.future.slice(0, -1),
      past: [...s.past, { project: s.project, label: next.label }],
      lastCoalesce: null,
    });
    get().toast(`重做：${next.label}`);
  },

  beginGesture() {
    if (!get().gestureBase) set({ gestureBase: get().project });
  },

  endGesture(label) {
    const s = get();
    const base = s.gestureBase;
    if (!base) return;
    if (base === s.project) {
      set({ gestureBase: null });
      return;
    }
    set({ gestureBase: null, past: [...s.past, { project: base, label }].slice(-200), future: [], lastCoalesce: null });
  },

  setUi(patch) {
    const ui = get().ui;
    const p = typeof patch === 'function' ? patch(ui) : patch;
    set({ ui: { ...ui, ...p } });
  },

  setTransport(patch) {
    set({ transport: { ...get().transport, ...patch } });
  },

  toast(text, kind = 'info') {
    const id = toastId++;
    set({ ui: { ...get().ui, toasts: [...get().ui.toasts, { id, text, kind }].slice(-4) } });
    setTimeout(() => {
      set({ ui: { ...get().ui, toasts: get().ui.toasts.filter((t) => t.id !== id) } });
    }, kind === 'error' ? 6000 : 2600);
  },
}));

export const getProject = (): Project => useDaw.getState().project;
