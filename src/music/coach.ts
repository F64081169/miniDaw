// Genre coach engine: turns a genre definition into follow-along steps and applies them to the project.

import type { Draft } from 'immer';
import { defaultFxParams } from '../audio/fx/registry';
import { DRUM_NOTE } from '../audio/dsp/drums';
import { beatsPerBar } from '../core/time';
import type { CoachState, InsertEffect, MidiRegion, Project, SectionType, Track } from '../core/types';
import { hashString, uid } from '../core/util';
import { sectionColor } from './sections';
import { createInstrumentTrack, createMidiRegion } from '../state/project';
import { useDaw } from '../state/store';
import { generateBass, type BassStyle } from './generate/bass';
import { SECTION_ENERGY, SECTION_LABEL, type GenNote, type SectionCtx } from './generate/common';
import { generateComp, type CompStyle } from './generate/comp';
import { HUMAN_FEEL, generateDrums, kickPositions } from './generate/drums';
import { generateMelody, type MelodyStyle } from './generate/melody';
import { getGenre } from './genres';
import type { GenreDef, RoleDef, StepId } from './genres/types';
import { chordSymbol, keyName, keyPrefersFlats, parseProgression, tileProgression } from './theory';

export interface CoachSection {
  type: SectionType;
  start: number; // beats
  bars: number;
  label: string;
}

export function defaultCoachState(g: GenreDef): CoachState {
  return { genreId: g.id, keyRoot: g.keys[0].root, keyMode: g.keys[0].mode, progressionIndex: 0, structureIndex: 0, completed: [] };
}

/** Sections of the song: from the project's section markers if present, else from the chosen structure. */
export function songSections(p: Project, g: GenreDef, s: CoachState): CoachSection[] {
  const bar = beatsPerBar(p.timeSig);
  const marked = p.markers.filter((m) => m.section).sort((a, b) => a.start - b.start);
  if (marked.length >= 2) {
    return marked.map((m) => ({ type: m.section!, start: m.start, bars: Math.max(1, Math.round(m.length / bar)), label: m.name }));
  }
  const structure = g.structures[s.structureIndex] ?? g.structures[0];
  let at = 0;
  return structure.sections.map((sec) => {
    const out = { type: sec.type, start: at, bars: sec.bars, label: SECTION_LABEL[sec.type] };
    at += sec.bars * bar;
    return out;
  });
}

function sectionContexts(p: Project, g: GenreDef, s: CoachState, sections: CoachSection[]): SectionCtx[] {
  const bar = beatsPerBar(p.timeSig);
  const prog = g.progressions[s.progressionIndex] ?? g.progressions[0];
  const chorusCount = sections.filter((x) => x.type === 'chorus' || x.type === 'drop').length;
  let chorusSeen = 0;
  return sections.map((sec, i) => {
    const chorusLike = sec.type === 'chorus' || sec.type === 'drop';
    if (chorusLike) chorusSeen++;
    const text = chorusLike && prog.chorus ? prog.chorus : prog.prog;
    const chords = tileProgression(parseProgression(text, s.keyRoot, s.keyMode, bar), sec.bars * bar);
    // the last chorus gets a little extra energy
    const lift = chorusLike && chorusSeen === chorusCount && chorusCount > 1 ? 0.05 : 0;
    return {
      section: sec.type,
      bars: sec.bars,
      barBeats: bar,
      timeSig: p.timeSig,
      chords,
      key: { root: s.keyRoot, mode: s.keyMode },
      energy: Math.min(1, SECTION_ENERGY[sec.type] + lift),
      isFirst: i === 0,
      isLast: i === sections.length - 1,
      next: sections[i + 1]?.type ?? null,
      swing: g.swing,
      swingUnit: g.swingUnit,
      humanize: g.humanize,
      seed: hashString(`${g.id}:${sec.type}`),
      bpm: p.bpm,
    };
  });
}

const HUMAN_DRUMS_NOTE =
  '這組鼓是職業鼓手的真實演奏（Groove MIDI Dataset），保留了鼓手的重音與微小的前後推拉：安靜的段落改用邊擊或拿掉小鼓，副歌換成同一位鼓手較滿的版本，過門也取自同一段演奏。';
const MELODY_NOTE =
  '示範旋律照作曲原則寫：4 小節一句、由 2 小節的動機發展；強拍放和弦音、其他音一步一步走；副歌比主歌高、Hook 重複；樂句之間留換氣的空間。照著它的節奏填詞或哼唱，再換成你自己的版本。';

function drumRoleOf(g: GenreDef): RoleDef | undefined {
  return g.roles.find((r) => r.kind === 'drums');
}

export function notesForRole(g: GenreDef, role: RoleDef, ctx: SectionCtx): GenNote[] {
  switch (role.kind) {
    case 'drums':
      return generateDrums(role.style, ctx);
    case 'bass': {
      const drum = drumRoleOf(g);
      const kicks = drum ? kickPositions(drum.style, ctx, 60) : [];
      return generateBass(role.style as BassStyle, ctx, kicks);
    }
    case 'comp': {
      const drum = drumRoleOf(g);
      const kicks = drum && role.style === 'metalChug' ? kickPositions(drum.style, ctx) : [];
      return generateComp(role.style as CompStyle, ctx, { guitar: role.guitar, voicing: role.voicing, range: role.range, kicks });
    }
    case 'melody':
      return generateMelody(role.style as MelodyStyle, ctx, role.range);
  }
}

export function regionsForRole(p: Project, g: GenreDef, s: CoachState, role: RoleDef): MidiRegion[] {
  const sections = songSections(p, g, s);
  const ctxs = sectionContexts(p, g, s, sections);
  const out: MidiRegion[] = [];
  sections.forEach((sec, i) => {
    if (role.sections && !role.sections.includes(sec.type)) return;
    const notes = notesForRole(g, role, ctxs[i]);
    if (!notes.length) return;
    out.push(createMidiRegion(sec.start, sec.bars * ctxs[i].barBeats, notes, sec.label));
  });
  return out;
}

// ------------------------------------------------------------------ draft mutations

function applySetupDraft(d: Draft<Project>, g: GenreDef, s: CoachState): void {
  if (d.bpm < g.bpm.min || d.bpm > g.bpm.max) d.bpm = g.bpm.default;
  d.timeSig = [...g.timeSig];
  d.key = { root: s.keyRoot, mode: s.keyMode };
}

function applyStructureDraft(d: Draft<Project>, g: GenreDef, s: CoachState): void {
  const bar = beatsPerBar(d.timeSig as [number, number]);
  const structure = g.structures[s.structureIndex] ?? g.structures[0];
  let at = 0;
  const counts: Partial<Record<SectionType, number>> = {};
  const totals: Partial<Record<SectionType, number>> = {};
  for (const sec of structure.sections) totals[sec.type] = (totals[sec.type] ?? 0) + 1;
  d.markers = structure.sections.map((sec) => {
    counts[sec.type] = (counts[sec.type] ?? 0) + 1;
    const n = (totals[sec.type] ?? 0) > 1 ? ` ${counts[sec.type]}` : '';
    const m = { id: uid('m'), name: `${SECTION_LABEL[sec.type]}${n}`, start: at, length: sec.bars * bar, color: sectionColor(sec.type), section: sec.type };
    at += sec.bars * bar;
    return m;
  });
}

/** Tracks created by the coach are tagged "<genre>:<role>" so each genre only reuses its own tracks. */
export function roleTag(g: GenreDef, role: RoleDef): string {
  return `${g.id}:${role.id}`;
}

function applyRoleDraft(d: Draft<Project>, g: GenreDef, s: CoachState, role: RoleDef): void {
  const p = d as unknown as Project;
  const regions = regionsForRole(p, g, s, role);
  const tag = roleTag(g, role);
  let t = d.tracks.find((x) => x.role === tag);
  if (!t) {
    const nt = createInstrumentTrack(role.patch, role.name, tag);
    nt.mixer.volumeDb = role.mix.volumeDb;
    nt.mixer.pan = role.mix.pan;
    nt.mixer.sends = { reverb: role.mix.reverb, delay: role.mix.delay };
    // order tracks the way the genre lists its roles
    const order = g.roles.map((r) => roleTag(g, r));
    const myIdx = order.indexOf(tag);
    let insertAt = d.tracks.length;
    for (let i = 0; i < d.tracks.length; i++) {
      const ri = order.indexOf(d.tracks[i].role ?? '');
      if (ri > myIdx) {
        insertAt = i;
        break;
      }
    }
    d.tracks.splice(insertAt, 0, nt as Draft<Track>);
    t = d.tracks[insertAt];
  }
  t.regions = regions as Draft<MidiRegion>[];
}

function ensureInsert(t: Draft<Track>, type: InsertEffect['type']): Draft<InsertEffect> {
  let ins = t.mixer.inserts.find((i) => i.type === type);
  if (!ins) {
    ins = { id: uid('fx'), type, enabled: true, params: defaultFxParams(type) };
    t.mixer.inserts.push(ins);
    ins = t.mixer.inserts[t.mixer.inserts.length - 1];
  }
  return ins;
}

function applyMixDraft(d: Draft<Project>, g: GenreDef): void {
  for (const role of g.roles) {
    const t = d.tracks.find((x) => x.role === roleTag(g, role));
    if (!t) continue;
    const m = role.mix;
    t.mixer.volumeDb = m.volumeDb;
    t.mixer.pan = m.pan;
    t.mixer.sends = { reverb: m.reverb, delay: m.delay };
    const eq = ensureInsert(t, 'eq');
    eq.enabled = true;
    eq.params = { ...defaultFxParams('eq'), ...(m.lowCut ? { lowCut: m.lowCut } : {}), ...(m.eq ?? {}) };
    const comp = ensureInsert(t, 'comp');
    comp.enabled = !!m.comp;
    if (m.comp) comp.params = { ...defaultFxParams('comp'), ...m.comp };
    for (const extra of m.inserts ?? []) {
      const ins = ensureInsert(t, extra.type);
      ins.enabled = true;
      ins.params = { ...defaultFxParams(extra.type), ...(extra.params ?? {}) };
    }
  }
  d.buses.reverb.params.decay = g.bus.reverbDecay;
  d.buses.reverb.params.predelay = g.bus.reverbPredelay;
  d.buses.reverb.params.damping = g.bus.damping;
  d.buses.delay.params.time = g.bus.delayTime;
  d.buses.delay.params.feedback = g.bus.delayFeedback;
  d.master.limiter = true;
}

function markDone(d: Draft<Project>, id: StepId): void {
  if (d.coach && !d.coach.completed.includes(id)) d.coach.completed.push(id);
}

// ------------------------------------------------------------------ public actions

function current(): { g: GenreDef; s: CoachState } | null {
  const p = useDaw.getState().project;
  const g = getGenre(p.coach?.genreId);
  if (!g || !p.coach) return null;
  return { g, s: p.coach };
}

export function selectGenre(id: string): void {
  const g = getGenre(id);
  if (!g) return;
  useDaw.getState().update('選擇曲風', (d) => {
    d.coach = defaultCoachState(g);
  }, { undoable: false });
}

export function clearGenre(): void {
  useDaw.getState().update('離開曲風', (d) => {
    d.coach = undefined;
  }, { undoable: false });
}

export function setCoachOption(patch: Partial<CoachState>): void {
  useDaw.getState().update('曲風設定', (d) => {
    if (d.coach) Object.assign(d.coach, patch);
  }, { undoable: false });
}

export function toggleStepDone(id: StepId): void {
  useDaw.getState().update('步驟完成', (d) => {
    if (!d.coach) return;
    const i = d.coach.completed.indexOf(id);
    if (i >= 0) d.coach.completed.splice(i, 1);
    else d.coach.completed.push(id);
  }, { undoable: false });
}

export function applyStep(step: StepId): void {
  const cur = current();
  if (!cur) return;
  const { g, s } = cur;
  const st = useDaw.getState();
  const label: Record<string, string> = {
    setup: '套用速度與調性',
    structure: '建立段落標記',
    drums: '生成鼓組',
    bass: '生成貝斯',
    harmony: '生成和弦',
    layers: '生成配器層',
    melody: '生成旋律',
    mix: '套用混音',
  };
  st.update(`${g.name}：${label[step] ?? step}`, (d) => {
    if (step === 'setup') applySetupDraft(d, g, s);
    else if (step === 'structure') applyStructureDraft(d, g, s);
    else if (step === 'mix') applyMixDraft(d, g);
    else {
      if (d.markers.filter((m) => m.section).length < 2) applyStructureDraft(d, g, s);
      for (const role of g.roles.filter((r) => r.step === step)) applyRoleDraft(d, g, s, role);
    }
    markDone(d, step);
  });
  st.setUi({ selectedRegionIds: [] });
}

/** One click: tempo, structure, every role and the mix. */
export function applyAll(): void {
  const cur = current();
  if (!cur) return;
  const { g, s } = cur;
  useDaw.getState().update(`${g.name}：一鍵生成編曲`, (d) => {
    // replace tracks the coach generated for other genres; the user's own tracks stay
    d.tracks = d.tracks.filter((t) => !t.role || t.role.startsWith(`${g.id}:`));
    applySetupDraft(d, g, s);
    applyStructureDraft(d, g, s);
    for (const role of g.roles) applyRoleDraft(d, g, s, role);
    applyMixDraft(d, g);
    for (const id of ['setup', 'structure', 'drums', 'bass', 'harmony', 'layers', 'melody', 'mix'] as StepId[]) markDone(d, id);
  });
  const p = useDaw.getState().project;
  useDaw.getState().setUi({ selectedTrackId: p.tracks.find((t) => t.role)?.id ?? null, selectedRegionIds: [] });
}

// ------------------------------------------------------------------ steps for the UI

export interface CoachStep {
  id: StepId;
  title: string;
  body: string;
  roles: RoleDef[];
  actionLabel?: string;
  auto: boolean; // can be applied with a button
  done: (p: Project) => boolean;
}

function roleTracksFilled(p: Project, g: GenreDef, roles: RoleDef[]): boolean {
  if (!roles.length) return false;
  return roles.every((r) => p.tracks.some((t) => t.role === roleTag(g, r) && t.regions.some((x) => x.kind === 'midi' && x.notes.length > 0)));
}

export function buildSteps(g: GenreDef, s: CoachState): CoachStep[] {
  const by = (step: RoleDef['step']) => g.roles.filter((r) => r.step === step);
  const key = keyName(s.keyRoot, s.keyMode);
  const prog = g.progressions[s.progressionIndex] ?? g.progressions[0];
  const manual = (id: StepId) => (p: Project) => !!p.coach?.completed.includes(id);
  const steps: CoachStep[] = [
    {
      id: 'setup',
      title: '設定速度、拍號與調性',
      body: `${g.name}常見速度是 ${g.bpm.min}–${g.bpm.max} BPM（建議 ${g.bpm.default}），拍號 ${g.timeSig[0]}/${g.timeSig[1]}，目前選擇的調性是「${key}」。速度決定歌曲的能量，調性決定適合的人聲音域──唱歌的話，挑一個你唱副歌最高音不吃力的調。`,
      roles: [],
      actionLabel: '套用速度與調性',
      auto: true,
      done: (p) => p.bpm >= g.bpm.min && p.bpm <= g.bpm.max && p.key.root === s.keyRoot && p.key.mode === s.keyMode,
    },
    {
      id: 'structure',
      title: '規劃曲式段落',
      body: `先把歌的地圖畫出來：${(g.structures[s.structureIndex] ?? g.structures[0]).sections
        .map((x) => `${SECTION_LABEL[x.type]} ${x.bars}`)
        .join(' → ')}（數字為小節數）。段落標記會出現在時間尺上方，之後每個樂器都會依照段落改變彈法與能量。`,
      roles: [],
      actionLabel: '建立段落標記',
      auto: true,
      done: (p) => p.markers.filter((m) => m.section).length >= 2,
    },
    {
      id: 'drums',
      title: '鼓組節奏',
      body: HUMAN_FEEL[drumRoleOf(g)?.style ?? ''] ? `${g.steps.drums}\n\n${HUMAN_DRUMS_NOTE}` : g.steps.drums,
      roles: by('drums'),
      actionLabel: '生成鼓組',
      auto: true,
      done: (p) => roleTracksFilled(p, g, by('drums')),
    },
    { id: 'bass', title: '貝斯線', body: g.steps.bass, roles: by('bass'), actionLabel: '生成貝斯', auto: true, done: (p) => roleTracksFilled(p, g, by('bass')) },
    {
      id: 'harmony',
      title: '和弦與和聲',
      body: `${g.steps.harmony}\n\n目前的進行：${prog.name}──${progressionSymbols(prog.prog, s)}。${prog.note}`,
      roles: by('harmony'),
      actionLabel: '生成和弦',
      auto: true,
      done: (p) => roleTracksFilled(p, g, by('harmony')),
    },
  ];
  if (by('layers').length) steps.push({ id: 'layers', title: '加入配器層次', body: g.steps.layers, roles: by('layers'), actionLabel: '生成配器層', auto: true, done: (p) => roleTracksFilled(p, g, by('layers')) });
  steps.push(
    {
      id: 'melody',
      title: '旋律與主唱',
      body: by('melody').length ? `${g.steps.melody}\n\n${MELODY_NOTE}` : g.steps.melody,
      roles: by('melody'),
      actionLabel: by('melody').length ? '生成旋律靈感' : undefined,
      auto: by('melody').length > 0,
      done: (p) => roleTracksFilled(p, g, by('melody')) || p.tracks.some((t) => t.kind === 'audio' && t.regions.length > 0),
    },
    { id: 'arrange', title: '編曲動態檢查', body: g.steps.arrange, roles: [], auto: false, done: manual('arrange') },
    { id: 'mix', title: '混音', body: g.steps.mix, roles: [], actionLabel: '套用混音建議', auto: true, done: manual('mix') },
    {
      id: 'record',
      title: '錄下你的聲音',
      body: '新增一條「音訊軌」，按下音軌上的錄音待命鍵（R），再按走帶列的錄音鈕（或鍵盤 R）。開啟節拍器與預備拍（Count-in），戴耳機錄音可以避免伴奏被收進去。錄完後可以在音軌上拖曳、分割、調整音量。',
      roles: [],
      auto: false,
      done: (p) => p.tracks.some((t) => t.kind === 'audio' && t.regions.length > 0),
    },
    { id: 'export', title: '輸出作品', body: '完成後從「檔案 → 匯出」輸出 WAV 混音檔，或匯出 MIDI 檔帶進 Logic Pro／GarageBand 繼續製作；也可以匯出分軌（Stems）。', roles: [], auto: false, done: manual('export') },
  );
  return steps;
}

export function progressionSymbols(text: string, s: CoachState): string {
  const flats = keyPrefersFlats(s.keyRoot, s.keyMode);
  const evs = parseProgression(text, s.keyRoot, s.keyMode, 4);
  return evs.map((e) => chordSymbol(e.chord, flats)).join(' – ');
}

/** Notes for auditioning a progression on a keyboard patch (4 bars). */
export function progressionPreview(text: string, s: CoachState): { pitch: number; start: number; dur: number; vel: number }[] {
  const evs = parseProgression(text, s.keyRoot, s.keyMode, 4);
  const out: { pitch: number; start: number; dur: number; vel: number }[] = [];
  const fakeCtx: SectionCtx = {
    section: 'verse',
    bars: Math.ceil((evs[evs.length - 1].start + evs[evs.length - 1].length) / 4),
    barBeats: 4,
    timeSig: [4, 4],
    chords: evs,
    key: { root: s.keyRoot, mode: s.keyMode },
    energy: 0.5,
    isFirst: true,
    isLast: true,
    next: null,
    swing: 0,
    swingUnit: 0.25,
    humanize: 0,
    seed: 1,
    bpm: 100,
  };
  for (const n of generateComp('popPiano', fakeCtx)) {
    out.push({ pitch: n.pitch, start: n.start, dur: n.duration, vel: n.velocity });
  }
  return out;
}

/** A tiny demo phrase per instrument category for the library's audition button. */
export function auditionPhrase(category: string): { pitch: number; start: number; dur: number; vel: number }[] {
  const chord = (root: number, third: number, fifth: number, at: number, dur: number) =>
    [root, root + third, root + fifth, root + 12].map((p) => ({ pitch: p, start: at, dur, vel: 92 }));
  switch (category) {
    case 'drums': {
      const out: { pitch: number; start: number; dur: number; vel: number }[] = [];
      for (let b = 0; b < 8; b += 0.5) out.push({ pitch: DRUM_NOTE.hatC, start: b, dur: 0.25, vel: b % 1 === 0 ? 96 : 72 });
      [0, 2.5, 4, 6.5].forEach((b) => out.push({ pitch: DRUM_NOTE.kick, start: b, dur: 0.25, vel: 110 }));
      [1, 3, 5, 7].forEach((b) => out.push({ pitch: DRUM_NOTE.snare, start: b, dur: 0.25, vel: 104 }));
      out.push({ pitch: DRUM_NOTE.crash, start: 0, dur: 1, vel: 100 }, { pitch: DRUM_NOTE.tomH, start: 7.5, dur: 0.25, vel: 90 }, { pitch: DRUM_NOTE.tomL, start: 7.75, dur: 0.25, vel: 96 });
      return out;
    }
    case 'bass':
      return [40, 40, 47, 45, 43, 43, 45, 47].map((p, i) => ({ pitch: p, start: i, dur: 0.85, vel: 100 }));
    case 'synth':
    case 'strings':
    case 'brass':
    case 'organ':
      return [...chord(57, 3, 7, 0, 1.9), ...chord(53, 4, 7, 2, 1.9), ...chord(48, 4, 7, 4, 1.9), ...chord(55, 4, 7, 6, 1.9)];
    case 'eguitar':
    case 'aguitar':
      return [40, 47, 52, 55, 59, 64].map((p, i) => ({ pitch: p, start: i * 0.04, dur: 1.8, vel: 96 })).concat(
        [45, 52, 57, 60, 64].map((p, i) => ({ pitch: p, start: 2 + i * 0.04, dur: 1.8, vel: 90 })),
        [43, 47, 50, 55, 59, 67].map((p, i) => ({ pitch: p, start: 4 + i * 0.04, dur: 3.5, vel: 96 })),
      );
    case 'mallet':
      return [72, 76, 79, 84, 79, 76, 74, 72].map((p, i) => ({ pitch: p, start: i * 0.5, dur: 0.6, vel: 90 }));
    default:
      return [...chord(60, 4, 7, 0, 1.9), ...chord(57, 3, 7, 2, 1.9), ...chord(53, 4, 7, 4, 1.9), ...chord(55, 4, 7, 6, 1.9), { pitch: 48, start: 0, dur: 1.9, vel: 80 }, { pitch: 45, start: 2, dur: 1.9, vel: 80 }, { pitch: 41, start: 4, dur: 1.9, vel: 80 }, { pitch: 43, start: 6, dur: 1.9, vel: 80 }];
  }
}
