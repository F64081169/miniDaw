// The masters' moves: tricks songwriters and arrangers found by ear and passed on, each named
// with where it comes from so the coach can teach it (see the coach's references).
//
// A version of a song picks a few of them, as often as its genre uses them (GENRE_MOVES).
// Chord moves (here) change the harmony every part plays; part moves change how one part plays
// a section (shapePart in ./arrange).

import type { ScaleMode } from '../../core/types';
import { isInScale, isMinorish, type Chord, type ChordEvent, type ChordQuality } from '../theory';
import type { SectionCtx } from './common';

export type MoveId = 'minorIV' | 'secondary' | 'sus4' | 'picardy' | 'walkUp' | 'pedal' | 'halfTime' | 'stopTime' | 'counter';

export interface MoveDef {
  name: string;
  effect: string; // what it does for the listener
  origin: string; // the masters who use it
}

export const MOVES: Record<MoveId, MoveDef> = {
  minorIV: {
    name: '小四級和弦 iv',
    effect: '大調裡的 IV 和弦後半換成小和弦：甜裡帶一點酸，像回頭看了一眼',
    origin: 'The Beatles〈In My Life〉的 D → Dm、Radiohead〈Creep〉的 C → Cm',
  },
  secondary: {
    name: '副屬和弦 V/vi',
    effect: '進小和弦 vi 之前先放它自己的屬七和弦，低音順勢靠過去：轉進憂傷的那一下非去不可',
    origin: 'Leonard Cohen〈Hallelujah〉的 E7 → Am、日本流行樂的「丸サ進行」（〈Just the Two of Us〉）',
  },
  sus4: {
    name: '掛留四度',
    effect: '導歌最後的屬和弦先掛著四度音，半小節後才落定：把「快到了」再拖一下',
    origin: '古典和聲的延遲音，福音與流行抒情最常用的收法',
  },
  picardy: {
    name: '皮卡第三度',
    effect: '小調的歌最後一個和弦換成大和弦：哀傷的故事最後透出一道光',
    origin: '巴哈的小調聖詠幾乎都這樣結束',
  },
  walkUp: {
    name: '貝斯爬音',
    effect: '進副歌前最後幾拍，貝斯一階一階走上副歌的第一個音，把聽眾領上樓',
    origin: 'Motown 貝斯手 James Jamerson 的半音爬升、鄉村樂的 walk-up',
  },
  pedal: {
    name: '屬音持續低音',
    effect: '導歌的和弦照常換，貝斯卻一直壓在屬音上：張力越堆越高，進副歌才解開',
    origin: '巴哈管風琴曲的持續低音；Gary Ewer〈Secrets of Songwriting〉建議用在導歌',
  },
  halfTime: {
    name: '半速感',
    effect: '小鼓從第 2、4 拍移到第 3 拍，速度沒變卻像慢了一半：歌喘一口氣，回到原速的副歌更有衝擊',
    origin: 'Twenty One Pilots〈Heavydirtysoul〉的橋段；搖滾與金屬讓段落變重的老方法',
  },
  stopTime: {
    name: '停頓節奏 stop-time',
    effect: '樂團只在每小節第一拍一起敲一下，其餘時間空出來，讓旋律自己說話',
    origin: 'Scott Joplin〈The Ragtime Dance〉、Jelly Roll Morton〈King Porter Stomp〉',
  },
  counter: {
    name: '對位旋律',
    effect: '最後的副歌，弦樂另外拉一條旋律跟主旋律對話：主旋律長音時它動，主旋律忙的時候它停',
    origin: '弦樂編曲的基本功（Sound On Sound〈Arranging Strings〉）',
  },
};

/** How often each genre reaches for each move (the chance per version of a song). */
const GENRE_MOVES: Record<string, Partial<Record<MoveId, number>>> = {
  pop: { minorIV: 0.3, secondary: 0.3, sus4: 0.4, picardy: 0.4, walkUp: 0.35, pedal: 0.3, halfTime: 0.35, stopTime: 0.2, counter: 0.45 },
  mandopop: { minorIV: 0.4, secondary: 0.45, sus4: 0.45, walkUp: 0.25, pedal: 0.3, halfTime: 0.25, counter: 0.6 },
  ballad: { minorIV: 0.45, secondary: 0.4, sus4: 0.5, picardy: 0.5, walkUp: 0.2, pedal: 0.35, halfTime: 0.3, counter: 0.65 },
  rock: { minorIV: 0.25, picardy: 0.35, walkUp: 0.3, stopTime: 0.4 },
  metal: { picardy: 0.15, stopTime: 0.35, counter: 0.2 },
  country: { minorIV: 0.2, secondary: 0.3, walkUp: 0.55, halfTime: 0.2, stopTime: 0.4 },
  hiphop: { stopTime: 0.35 },
  trap: { stopTime: 0.3 },
  lofi: { minorIV: 0.35, secondary: 0.3, stopTime: 0.2 },
  rnb: { minorIV: 0.3, secondary: 0.4, sus4: 0.35, picardy: 0.3, walkUp: 0.35, pedal: 0.25, halfTime: 0.3, stopTime: 0.3, counter: 0.35 },
  edm: { minorIV: 0.15, secondary: 0.15, picardy: 0.25 },
  synthwave: { minorIV: 0.25, picardy: 0.35, halfTime: 0.3, counter: 0.4 },
  jazz: { picardy: 0.3, stopTime: 0.45 },
  bossa: { minorIV: 0.3, secondary: 0.35, picardy: 0.4, counter: 0.3 },
  funk: { walkUp: 0.4, stopTime: 0.55 },
  citypop: { minorIV: 0.35, secondary: 0.55, sus4: 0.35, picardy: 0.3, walkUp: 0.35, pedal: 0.25, stopTime: 0.3, counter: 0.45 },
  reggae: { minorIV: 0.2, secondary: 0.2, picardy: 0.25, walkUp: 0.3, stopTime: 0.3 },
};

/** Genres whose bass walks up chromatically (Motown); the others walk the scale. */
const CHROMATIC_WALK = new Set(['funk', 'rnb', 'citypop']);

export function walksChromatically(genreId: string): boolean {
  return CHROMATIC_WALK.has(genreId);
}

/** The moves one version of a song uses, each rolled at its genre's rate. */
export function pickMoves(genreId: string, rng: () => number): Set<MoveId> {
  const rates = GENRE_MOVES[genreId] ?? {};
  const out = new Set<MoveId>();
  for (const id of Object.keys(MOVES) as MoveId[]) {
    const rate = rates[id] ?? 0;
    if (rate > 0 && rng() < rate) out.add(id);
  }
  return out;
}

// ------------------------------------------------------------------ chord moves

/** A chord move as it happened: where, and the chords before and after it. */
export interface ChordMove {
  chords: ChordEvent[];
  at: number; // beat where the new chord starts
  from: Chord;
  to: Chord;
}

type Key = SectionCtx['key'];

const pcOf = (n: number) => ((n % 12) + 12) % 12;
const MINOR_QUALITIES = new Set<ChordQuality>(['min', 'm7', 'm9', 'm11', 'm6', 'madd9']);
const MINOR_OF: Partial<Record<ChordQuality, ChordQuality>> = { maj: 'min', maj7: 'm7', maj9: 'm9', add9: 'madd9', '6': 'm6' };
const DOMINANT_QUALITIES = new Set<ChordQuality>(['maj', '7', '9', '13']);

/** Whether a chord is minor (a minor triad or one of its extensions). */
export function isMinorChord(c: Chord): boolean {
  return MINOR_QUALITIES.has(c.quality);
}

/** Whether the key is major (the borrowed and secondary chords below are major-key moves). */
export function isMajorKey(mode: ScaleMode): boolean {
  return mode === 'major';
}

/** Split an event in two halves, the second played by `to`. */
function splitWith(chords: ChordEvent[], i: number, to: Chord): ChordMove {
  const e = chords[i];
  const half = e.length / 2;
  return {
    chords: [...chords.slice(0, i), { ...e, length: half }, { start: e.start + half, length: half, chord: to }, ...chords.slice(i + 1)],
    at: e.start + half,
    from: e.chord,
    to,
  };
}

/**
 * The minor iv: the second half of a major IV turns minor (the section's last IV that lasts a
 * bar, preferably one that goes home to I), the borrowed chord of "In My Life" and "Creep".
 */
export function minorFour(chords: ChordEvent[], key: Key, bar: number): ChordMove | null {
  if (!isMajorKey(key.mode)) return null;
  const fours = chords.flatMap((e, i) => (pcOf(e.chord.root - key.root) === 5 && MINOR_OF[e.chord.quality] && e.length >= bar - 1e-6 ? [i] : []));
  if (!fours.length) return null;
  const home = fours.filter((i) => chords[i + 1] && pcOf(chords[i + 1].chord.root - key.root) === 0);
  const i = (home.length ? home : fours).at(-1)!;
  const c = chords[i].chord;
  return splitWith(chords, i, { ...c, quality: MINOR_OF[c.quality]!, numeral: 'iv' });
}

/** Distance between two pitch classes (0 … 6). */
function pcDist(a: number, b: number): number {
  const d = pcOf(a - b);
  return Math.min(d, 12 - d);
}

/**
 * A secondary dominant into vi: before the section's last vi, III7 (the dominant of vi) takes
 * over a iii, or the second half of another chord that lasts a bar, with the bass note that
 * moves least.
 */
export function secondaryDominant(chords: ChordEvent[], key: Key, bar: number): ChordMove | null {
  if (!isMajorKey(key.mode)) return null;
  const root = pcOf(key.root + 4);
  for (let i = chords.length - 1; i >= 1; i--) {
    const vi = chords[i].chord;
    if (pcOf(vi.root - key.root) !== 9 || !MINOR_QUALITIES.has(vi.quality)) continue;
    const prev = chords[i - 1];
    const rel = pcOf(prev.chord.root - key.root);
    if (rel === 4 && !MINOR_QUALITIES.has(prev.chord.quality)) return null; // already there
    const basses = [root, pcOf(root + 4), pcOf(root + 7)]; // root, third (vi's leading tone), fifth
    const cost = (b: number) => pcDist(prev.chord.bass, b) + pcDist(b, vi.bass) + (b === root ? 0 : 0.5);
    const bass = basses.reduce((a, b) => (cost(b) < cost(a) ? b : a));
    const dom: Chord = { root, quality: '7', bass, numeral: 'V7/vi' };
    if (rel === 4) return { chords: chords.map((e, k) => (k === i - 1 ? { ...e, chord: dom } : e)), at: prev.start, from: prev.chord, to: dom };
    if (prev.length < bar - 1e-6) return null;
    return splitWith(chords, i - 1, dom);
  }
  return null;
}

/** V → Vsus4 V: a dominant bar that ends the section first holds the fourth, then resolves. */
export function suspendDominant(chords: ChordEvent[], key: Key, bar: number): ChordMove | null {
  const i = chords.length - 1;
  const e = chords[i];
  if (!e || pcOf(e.chord.root - key.root) !== 7 || !DOMINANT_QUALITIES.has(e.chord.quality) || e.length < bar - 1e-6) return null;
  const half = e.length / 2;
  const sus: Chord = { ...e.chord, quality: e.chord.quality === 'maj' ? 'sus4' : '7sus4', bass: e.chord.root, numeral: 'Vsus4' };
  return {
    chords: [...chords.slice(0, i), { start: e.start, length: half, chord: sus }, { ...e, start: e.start + half, length: half }],
    at: e.start,
    from: sus,
    to: e.chord,
  };
}

/**
 * The Picardy third: a minor song's last chord is the major tonic. A minor tonic turns major;
 * another chord that lasts a bar gives its second half to it.
 */
export function picardy(chords: ChordEvent[], key: Key, bar: number): ChordMove | null {
  const i = chords.length - 1;
  const e = chords[i];
  if (!e || !isMinorish(key.mode)) return null;
  const tonic: Chord = { root: key.root, quality: 'maj', bass: key.root, numeral: 'I' };
  if (e.chord.root === key.root && MINOR_QUALITIES.has(e.chord.quality)) {
    return { chords: [...chords.slice(0, i), { ...e, chord: tonic }], at: e.start, from: e.chord, to: tonic };
  }
  if (e.chord.root === key.root || e.length < bar - 1e-6) return null;
  return splitWith(chords, i, tonic);
}

// ------------------------------------------------------------------ part moves

/** A walk-up: where the bass climbs to, in which key, chromatically or along the scale. */
export interface WalkUp {
  to: number; // pitch class of the next section's first bass note
  key: number; // root of the key it arrives in (the next section's, after a key change)
  chromatic: boolean;
}

/** The note the bass walks to: the next section's bass note where the bass parts start (near E2–F#2). */
export function walkTarget(pc: number): number {
  let t = 36 + pcOf(pc - 36);
  if (t - 36 > 6) t -= 12;
  return t;
}

/**
 * The notes of a walk-up into `w.to` (up to `steps` of them, on the beats before it): the scale
 * steps below it, or the half steps (Jamerson); none lower than the bass's low E.
 */
export function walkNotes(w: WalkUp, mode: ScaleMode, steps: number): number[] {
  const target = walkTarget(w.to);
  const out: number[] = [];
  let p = target;
  for (let k = 0; k < steps; k++) {
    p--;
    if (!w.chromatic) while (!isInScale(p, w.key, mode)) p--;
    out.unshift(p);
  }
  return out.filter((q) => q >= 28);
}

/** Where the moves come from (shown in the coach). */
export const MOVE_SOURCES: { title: string; url: string }[] = [
  { title: 'Ethan Hein：In My Life（IV → iv，「Beatles cadence」）', url: 'https://www.ethanhein.com/wp/2022/in-my-life/' },
  { title: 'MusicRadar：Songwriting basics — borrowed chords', url: 'https://musicradar.com/how-to/songwriting-basics-borrowed-chords' },
  { title: 'Wikipedia：Secondary dominant（CC BY-SA 4.0）', url: 'https://en.wikipedia.org/wiki/Secondary_dominant' },
  { title: 'nippon.com：破譯樂理——席捲 J-POP 樂壇的「Just The Two of Us」經典和弦進行', url: 'https://www.nippon.com/hk/japan-topics/g01096/' },
  { title: 'SleepFreaks：sus4 與 7sus4 和弦（延遲屬和弦的解決）', url: 'https://sleepfreaks-dtm.com/en/music-theory-beginner/sus-2' },
  { title: 'Wikipedia：Picardy third（CC BY-SA 4.0）', url: 'https://en.wikipedia.org/wiki/Picardy_third' },
  { title: 'No Treble：James Jamerson Motown Bass Breakdown（半音爬升到根音）', url: 'https://www.notreble.com/?p=115511' },
  { title: 'Secrets of Songwriting：Building Song Energy By Using a “Dominant Pedal”', url: 'https://www.secretsofsongwriting.com/2013/04/18/building-song-energy-by-using-a-dominant-pedal/' },
  { title: 'OnlineDrummer：Learn the Half-time Bridge from Heavydirtysoul', url: 'https://onlinedrummer.com/blogs/drum-lessons/learn-the-half-time-bridge-from-heavydirtysoul' },
  { title: 'Wikipedia：Stop-time（CC BY-SA 4.0）', url: 'https://en.wikipedia.org/wiki/Stop-time' },
  { title: 'Sound On Sound：Arranging Strings, Part 4（對位旋律）', url: 'https://www.soundonsound.com/techniques/arranging-strings-part-4' },
  { title: 'Secrets of Songwriting：Add Melodic Interest With a Countermelody', url: 'https://www.secretsofsongwriting.com/2010/06/03/add-melodic-interest-with-a-countermelody/' },
];
