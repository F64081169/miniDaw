// Small stroke icon set (24 × 24, currentColor).

import type { SVGProps } from 'react';

const P: Record<string, string> = {
  play: 'M8 5.5v13l10.5-6.5z',
  stop: 'M7 7h10v10H7z',
  record: 'M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z',
  toStart: 'M6 6v12M18 6l-9 6l9 6z',
  back: 'M11 6l-7 6l7 6zM20 6l-7 6l7 6z',
  forward: 'M13 6l7 6l-7 6zM4 6l7 6l-7 6z',
  cycle: 'M5 10a7 7 0 0 1 12-3l2 2M19 14a7 7 0 0 1-12 3l-2-2M19 5v4h-4M5 19v-4h4',
  metronome: 'M9 3h6l3.5 17h-13zM12 15l5-9M8 15h8',
  countIn: 'M5 18V8l-2 1.5M10 9.5a2 2 0 1 1 3.5 1.3L10 15h4M17 8.5a2 2 0 1 1 1.5 3.4a2 2 0 1 1-1.5 3.6',
  library: 'M4 5h4v14H4zM10 5h4v14h-4zM16 6l3.5-1l3 13.5l-3.5 1z',
  inspector: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v6M12 7.5v.5',
  mixer: 'M6 4v16M12 4v16M18 4v16M4 9h4M10 15h4M16 7h4',
  editor: 'M3 5h18v14H3zM3 10h18M7 13h4M13 15h5M6 7h3',
  coach: 'M12 4l9 4.5l-9 4.5l-9-4.5zM7 11v4.5c1.5 1.3 3.2 2 5 2s3.5-.7 5-2V11M21 8.5V14',
  keyboard: 'M3 6h18v12H3zM7 6v7M11 6v7M15 6v7M19 6v7M5 13h4M9.5 13v5M14.5 13v5',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10 11v6M14 11v6',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  scissors: 'M6 7a2.5 2.5 0 1 0 0 .01M6 17a2.5 2.5 0 1 0 0 .01M8 8.5l11 9M8 15.5l11-9',
  undo: 'M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2',
  redo: 'M15 7l5 5l-5 5M20 12H9a5 5 0 0 0 0 10h2',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  chevronDown: 'M6 9l6 6l6-6',
  chevronRight: 'M9 6l6 6l-6 6',
  chevronLeft: 'M15 6l-6 6l6 6',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H4zM17 15h3v5h-3z',
  speaker: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  settings: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  download: 'M12 4v11M7 10l5 5l5-5M5 19h14',
  upload: 'M12 16V5M7 10l5-5l5 5M5 19h14',
  help: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7M12 16.5v.5',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  pencil: 'M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3',
  pointer: 'M5 3l13 8l-6 1.5l-2.5 6z',
  eraser: 'M8 20h12M5 15l9-9l5 5l-8 8H8z',
  magnet: 'M6 4v7a6 6 0 0 0 12 0V4h-4v7a2 2 0 0 1-4 0V4zM6 8h4M14 8h4',
  zoomIn: 'M10 4a6 6 0 1 0 0 12a6 6 0 1 0 0-12zM20 20l-5.5-5.5M7.5 10h5M10 7.5v5',
  zoomOut: 'M10 4a6 6 0 1 0 0 12a6 6 0 1 0 0-12zM20 20l-5.5-5.5M7.5 10h5',
  check: 'M5 12.5l4.5 4.5L19 7',
  wand: 'M5 19L15 9M14 4v2M19 9h-2M17.5 5.5l-1.4 1.4M10 5l.5 1.5M19 14l-1.5-.5',
  sparkle: 'M12 3l2 6l6 2l-6 2l-2 6l-2-6l-6-2l6-2z',
  drums: 'M4 9c0-2 3.6-3.5 8-3.5S20 7 20 9v6c0 2-3.6 3.5-8 3.5S4 17 4 15zM4 9c0 2 3.6 3.5 8 3.5S20 11 20 9M8 3l3 5M16 3l-3 5',
  piano: 'M3 5h18v14H3zM7 5v8M11 5v8M15 5v8M19 5v8M5.5 13v6M9 13v6M13 13v6M17 13v6',
  epiano: 'M3 8h18v9H3zM6 8v5M9 8v5M12 8v5M15 8v5M18 8v5M5 17l-1 3M19 17l1 3',
  eguitar: 'M15 4l5 5l-3 1l-5 5a3.5 3.5 0 1 1-4-4l5-5zM9 15l-2-2',
  aguitar: 'M14 4l6 6M17 7l-5 5M10.5 10.5a4.5 4.5 0 1 0 3 3a3 3 0 0 0-3-3zM9 15a1 1 0 1 0 .01 0',
  bass: 'M16 3l5 5l-2 1l-6 6a3.5 3.5 0 1 1-4-4l6-6zM6 18l-2 2',
  organ: 'M3 6h18v4H3zM3 10h18v8H3zM6 13v5M10 13v5M14 13v5M18 13v5M6 6v4M10 6v4M14 6v4M18 6v4',
  strings: 'M8 3c3 2 4 5 3 8c-1 2-3 3-3 6s2 4 4 4s4-1 4-4s-2-4-3-6c-1-3 0-6 3-8M12 13v8',
  synth: 'M3 6h18v12H3zM7 10a1.5 1.5 0 1 0 0 .01M12 10a1.5 1.5 0 1 0 0 .01M17 10a1.5 1.5 0 1 0 0 .01M6 15h12',
  brass: 'M3 10h9l5-4v12l-5-4H3zM17 8a5 5 0 0 1 0 8M7 10v4',
  mallet: 'M4 16h16M6 13h12M8 10h8M14 3l-3 7M17 4l-4 6',
  winds: 'M4 20L18 6M16 4l4 4M8.5 15.5h.01M11 13h.01M13.5 10.5h.01',
  audio: 'M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0',
  folder: 'M3 6h6l2 2h10v11H3z',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  rows: 'M4 6h16M4 12h16M4 18h16',
  quantize: 'M4 18V6M9 18V6M14 18V6M19 18V6M3 12h6M14 12h6',
  arrowUp: 'M12 19V5M6 11l6-6l6 6',
  arrowDown: 'M12 5v14M6 13l6 6l6-6',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  solo: 'M15 8a3 3 0 0 0-3-2c-2 0-3 1-3 2.5C9 12 15 11 15 15c0 1.5-1.2 3-3 3a3.5 3.5 0 0 1-3.2-2',
  waveform: 'M2 12h3l2-6l3 12l3-9l2 5l2-2h5',
  note: 'M9 18a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0M9 18V5l11-2v12M20 15a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0',
  marker: 'M5 4v16M5 4h12l-3 4l3 4H5',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, filled = false, ...rest }: { name: IconName | string; size?: number; filled?: boolean } & SVGProps<SVGSVGElement>) {
  const d = P[name] ?? P.dots;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}
