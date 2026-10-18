import { describe, expect, it } from 'vitest';
import { chordPitchClasses, chordSymbol, parseNumeral, parseProgression, tileProgression, voiceChord, bassNoteFor, keyName } from '../src/music/theory';
import { guitarVoicing } from '../src/music/guitar';

describe('roman numerals', () => {
  it('parses diatonic chords in C major', () => {
    expect(chordSymbol(parseNumeral('I', 0))).toBe('C');
    expect(chordSymbol(parseNumeral('ii7', 0))).toBe('Dm7');
    expect(chordSymbol(parseNumeral('V7', 0))).toBe('G7');
    expect(chordSymbol(parseNumeral('vi', 0))).toBe('Am');
    expect(chordSymbol(parseNumeral('IVmaj7', 0))).toBe('Fmaj7');
    expect(chordSymbol(parseNumeral('vii°', 0))).toBe('Bdim');
  });
  it('handles borrowed, secondary and slash chords', () => {
    expect(chordSymbol(parseNumeral('bVII', 0), true)).toBe('Bb');
    expect(chordSymbol(parseNumeral('V7/V', 0))).toBe('D7');
    expect(chordSymbol(parseNumeral('V/7', 2))).toBe('A/C#');
    expect(chordSymbol(parseNumeral('I/3', 2))).toBe('D/F#');
    expect(chordSymbol(parseNumeral('iii/5', 2))).toBe('F#m/A');
    expect(chordSymbol(parseNumeral('i', 9, 'minor'))).toBe('Am');
    expect(chordSymbol(parseNumeral('bVI', 9, 'minor'))).toBe('F');
  });
  it('parses extended qualities', () => {
    expect(chordSymbol(parseNumeral('ii9', 0))).toBe('Dm9');
    expect(chordSymbol(parseNumeral('V13', 0))).toBe('G13');
    expect(chordSymbol(parseNumeral('Imaj9', 0))).toBe('Cmaj9');
    expect(chordSymbol(parseNumeral('V7sus4', 0))).toBe('G7sus4');
    expect(chordPitchClasses(parseNumeral('V7', 0))).toEqual([7, 11, 2, 5]);
  });
  it('splits bars evenly and tiles progressions', () => {
    const evs = parseProgression('ii7 V7 | Imaj7 |', 0, 'major', 4);
    expect(evs.map((e) => [e.start, e.length])).toEqual([[0, 2], [2, 2], [4, 4]]);
    const tiled = tileProgression(evs, 16);
    expect(tiled.length).toBe(6);
    expect(tiled[tiled.length - 1].start + tiled[tiled.length - 1].length).toBe(16);
  });
  it('names keys', () => {
    expect(keyName(3, 'major')).toBe('Eb 大調');
    expect(keyName(9, 'minor')).toBe('A 小調');
  });
});

describe('voicing', () => {
  it('stays in range and voice-leads smoothly', () => {
    const c = parseNumeral('I', 0);
    const f = parseNumeral('IV', 0);
    const g = parseNumeral('V', 0);
    const v1 = voiceChord(c, { low: 55, high: 76 });
    const v2 = voiceChord(f, { low: 55, high: 76, prev: v1 });
    const v3 = voiceChord(g, { low: 55, high: 76, prev: v2 });
    for (const v of [v1, v2, v3]) {
      expect(Math.min(...v)).toBeGreaterThanOrEqual(55);
      expect(Math.max(...v)).toBeLessThanOrEqual(76);
    }
    const move = (a: number[], b: number[]) => a.reduce((s, n, i) => s + Math.abs(n - (b[i] ?? n)), 0);
    expect(move(v1, v2)).toBeLessThan(8);
    expect(move(v2, v3)).toBeLessThan(10);
  });
  it('rootless voicings omit the root', () => {
    const v = voiceChord(parseNumeral('ii7', 0), { low: 50, high: 74, style: 'rootless' });
    expect(v.some((p) => p % 12 === 2)).toBe(false); // no D in a rootless Dm7 (F A C E)
    expect(v.map((p) => p % 12).sort((a, b) => a - b)).toEqual([0, 4, 5, 9]);
  });
  it('bass notes follow slash chords', () => {
    expect(bassNoteFor(parseNumeral('V/7', 2)) % 12).toBe(1);
  });
});

describe('guitar shapes', () => {
  it('uses open chords when available', () => {
    expect(guitarVoicing(parseNumeral('I', 0), null).notes).toEqual([48, 52, 55, 60, 64]);
    expect(guitarVoicing(parseNumeral('vi', 0), null).notes).toEqual([45, 52, 57, 60, 64]);
  });
  it('falls back to barre shapes', () => {
    const f = guitarVoicing(parseNumeral('IV', 0), null);
    expect(f.notes.every((n) => [5, 9, 0].includes(n % 12))).toBe(true);
    const bb = guitarVoicing(parseNumeral('bVII', 0), null);
    expect(bb.notes.every((n) => [10, 2, 5].includes(n % 12))).toBe(true);
  });
  it('power chords are root + fifth', () => {
    const e = guitarVoicing(parseNumeral('i', 4, 'minor'), null, { power: true });
    expect(e.notes.every((n) => [4, 11].includes(n % 12))).toBe(true);
  });
});
