// Core project data model. Everything in here is plain JSON-serialisable data.
// Positions are measured in beats (quarter notes) unless a field says seconds.

export type ID = string;

export type ScaleMode =
  | 'major'
  | 'minor'
  | 'dorian'
  | 'mixolydian'
  | 'phrygian'
  | 'lydian'
  | 'harmonicMinor';

export interface Note {
  id: ID;
  pitch: number; // MIDI note number 0–127
  start: number; // beats, relative to the region start
  duration: number; // beats
  velocity: number; // 1–127
}

export interface MidiRegion {
  id: ID;
  kind: 'midi';
  name: string;
  start: number; // beats, absolute
  length: number; // beats
  notes: Note[];
  muted?: boolean;
  color?: string;
}

export interface AudioRegion {
  id: ID;
  kind: 'audio';
  name: string;
  start: number; // beats, absolute
  audioId: ID; // key into the audio pool
  offset: number; // seconds into the source recording
  duration: number; // seconds
  gainDb: number;
  fadeIn: number; // seconds
  fadeOut: number; // seconds
  muted?: boolean;
  color?: string;
}

export type Region = MidiRegion | AudioRegion;

export type InsertType = 'eq' | 'comp' | 'drive' | 'chorus' | 'tremolo' | 'pump' | 'lofi' | 'delay';

export interface InsertEffect {
  id: ID;
  type: InsertType;
  enabled: boolean;
  params: Record<string, number>;
}

export interface ChannelSettings {
  volumeDb: number; // -96 (silence) … +6
  pan: number; // -1 … 1
  mute: boolean;
  solo: boolean;
  sends: { reverb: number; delay: number }; // 0 … 1, post-fader
  inserts: InsertEffect[];
}

export interface InstrumentSettings {
  patchId: string;
  params: Record<string, number>; // smart-control values, normalised 0 … 1
}

export type TrackKind = 'instrument' | 'audio';

export interface Track {
  id: ID;
  name: string;
  kind: TrackKind;
  color: string;
  instrument?: InstrumentSettings;
  regions: Region[];
  mixer: ChannelSettings;
  armed: boolean;
  monitor: boolean; // live input monitoring for audio tracks
  height: number; // px in the tracks area
  role?: string; // set by the genre coach so it can update "its" tracks later
}

export interface Marker {
  id: ID;
  name: string;
  start: number; // beats
  length: number; // beats
  color: string;
  section?: SectionType;
}

export type SectionType =
  | 'intro'
  | 'verse'
  | 'pre'
  | 'chorus'
  | 'bridge'
  | 'breakdown'
  | 'build'
  | 'drop'
  | 'solo'
  | 'outro';

export interface BusSettings {
  returnDb: number;
  params: Record<string, number>;
}

export interface MetronomeSettings {
  enabled: boolean;
  volume: number; // 0 … 1
  countIn: boolean;
  countInBars: number;
  onlyWhileRecording: boolean;
}

export interface CoachState {
  genreId: string;
  keyRoot: number;
  keyMode: ScaleMode;
  progressionIndex: number;
  structureIndex: number;
  completed: string[]; // step ids ticked by hand
  /** Random seed of each generated part (by role id): every generation rolls new ones. */
  seeds?: Record<string, number>;
}

export interface Project {
  version: 1;
  id: ID;
  name: string;
  bpm: number;
  timeSig: [number, number];
  key: { root: number; mode: ScaleMode };
  tracks: Track[];
  markers: Marker[];
  loop: { enabled: boolean; start: number; end: number };
  master: { volumeDb: number; limiter: boolean };
  buses: { reverb: BusSettings; delay: BusSettings };
  metronome: MetronomeSettings;
  coach?: CoachState;
  createdAt: number;
  updatedAt: number;
}

export type SnapSetting = 'smart' | 'bar' | '1/4' | '1/8' | '1/16' | '1/32' | '1/8t' | '1/16t' | 'off';
