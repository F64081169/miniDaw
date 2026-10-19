// Genre coach engine: turns a genre definition into follow-along steps and applies them to the project.

import type { Draft } from 'immer';
import { defaultFxParams } from '../audio/fx/registry';
import { DRUM_NOTE } from '../audio/dsp/drums';
import { beatsPerBar } from '../core/time';
import type { CoachState, InsertEffect, MidiRegion, Project, SectionType, Track } from '../core/types';
import { hashString, uid } from '../core/util';
import { sectionColor } from './sections';
import { CATEGORY_INFO, defaultParams, getPatch } from '../audio/instruments/patches';
import { createInstrumentTrack, createMidiRegion } from '../state/project';
import { useDaw } from '../state/store';
import { breathOf, planSong, shapePart, walkSteps, type MoveUse, type Part, type SectionPlan } from './generate/arrange';
import { generateBass, type BassStyle } from './generate/bass';
import { SECTION_ENERGY, SECTION_LABEL, chordAtBeat, nextChordAfter, type GenNote, type SectionCtx } from './generate/common';
import { generateComp, type CompStyle } from './generate/comp';
import { DRUM_STYLES, HUMAN_FEEL, generateDrums, kickPositions } from './generate/drums';
import { generateMelody, type MelodyStyle } from './generate/melody';
import { MOVES, walkNotes } from './generate/moves';
import { getGenre } from './genres';
import type { GenreDef, RoleDef, StepId } from './genres/types';
import { chordPitchClasses, chordSymbol, keyName, keyPrefersFlats, noteName, parseProgression, pcName, tileProgression, type Chord, type ChordEvent } from './theory';

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

/** Chords a bridge turns to when its progression does not name any: the relative minor first. */
const BRIDGE_TURN = { major: 'vi | IV | I | V |', minor: 'bVI | bVII | i | V |' };

/** The section's chords with its last bar on the dominant (V): the pull a pre-chorus hands to the chorus. */
function endOnDominant(chords: ChordEvent[], beats: number, bar: number, s: CoachState): ChordEvent[] {
  const at = beats - bar;
  const v = parseProgression('V', s.keyRoot, s.keyMode, bar)[0].chord;
  const last = chords.filter((e) => e.start < beats - 1e-6).at(-1);
  if (!last || at <= 0 || (last.chord.root === v.root && last.start <= at + 1e-6)) return chords;
  const head = chords.filter((e) => e.start < at - 1e-6).map((e) => ({ ...e, length: Math.min(e.length, at - e.start) }));
  return [...head, { start: at, length: bar, chord: v }];
}

function sectionContexts(p: Project, g: GenreDef, s: CoachState, sections: CoachSection[]): SectionCtx[] {
  const bar = beatsPerBar(p.timeSig);
  const prog = g.progressions[s.progressionIndex] ?? g.progressions[0];
  const breath = breathOf(g.id);
  const minorish = !['major', 'lydian', 'mixolydian'].includes(s.keyMode);
  const seen: Partial<Record<SectionType, number>> = {};
  const totals: Partial<Record<SectionType, number>> = {};
  for (const sec of sections) totals[sec.type] = (totals[sec.type] ?? 0) + 1;
  return sections.map((sec, i) => {
    seen[sec.type] = (seen[sec.type] ?? 0) + 1;
    const chorusLike = sec.type === 'chorus' || sec.type === 'drop';
    const next = sections[i + 1]?.type ?? null;
    let text = chorusLike && prog.chorus ? prog.chorus : prog.prog;
    // the bridge turns to chords the song has not used yet: the new harmony before the last chorus
    if (sec.type === 'bridge' && (prog.bridge || breath.bridgeTurn)) text = prog.bridge ?? BRIDGE_TURN[minorish ? 'minor' : 'major'];
    let chords = tileProgression(parseProgression(text, s.keyRoot, s.keyMode, bar), sec.bars * bar);
    if (sec.type === 'pre' && breath.preDominant && (next === 'chorus' || next === 'drop')) chords = endOnDominant(chords, sec.bars * bar, bar, s);
    return {
      section: sec.type,
      bars: sec.bars,
      barBeats: bar,
      timeSig: p.timeSig,
      chords,
      key: { root: s.keyRoot, mode: s.keyMode },
      energy: SECTION_ENERGY[sec.type],
      isFirst: i === 0,
      isLast: i === sections.length - 1,
      next,
      swing: g.swing,
      swingUnit: g.swingUnit,
      humanize: g.humanize,
      seed: hashString(`${g.id}:${sec.type}`),
      bpm: p.bpm,
      index: i,
      occurrence: seen[sec.type],
      occurrences: totals[sec.type],
      prev: sections[i - 1]?.type ?? null,
    };
  });
}

/** A part's own version of a section: its seed mixed into the section's (0 keeps the default). */
function partCtx(ctx: SectionCtx, variation = 0): SectionCtx {
  return variation ? { ...ctx, seed: hashString(`${ctx.seed}:${variation}`), variation } : ctx;
}

/** A fresh random seed for a newly generated part. */
function newSeed(): number {
  return Math.floor(Math.random() * 0xfffffffe) + 1;
}

const HUMAN_DRUMS_NOTE =
  '這組鼓是職業鼓手的真實演奏（Groove MIDI Dataset），保留了鼓手的重音與微小的前後推拉：安靜的段落改用邊擊或拿掉小鼓，副歌換成同一位鼓手較滿的版本，過門也取自同一段演奏。';
const MELODY_NOTE =
  '示範旋律照作曲原則寫：4 小節一句、由 2 小節的動機發展；強拍放和弦音、其他音一步一步走；副歌比主歌高、Hook 重複；樂句之間留換氣的空間。照著它的節奏填詞或哼唱，再換成你自己的版本。';

function drumRoleOf(g: GenreDef): RoleDef | undefined {
  return g.roles.find((r) => r.kind === 'drums');
}

export function notesForRole(g: GenreDef, role: RoleDef, ctx: SectionCtx, seeds: Record<string, number> = {}): GenNote[] {
  const own = partCtx(ctx, seeds[role.id]);
  // parts that lock to the kick follow the drum part as it was generated
  const drum = drumRoleOf(g);
  const kicksFor = (minVelocity: number) => (drum ? kickPositions(drum.style, partCtx(ctx, seeds[drum.id]), minVelocity) : []);
  switch (role.kind) {
    case 'drums':
      return generateDrums(role.style, own);
    case 'bass':
      return generateBass(role.style as BassStyle, own, kicksFor(60));
    case 'comp':
      return generateComp(role.style as CompStyle, own, { guitar: role.guitar, voicing: role.voicing, range: role.range, kicks: role.style === 'metalChug' ? kicksFor(0) : [] });
    case 'melody':
      return generateMelody(role.style as MelodyStyle, own, role.range);
  }
}

/** The instruments a part can be played on: the role's own patch first. */
export function patchOptions(role: RoleDef): string[] {
  return [role.patch, ...(role.alts ?? []).map((a) => a.patch)];
}

/** The role's fader for one of its instruments. */
export function faderFor(role: RoleDef, patchId: string | undefined): number {
  return role.mix.volumeDb + (role.alts?.find((a) => a.patch === patchId)?.db ?? 0);
}

/** The instrument this version of the part plays, picked by the part's seed. */
export function patchForRole(role: RoleDef, seeds: Record<string, number> = {}): string {
  const options = patchOptions(role);
  const seed = seeds[role.id];
  return seed ? options[hashString(`${seed}:patch`) % options.length] : role.patch;
}

/** Seed of the song-level plan (stops, drop-downs …), rolled by every one-click generation. */
const SONG_SEED = '@song';

function partOf(role: RoleDef): Part {
  if (role.kind === 'comp') return role.step === 'layers' ? 'layers' : 'harmony';
  return role.kind;
}

/** The instrument that answers the melody in its gaps: horns where the genre has them, else the main chord part. */
function answerRoleOf(g: GenreDef): RoleDef | undefined {
  if (!breathOf(g.id).answer) return undefined;
  return g.roles.find((r) => r.id === 'horns') ?? g.roles.find((r) => r.kind === 'comp' && r.step === 'harmony');
}

/** Parts that follow the melody (answers in its gaps, octave doubling in a lifted chorus). */
function followersOf(g: GenreDef): RoleDef[] {
  const answer = answerRoleOf(g);
  return g.roles.filter((r) => r === answer || (r.kind === 'comp' && r.style === 'sustain'));
}

/** The song as planned: its sections, their contexts (with the chords as played) and plans. */
export function songPlan(p: Project, g: GenreDef, s: CoachState): { sections: CoachSection[]; ctxs: SectionCtx[]; plans: SectionPlan[] } {
  const sections = songSections(p, g, s);
  const base = sectionContexts(p, g, s, sections);
  const plans = planSong(g.id, base, s.seeds?.[SONG_SEED] ?? 0);
  const ctxs = base.map((c, i) => ({ ...c, energy: plans[i].energy, chords: plans[i].chords ?? c.chords }));
  return { sections, ctxs, plans };
}

export function regionsForRole(p: Project, g: GenreDef, s: CoachState, role: RoleDef): MidiRegion[] {
  const { sections, ctxs, plans } = songPlan(p, g, s);
  const melodyRole = g.roles.find((r) => r.kind === 'melody');
  const answers = role === answerRoleOf(g);
  const doubles = role.kind === 'comp' && role.style === 'sustain';
  const out: MidiRegion[] = [];
  sections.forEach((sec, i) => {
    if (role.sections && !role.sections.includes(sec.type)) return;
    const raw = notesForRole(g, role, ctxs[i], s.seeds);
    // answers and doubling follow the melody of the same section
    const sings = melodyRole && (!melodyRole.sections || melodyRole.sections.includes(sec.type));
    const melody = sings && (answers || (doubles && plans[i].lift)) ? notesForRole(g, melodyRole, ctxs[i], s.seeds) : undefined;
    let notes = shapePart(raw, partOf(role), ctxs[i], plans[i], {
      crash: role.kind === 'drums' && !!DRUM_STYLES[role.style]?.crash,
      melody,
      answer: answers,
      double: doubles,
      range: role.range ?? (role.guitar ? [52, 76] : [55, 79]),
    });
    // the key change into the last chorus lifts every pitched part together
    if (plans[i].shift && role.kind !== 'drums') notes = notes.map((n) => ({ ...n, pitch: n.pitch + plans[i].shift }));
    if (!notes.length) return;
    out.push(createMidiRegion(sec.start, sec.bars * ctxs[i].barBeats, notes, sec.label));
  });
  return out;
}

// ------------------------------------------------------------------ emotion map

/** One of the masters' moves as the map tells it: what happens here, and what it does. */
export interface MoveNote {
  name: string;
  detail: string;
  effect: string;
  origin: string;
}

/** One section of a generated song: what it does emotionally and the devices that do it. */
export interface EmotionStop {
  label: string;
  type: SectionType;
  bars: number;
  energy: number; // 0 … 1
  role: string;
  devices: string[];
  moves: MoveNote[];
}

const PART_NAME: Record<Part, string> = { drums: '鼓', bass: '貝斯', harmony: '和弦', layers: '配器層', melody: '旋律' };

/** Whether a role plays in a section (and has come in by its end). */
function playsIn(r: RoleDef, sec: CoachSection, plan: SectionPlan): boolean {
  return (!r.sections || r.sections.includes(sec.type)) && (plan.enter[partOf(r)] ?? 0) < sec.bars;
}

/** The emotional design of the current version, read from the same plan the parts were written from. */
export function emotionMap(p: Project, g: GenreDef, s: CoachState): EmotionStop[] {
  const { sections, ctxs, plans } = songPlan(p, g, s);
  const breath = breathOf(g.id);
  const prog = g.progressions[s.progressionIndex] ?? g.progressions[0];
  const flats = keyPrefersFlats(s.keyRoot, s.keyMode);
  const melodyRole = g.roles.find((r) => r.kind === 'melody');
  const melodies = sections.map((sec, i) =>
    melodyRole && (!melodyRole.sections || melodyRole.sections.includes(sec.type))
      ? notesForRole(g, melodyRole, ctxs[i], s.seeds).map((n) => ({ ...n, pitch: n.pitch + plans[i].shift }))
      : [],
  );
  const songTop = Math.max(-1, ...melodies.flat().map((n) => n.pitch));
  const topAt = melodies.map((m) => m.some((n) => n.pitch === songTop)).lastIndexOf(true);
  const choruses = sections.filter((x) => x.type === 'chorus' || x.type === 'drop').length;
  // who plays in each section
  const playing = sections.map((sec, i) => g.roles.filter((r) => playsIn(r, sec, plans[i])).map((r) => r.name));
  let chorusSeen = 0;
  return sections.map((sec, i) => {
    const plan = plans[i];
    const ctx = ctxs[i];
    const devices: string[] = [];
    if (i > 0) {
      const added = playing[i].filter((n) => !playing[i - 1].includes(n));
      const removed = playing[i - 1].filter((n) => !playing[i].includes(n));
      if (added.length) devices.push(`加入：${added.join('、')}`);
      if (removed.length) devices.push(`拿掉：${removed.join('、')}`);
    } else {
      devices.push(`只有：${playing[0].join('、')}`);
    }
    const occ = ctx.occurrence ?? 1;
    let role: string;
    switch (sec.type) {
      case 'intro':
        role = '鋪陳';
        break;
      case 'verse':
        role = occ === 1 ? '敘事：先收著講' : '再說一次：比第一段多一點';
        break;
      case 'pre':
        role = '上坡：吸氣';
        break;
      case 'chorus':
      case 'drop':
        chorusSeen++;
        role = chorusSeen === choruses && choruses > 1 ? '最後一擊：全曲最高點' : chorusSeen === 1 ? '釋放：第一次高潮' : '再次釋放';
        break;
      case 'bridge':
        role = '轉折：換個角度';
        break;
      case 'breakdown':
        role = '喘息';
        break;
      case 'build':
        role = '蓄力';
        break;
      case 'solo':
        role = '獨奏';
        break;
      default:
        role = '收尾：吐氣';
    }
    // chords and notes are named in the key the section sounds in (after a key change)
    const sharpsOrFlats = plan.shift ? keyPrefersFlats((s.keyRoot + plan.shift) % 12, s.keyMode) : flats;
    const sym = (c: Chord) => chordSymbol({ ...c, root: (c.root + plan.shift) % 12, bass: (c.bass + plan.shift) % 12 }, sharpsOrFlats);
    for (const [part, bar] of Object.entries(plan.enter) as [Part, number][]) {
      if (bar > 0 && bar < sec.bars) devices.push(`${PART_NAME[part]}第 ${bar + 1} 小節才進來`);
    }
    if (plan.dyn[1] - plan.dyn[0] >= 0.1) devices.push('一路漸強');
    if (sec.type === 'pre' && breath.preDominant && (ctx.next === 'chorus' || ctx.next === 'drop')) {
      devices.push(`最後一小節停在屬和弦 ${sym(chordAtBeat(ctx, sec.bars * ctx.barBeats - 0.5).chord)}，把期待拉到最高`);
    }
    if (sec.type === 'bridge' && (prog.bridge || breath.bridgeTurn)) {
      const chords = Array.from({ length: Math.min(4, sec.bars) }, (_, b) => sym(chordAtBeat(ctx, b * ctx.barBeats + 0.01).chord));
      devices.push(`換成全曲沒用過的和弦（${chords.join(' – ')}）：沒有預告的新和聲`);
    }
    if (plan.stop !== null) devices.push('最後一拍全團停下來憋氣，下一段更有衝擊');
    if (plan.dropDown) devices.push(`前 ${plan.dropDown} 小節先收（只留大鼓與 Hi-hat），再整個爆開`);
    const sustained = g.roles.filter((r) => r.kind === 'comp' && r.style === 'sustain' && playsIn(r, sec, plan));
    const sings = melodies[i].length > 0;
    if (plan.lift && !plan.counter && sustained.length && sings) devices.push(`${sustained.map((r) => r.name).join('、')}低八度跟著唱旋律，把副歌撐得更大`);
    if (plan.shift && (i === 0 || plans[i - 1].shift === 0)) {
      devices.push(`升 Key：${keyName(s.keyRoot, s.keyMode)} → ${keyName((s.keyRoot + plan.shift) % 12, s.keyMode)}（${plan.shift === 2 ? '全音' : '半音'}）`);
    }
    if (plan.kickOut) devices.push(`第 ${plan.kickOut[0] + 1}–${plan.kickOut[1]} 小節抽掉大鼓，讓下一句更突出`);
    if (plan.fade) devices.push('慢慢淡出');
    const mel = melodies[i];
    if (mel.length) {
      const top = mel.reduce((a, n) => (n.pitch > a.pitch ? n : a));
      const at = `第 ${Math.floor(top.start / ctx.barBeats) + 1} 小節`;
      devices.push(`${i === topAt ? '全曲最高音' : '最高音'} ${noteName(top.pitch, sharpsOrFlats)}（${at}）`);
      // an appoggiatura: a dissonance on the beat that steps down into a chord tone
      const sigh = mel.find((n, k) => {
        const next = mel[k + 1];
        if (!next || n.pitch < top.pitch - 2 || Math.abs(n.start % 1) > 0.05) return false;
        const tones = chordPitchClasses(chordAtBeat(ctx, n.start + 0.05).chord);
        const d = n.pitch - next.pitch;
        return d > 0 && d <= 2 && !tones.includes((n.pitch - plan.shift + 120) % 12) && tones.includes((next.pitch - plan.shift + 120) % 12);
      });
      if (sigh) devices.push(`倚音：最高點先唱 ${noteName(sigh.pitch, sharpsOrFlats)} 再落到 ${noteName(mel[mel.indexOf(sigh) + 1].pitch, sharpsOrFlats)}，像一聲嘆息`);
    }
    // the masters' moves, where the part that plays them is there to play them
    const has = (kind: RoleDef['kind']) => g.roles.some((r) => r.kind === kind && playsIn(r, sec, plan));
    const pcText = (pc: number) => pcName(pc + plan.shift, sharpsOrFlats);
    const bar = (beat: number) => `第 ${Math.floor(beat / ctx.barBeats + 1e-6) + 1} 小節`;
    const detail = (u: MoveUse): string | null => {
      switch (u.id) {
        case 'minorIV':
        case 'sus4':
          return `${bar(u.at)} ${sym(u.from!)} → ${sym(u.to!)}`;
        case 'secondary': {
          const vi = nextChordAfter(ctx, u.at + 0.01)?.chord;
          return vi ? `${bar(u.at)} 先放 ${sym(u.to!)}，再進 ${sym(vi)}` : null;
        }
        case 'picardy':
          return `最後一個和弦是 ${sym(u.to!)}，而不是 ${sym({ ...u.to!, quality: 'min' })}`;
        case 'walkUp': {
          if (!has('bass') || !plan.walkUp) return null;
          const w = plan.walkUp;
          // spelled in the key it walks into
          const into = keyPrefersFlats((w.key + plan.shift) % 12, s.keyMode);
          const name = (pc: number) => pcName(pc + plan.shift, into);
          const walk = walkNotes(w, ctx.key.mode, walkSteps(ctx));
          return `最後 ${walk.length} 拍貝斯走 ${walk.map(name).join(' → ')}，接上下一段的 ${name(w.to)}${w.key !== ctx.key.root ? '（順勢走進新的調）' : ''}`;
        }
        case 'pedal':
          return has('bass') && plan.pedal != null ? `貝斯整段壓在屬音 ${pcText(plan.pedal)} 上` : null;
        case 'halfTime':
          return has('drums') ? '小鼓改打第 3 拍，最後一小節恢復原速帶進副歌' : null;
        case 'stopTime':
          return `前 ${plan.stopTime} 小節全團只在第一拍齊奏${sings ? '，旋律自己唱' : '，空出來給人聲'}`;
        case 'counter':
          return sustained.length && sings ? `${sustained.map((r) => r.name).join('、')}在主旋律下方拉一條對位旋律` : null;
      }
    };
    const moves = (plan.moves ?? []).flatMap((u): MoveNote[] => {
      const d = detail(u);
      return d ? [{ name: MOVES[u.id].name, detail: d, effect: MOVES[u.id].effect, origin: MOVES[u.id].origin }] : [];
    });
    return { label: sec.label, type: sec.type, bars: sec.bars, energy: plan.energy, role, devices, moves };
  });
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
  const patch = patchForRole(role, s.seeds);
  let t = d.tracks.find((x) => x.role === tag);
  if (t?.instrument && t.instrument.patchId !== patch && patchOptions(role).includes(t.instrument.patchId)) {
    // a new version may bring another of the part's instruments; one the user picked stays
    const from = getPatch(t.instrument.patchId);
    const to = getPatch(patch);
    if (t.color === (from.trackColor ?? CATEGORY_INFO[from.category].color)) t.color = to.trackColor ?? CATEGORY_INFO[to.category].color;
    t.mixer.volumeDb += faderFor(role, patch) - faderFor(role, from.id);
    t.instrument.patchId = patch;
    t.instrument.params = defaultParams(to);
  }
  if (!t) {
    const nt = createInstrumentTrack(patch, role.name, tag);
    nt.mixer.volumeDb = faderFor(role, patch);
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
    t.mixer.volumeDb = faderFor(role, t.instrument?.patchId);
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
  // generating a part again makes a new version of it
  const roles = g.roles.filter((r) => r.step === step);
  const s2: CoachState = { ...s, seeds: { ...s.seeds, ...Object.fromEntries(roles.map((r) => [r.id, newSeed()])) } };
  st.update(`${g.name}：${label[step] ?? step}`, (d) => {
    if (step === 'setup') applySetupDraft(d, g, s);
    else if (step === 'structure') applyStructureDraft(d, g, s);
    else if (step === 'mix') applyMixDraft(d, g);
    else {
      if (d.markers.filter((m) => m.section).length < 2) applyStructureDraft(d, g, s);
      for (const role of roles) applyRoleDraft(d, g, s2, role);
      // parts already following the melody follow the new one (their own version stays)
      if (step === 'melody') {
        for (const role of followersOf(g)) if (d.tracks.some((t) => t.role === roleTag(g, role))) applyRoleDraft(d, g, s2, role);
      }
      if (d.coach) d.coach.seeds = s2.seeds;
    }
    markDone(d, step);
  });
  st.setUi({ selectedRegionIds: [] });
}

/** One click: tempo, structure, every role and the mix — a new version every time. */
export function applyAll(): void {
  const cur = current();
  if (!cur) return;
  const { g } = cur;
  const s: CoachState = { ...cur.s, seeds: Object.fromEntries([SONG_SEED, ...g.roles.map((r) => r.id)].map((id) => [id, newSeed()])) };
  useDaw.getState().update(`${g.name}：一鍵生成編曲`, (d) => {
    // replace tracks the coach generated for other genres; the user's own tracks stay
    d.tracks = d.tracks.filter((t) => !t.role || t.role.startsWith(`${g.id}:`));
    if (d.coach) d.coach.seeds = s.seeds;
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
