#!/usr/bin/env python3
"""Even out the loudness of the zones of each pitched sample set.

Libraries record every note at the player's natural dynamics, and across a range that can
swing by 20 dB or more (a flute's low octave, a vibraphone's soft layer, a sax note that
happened to be played harder). Played back as recorded, a melody jumps in level from one
note to the next. For every zone this measures the K-weighted loudness of its body (the
loudest third of its 400 ms windows) and stores the gain that puts it on one smooth line
per articulation:

- across the range, the set's own trend, limited to between -2 and +1 dB per octave;
- below the top velocity layer, exactly the step the sampler's velocity curve expects
  (26 dB x the default sensitivity over the full velocity range, see zoneGain in
  src/audio/instruments/multisample.ts), so a phrase crossing into the next layer
  does not jump.

Writes each zone's gain (dB) as "g" into src/audio/samples/sets.json; build_samples.py calls
even_set() for every set it builds.

Usage: python3 scripts/samples/even_zones.py [set ...]      (needs ffmpeg, numpy)
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / 'src' / 'assets' / 'samples'
MANIFEST = ROOT / 'src' / 'audio' / 'samples' / 'sets.json'
SR = 44100

SENSITIVITY = 0.8  # the sampler's default velocity sensitivity
DB_PER_VELOCITY = 26 * SENSITIVITY / 127
SLOPE = (-2.0, 1.0)  # dB per octave
LIMIT = (-24.0, 24.0)  # dB

# BS.1770 K-weighting (pre-filter shelf + RLB high-pass), specified at 48 kHz
SHELF = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585])
RLB = ([1, -2, 1], [1, -1.99004745483398, 0.99007225036621])


def k_weight(freqs: np.ndarray) -> np.ndarray:
    """Power response of the K-weighting filter at the given frequencies."""
    z = np.exp(-2j * np.pi * freqs / 48000)
    out = np.ones_like(freqs)
    for b, a in (SHELF, RLB):
        h = (b[0] + b[1] * z + b[2] * z * z) / (a[0] + a[1] * z + a[2] * z * z)
        out = out * np.abs(h) ** 2
    return out


def decode(path: Path) -> np.ndarray:
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def body_loudness(x: np.ndarray, sr: int = SR) -> float:
    """K-weighted loudness (LUFS-like) of the loudest third of a sample's 400 ms windows."""
    n = int(0.4 * sr)
    if len(x) < n:
        x = np.pad(x, (0, n - len(x)))
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[:: n // 4]
    power = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    w = k_weight(np.fft.rfftfreq(n, 1 / sr))
    w[1:-1] *= 2  # one-sided spectrum
    e = (power * w).sum(axis=1) / (n * n)
    top = np.sort(e)[-max(1, len(e) // 3):]
    return float(-0.691 + 10 * np.log10(top.mean() + 1e-12))


def theil_sen(x: np.ndarray, y: np.ndarray) -> float:
    """Median of the pairwise slopes: a line fit that a few odd notes cannot pull around."""
    slopes = [(y[j] - y[i]) / (x[j] - x[i]) for i in range(len(x)) for j in range(i + 1, len(x)) if x[j] != x[i]]
    return float(np.median(slopes)) if slopes else 0.0


def zone_gains(zones: list[dict], loudness: list[float]) -> list[float]:
    """Gain (dB) per zone that puts the set on one smooth line (see the module docstring)."""
    loud = np.array(loudness)
    vh = np.array([z['vh'] for z in zones], float)
    keys = np.array([z.get('k', 60) for z in zones], float)
    arts = [z.get('a', '') for z in zones]
    # what each zone would measure as the top velocity layer
    top = loud + (127 - vh) * DB_PER_VELOCITY
    lines: dict[str, tuple[float, float, float]] = {}
    for art in sorted(set(arts)):
        idx = np.array([a == art for a in arts])
        k0 = float(np.median(keys[idx]))
        slope = float(np.clip(theil_sen(keys[idx] / 12, top[idx]), *SLOPE))
        level = float(np.median(top[idx] - slope * (keys[idx] - k0) / 12))
        lines[art] = (level, slope, k0)
    # all articulations at the level of the one with the most zones
    main = max(lines, key=lambda a: arts.count(a))
    gains = []
    for z, l in zip(zones, loud):
        _, slope, k0 = lines[z.get('a', '')]
        target = lines[main][0] + slope * (z.get('k', 60) - k0) / 12 - (127 - z['vh']) * DB_PER_VELOCITY
        gains.append(round(float(np.clip(target - l, *LIMIT)), 1))
    return gains


def even_set(info: dict, signals: list[np.ndarray] | None = None) -> dict:
    """Store each zone's evening gain in a set's manifest entry (kits are left alone)."""
    if info.get('kind') != 'pitched':
        return info
    zones = info['zones']
    if signals is None:
        signals = [decode(SAMPLES / z['f']) for z in zones]
    gains = zone_gains(zones, [body_loudness(x) for x in signals])
    for z, g in zip(zones, gains):
        if abs(g) >= 0.1:
            z['g'] = g
        else:
            z.pop('g', None)
    return info


def main(argv: list[str]) -> None:
    manifest = json.loads(MANIFEST.read_text())
    for id in argv or list(manifest['sets']):
        info = even_set(manifest['sets'][id])
        g = [z.get('g', 0.0) for z in info['zones']]
        if info.get('kind') == 'pitched':
            print(f'{id}: gains {min(g):+.1f} … {max(g):+.1f} dB, mean |g| {np.mean(np.abs(g)):.1f} dB', flush=True)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main(sys.argv[1:])
