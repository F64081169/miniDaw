// High-level editing operations used by the UI, keyboard shortcuts and the genre coach.

import { audioPool } from '../audio/audioPool';
import { engine } from '../audio/engine';
import { defaultFxParams } from '../audio/fx/registry';
import { defaultParams, getPatch } from '../audio/instruments/patches';
import { beatsPerBar, tidy } from '../core/time';
import type { InsertType, Marker, MidiRegion, Note, Project, Region, ScaleMode, SectionType, Track } from '../core/types';
import { clamp, uid } from '../core/util';
import { importMidi, patchForProgram } from '../music/midifile';
import { sectionColor } from '../music/sections';
import { saveAudio } from './persistence';
import { cloneRegion, findRegion, regionEnd, splitAudioRegion, splitMidiRegion } from './ops';
import { createAudioRegion, createAudioTrack, createInstrumentTrack, createMidiRegion } from './project';
import { useDaw, type UpdateOpts } from './store';
import type { Draft } from 'immer';

const st = () => useDaw.getState();
const upd = (label: string, fn: (d: Draft<Project>) => void, opts?: UpdateOpts) => st().update(label, fn, opts);
const trackOf = (d: Draft<Project>, id: string) => d.tracks.find((t) => t.id === id);

function insertIndex(p: Project): number {
  const sel = st().ui.selectedTrackId;
  const i = p.tracks.findIndex((t) => t.id === sel);
  return i >= 0 ? i + 1 : p.tracks.length;
}

// ------------------------------------------------------------------ tracks

export function addTrack(track: Track, select = true, index?: number): string {
  upd('新增音軌', (d) => {
    d.tracks.splice(index ?? insertIndex(st().project), 0, track as Draft<Track>);
  });
  if (select) st().setUi({ selectedTrackId: track.id, selectedRegionIds: [] });
  return track.id;
}

export function addInstrumentTrack(patchId: string, name?: string): string {
  const id = addTrack(createInstrumentTrack(patchId, name));
  setTimeout(() => engine.prefetchTrackRange(id), 50);
  return id;
}

export function addAudioTrack(name?: string): string {
  const n = st().project.tracks.filter((t) => t.kind === 'audio').length + 1;
  return addTrack(createAudioTrack(name ?? `音訊 ${n}`));
}

export function deleteTrack(id: string): void {
  const p = st().project;
  const idx = p.tracks.findIndex((t) => t.id === id);
  if (idx < 0) return;
  upd('刪除音軌', (d) => {
    d.tracks.splice(idx, 1);
  });
  const next = st().project.tracks[Math.min(idx, st().project.tracks.length - 1)];
  st().setUi({ selectedTrackId: next?.id ?? null, selectedRegionIds: [], editorRegionId: null });
}

export function duplicateTrack(id: string): void {
  const t = st().project.tracks.find((x) => x.id === id);
  if (!t) return;
  const copy: Track = {
    ...t,
    id: uid('t'),
    name: `${t.name} 副本`,
    armed: false,
    role: undefined,
    regions: t.regions.map((r) => cloneRegion(r, r.start)),
    mixer: { ...t.mixer, solo: false, inserts: t.mixer.inserts.map((i) => ({ ...i, id: uid('fx') })) },
  };
  const idx = st().project.tracks.findIndex((x) => x.id === id);
  addTrack(copy, true, idx + 1);
}

export function renameTrack(id: string, name: string): void {
  upd('重新命名音軌', (d) => {
    const t = trackOf(d, id);
    if (t) t.name = name.trim() || t.name;
  });
}

export function setTrackColor(id: string, color: string): void {
  upd('音軌顏色', (d) => {
    const t = trackOf(d, id);
    if (t) t.color = color;
  });
}

export function moveTrack(id: string, toIndex: number): void {
  upd('移動音軌', (d) => {
    const from = d.tracks.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [t] = d.tracks.splice(from, 1);
    d.tracks.splice(clamp(toIndex, 0, d.tracks.length), 0, t);
  });
}

export function setTrackHeight(id: string, h: number): void {
  upd('音軌高度', (d) => {
    const t = trackOf(d, id);
    if (t) t.height = clamp(Math.round(h), 44, 220);
  }, { undoable: false });
}

export function setTrackPatch(id: string, patchId: string): void {
  const patch = getPatch(patchId);
  upd(`更換音色：${patch.name}`, (d) => {
    const t = trackOf(d, id);
    if (!t || t.kind !== 'instrument') return;
    const old = t.instrument ? getPatch(t.instrument.patchId) : null;
    if (!old || t.name === old.name) t.name = patch.name;
    t.instrument = { patchId, params: defaultParams(patch) };
    t.color = patch.trackColor;
  });
  setTimeout(() => engine.prefetchTrackRange(id), 50);
}

export function setInstrumentParam(id: string, ctl: string, value: number): void {
  upd('音色控制', (d) => {
    const t = trackOf(d, id);
    if (t?.instrument) t.instrument.params[ctl] = clamp(value, 0, 1);
  }, { coalesce: `inst:${id}:${ctl}` });
}

export function setVolume(id: string, db: number): void {
  upd('音量', (d) => {
    const t = trackOf(d, id);
    if (t) t.mixer.volumeDb = clamp(Math.round(db * 10) / 10, -96, 6);
  }, { coalesce: `vol:${id}` });
}

export function setPan(id: string, pan: number): void {
  upd('聲像', (d) => {
    const t = trackOf(d, id);
    if (t) t.mixer.pan = clamp(Math.round(pan * 100) / 100, -1, 1);
  }, { coalesce: `pan:${id}` });
}

export function setSend(id: string, bus: 'reverb' | 'delay', v: number): void {
  upd(bus === 'reverb' ? '殘響傳送' : '延遲傳送', (d) => {
    const t = trackOf(d, id);
    if (t) t.mixer.sends[bus] = clamp(v, 0, 1);
  }, { coalesce: `send:${bus}:${id}` });
}

export function toggleMute(id: string): void {
  upd('靜音', (d) => {
    const t = trackOf(d, id);
    if (t) t.mixer.mute = !t.mixer.mute;
  });
}

export function toggleSolo(id: string, exclusive = false): void {
  upd('獨奏', (d) => {
    const t = trackOf(d, id);
    if (!t) return;
    const on = !t.mixer.solo;
    if (exclusive) d.tracks.forEach((x) => (x.mixer.solo = false));
    t.mixer.solo = on;
  });
}

export function toggleArm(id: string): void {
  upd('錄音待命', (d) => {
    const t = trackOf(d, id);
    if (!t) return;
    const on = !t.armed;
    // only one audio input at a time
    if (on && t.kind === 'audio') d.tracks.forEach((x) => x.kind === 'audio' && (x.armed = false));
    t.armed = on;
  }, { undoable: false });
}

export function toggleMonitor(id: string): void {
  upd('輸入監聽', (d) => {
    const t = trackOf(d, id);
    if (!t) return;
    const on = !t.monitor;
    d.tracks.forEach((x) => (x.monitor = false));
    t.monitor = on;
  }, { undoable: false });
}

// ------------------------------------------------------------------ inserts / buses / master

export function addInsert(trackId: string, type: InsertType): string {
  const id = uid('fx');
  upd('新增效果器', (d) => {
    trackOf(d, trackId)?.mixer.inserts.push({ id, type, enabled: true, params: defaultFxParams(type) });
  });
  return id;
}

export function removeInsert(trackId: string, insertId: string): void {
  upd('移除效果器', (d) => {
    const t = trackOf(d, trackId);
    if (t) t.mixer.inserts = t.mixer.inserts.filter((i) => i.id !== insertId);
  });
}

export function toggleInsert(trackId: string, insertId: string): void {
  upd('效果器開關', (d) => {
    const ins = trackOf(d, trackId)?.mixer.inserts.find((i) => i.id === insertId);
    if (ins) ins.enabled = !ins.enabled;
  });
}

export function setInsertParam(trackId: string, insertId: string, param: string, value: number): void {
  upd('效果器參數', (d) => {
    const ins = trackOf(d, trackId)?.mixer.inserts.find((i) => i.id === insertId);
    if (ins) ins.params[param] = value;
  }, { coalesce: `fx:${insertId}:${param}` });
}

export function setInsertParams(trackId: string, insertId: string, params: Record<string, number>, label = '效果器預設'): void {
  upd(label, (d) => {
    const ins = trackOf(d, trackId)?.mixer.inserts.find((i) => i.id === insertId);
    if (ins) Object.assign(ins.params, params);
  });
}

export function setMasterVolume(db: number): void {
  upd('主音量', (d) => {
    d.master.volumeDb = clamp(Math.round(db * 10) / 10, -96, 6);
  }, { coalesce: 'master' });
}

export function toggleLimiter(): void {
  upd('母帶限幅器', (d) => {
    d.master.limiter = !d.master.limiter;
  });
}

export function setBusParam(bus: 'reverb' | 'delay', param: string, v: number): void {
  upd(bus === 'reverb' ? '殘響設定' : '延遲設定', (d) => {
    d.buses[bus].params[param] = v;
  }, { coalesce: `bus:${bus}:${param}` });
}

export function setBusReturn(bus: 'reverb' | 'delay', db: number): void {
  upd('效果返回', (d) => {
    d.buses[bus].returnDb = clamp(db, -96, 6);
  }, { coalesce: `busret:${bus}` });
}

// ------------------------------------------------------------------ project settings

export function setBpm(bpm: number): void {
  upd('速度', (d) => {
    d.bpm = clamp(Math.round(bpm * 10) / 10, 30, 300);
  }, { coalesce: 'bpm' });
}

export function setTimeSig(n: number, den: number): void {
  upd('拍號', (d) => {
    d.timeSig = [clamp(Math.round(n), 1, 16), [2, 4, 8, 16].includes(den) ? den : 4];
  });
}

export function setKey(root: number, mode: ScaleMode): void {
  upd('調性', (d) => {
    d.key = { root: ((root % 12) + 12) % 12, mode };
  });
}

export function setProjectName(name: string): void {
  upd('專案名稱', (d) => {
    d.name = name.trim() || d.name;
  });
}

export function toggleLoop(): void {
  upd('循環', (d) => {
    d.loop.enabled = !d.loop.enabled;
    if (d.loop.end - d.loop.start < 0.25) {
      const bar = beatsPerBar(d.timeSig);
      d.loop.start = 0;
      d.loop.end = bar * 4;
    }
  }, { undoable: false });
}

export function setLoop(start: number, end: number, enable = true): void {
  upd('循環範圍', (d) => {
    d.loop.start = Math.max(0, Math.min(start, end));
    d.loop.end = Math.max(start, end);
    if (enable) d.loop.enabled = true;
  }, { undoable: false });
}

export function toggleMetronome(): void {
  upd('節拍器', (d) => {
    d.metronome.enabled = !d.metronome.enabled;
  }, { undoable: false });
}

export function setMetronome(patch: Partial<Project['metronome']>): void {
  upd('節拍器設定', (d) => {
    Object.assign(d.metronome, patch);
  }, { undoable: false });
}

// ------------------------------------------------------------------ regions

export function createEmptyRegion(trackId: string, start: number, length?: number): string | null {
  const p = st().project;
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t || t.kind !== 'instrument') return null;
  const r = createMidiRegion(tidy(start), length ?? beatsPerBar(p.timeSig), [], t.name);
  upd('新增 MIDI 片段', (d) => {
    trackOf(d, trackId)?.regions.push(r as Draft<MidiRegion>);
  });
  st().setUi({ selectedRegionIds: [r.id], editorRegionId: r.id, selectedTrackId: trackId });
  return r.id;
}

export function addRegion(trackId: string, region: Region, label = '新增片段'): void {
  upd(label, (d) => {
    trackOf(d, trackId)?.regions.push(region as Draft<Region>);
  });
}

export function deleteRegions(ids: string[]): void {
  if (!ids.length) return;
  const set = new Set(ids);
  upd('刪除片段', (d) => {
    for (const t of d.tracks) t.regions = t.regions.filter((r) => !set.has(r.id));
  });
  const ui = st().ui;
  st().setUi({ selectedRegionIds: [], editorRegionId: ui.editorRegionId && set.has(ui.editorRegionId) ? null : ui.editorRegionId });
}

export function duplicateRegions(ids: string[], times = 1): void {
  if (!ids.length) return;
  const p = st().project;
  const created: string[] = [];
  upd(times > 1 ? `重複片段 ×${times}` : '複製片段', (d) => {
    for (const id of ids) {
      const hit = findRegion(p, id);
      if (!hit) continue;
      const len = regionEnd(hit.region, p.bpm) - hit.region.start;
      const t = trackOf(d, hit.track.id);
      for (let k = 1; k <= times; k++) {
        const c = cloneRegion(hit.region, tidy(hit.region.start + len * k));
        t?.regions.push(c as Draft<Region>);
        created.push(c.id);
      }
    }
  });
  st().setUi({ selectedRegionIds: created.slice(-ids.length) });
}

export function splitRegionsAt(beat: number, ids?: string[]): void {
  const p = st().project;
  const targets = ids && ids.length ? ids : p.tracks.flatMap((t) => t.regions.filter((r) => r.start < beat && regionEnd(r, p.bpm) > beat).map((r) => r.id));
  if (!targets.length) return;
  upd('分割片段', (d) => {
    for (const id of targets) {
      for (const t of d.tracks) {
        const i = t.regions.findIndex((r) => r.id === id);
        if (i < 0) continue;
        const r = t.regions[i] as Region;
        const parts = r.kind === 'midi' ? splitMidiRegion(r, beat) : splitAudioRegion(r, beat, p.bpm);
        if (parts) t.regions.splice(i, 1, ...(parts as Draft<Region>[]));
      }
    }
  });
}

export function toggleRegionMute(ids: string[]): void {
  const set = new Set(ids);
  upd('片段靜音', (d) => {
    for (const t of d.tracks) for (const r of t.regions) if (set.has(r.id)) r.muted = !r.muted;
  });
}

export function renameRegion(id: string, name: string): void {
  upd('重新命名片段', (d) => {
    for (const t of d.tracks) for (const r of t.regions) if (r.id === id) r.name = name.trim() || r.name;
  });
}

/** Apply a mutation to one MIDI region (used by the piano roll). */
export function editMidiRegion(regionId: string, label: string, fn: (r: Draft<MidiRegion>) => void, opts?: UpdateOpts): void {
  upd(label, (d) => {
    for (const t of d.tracks) {
      const r = t.regions.find((x) => x.id === regionId);
      if (r && r.kind === 'midi') fn(r);
    }
  }, opts);
}

export function addNotes(regionId: string, notes: Omit<Note, 'id'>[], label = '新增音符'): string[] {
  const ids = notes.map(() => uid('n'));
  editMidiRegion(regionId, label, (r) => {
    notes.forEach((n, i) => r.notes.push({ ...n, id: ids[i] }));
    const end = Math.max(...notes.map((n) => n.start + n.duration));
    if (end > r.length) r.length = Math.ceil(end);
  });
  return ids;
}

export function deleteNotes(regionId: string, ids: string[]): void {
  const set = new Set(ids);
  editMidiRegion(regionId, '刪除音符', (r) => {
    r.notes = r.notes.filter((n) => !set.has(n.id));
  });
}

export function transposeNotes(regionId: string, ids: string[] | null, semis: number): void {
  const set = ids ? new Set(ids) : null;
  editMidiRegion(regionId, '移調', (r) => {
    for (const n of r.notes) if (!set || set.has(n.id)) n.pitch = clamp(n.pitch + semis, 0, 127);
  });
}

export function setNoteVelocity(regionId: string, ids: string[], velocity: number): void {
  const set = new Set(ids);
  editMidiRegion(regionId, '力度', (r) => {
    for (const n of r.notes) if (set.has(n.id)) n.velocity = clamp(Math.round(velocity), 1, 127);
  }, { coalesce: `vel:${regionId}` });
}

// ------------------------------------------------------------------ markers (arrangement)

export function addMarker(start: number, length: number, name: string, section?: SectionType): void {
  const m: Marker = { id: uid('m'), start: tidy(start), length, name, color: sectionColor(section), section };
  upd('新增段落標記', (d) => {
    d.markers.push(m);
    d.markers.sort((a, b) => a.start - b.start);
  });
}

export function deleteMarker(id: string): void {
  upd('刪除段落標記', (d) => {
    d.markers = d.markers.filter((m) => m.id !== id);
  });
}

export function renameMarker(id: string, name: string): void {
  upd('重新命名段落', (d) => {
    const m = d.markers.find((x) => x.id === id);
    if (m) m.name = name.trim() || m.name;
  });
}

// ------------------------------------------------------------------ import

export async function importAudioFile(file: File, trackId?: string, atBeat?: number): Promise<void> {
  const ctx = engine.ensure();
  const data = await file.arrayBuffer();
  const buf = await ctx.decodeAudioData(data);
  const id = audioPool.add(buf);
  void saveAudio(id, buf);
  const p = st().project;
  let tid = trackId && p.tracks.find((t) => t.id === trackId && t.kind === 'audio') ? trackId : undefined;
  if (!tid) tid = addAudioTrack(file.name.replace(/\.[^.]+$/, ''));
  const region = createAudioRegion(atBeat ?? st().transport.position, id, buf.duration, file.name.replace(/\.[^.]+$/, ''));
  addRegion(tid, region, '匯入音訊');
  st().setUi({ selectedRegionIds: [region.id], selectedTrackId: tid });
  st().toast(`已匯入「${file.name}」`, 'success');
}

export async function importMidiFile(file: File): Promise<void> {
  const midi = importMidi(new Uint8Array(await file.arrayBuffer()));
  if (!midi.tracks.length) throw new Error('MIDI 檔裡沒有音符');
  const p = st().project;
  const bar = beatsPerBar(midi.timeSig);
  const tracks: Track[] = midi.tracks.map((mt) => {
    const t = createInstrumentTrack(patchForProgram(mt.program, mt.isDrum), mt.name);
    const end = Math.max(...mt.notes.map((n) => n.start + n.duration));
    t.regions = [createMidiRegion(0, Math.max(bar, Math.ceil(end / bar) * bar), mt.notes, mt.name)];
    return t;
  });
  upd('匯入 MIDI', (d) => {
    if (p.tracks.every((t) => t.regions.length === 0)) {
      d.bpm = midi.bpm;
      d.timeSig = midi.timeSig;
    }
    d.tracks.push(...(tracks as Draft<Track>[]));
  });
  st().toast(`已匯入 ${tracks.length} 條 MIDI 音軌`, 'success');
}
