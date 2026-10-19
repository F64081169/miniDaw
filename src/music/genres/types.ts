import type { InsertType, ScaleMode, SectionType } from '../../core/types';
import type { VoicingStyle } from '../theory';

export type RoleKind = 'drums' | 'bass' | 'comp' | 'melody';
export type StepId = 'setup' | 'structure' | 'drums' | 'bass' | 'harmony' | 'layers' | 'melody' | 'arrange' | 'mix' | 'record' | 'export';

export interface RoleMix {
  volumeDb: number;
  pan: number;
  reverb: number;
  delay: number;
  lowCut?: number;
  comp?: Record<string, number>; // enable the channel compressor with these params
  eq?: Record<string, number>;
  inserts?: { type: InsertType; params?: Record<string, number> }[];
}

export interface RoleDef {
  id: string; // stable role tag stored on the track
  kind: RoleKind;
  name: string;
  patch: string;
  /** Other instruments that suit the part (every new version plays `patch` or one of these),
   *  each with the fader change (dB) that makes it sit in the mix like `patch` does. */
  alts?: { patch: string; db: number }[];
  style: string;
  guitar?: boolean;
  voicing?: VoicingStyle;
  range?: [number, number];
  sections?: SectionType[]; // only plays in these sections (default: everywhere)
  step: 'drums' | 'bass' | 'harmony' | 'layers' | 'melody';
  mix: RoleMix;
  why: string;
}

export interface ProgressionDef {
  name: string;
  prog: string; // see parseProgression
  chorus?: string; // optional different progression for chorus / drop
  note: string;
}

export interface StructureDef {
  name: string;
  sections: { type: SectionType; bars: number }[];
}

export interface GenreDef {
  id: string;
  name: string;
  nameEn: string;
  color: string;
  tagline: string;
  overview: string;
  bpm: { min: number; max: number; default: number };
  timeSig: [number, number];
  swing: number;
  swingUnit: number;
  humanize: number;
  keys: { root: number; mode: ScaleMode }[];
  progressions: ProgressionDef[];
  structures: StructureDef[];
  roles: RoleDef[];
  traits: { title: string; text: string }[];
  steps: { drums: string; bass: string; harmony: string; layers: string; melody: string; arrange: string; mix: string };
  tips: string[];
  bus: { reverbDecay: number; reverbPredelay: number; damping: number; delayTime: number; delayFeedback: number };
  references: string;
}
