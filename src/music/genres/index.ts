import { BOSSA, CITYPOP, FUNK, JAZZ, REGGAE } from './jazzWorld';
import { BALLAD, COUNTRY, MANDOPOP, METAL, POP, ROCK } from './popRock';
import type { GenreDef } from './types';
import { EDM, HIPHOP, HOUSE, LOFI, RNB, SYNTHWAVE, TRAP } from './urbanElectronic';

export const GENRES: GenreDef[] = [POP, MANDOPOP, BALLAD, ROCK, METAL, COUNTRY, HIPHOP, TRAP, LOFI, RNB, HOUSE, EDM, SYNTHWAVE, JAZZ, BOSSA, FUNK, CITYPOP, REGGAE];

export const GENRE_BY_ID = new Map(GENRES.map((g) => [g.id, g]));

export function getGenre(id: string | undefined): GenreDef | undefined {
  return id ? GENRE_BY_ID.get(id) : undefined;
}

export type { GenreDef, RoleDef, ProgressionDef, StructureDef, StepId } from './types';
