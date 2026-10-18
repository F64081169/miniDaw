// Commands shared by menus, toolbar buttons and keyboard shortcuts.

import { audioPool } from '../audio/audioPool';
import { engine } from '../audio/engine';
import { beatsPerBar, gridBeats, snapBeat } from '../core/time';
import type { MidiRegion } from '../core/types';
import { pickFiles } from '../core/files';
import { applyAll, selectGenre } from '../music/coach';
import {
  deleteNotes,
  deleteRegions,
  duplicateRegions,
  editMidiRegion,
  importAudioFile,
  importMidiFile,
  setMetronome,
  splitRegionsAt,
  toggleLoop,
  toggleMetronome,
} from '../state/actions';
import { findRegion, quantizeNotes } from '../state/ops';
import { loadProjectFile, saveProjectFile } from '../state/persistence';
import { createInstrumentTrack, createProject } from '../state/project';
import { useDaw, type BottomPanel, type LeftPanel } from '../state/store';
import { uid } from '../core/util';

const st = () => useDaw.getState();

/** Which area last received a click — decides what Delete / ⌘A / ⌘D act on. */
export let focusZone: 'tracks' | 'editor' = 'tracks';
export function setFocusZone(z: 'tracks' | 'editor'): void {
  focusZone = z;
}

export function toggleLeft(panel: Exclude<LeftPanel, null>): void {
  st().setUi((u) => ({ leftPanel: u.leftPanel === panel ? null : panel }));
}

export function toggleBottom(panel: Exclude<BottomPanel, null>): void {
  st().setUi((u) => ({ bottomPanel: u.bottomPanel === panel ? null : panel }));
}

export function openEditorFor(regionId: string | null): void {
  st().setUi({ editorRegionId: regionId, bottomPanel: 'editor', selectedNoteIds: [] });
}

export function moveBars(n: number): void {
  const p = st().project;
  const bar = beatsPerBar(p.timeSig);
  const cur = engine.currentBeat();
  const target = Math.max(0, Math.round(cur / bar + n) * bar);
  engine.seek(target);
}

export function toStart(): void {
  engine.seek(0);
}

export function toggleCountIn(): void {
  setMetronome({ countIn: !st().project.metronome.countIn });
}

export { toggleLoop, toggleMetronome };

export async function newProject(): Promise<void> {
  await engine.stop();
  const p = createProject('未命名專案');
  p.tracks = [createInstrumentTrack('piano.grand', '鋼琴')];
  st().loadProject(p);
  st().setUi({ dialog: null, coachOpen: true });
  st().toast('已建立新專案');
}

export async function loadDemo(genreId = 'pop'): Promise<void> {
  await engine.stop();
  const p = createProject('示範歌曲');
  st().loadProject(p);
  selectGenre(genreId);
  applyAll();
  // the demo should not count as undoable history the user has to wade through
  useDaw.setState({ past: [], future: [] });
  st().setUi({ dialog: null, coachOpen: true });
}

export async function openProject(): Promise<void> {
  const [f] = await pickFiles('.json,application/json');
  if (!f) return;
  try {
    await engine.stop();
    await loadProjectFile(f);
    st().toast(`已開啟「${f.name}」`, 'success');
  } catch (err) {
    st().toast(`無法開啟專案：${(err as Error).message}`, 'error');
  }
}

export async function saveProject(): Promise<void> {
  try {
    await saveProjectFile();
    st().toast('已儲存專案檔', 'success');
  } catch (err) {
    st().toast(`儲存失敗：${(err as Error).message}`, 'error');
  }
}

export async function importAudio(trackId?: string): Promise<void> {
  const files = await pickFiles('audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac', true);
  for (const f of files) {
    try {
      await importAudioFile(f, trackId);
    } catch (err) {
      st().toast(`無法匯入「${f.name}」：${(err as Error).message}`, 'error');
    }
  }
}

export async function importMidi(): Promise<void> {
  const [f] = await pickFiles('.mid,.midi,audio/midi');
  if (!f) return;
  try {
    await importMidiFile(f);
  } catch (err) {
    st().toast(`無法匯入 MIDI：${(err as Error).message}`, 'error');
  }
}

export function deleteSelection(): void {
  const s = st();
  if (focusZone === 'editor' && s.ui.editorRegionId && s.ui.selectedNoteIds.length) {
    deleteNotes(s.ui.editorRegionId, s.ui.selectedNoteIds);
    s.setUi({ selectedNoteIds: [] });
    return;
  }
  if (s.ui.selectedRegionIds.length) deleteRegions(s.ui.selectedRegionIds);
}

export function duplicateSelection(): void {
  const s = st();
  if (focusZone === 'editor' && s.ui.editorRegionId && s.ui.selectedNoteIds.length) {
    const hit = findRegion(s.project, s.ui.editorRegionId);
    if (!hit || hit.region.kind !== 'midi') return;
    const sel = hit.region.notes.filter((n) => s.ui.selectedNoteIds.includes(n.id));
    const start = Math.min(...sel.map((n) => n.start));
    const end = Math.max(...sel.map((n) => n.start + n.duration));
    const bar = beatsPerBar(s.project.timeSig);
    const span = Math.max(gridBeats(s.ui.snap, s.ui.editorPxPerBeat, s.project.timeSig), Math.ceil((end - start) / 1) * 1);
    const shift = end - start > bar / 2 ? Math.ceil((end - start) / bar) * bar : span;
    const ids: string[] = [];
    editMidiRegion(hit.region.id, '複製音符', (r) => {
      for (const n of sel) {
        const id = uid('n');
        ids.push(id);
        r.notes.push({ ...n, id, start: n.start + shift });
      }
      const last = Math.max(...r.notes.map((n) => n.start + n.duration));
      if (last > r.length) r.length = Math.ceil(last / bar) * bar;
    });
    s.setUi({ selectedNoteIds: ids });
    return;
  }
  if (s.ui.selectedRegionIds.length) duplicateRegions(s.ui.selectedRegionIds);
}

export function splitAtPlayhead(): void {
  const s = st();
  splitRegionsAt(engine.currentBeat(), s.ui.selectedRegionIds.length ? s.ui.selectedRegionIds : undefined);
}

export function quantizeSelection(): void {
  const s = st();
  const grid = gridBeats(s.ui.snap === 'smart' || s.ui.snap === 'off' ? '1/16' : s.ui.snap, 1, s.project.timeSig);
  const targets: { id: string; noteIds: string[] | null }[] = [];
  if (focusZone === 'editor' && s.ui.editorRegionId) targets.push({ id: s.ui.editorRegionId, noteIds: s.ui.selectedNoteIds.length ? s.ui.selectedNoteIds : null });
  else for (const id of s.ui.selectedRegionIds) targets.push({ id, noteIds: null });
  if (!targets.length) {
    s.toast('先選擇要量化的片段或音符');
    return;
  }
  for (const t of targets) {
    editMidiRegion(t.id, '量化', (r) => {
      const set = t.noteIds ? new Set(t.noteIds) : null;
      const chosen = r.notes.filter((n) => !set || set.has(n.id));
      const q = quantizeNotes(chosen as MidiRegion['notes'], grid);
      const byId = new Map(q.map((n) => [n.id, n]));
      for (const n of r.notes) {
        const qn = byId.get(n.id);
        if (qn) n.start = qn.start;
      }
    });
  }
  s.toast(`已量化到 ${s.ui.snap === 'smart' || s.ui.snap === 'off' ? '1/16' : s.ui.snap}`);
}

export function selectAll(): void {
  const s = st();
  if (focusZone === 'editor' && s.ui.editorRegionId) {
    const hit = findRegion(s.project, s.ui.editorRegionId);
    if (hit && hit.region.kind === 'midi') s.setUi({ selectedNoteIds: hit.region.notes.map((n) => n.id) });
    return;
  }
  s.setUi({ selectedRegionIds: s.project.tracks.flatMap((t) => t.regions.map((r) => r.id)) });
}

export function snapPlayhead(beat: number): number {
  const s = st();
  return Math.max(0, snapBeat(beat, gridBeats(s.ui.snap, s.ui.pxPerBeat, s.project.timeSig)));
}

export function clearAudioPool(): void {
  audioPool.clear();
}
