import type { RenderSpec } from '../dsp/render';

export type PatchCategory =
  | 'drums'
  | 'piano'
  | 'epiano'
  | 'eguitar'
  | 'aguitar'
  | 'bass'
  | 'organ'
  | 'strings'
  | 'synth'
  | 'brass'
  | 'mallet';

export type ControlId =
  | 'tone'
  | 'drive'
  | 'room'
  | 'width'
  | 'tremolo'
  | 'rate'
  | 'chorus'
  | 'rotary'
  | 'attack'
  | 'release'
  | 'cutoff'
  | 'resonance'
  | 'glide'
  | 'velocity'
  | 'body'
  | 'decay'
  | 'punch';

export interface SmartControl {
  id: ControlId;
  default: number; // 0 … 1
}

export interface AmpDef {
  drive: number; // base drive 0 … 1 (the 'drive' control scales around it)
  cabinet: 'guitar' | 'bass' | 'none';
  presence: number; // dB
}

export interface ChainDef {
  amp?: AmpDef;
  tremolo?: { rate: number; stereo: boolean };
  chorus?: boolean;
  rotary?: boolean;
  room?: { decay: number; damping: number };
  width?: boolean;
  bodyEq?: boolean;
  punch?: boolean; // drum bus compressor
  saturate?: boolean; // soft saturation stage (808, organ)
}

export type OscWave = 'sine' | 'square' | 'sawtooth' | 'triangle' | 'organ';

export interface SynthOsc {
  wave: OscWave;
  octave: number;
  detune: number; // cents
  gain: number;
  unison?: number; // voices per osc
  spread?: number; // cents between unison voices
}

export interface SynthDef {
  oscs: SynthOsc[];
  noise?: number; // key click / breath
  filter: {
    type: BiquadFilterType;
    cutoff: number; // Hz before envelope
    q: number;
    env: number; // octaves of envelope sweep
    keyTrack: number; // 0 … 1
    velocity: number; // octaves added at full velocity
    a: number;
    d: number;
    s: number;
    r: number;
  };
  amp: { a: number; d: number; s: number; r: number };
  pitchEnv?: { semis: number; time: number };
  vibrato?: { rate: number; depth: number; delay: number };
  mono?: boolean;
  glide?: number; // seconds
  drawbars?: number[]; // 9 tonewheel drawbars (0 … 8)
  maxVoices?: number;
}

export interface SampledDef {
  spec: RenderSpec;
  zoneStep: number;
  release: number; // seconds (damper)
  attack?: number;
  layers?: 1 | 2; // velocity layers (default 2: soft + hard)
  panSpread?: number; // pitch-dependent pan width
  retrigger?: 'cut' | 'overlap';
  maxVoices?: number;
  sustainLoop?: false;
}

/** Recorded samples for a pitched patch (see src/audio/samples). */
export interface SamplesDef {
  set: string;
  release: number; // seconds after note-off
  retrigger?: 'cut' | 'overlap';
  maxVoices?: number;
  panSpread?: number; // pitch-dependent pan width for mono sets
  shortBelow?: number; // notes shorter than this (s) use the 'short' articulation
}

export interface PatchDef {
  id: string;
  name: string; // Traditional Chinese
  nameEn: string;
  category: PatchCategory;
  description: string;
  gmProgram: number;
  range: [number, number];
  engine: 'sampled' | 'synth' | 'drums';
  sampled?: SampledDef;
  synth?: SynthDef;
  kit?: string;
  /** Recorded samples; the engine above becomes the fallback while they load. */
  samples?: SamplesDef;
  /** Recorded drum kit sets, in priority order (later sets fill in missing pieces). */
  kitSets?: string[];
  chain: ChainDef;
  controls: SmartControl[];
  level: number; // output trim in dB
  trackColor: string;
}
