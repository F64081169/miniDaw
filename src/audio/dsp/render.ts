// Render job dispatcher shared by the render worker and the main-thread fallback.

import { renderDrumPiece, type DrumPiece } from './drums';
import { renderEPiano, renderMallet, renderPiano, type EPianoModel, type MalletModel, type PianoModel } from './keys';
import { renderString, type StringModel } from './strings';

export type RenderSpec =
  | { type: 'string'; model: StringModel }
  | { type: 'piano'; model: PianoModel }
  | { type: 'epiano'; model: EPianoModel }
  | { type: 'mallet'; model: MalletModel };

/** Velocity layer: 0 = soft (darker, gentler attack), 1 = hard. */
export type Layer = 0 | 1;

export type RenderJob =
  | { kind: 'zone'; spec: RenderSpec; pitch: number; sr: number; seed: number; layer: Layer }
  | { kind: 'drum'; kit: string; piece: DrumPiece; sr: number; layer: Layer };

/** The soft layer is the same model played gently: duller excitation, less hammer / tine / bark. */
function softSpec(spec: RenderSpec): RenderSpec {
  switch (spec.type) {
    case 'string':
      return {
        type: 'string',
        model: { ...spec.model, exciteCutoff: spec.model.exciteCutoff * 0.4, brightness: Math.max(0, spec.model.brightness - 0.1), pickNoise: (spec.model.pickNoise ?? 0) * 0.35 },
      };
    case 'piano':
      return { type: 'piano', model: { ...spec.model, brightness: spec.model.brightness * 0.15, hammer: spec.model.hammer * 0.3 } };
    case 'epiano':
      return { type: 'epiano', model: { ...spec.model, bark: spec.model.bark * 0.3, bell: spec.model.bell * 0.5 } };
    case 'mallet':
      return { type: 'mallet', model: { ...spec.model, hardness: spec.model.hardness * 0.45 } };
  }
}

export function runJob(job: RenderJob): Float32Array {
  if (job.kind === 'drum') return renderDrumPiece(job.kit, job.piece, job.sr, 1, job.layer === 0);
  const { pitch, sr, seed } = job;
  const spec = job.layer === 0 ? softSpec(job.spec) : job.spec;
  switch (spec.type) {
    case 'string':
      return renderString(pitch, sr, spec.model, seed);
    case 'piano':
      return renderPiano(pitch, sr, spec.model, seed);
    case 'epiano':
      return renderEPiano(pitch, sr, spec.model, seed);
    case 'mallet':
      return renderMallet(pitch, sr, spec.model, seed);
  }
}

export function jobKey(job: RenderJob): string {
  if (job.kind === 'drum') return `drum|${job.kit}|${job.piece}|${job.sr}|${job.layer}`;
  return `zone|${JSON.stringify(job.spec)}|${job.pitch}|${job.sr}|${job.seed}|${job.layer}`;
}

/** Velocity at which an instrument switches from the soft to the hard layer. */
export const LAYER_SPLIT = 76;
