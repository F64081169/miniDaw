import type { SectionType } from '../core/types';

const SECTION_COLORS: Record<SectionType, string> = {
  intro: '#7f8c9d',
  verse: '#4f8ef7',
  pre: '#9b6bf2',
  chorus: '#f25f5c',
  bridge: '#f2a541',
  breakdown: '#45b7a5',
  build: '#e8c547',
  drop: '#ff4f81',
  solo: '#5fd068',
  outro: '#7f8c9d',
};

export function sectionColor(s: SectionType | undefined): string {
  return s ? SECTION_COLORS[s] : '#7f8c9d';
}
