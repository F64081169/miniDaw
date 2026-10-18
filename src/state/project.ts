// Factories for project data.

import type { AudioRegion, ChannelSettings, InsertEffect, MidiRegion, Note, Project, Track } from '../core/types';
import { uid } from '../core/util';
import { DELAY_BUS_PARAMS, REVERB_PARAMS, defaultFxParams, defaultsOf } from '../audio/fx/registry';
import { CATEGORY_INFO, defaultParams, getPatch } from '../audio/instruments/patches';
import type { PatchCategory } from '../audio/instruments/types';

export const AUDIO_TRACK_COLOR = '#5b8def';

export function defaultInserts(): InsertEffect[] {
  return [
    { id: uid('fx'), type: 'eq', enabled: true, params: defaultFxParams('eq') },
    { id: uid('fx'), type: 'comp', enabled: false, params: defaultFxParams('comp') },
  ];
}

export function defaultChannel(overrides: Partial<ChannelSettings> = {}): ChannelSettings {
  return {
    volumeDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    sends: { reverb: 0, delay: 0 },
    inserts: defaultInserts(),
    ...overrides,
  };
}

const CATEGORY_SENDS: Record<PatchCategory, { reverb: number; delay: number; volumeDb: number }> = {
  drums: { reverb: 0.06, delay: 0, volumeDb: -3 },
  piano: { reverb: 0.18, delay: 0, volumeDb: -4 },
  epiano: { reverb: 0.14, delay: 0.04, volumeDb: -4 },
  eguitar: { reverb: 0.12, delay: 0.06, volumeDb: -5 },
  aguitar: { reverb: 0.15, delay: 0, volumeDb: -4 },
  bass: { reverb: 0, delay: 0, volumeDb: -3 },
  organ: { reverb: 0.12, delay: 0, volumeDb: -6 },
  strings: { reverb: 0.28, delay: 0, volumeDb: -7 },
  synth: { reverb: 0.22, delay: 0.08, volumeDb: -7 },
  brass: { reverb: 0.18, delay: 0, volumeDb: -6 },
  mallet: { reverb: 0.25, delay: 0.1, volumeDb: -6 },
};

export function createInstrumentTrack(patchId: string, name?: string, role?: string): Track {
  const patch = getPatch(patchId);
  const s = CATEGORY_SENDS[patch.category];
  return {
    id: uid('t'),
    name: name ?? patch.name,
    kind: 'instrument',
    color: patch.trackColor ?? CATEGORY_INFO[patch.category].color,
    instrument: { patchId: patch.id, params: defaultParams(patch) },
    regions: [],
    mixer: defaultChannel({ volumeDb: s.volumeDb, sends: { reverb: s.reverb, delay: s.delay } }),
    armed: false,
    monitor: false,
    height: 72,
    role,
  };
}

export function createAudioTrack(name = '音訊軌'): Track {
  const mixer = defaultChannel({ sends: { reverb: 0.12, delay: 0 } });
  // vocals and live instruments almost always want a low cut and gentle compression
  mixer.inserts[0].params.lowCut = 80;
  mixer.inserts[1].enabled = true;
  return {
    id: uid('t'),
    name,
    kind: 'audio',
    color: AUDIO_TRACK_COLOR,
    regions: [],
    mixer,
    armed: false,
    monitor: false,
    height: 72,
  };
}

export function createMidiRegion(start: number, length: number, notes: Omit<Note, 'id'>[] = [], name = 'MIDI 片段'): MidiRegion {
  return {
    id: uid('r'),
    kind: 'midi',
    name,
    start,
    length,
    notes: notes.map((n) => ({ ...n, id: uid('n') })),
  };
}

export function createAudioRegion(start: number, audioId: string, duration: number, name = '錄音'): AudioRegion {
  return { id: uid('r'), kind: 'audio', name, start, audioId, offset: 0, duration, gainDb: 0, fadeIn: 0.005, fadeOut: 0.01 };
}

export function createProject(name = '未命名專案'): Project {
  const now = Date.now();
  return {
    version: 1,
    id: uid('p'),
    name,
    bpm: 110,
    timeSig: [4, 4],
    key: { root: 0, mode: 'major' },
    tracks: [],
    markers: [],
    loop: { enabled: false, start: 0, end: 16 },
    master: { volumeDb: 0, limiter: true },
    buses: {
      reverb: { returnDb: -3, params: defaultsOf(REVERB_PARAMS) },
      delay: { returnDb: -6, params: defaultsOf(DELAY_BUS_PARAMS) },
    },
    metronome: { enabled: false, volume: 0.7, countIn: true, countInBars: 1, onlyWhileRecording: false },
    createdAt: now,
    updatedAt: now,
  };
}

/** Starter project shown on first launch: a few tracks ready to play. */
export function createStarterProject(): Project {
  const p = createProject('我的第一首歌');
  p.tracks = [
    createInstrumentTrack('drums.studio', '鼓組', 'drums'),
    createInstrumentTrack('bass.finger', '貝斯', 'bass'),
    createInstrumentTrack('piano.grand', '鋼琴', 'chords'),
    createAudioTrack('人聲'),
  ];
  return p;
}

/** Make sure data loaded from disk / older versions has every field we rely on. */
export function normalizeProject(raw: Project): Project {
  const base = createProject(raw.name);
  const p: Project = { ...base, ...raw, version: 1 };
  p.metronome = { ...base.metronome, ...raw.metronome };
  p.loop = { ...base.loop, ...raw.loop };
  p.master = { ...base.master, ...raw.master };
  p.buses = {
    reverb: { ...base.buses.reverb, ...raw.buses?.reverb, params: { ...base.buses.reverb.params, ...raw.buses?.reverb?.params } },
    delay: { ...base.buses.delay, ...raw.buses?.delay, params: { ...base.buses.delay.params, ...raw.buses?.delay?.params } },
  };
  p.markers = raw.markers ?? [];
  p.tracks = (raw.tracks ?? []).map((t) => ({
    ...t,
    height: t.height ?? 72,
    armed: false,
    monitor: !!t.monitor,
    mixer: { ...defaultChannel(), ...t.mixer, sends: { ...{ reverb: 0, delay: 0 }, ...t.mixer?.sends } },
    regions: t.regions ?? [],
  }));
  return p;
}
