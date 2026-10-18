// Render job dispatcher shared by the render worker and the main-thread fallback.

import { renderDrumPiece, type DrumPiece } from './drums';
import { renderEPiano, renderMallet, renderPiano, type EPianoModel, type MalletModel, type PianoModel } from './keys';
import { renderString, type StringModel } from './strings';

export type RenderSpec =
  | { type: 'string'; model: StringModel }
  | { type: 'piano'; model: PianoModel }
  | { type: 'epiano'; model: EPianoModel }
  | { type: 'mallet'; model: MalletModel };

export type RenderJob =
  | { kind: 'zone'; spec: RenderSpec; pitch: number; sr: number; seed: number }
  | { kind: 'drum'; kit: string; piece: DrumPiece; sr: number };

export function runJob(job: RenderJob): Float32Array {
  if (job.kind === 'drum') return renderDrumPiece(job.kit, job.piece, job.sr);
  const { spec, pitch, sr, seed } = job;
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
  if (job.kind === 'drum') return `drum|${job.kit}|${job.piece}|${job.sr}`;
  return `zone|${JSON.stringify(job.spec)}|${job.pitch}|${job.sr}|${job.seed}`;
}
