#!/usr/bin/env python3
"""Extract human drum grooves and fills from the Groove MIDI Dataset for the arrangement coach.

The Groove MIDI Dataset (Gillick, Roberts, Engel, Eck & Bamman, Google Magenta, CC BY 4.0) has
13.6 hours of professional drummers playing to a click on an electronic kit. For each drum
style the coach uses, this script

- looks at every performance of the matching dataset styles within the genre's tempo range,
- aligns it to the bar (the phase that best matches the style's reference groove),
- picks its most typical two-bar groove that best matches the reference, plus a busier
  variation from the same performance for big sections,
- finds the fills the drummer played inside that performance (bars that break from the
  groove into toms / snare, usually landing on a crash), so fills match the groove's feel,
- keeps the drummer's microtiming (centred on the click) and accents, with velocities scaled
  per drum piece to the app's levels, and maps the kit to General MIDI pieces,

choosing up to three performances spread across the genre's tempo range, and writes
src/music/grooves/gmd.json.

Usage: python3 scripts/grooves/build_grooves.py [--only style,style] [--show style ...]
(needs `pip install mido`; the dataset, 3 MB, is downloaded to .cache/research/gmd)
"""

from __future__ import annotations

import csv
import io
import json
import math
import pickle
import subprocess
import sys
import zipfile
from collections import Counter
from pathlib import Path

import mido

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.cache' / 'research' / 'gmd'
OUT = ROOT / 'src' / 'music' / 'grooves' / 'gmd.json'
URL = 'https://storage.googleapis.com/magentadata/datasets/groove/groove-v1.0.0-midionly.zip'

# Roland TD-11 note numbers used by the dataset → miniDaw drum pieces (General MIDI notes).
# The kit has a high and a low tom sample: tom 1 → high tom, tom 3 (floor) → low tom and
# tom 2 → mid tom (played from the high tom, tuned down).
PIECE = {
    36: 'kick', 38: 'snare', 40: 'snare2', 37: 'rim',
    48: 'tomH', 50: 'tomH', 45: 'tomM', 47: 'tomM', 43: 'tomL', 58: 'tomL',
    46: 'hatO', 26: 'hatO', 42: 'hatC', 22: 'hatC', 44: 'hatP',
    49: 'crash', 55: 'crash', 57: 'crash2', 52: 'crash2', 51: 'ride', 59: 'ride', 53: 'bell',
}
TOMS = ('tomH', 'tomM', 'tomL')
CYMBALS = ('hatC', 'hatO', 'ride', 'bell')
SNARES = ('snare', 'snare2', 'rim')

# Level each piece's main hits are scaled to (see piece_scales), matching the app's patterns.
ACCENT = {
    'kick': 100, 'snare': 106, 'snare2': 110, 'rim': 92, 'hatC': 88, 'hatO': 90, 'hatP': 66,
    'ride': 88, 'bell': 90, 'crash': 108, 'crash2': 106, 'tomH': 100, 'tomM': 100, 'tomL': 100,
}

# coach drum style → (dataset styles, genre tempo range, reference groove).
# Reference lanes are one or two bars of 16ths ('cym' = hats / ride, 'snare' includes
# cross-stick); jazz uses a triplet grid (12 steps per bar). Reggae (one drop) and bossa nova
# (cross-stick clave) keep the app's programmed patterns: the dataset has no steady takes of them.
STYLES = {
    'pop': (['pop', 'rock', 'soul'], (92, 128),
            {'kick': 'x.....x.x.......', 'snare': '....x.......x...', 'cym': 'x.x.x.x.x.x.x.x.'}),
    'mandopop': (['pop/soft', 'pop', 'rock', 'soul'], (64, 96),
                 {'kick': 'x.......x.......', 'snare': '....x.......x...', 'cym': 'x.x.x.x.x.x.x.x.'}),
    'ballad': (['pop/soft', 'rock', 'soul'], (58, 80),
               {'kick': 'x.......x.x.....', 'snare': '....x.......x...', 'cym': 'x.x.x.x.x.x.x.x.'}),
    'rock': (['rock'], (105, 160),
             {'kick': 'x.......x.x.....', 'snare': '....x.......x...', 'cym': 'x.x.x.x.x.x.x.x.'}),
    'country': (['country', 'rock', 'rock/folk'], (85, 128),
                {'kick': 'x.......x.......', 'snare': '....x.......x...', 'cym': 'x.x.x.x.x.x.x.x.'}),
    'boombap': (['hiphop'], (82, 98),
                {'kick': 'x......x..x.....', 'snare': '....x.......x...', 'cym': 'x.x.x.x.x.x.x.x.'}),
    'lofi': (['hiphop'], (68, 90),
             {'kick': 'x......x..x.....', 'snare': '....x.......x...', 'cym': 'x.x.x.x.x.x.x.x.'}),
    'rnb': (['soul', 'hiphop', 'neworleans/funk'], (64, 96),
            {'kick': 'x.....x...x.....', 'snare': '....x.......x...', 'cym': 'x.x.x.x.x.x.x.x.'}),
    'funk': (['funk', 'neworleans/funk'], (92, 120),
             {'kick': 'x.x.......x..x..', 'snare': '....x.......x...', 'cym': 'xxxxxxxxxxxxxxxx'}),
    'citypop': (['funk', 'soul', 'pop', 'dance/disco'], (98, 126),
                {'kick': 'x.....x...x.....', 'snare': '....x.......x...', 'cym': 'xxxxxxxxxxxxxxxx'}),
    'disco': (['dance/disco'], (98, 137),
              {'kick': 'x...x...x...x...', 'snare': '....x.......x...', 'cym': 'x.x.x.x.x.x.x.x.'}),
    'jazz': (['jazz/swing', 'jazz', 'jazz/mediumfast'], (100, 220),
             {'cym': 'x..x.xx..x.x', 'hatP': '...x.....x..'}),
}
CYMBAL = {'jazz': 'ride'}  # timekeeping cymbal of the main groove
WEIGHT = {'kick': 0.4, 'snare': 0.35, 'cym': 0.25, 'hatP': 0.4}
MIN_VEL = {'kick': 25, 'snare': 50, 'cym': 20, 'hatP': 20}
EDGE = 0.12  # a hit this early still belongs to the next beat / bar


def load_dataset() -> zipfile.ZipFile:
    CACHE.mkdir(parents=True, exist_ok=True)
    z = CACHE / 'gmd.zip'
    if not z.exists():
        subprocess.run(['curl', '-sSfL', '-m', '300', '-o', str(z), URL], check=True)
    return zipfile.ZipFile(z)


def notes_of(zf: zipfile.ZipFile, name: str) -> list[tuple[float, str, int]]:
    mid = mido.MidiFile(file=io.BytesIO(zf.read(f'groove/{name}')))
    t, out = 0, []
    for msg in mido.merge_tracks(mid.tracks):
        t += msg.time
        if msg.type == 'note_on' and msg.velocity > 0 and msg.note in PIECE:
            out.append((t / mid.ticks_per_beat, PIECE[msg.note], msg.velocity))
    return out


def lane_class(piece: str) -> str | None:
    if piece == 'kick':
        return 'kick'
    if piece in SNARES:
        return 'snare'
    if piece in CYMBALS:
        return 'cym'
    if piece == 'hatP':
        return 'hatP'
    return None


class Reference:
    """The style's reference groove as onset sets over two bars."""

    def __init__(self, lanes: dict[str, str]):
        self.res = 3 if any(len(p) % 12 == 0 and len(p) % 16 for p in lanes.values()) else 4
        per_bar = self.res * 4
        self.sets = {}
        for cls, pat in lanes.items():
            two = (pat * 2)[: 2 * per_bar] if len(pat) <= per_bar else pat[: 2 * per_bar]
            self.sets[cls] = {i for i, ch in enumerate(two) if ch != '.'}
        self.two_bar = any(len(p) > per_bar for p in lanes.values())

    def onsets(self, win) -> dict[str, set[int]]:
        out = {cls: set() for cls in self.sets}
        for t, p, v in win:
            cls = lane_class(p)
            if cls in out and v >= MIN_VEL[cls]:
                s = round(t * self.res)
                if 0 <= s < 8 * self.res:
                    out[cls].add(s)
        return out

    def match(self, win) -> float:
        got = self.onsets(win)
        total = sum(WEIGHT[c] for c in self.sets)
        score = 0.0
        for cls, ref in self.sets.items():
            union = ref | got[cls]
            score += WEIGHT[cls] * (len(ref & got[cls]) / len(union) if union else 1)
        return score / total


def window(notes, start: float, beats: float) -> list:
    return [[round(t - start, 3), p, v] for t, p, v in notes if start - EDGE <= t < start + beats - EDGE]


def grid(win, res: int = 4) -> Counter:
    return Counter((p, round(t * res)) for t, p, v in win)


def similarity(a: Counter, b: Counter) -> float:
    keys = set(a) | set(b)
    return sum(min(a[k], b[k]) for k in keys) / max(1, sum(max(a[k], b[k]) for k in keys))


def penalty(win, cymbal: str) -> float:
    """Toms and crashes don't belong in a repeating groove; the style's usual timekeeping cymbal does."""
    toms = sum(1 for t, p, v in win if p in TOMS)
    crash = sum(1 for t, p, v in win if p in ('crash', 'crash2'))
    cym = [p for t, p, v in win if p in CYMBALS]
    wanted = sum(1 for p in cym if (p in ('hatC', 'hatO')) == (cymbal == 'hats')) / max(1, len(cym))
    return 0.15 * toms + 2 * crash + (0.8 if cymbal != 'any' and wanted < 0.5 else 0)


def best_phase(notes, ref: Reference, bars: int) -> float:
    """Beat offset that lines the performance up with the reference groove and puts the
    crashes (which mark new phrases) on the downbeat — a backbeat looks the same either way."""
    shifts = range(8 if ref.two_bar else 4)
    crashes = [t for t, p, v in notes if p in ('crash', 'crash2') and v >= 50]
    best, best_score = 0.0, -1.0
    for k in shifts:
        scores = sorted((ref.match(window(notes, k + 4.0 * b, 8)) for b in range(0, max(1, bars - 2))), reverse=True)
        top = scores[: max(1, len(scores) // 4)]
        s = sum(top) / len(top)
        if len(crashes) >= 2:
            span = 8 if ref.two_bar else 4
            s += 0.5 * sum(1 for t in crashes if abs(((t - k + 0.15) % span) - 0.15) < 0.15) / len(crashes)
        if s > best_score:
            best, best_score = float(k), s
    return best


def centre(notes) -> list:
    """Remove the drummer's overall push / drag against the click (median of hits near beats)."""
    devs = sorted(t - round(t) for t, p, v in notes if p in ('kick', 'snare', 'snare2') and abs(t - round(t)) < 0.1)
    if len(devs) < 8:
        return notes
    off = devs[len(devs) // 2]
    return [(t - off, p, v) for t, p, v in notes]


def consistent_snare(notes) -> list:
    """An electronic kit's snare zones fire rimshots and cross-sticks now and then where the drummer
    meant a plain hit; keep each the way the performance mostly plays it."""
    accents = [p for t, p, v in notes if p in ('snare', 'snare2') and v >= 60]
    rimshots = len(accents) and accents.count('snare2') / len(accents) >= 0.6
    hits = sum(1 for t, p, v in notes if p in SNARES)
    sticks = sum(1 for t, p, v in notes if p == 'rim') / max(1, hits) >= 0.15
    out = []
    for t, p, v in notes:
        if p in ('snare', 'snare2'):
            p = 'snare2' if rimshots and v >= 60 else 'snare'
        elif p == 'rim' and not sticks:
            p = 'snare'
        out.append((t, p, v))
    return out


def piece_scales(notes, least: int = 4, limits: tuple[float, float] = (0.6, 1.8)) -> dict[str, float]:
    """Velocity scale per piece, from the hits that carry the groove: kicks and timekeeping
    cymbals on the beat, snares on the backbeat (so ghost notes and odd accents don't count)."""
    out = {}
    for piece in {p for _, p, _ in notes}:
        hits = [(t, v) for t, p, v in notes if p == piece]
        if piece in ('snare', 'snare2'):
            ref = [v for t, v in hits if abs(t - round(t)) < 0.08 and round(t) % 2 == 1]
        elif piece in ('kick', 'hatC', 'ride', 'bell'):
            ref = [v for t, v in hits if abs(t - round(t)) < 0.08]
        else:
            ref = [v for t, v in hits]
        if len(ref) < least:
            ref = [v for t, v in hits]
        ref.sort()
        out[piece] = min(limits[1], max(limits[0], ACCENT[piece] / max(1, ref[len(ref) // 2])))
    return out


def normalise(notes, scale: dict[str, float]) -> list:
    return [(t, p, max(1, min(127, round(v * scale.get(p, 1))))) for t, p, v in notes]


def beat_grid(win, beat: int) -> Counter:
    return Counter((p, round((t - beat) * 4)) for t, p, v in win if beat - EDGE <= t < beat + 1 - EDGE)


def fill_in(bar_win, groove_bars) -> dict | None:
    """A bar that breaks from the groove into a fill: the beat where it departs and how busy it is."""
    sims = [max(similarity(beat_grid(bar_win, b), beat_grid(g, b)) for g in groove_bars) for b in range(4)]
    start = 4
    for b in range(3, -1, -1):  # the fill is the run of beats at the end of the bar that leave the groove
        if sims[b] >= 0.4:
            break
        start = b
    if start > 3:
        return None
    part = [n for n in bar_win if n[0] >= start - EDGE]
    toms = sum(1 for t, p, v in part if p in TOMS)
    active = toms + sum(1 for t, p, v in part if p in ('snare', 'snare2') and v >= 40)
    if active < max(3, 2 * (4 - start)):
        return None
    return {'from': start, 'busy': active + toms}


def timekeeper(win) -> str:
    c = Counter(p for t, p, v in win if p in ('hatC', 'ride'))
    return 'ride' if c['ride'] > c['hatC'] else 'hatC'


def keep_cymbal(win, cymbal: str) -> list:
    """Fills keep the groove's timekeeping cymbal (some drummers switch to the ride before a fill)
    and drop a crash on their own first beat (the take's starting hit, not part of the fill)."""
    other = 'ride' if cymbal == 'hatC' else 'hatC'
    return [[t, cymbal if p == other else p, v] for t, p, v in win if not (p in ('crash', 'crash2') and t < EDGE)]


def landing_fills(notes, groove_bars) -> list[dict]:
    """Fills from the drummer's separate fill takes: the bar before the landing hit."""
    out = []
    hits = [t for t, p, v in notes if (p in ('crash', 'crash2') or (p == 'kick' and v >= 80)) and abs(t - round(t)) < 0.15]
    if not hits:
        return out
    land = round(max(hits))
    if land < 4:
        return out
    win = keep_cymbal(window(notes, land - 4.0, 4), timekeeper(groove_bars[0] + groove_bars[1]))
    f = fill_in(win, groove_bars)
    if f:
        out.append({'from': f['from'], 'score': f['busy'] + 2, 'notes': win, 'src': 'take'})
    return out


def analyse(notes, ref: Reference, takes: list, cymbal: str) -> dict | None:
    bars = int(max(t for t, _, _ in notes) // 4)
    if bars < 4:
        return None
    sh = best_phase(notes, ref, bars)
    notes = [(t - sh, p, v) for t, p, v in notes if t - sh >= -EDGE]
    notes = consistent_snare(centre(notes))
    scale = piece_scales(notes)
    notes = normalise(notes, scale)
    bars = int(max(t for t, _, _ in notes) // 4)
    starts = [4.0 * b for b in range(0, bars - 1, 1)]
    wins = [window(notes, st, 8) for st in starts]
    grids = [grid(w) for w in wins]
    consistency = [sum(similarity(g, h) for h in grids) / len(grids) for g in grids]
    fits = [4 * ref.match(w) + 1.5 * c - penalty(w, cymbal) for w, c in zip(wins, consistency)]
    main = max(range(len(starts)), key=lambda i: fits[i])
    dens = [sum(g.values()) for g in grids]
    close = [i for i in range(len(starts))
             if i != main and similarity(grids[i], grids[main]) > 0.5 and fits[i] > fits[main] - 0.8
             and not any(p in ('crash', 'crash2') for t, p, v in wins[i])]
    busy = max(close, key=lambda i: dens[i]) if close else main
    if dens[busy] <= dens[main]:
        busy = main
    groove_bars = [window(wins[main], 0, 4), window(wins[main], 4, 4)]
    fills = []
    keeper = timekeeper(wins[main])
    for b in range(1, bars):
        win = keep_cymbal(window(notes, 4.0 * b, 4), keeper)
        f = fill_in(win, groove_bars)
        if not f:
            continue
        land = any(p in ('crash', 'crash2') and abs(t - 4.0 * (b + 1)) < 0.15 for t, p, v in notes)
        fills.append({'from': f['from'], 'score': f['busy'] + (4 if land else 0), 'notes': win, 'src': f'bar {b}'})
    # the most convincing fills, at least one short (last two beats or less) when there is one
    fills.sort(key=lambda f: -f['score'])
    chosen, seen = [], set()
    for f in fills:
        key = tuple(sorted((p, round(t * 4)) for t, p, v in f['notes'] if round(t * 4) >= f['from'] * 4))
        if key in seen:
            continue
        seen.add(key)
        chosen.append(f)
        if len(chosen) == 4:
            break
    short = [f for f in fills if f['from'] >= 2 and f not in chosen]
    if chosen and not any(f['from'] >= 2 for f in chosen) and short:
        chosen[-1] = short[0]
    # too few inside the performance: the same drummer's separate fill takes at this tempo
    for take in takes:
        if len(chosen) >= 3:
            break
        chosen += landing_fills(normalise(consistent_snare(take), scale), groove_bars)[: 3 - len(chosen)]
    # the excerpted groove itself sits at the app's levels (the drummer may have played it in a
    # quieter part of the take); its busy version and fills move with it
    fix = piece_scales([tuple(n) for n in wins[main]], least=2, limits=(0.75, 1.5))
    level = lambda win: [list(n) for n in normalise([tuple(n) for n in win], fix)]
    return {
        'fit': fits[main],
        'main': level(wins[main]),
        'busy': level(wins[busy]),
        'fills': [{'from': f['from'], 'notes': level(f['notes']), 'src': f['src']} for f in chosen],
    }


def tempo_bands(lo: int, hi: int) -> list[tuple[float, float]]:
    a, b = math.log(lo), math.log(hi)
    edges = [math.exp(a + (b - a) * k / 3) for k in range(4)]
    return [(edges[k], edges[k + 1]) for k in range(3)]


def main() -> None:
    args = sys.argv[1:]
    show = args[args.index('--show') + 1:] if '--show' in args else []
    only = args[args.index('--only') + 1].split(',') if '--only' in args else list(STYLES)
    zf = load_dataset()
    rows = [r for r in csv.DictReader(io.TextIOWrapper(zf.open('groove/info.csv'))) if r['time_signature'] == '4-4']
    cache: dict[str, list] = {}
    pickled = CACHE / 'notes.pkl'
    if pickled.exists():
        cache = pickle.loads(pickled.read_bytes())

    def notes(name: str) -> list:
        if name not in cache:
            cache[name] = notes_of(zf, name)
        return cache[name]

    fill_takes: dict[tuple, list] = {}
    for r in rows:
        if r['beat_type'] == 'fill':
            fill_takes.setdefault((r['session'], r['style'], r['bpm']), []).append(r['midi_filename'])
    out = json.loads(OUT.read_text())['styles'] if OUT.exists() and len(only) < len(STYLES) else {}
    for style, (sources, (lo, hi), lanes) in STYLES.items():
        if style not in only:
            continue
        ref = Reference(lanes)
        beats = [r for r in rows if r['beat_type'] == 'beat'
                 and any(r['style'] == s or r['style'].startswith(s + '/') for s in sources)
                 and lo * 0.8 <= int(r['bpm']) <= hi * 1.2]
        candidates = []
        for r in beats:
            if len(notes(r['midi_filename'])) < 16:
                continue
            takes = [notes(f) for f in fill_takes.get((r['session'], r['style'], r['bpm']), [])]
            a = analyse(notes(r['midi_filename']), ref, [t for t in takes if t], CYMBAL.get(style, 'hats'))
            if a and len(a['main']) >= 8:
                # grooves that come with their own fills are worth more
                candidates.append((a['fit'] + 0.35 * min(3, len(a['fills'])), r, a))
        candidates.sort(key=lambda c: -c[0])
        # one performance per named groove (several drummers recorded the same ones)
        seen, unique = set(), []
        for c in candidates:
            k = (c[1]['style'], c[1]['bpm'])
            if k not in seen:
                seen.add(k)
                unique.append(c)
        best = unique[0][0] if unique else 0
        good = [c for c in unique if c[0] >= best - 1.0]
        # spread across the tempo range: the best in each third, then the best of the rest
        picks = []
        for a, b in tempo_bands(lo, hi):
            band = [c for c in good if a * 0.92 <= int(c[1]['bpm']) <= b * 1.08 and c not in picks]
            if band:
                picks.append(band[0])
        for c in good:
            if len(picks) >= 3:
                break
            if c not in picks:
                picks.append(c)
        picks.sort(key=lambda c: int(c[1]['bpm']))
        out[style] = {'grooves': [{
            'src': r['midi_filename'], 'bpm': int(r['bpm']), 'fit': round(fit, 2),
            'main': a['main'], 'busy': a['busy'], 'fills': a['fills'],
        } for fit, r, a in picks]}
        desc = ', '.join(f"{g['src'].split('/')[-1]} ({g['fit']}, {len(g['fills'])} fills)" for g in out[style]['grooves'])
        print(f'{style}: {desc}', file=sys.stderr)
    data = {
        'source': 'Groove MIDI Dataset v1.0.0 — Jon Gillick, Adam Roberts, Jesse Engel, Douglas Eck, David Bamman (Google Magenta)',
        'license': 'CC-BY-4.0',
        'url': 'https://magenta.tensorflow.org/datasets/groove',
        'changes': 'two-bar grooves and one-bar fills excerpted from performances; timing given in beats and centred on '
                   'the click; velocities scaled per drum piece; rimshot / cross-stick triggers made consistent; kit '
                   'mapped to General MIDI pieces',
        'styles': out,
    }
    pickled.write_bytes(pickle.dumps(cache))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(',', ':')) + '\n')
    print(f'wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)', file=sys.stderr)
    for style in show:
        print_style(style, out[style])


ORDER = ['crash', 'crash2', 'ride', 'bell', 'hatO', 'hatC', 'hatP', 'rim', 'snare', 'snare2', 'tomH', 'tomM', 'tomL', 'kick']


def print_grid(notes, beats: int, res: int = 4) -> None:
    steps = beats * res
    rows: dict[str, list[str]] = {}
    for t, p, v in notes:
        s = round(t * res)
        if 0 <= s < steps:
            rows.setdefault(p, ['.'] * steps)[s] = 'X' if v >= 100 else 'x' if v >= 75 else 'o' if v >= 50 else 'g'
    for p in ORDER:
        if p in rows:
            r = ''.join(rows[p])
            print(f'      {p:6s} ' + '|'.join(r[i:i + res * 4] for i in range(0, steps, res * 4)))


def print_style(style: str, entry: dict) -> None:
    print(f'== {style}')
    for g in entry['grooves']:
        print(f"  {g['src']}  bpm {g['bpm']}  fit {g['fit']}")
        print('    main')
        print_grid(g['main'], 8)
        if g['busy'] != g['main']:
            print('    busy')
            print_grid(g['busy'], 8)
        for f in g['fills']:
            print(f"    fill from beat {f['from']} ({f.get('src')})")
            print_grid(f['notes'], 4)


if __name__ == '__main__':
    main()
