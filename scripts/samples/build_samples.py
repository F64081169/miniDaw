#!/usr/bin/env python3
"""Build miniDaw's sampled instruments from open-licensed sample libraries.

Fetches only the files it needs from each library's Git repository (partial clone),
then for every zone: mixes microphones where a library has several, trims the silence
before the attack, shortens long decays with a fade, normalises the whole set together
and encodes compact MP3s. Each zone also gets the gain that evens its loudness out
against the rest of the set (see even_zones.py).

Writes:
  src/assets/samples/<set>/*.mp3   the audio the app loads
  src/audio/samples/sets.json      zones (key / velocity / round-robin) + credits per set

Usage: python3 scripts/samples/build_samples.py [set ...]      (needs git, ffmpeg, numpy)
Sources and licenses are listed in THIRD_PARTY_NOTICES.md.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

from even_zones import even_set

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.cache' / 'sample-src'
OUT = ROOT / 'src' / 'assets' / 'samples'
MANIFEST = ROOT / 'src' / 'audio' / 'samples' / 'sets.json'
SR = 44100

# ----------------------------------------------------------------------------- helpers

PC = {'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11}


def midi(name: str) -> int:
    """'C4' = 60; accepts 'D#4', 'Ds4', 'db2', 'Bb2', 'A#0'."""
    m = re.fullmatch(r'([A-Ga-g])([#sb]?)(-?\d)', name)
    if not m:
        raise ValueError(name)
    pc = PC[m.group(1).lower()] + {'#': 1, 's': 1, 'b': -1, '': 0}[m.group(2)]
    return 12 * (int(m.group(3)) + 1) + pc


class Repo:
    """Partial clone: file list without blobs; blobs fetched on demand and cached."""

    def __init__(self, slug: str):
        slug, _, branch = slug.partition('@')
        self.slug = slug
        self.dir = CACHE / (slug.replace('/', '__') + (f'@{branch}' if branch else ''))
        if not self.dir.exists():
            CACHE.mkdir(parents=True, exist_ok=True)
            cmd = ['git', 'clone', '-q', '--filter=blob:none', '--no-checkout', '--depth', '1']
            subprocess.run(cmd + (['-b', branch] if branch else []) + [f'https://github.com/{slug}.git', str(self.dir)],
                           check=True)
        self._files: list[str] | None = None

    @property
    def url(self) -> str:
        return f'https://github.com/{self.slug}'

    def files(self) -> list[str]:
        if self._files is None:
            out = subprocess.run(['git', '-C', str(self.dir), 'ls-tree', '-r', '--name-only', 'HEAD'],
                                 check=True, capture_output=True, text=True).stdout
            self._files = out.splitlines()
        return self._files

    def find(self, pattern: str) -> list[str]:
        rx = re.compile(pattern)
        return [f for f in self.files() if rx.search(f)]

    def path(self, name: str) -> Path:
        local = self.dir / 'blobs' / name
        if not local.exists():
            local.parent.mkdir(parents=True, exist_ok=True)
            data = subprocess.run(['git', '-C', str(self.dir), 'cat-file', '-p', f'HEAD:{name}'],
                                  check=True, capture_output=True).stdout
            local.write_bytes(data)
        return local

    def text(self, name: str) -> str:
        return self.path(name).read_text(errors='replace')


class RawFiles:
    """Single files over raw.githubusercontent.com (for repositories too big to clone)."""

    def __init__(self, slug: str, branch: str):
        self.slug = slug
        self.branch = branch
        self.dir = CACHE / (slug.replace('/', '__') + '__raw')

    @property
    def url(self) -> str:
        return f'https://github.com/{self.slug}'

    def path(self, name: str) -> Path:
        local = self.dir / name
        if not local.exists():
            local.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(['curl', '-sSfL', '-m', '60', '-o', str(local),
                            f'https://raw.githubusercontent.com/{self.slug}/{self.branch}/{name}'], check=True)
        return local


_repos: dict[str, Repo] = {}


def repo(slug: str) -> Repo:
    if slug not in _repos:
        _repos[slug] = Repo(slug)
    return _repos[slug]


def decode(path: Path, channels: int) -> np.ndarray:
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-ac', str(channels),
                          '-ar', str(SR), '-'], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).T.copy()


def encode(x: np.ndarray, path: Path, quality: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.ascontiguousarray(x.T.astype(np.float32)).tobytes()
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', str(x.shape[0]),
                    '-i', '-', '-c:a', 'libmp3lame', '-q:a', str(quality), str(path)],
                   input=data, check=True)


def db(v: float) -> float:
    return 10 ** (v / 20)


def shape(x: np.ndarray, max_s: float, fade_s: float, head_db: float = -48, tail_db: float = -66) -> np.ndarray:
    """Cut the silence before the attack (keep 2 ms), end at the decay floor or max_s with a fade."""
    env = np.max(np.abs(x), axis=0)
    peak = float(env.max()) or 1.0
    start = int(np.argmax(env > peak * db(head_db)))
    start = max(0, start - int(0.002 * SR))
    above = np.nonzero(env > peak * db(tail_db))[0]
    end = int(above[-1]) + 1 if len(above) else env.size
    end = min(end, start + int(max_s * SR))
    y = x[:, start:end].copy()
    n = min(int(fade_s * SR), y.shape[1] // 2)
    if n > 0:
        y[:, -n:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, n)))[None, :]
    return y


def mix(parts: list[tuple[np.ndarray, float]]) -> np.ndarray:
    """Sum (signal, gain dB) parts, aligned at their start; mono parts are centred."""
    ch = max(p.shape[0] for p, _ in parts)
    n = max(p.shape[1] for p, _ in parts)
    out = np.zeros((ch, n), dtype=np.float32)
    for p, g in parts:
        q = p if p.shape[0] == ch else np.repeat(p, ch, axis=0) * (db(-3) if ch == 2 else 1)
        out[:, : q.shape[1]] += q * db(g)
    return out


def vel_ranges(n: int) -> list[tuple[int, int]]:
    """Split 1…127 into n velocity layers (louder layers get a little less range)."""
    edges = {1: [127], 2: [80, 127], 3: [58, 92, 127], 4: [45, 72, 100, 127], 5: [36, 60, 84, 106, 127]}[n]
    lo = 1
    out = []
    for hi in edges:
        out.append((lo, hi))
        lo = hi + 1
    return out


def key_ranges(roots: list[int], lo_limit: int, hi_limit: int) -> dict[int, tuple[int, int]]:
    rs = sorted(set(roots))
    out = {}
    for i, r in enumerate(rs):
        lo = lo_limit if i == 0 else (rs[i - 1] + r) // 2 + 1
        hi = hi_limit if i == len(rs) - 1 else (r + rs[i + 1]) // 2
        out[r] = (lo, hi)
    return out



# ----------------------------------------------------------------------------- SFZ + pitch helpers

HEADER = re.compile(r'<(control|global|master|group|region)>')
OPCODE = re.compile(r'([A-Za-z0-9_]+)=')


def note_value(v: str) -> int:
    v = v.strip()
    return int(v) if re.fullmatch(r'-?\d+', v) else midi(v[0].upper() + v[1:])


def parse_sfz(r: Repo, path: str) -> list[dict]:
    """Regions of an SFZ file with inherited opcodes (enough for simple mappings)."""
    base = str(Path(path).parent)
    text = r.text(path)
    text = re.sub(r'//[^\n]*', '', text)
    text = re.sub(r'#include\s+"([^"]+)"', lambda m: r.text(str(Path(base) / m.group(1))), text)
    for name, value in re.findall(r'#define\s+(\$\w+)\s+(\S+)', text):
        text = text.replace(name, value)
    text = re.sub(r'#define[^\n]*', '', text)
    regions: list[dict] = []
    scope = {'control': {}, 'global': {}, 'master': {}, 'group': {}, 'region': None}
    current = None
    pos = 0
    tokens = []
    for m in HEADER.finditer(text):
        tokens.append((m.start(), m.end(), m.group(1)))
    chunks = []
    for i, (st, en, h) in enumerate(tokens):
        body = text[en: tokens[i + 1][0] if i + 1 < len(tokens) else len(text)]
        chunks.append((h, body))
    def opcodes(body: str) -> dict:
        out = {}
        ms = list(OPCODE.finditer(body))
        for i, m in enumerate(ms):
            end = ms[i + 1].start() if i + 1 < len(ms) else len(body)
            val = body[m.end():end]
            key = m.group(1)
            val = val.split('\n')[0].strip() if key != 'sample' else val.strip().split('\n')[0].strip()
            out[key] = val
        return out
    for h, body in chunks:
        ops = opcodes(body)
        if h == 'region':
            reg = {**scope['control'], **scope['global'], **scope['master'], **scope['group'], **ops}
            regions.append(reg)
        else:
            scope[h] = ops
            if h == 'global':
                scope['master'] = {}
                scope['group'] = {}
            if h == 'master':
                scope['group'] = {}
    out = []
    for reg in regions:
        if 'sample' not in reg:
            continue
        sample = reg['sample'].replace('\\', '/')
        full = str(Path(base) / reg.get('default_path', '').replace('\\', '/') / sample)
        full = re.sub(r'(^|/)\./', r'\1', full)
        parts = []
        for seg in full.split('/'):
            if seg == '..':
                parts.pop()
            elif seg:
                parts.append(seg)
        reg['file'] = '/'.join(parts)
        if 'key' in reg:
            k = note_value(reg['key'])
            reg.setdefault('lokey', str(k))
            reg.setdefault('hikey', str(k))
            reg.setdefault('pitch_keycenter', str(k))
        out.append(reg)
    return out


def detect_pitch(x: np.ndarray) -> float:
    """Fundamental (Hz) of a pitched sample: harmonic product spectrum of the sustained part."""
    y = x.mean(axis=0)
    env = np.abs(y)
    start = int(np.argmax(env > env.max() * 0.1)) + int(0.05 * SR)
    seg = y[start: start + 32768]
    if seg.size < 8192:
        return 0.0
    seg = seg * np.hanning(seg.size)
    n = 4 * seg.size
    sp = np.abs(np.fft.rfft(seg, n))
    freqs = np.fft.rfftfreq(n, 1 / SR)
    h = sp.copy()
    for k in (2, 3, 4):
        d = sp[::k]
        h[: d.size] *= d
    h[(freqs < 25) | (freqs > 4500)] = 0
    return float(freqs[int(np.argmax(h))])


def check_pitch(id: str, zones: list['Zone']) -> None:
    """Warn when a zone's root disagrees with the measured pitch (catches octave naming errors)."""
    probe = [z for z in zones if z.root is not None][:: max(1, len(zones) // 4)][:4]
    for z in probe:
        r, path, _ = z.parts[0]
        f0 = detect_pitch(decode(r.path(path), 1))
        if f0 <= 0:
            continue
        measured = 69 + 12 * np.log2(f0 / 440)
        diff = measured - z.root
        flag = '' if abs(diff) < 0.6 else '   <-- CHECK'
        print(f'  pitch {id}: root {z.root} measured {measured:.1f} ({path.split("/")[-1]}){flag}')


def sfz_zones(r: Repo, sfz: str, keep=lambda reg: True, layer_of=None, art=None) -> list['Zone']:
    """Zones from an SFZ mapping: one per region kept; velocity layers numbered by lovel."""
    regs = [g for g in parse_sfz(r, sfz) if keep(g)]
    vels = sorted({int(g.get('lovel', 1)) for g in regs})
    zones = []
    for g in regs:
        lo = int(g.get('lovel', 1))
        layer = layer_of(g) if layer_of else vels.index(lo)
        layers = len(vels)
        root = note_value(g.get('pitch_keycenter', g.get('lokey', '60')))
        z = Zone([(r, g['file'], float(g.get('volume', 0)))], root=root, layer=layer, layers=layers,
                 art=art, vel=(lo, int(g.get('hivel', 127))))
        if g['file'].lower().endswith('.wav') and (lp := wav_loop(r.path(g['file']))):
            z.loop = (round(lp[0] * SR / lp[2]), round(lp[1] * SR / lp[2]))
            z.hold = float(g.get('ampeg_hold', 0))
            z.decay = float(g.get('ampeg_decay', 0))
        zones.append(z)
    return zones

def wav_loop(path: Path) -> tuple[int, int, int] | None:
    """(start, end, sample rate) of the first loop in a WAV 'smpl' chunk."""
    import struct
    data = path.read_bytes()
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        return None
    i, sr, loop = 12, 0, None
    while i + 8 <= len(data):
        cid, size = data[i:i + 4], struct.unpack('<I', data[i + 4:i + 8])[0]
        body = data[i + 8:i + 8 + size]
        if cid == b'fmt ':
            sr = struct.unpack('<I', body[4:8])[0]
        elif cid == b'smpl' and len(body) >= 36 + 24 and struct.unpack('<I', body[28:32])[0] > 0:
            start, end = struct.unpack('<II', body[36 + 8:36 + 16])
            loop = (start, end)
        i += 8 + size + (size & 1)
    return (loop[0], loop[1], sr) if loop and sr else None


def unroll(x: np.ndarray, start: int, end: int, length: int, hold: float, decay: float) -> np.ndarray:
    """Extend a looped sample to `length` frames and fade it like the SFZ envelope would."""
    if end <= start + 16 or x.shape[1] >= length:
        return x
    head = x[:, :end + 1]
    loop = x[:, start:end + 1]
    reps = int(np.ceil((length - head.shape[1]) / loop.shape[1]))
    y = np.concatenate([head] + [loop] * reps, axis=1)[:, :length]
    if decay > 0:
        t = np.arange(y.shape[1]) / SR
        db_per_s = 60.0 / decay
        env = np.where(t < hold, 1.0, 10 ** (-(t - hold) * db_per_s / 20))
        y = y * env[None, :]
    return y


# ----------------------------------------------------------------------------- set builders

class Zone:
    def __init__(self, parts, root=None, layer=0, layers=1, rr=0, piece=None, art=None, vel=None):
        self.parts = parts  # [(Repo, path, gain_db)]
        self.loop = None  # (start, end) frames of a sustain loop in the source file
        self.hold = 0.0  # seconds before the SFZ envelope starts decaying
        self.decay = 0.0  # SFZ decay time (s)
        self.root = root
        self.layer = layer
        self.layers = layers
        self.rr = rr
        self.piece = piece
        self.art = art
        self.vel = vel  # explicit (lo, hi)


SETS: dict[str, dict] = {}


def define(id: str, **info):
    def wrap(fn):
        SETS[id] = {'build': fn, **info}
        return fn
    return wrap


def build_set(id: str) -> dict:
    spec = SETS[id]
    zones: list[Zone] = spec['build']()
    channels = spec.get('channels', 1)
    if spec.get('kind', 'pitched') == 'pitched':
        check_pitch(id, zones)
    rendered = []
    for z in zones:
        parts = [(decode(r.path(p), channels), g) for r, p, g in z.parts]
        x = mix(parts) if len(parts) > 1 else parts[0][0]
        max_s = spec['max_s'](z) if callable(spec['max_s']) else spec['max_s']
        if z.loop:
            x = unroll(x, z.loop[0], z.loop[1], int(max_s * SR) + int(0.05 * SR), z.hold, z.decay)
        rendered.append(shape(x, max_s, spec.get('fade_s', 0.3), tail_db=spec.get('tail_db', -66)))
    peak = max(float(np.max(np.abs(y))) for y in rendered)
    gain = db(-1) / peak
    out_dir = OUT / id
    if out_dir.exists():
        for old in out_dir.glob('*.mp3'):
            old.unlink()
    entries = []
    total = 0
    kind = spec.get('kind', 'pitched')
    lo_lim, hi_lim = spec.get('range', (0, 127))
    roots_by_group: dict[tuple, list[int]] = {}
    for z in zones:
        roots_by_group.setdefault((z.art, z.layer), []).append(z.root)
    for z, y in zip(zones, rendered):
        if kind == 'kit':
            name = f'{z.piece}_v{z.layer + 1}_r{z.rr + 1}'
        else:
            name = f'{z.art + "_" if z.art else ""}{z.root}_v{z.layer + 1}_r{z.rr + 1}'
        path = out_dir / f'{name}.mp3'
        encode(y * gain, path, spec.get('quality', 6))
        total += path.stat().st_size
        vl, vh = z.vel or vel_ranges(z.layers)[z.layer]
        e = {'f': f'{id}/{name}.mp3', 'vl': vl, 'vh': vh, 'rr': z.rr}
        if kind == 'kit':
            e['p'] = z.piece
        else:
            lo, hi = key_ranges(roots_by_group[(z.art, z.layer)], lo_lim, hi_lim)[z.root]
            e.update({'k': z.root, 'lo': lo, 'hi': hi})
            if z.art:
                e['a'] = z.art
        entries.append(e)
    info = {k: spec[k] for k in ('name', 'author', 'license', 'source', 'notes') if k in spec}
    info.update({'kind': kind, 'zones': entries, 'bytes': total})
    even_set(info, [(y * gain).mean(axis=0) for y in rendered])
    print(f'{id}: {len(entries)} zones, {total / 1e6:.2f} MB', flush=True)
    return info


# ----------------------------------------------------------------------------- sources

def by_layers(files: dict[tuple[int, int], str], r: Repo, layers: int, rr: int = 0) -> list[Zone]:
    return [Zone([(r, path, 0)], root=root, layer=layer, layers=layers, rr=rr) for (root, layer), path in sorted(files.items())]


@define('salamander', name='Salamander Grand Piano V3', author='Alexander Holm', license='CC-BY-3.0',
        source='https://github.com/sfzinstruments/SalamanderGrandPiano', channels=2, quality=5,
        range=(21, 108), fade_s=0.6,
        max_s=lambda z: 9.0 if z.root < 48 else 7.0 if z.root < 72 else 5.0 if z.root < 90 else 3.5,
        notes='Yamaha C5, velocity layers 4 / 9 / 14 of 16')
def salamander():
    r = repo('sfzinstruments/SalamanderGrandPiano')
    names = sorted({m.group(1) for f in r.files() if (m := re.fullmatch(r'Samples/([A-G]#?\d)v\d+\.flac', f))},
                   key=midi)
    files = {}
    for n in names:
        for layer, v in enumerate((4, 9, 14)):
            files[(midi(n), layer)] = f'Samples/{n}v{v}.flac'
    return by_layers(files, r, 3)


def kit_zones(r: Repo, piece: str, pattern: str, mics: list[tuple[str, float]], layers: list[int], rrs: list[int],
              vel_of=None) -> list[Zone]:
    """Multi-mic drum hits: `pattern` has {mic}, {v} and {rr} placeholders."""
    out = []
    files = set(r.files())
    for li, v in enumerate(layers):
        for ri, rr in enumerate(rrs):
            parts = [(r, pattern.format(mic=m, v=v, rr=rr), g) for m, g in mics]
            if not all(p in files for _, p, _ in parts):
                # some articulations have no round robins in their names
                parts = [(r, pattern.replace('_rr{rr}', '').format(mic=m, v=v), g) for m, g in mics]
            if all(p in files for _, p, _ in parts):
                out.append(Zone(parts, piece=piece, layer=li, layers=len(layers), rr=ri,
                                vel=vel_of(li) if vel_of else None))
    if not out:
        raise RuntimeError(f'no samples for {piece}: {pattern}')
    return out


VIRT = 'sfzinstruments/virtuosity_drums'
CLOSE_KIT = [('kickmic', 0.0), ('snaremic', 0.0), ('oh', 0.0)]


@define('virtuosity', name='Virtuosity Drums', author='Versilian Studios & Karoryfer Samples', license='CC0-1.0',
        source='https://github.com/sfzinstruments/virtuosity_drums', channels=2, quality=5, kind='kit', fade_s=0.15,
        max_s=lambda z: {'crash': 4.0, 'crash2': 4.0, 'ride': 3.0, 'bell': 3.0, 'hatO': 1.6}.get(z.piece, 1.2),
        notes='kick, snare and overhead microphones mixed to stereo')
def virtuosity():
    r = repo(VIRT)
    z = []
    s = 'Samples/{mic}/'
    z += kit_zones(r, 'kick', s + 'kick/{mic}_kick_snoff_vl{v}_rr{rr}.flac', CLOSE_KIT, [1, 2, 3, 4], [1, 2])
    z += kit_zones(r, 'snare', s + 'snare/{mic}_snare_center_vl{v}.flac', CLOSE_KIT, [6, 14, 22, 30, 36], [1])
    z += kit_zones(r, 'snare2', s + 'snare/{mic}_snare_rimshot_vl{v}.flac', CLOSE_KIT, [5, 9, 12], [1])
    z += kit_zones(r, 'rim', s + 'snare/{mic}_snare_crossstick_vl{v}.flac', CLOSE_KIT, [4, 9, 14], [1])
    z += kit_zones(r, 'hatC', s + 'hh/{mic}_hh_closed_vl{v}_rr{rr}.flac', CLOSE_KIT, [1, 2, 3, 4], [1, 2])
    z += kit_zones(r, 'hatP', s + 'hh/{mic}_hh_pedal_vl{v}_rr{rr}.flac', CLOSE_KIT, [2, 3], [1])
    z += kit_zones(r, 'hatO', s + 'hh/{mic}_hh_open_vl{v}_rr{rr}.flac', CLOSE_KIT, [2, 3, 4], [1])
    z += kit_zones(r, 'tomH', s + 'htom/{mic}_htom_center_vl{v}.flac', CLOSE_KIT, [6, 11, 16], [1])
    z += kit_zones(r, 'tomL', s + 'ltom/{mic}_ltom_center_vl{v}.flac', CLOSE_KIT, [6, 11, 16], [1])
    z += kit_zones(r, 'crash', s + 'crash/{mic}_crash_crash_vl{v}_rr{rr}.flac', CLOSE_KIT, [1, 2, 3], [1])
    z += kit_zones(r, 'ride', s + 'ride/{mic}_ride_ride_vl{v}_rr{rr}.flac', CLOSE_KIT, [1, 2, 3], [1])
    z += kit_zones(r, 'bell', s + 'ride/{mic}_ride_bell_vl{v}_rr{rr}.flac', CLOSE_KIT, [2, 3], [1])
    return z


# ----------------------------------------------------------------------------- keys

def layered(zones: list[Zone], keep_layers: list[int]) -> list[Zone]:
    """Keep some velocity layers (by index) and renumber them evenly over 1…127."""
    out = []
    for z in zones:
        if z.layer in keep_layers:
            z.layer = keep_layers.index(z.layer)
            z.layers = len(keep_layers)
            z.vel = None
            out.append(z)
    return out


def first_rr(reg: dict) -> bool:
    return float(reg.get('lorand', 0)) == 0 and int(reg.get('seq_position', 1)) == 1


DISCORD = 'sfzinstruments/Discord-SFZ-GM-Bank'


@define('rhodes', name='jRhodes3c (GM version)', author='Jeff Learman', license='CC0-1.0',
        source='https://github.com/sfzinstruments/Discord-SFZ-GM-Bank', channels=1, quality=6, range=(21, 108),
        fade_s=0.5, max_s=lambda z: 6.5 if z.root < 55 else 5.0 if z.root < 79 else 3.0,
        notes='1977 Rhodes Mark I Stage 73')
def rhodes():
    return sfz_zones(repo(DISCORD), 'Discord GM/Melodic/005-Electric Piano 1.sfz')


@define('wurli', name='Wurlitzer EP200', author='Greg Sullivan', license='CC-BY-3.0',
        source='https://github.com/sfzinstruments/GregSullivan.E-Pianos', channels=1, quality=6, range=(28, 103),
        fade_s=0.4, max_s=lambda z: 5.0 if z.root < 60 else 3.5, notes='layers mp / f / ff')
def wurli():
    r = repo('sfzinstruments/GregSullivan.E-Pianos')
    zones = sfz_zones(r, 'Wurlitzer EP200/Wurlitzer EP200.sfz')
    return layered(zones, sorted({z.layer for z in zones})[1:])


@define('fmpiano', name='Yamaha TX81Z FM Piano', author='Versilian Studios (VCSL)', license='CC0-1.0',
        source='https://github.com/sgossner/VCSL', channels=1, quality=6, range=(24, 108), fade_s=0.4,
        max_s=lambda z: 4.5 if z.root < 72 else 3.0)
def fmpiano():
    r = repo('sgossner/VCSL')
    zones = []
    for f in r.find(r'TX81Z/FM Piano/FMPiano_[A-G]#?\d_vl\d\.wav$'):
        m = re.search(r'FMPiano_([A-G]#?\d)_vl(\d)', f)
        zones.append(Zone([(r, f, 0)], root=midi(m.group(1)), layer=int(m.group(2)) - 1, layers=3))
    return zones


@define('upright', name='VSCO 2 CE Upright Piano', author='Versilian Studios', license='CC0-1.0',
        source='https://github.com/sgossner/VSCO-2-CE', channels=2, quality=6, range=(21, 108), fade_s=0.5,
        max_s=lambda z: 6.0 if z.root < 60 else 4.5 if z.root < 84 else 3.0, notes='soft and medium layers')
def upright():
    zones = sfz_zones(repo('sgossner/VSCO-2-CE@SFZ'), 'UprightPiano.sfz', keep=first_rr)
    return layered(zones, [0, 1])


@define('steel', name='Martin HD28 acoustic guitar (GM version)', author='Jeff Learman', license='CC0-1.0',
        source='https://github.com/sfzinstruments/Discord-SFZ-GM-Bank', channels=2, quality=6, range=(36, 96),
        fade_s=0.5, max_s=lambda z: 5.0 if z.root < 60 else 3.5)
def steel():
    return sfz_zones(repo(DISCORD), 'Discord GM/Melodic/026-Acoustic Guitar (steel).sfz')


@define('nylon', name='FluidR3 GM nylon guitar', author='Frank Wen (rendered by Benjamin Gleitzman)',
        license='MIT', source='https://github.com/gleitz/midi-js-soundfonts', channels=1, quality=6,
        range=(36, 96), fade_s=0.4, max_s=3.2)
def nylon():
    r = RawFiles('gleitz/midi-js-soundfonts', 'gh-pages')
    names = ['E2', 'G2', 'Bb2', 'Db3', 'E3', 'G3', 'Bb3', 'Db4', 'E4', 'G4', 'Bb4', 'Db5', 'E5', 'G5', 'Bb5']
    return [Zone([(r, f'FluidR3_GM/acoustic_guitar_nylon-mp3/{n}.mp3', 0)], root=midi(n)) for n in names]


@define('emily', name='Emilyguitar (direct electric guitar)', author='D. Smolken / Karoryfer Samples',
        license='CC0-1.0', source='https://github.com/sfzinstruments/karoryfer.emilyguitar', channels=1, quality=6,
        range=(33, 92), fade_s=0.3, max_s=lambda z: 4.0 if z.root < 64 else 3.0, notes='layers mp / mf / f, DI')
def emily():
    r = repo('sfzinstruments/karoryfer.emilyguitar')
    zones = []
    dyn = {'mp': 0, 'mf': 1, 'f': 2}
    for f in r.find(r'^notes/[a-g]b?\d_(mp|mf|f)_rr1\.wav$'):
        m = re.search(r'notes/([a-g]b?\d)_(mp|mf|f)_rr1', f)
        zones.append(Zone([(r, f, 0)], root=midi(m.group(1)), layer=dyn[m.group(2)], layers=3))
    return zones


@define('fingerbass', name='Killer Bass (fingered electric bass)', author='Karoryfer Samples', license='CC0-1.0',
        source='https://github.com/sfzinstruments/Discord-SFZ-GM-Bank', channels=1, quality=6, range=(23, 72),
        fade_s=0.3, max_s=3.5, notes='layers 2 / 3 / 5 of 5')
def fingerbass():
    zones = sfz_zones(repo(DISCORD), 'Discord GM/Melodic/034-Electric Bass (finger).sfz')
    return layered(zones, [1, 2, 4])


@define('upbass', name='Rubner double bass (pizzicato)', author='D. Smolken', license='CC0-1.0',
        source='https://github.com/sfzinstruments/dsmolken.double-bass', channels=1, quality=6, range=(24, 67),
        fade_s=0.3, max_s=3.0)
def upbass():
    r = repo('sfzinstruments/dsmolken.double-bass')
    zones = []
    for f in r.find(r'^pizz/pizz_[a-g]b?\d_[pmf]a\.wav$'):
        m = re.search(r'pizz_([a-g]b?\d)_([pmf])a', f)
        zones.append(Zone([(r, f, 0)], root=midi(m.group(1)), layer='pmf'.index(m.group(2)), layers=3))
    return zones


@define('strings', name='VSCO 2 CE string sections (sustain, vibrato)', author='Versilian Studios',
        license='CC0-1.0', source='https://github.com/sgossner/VSCO-2-CE', channels=2, quality=6, range=(28, 103),
        fade_s=0.8, max_s=8.0, tail_db=-60, notes='cello, viola and violin sections joined by range')
def strings():
    r = repo('sgossner/VSCO-2-CE@SFZ')
    out = []
    for sfz, lo, hi in (('CelloEnsSusVib.sfz', 0, 55), ('ViolaEnsSusVib.sfz', 56, 64), ('ViolinEnsSusVib.sfz', 65, 127)):
        zones = sfz_zones(r, sfz, keep=first_rr)
        layers = sorted({z.layer for z in zones})
        keep = [layers[0], layers[-1]] if len(layers) > 1 else layers
        out += [z for z in layered(zones, keep) if lo <= z.root <= hi]
    return out


@define('brass', name='VSCO 2 CE trumpet and trombone', author='Versilian Studios', license='CC0-1.0',
        source='https://github.com/sgossner/VSCO-2-CE', channels=1, quality=6, range=(34, 90), fade_s=0.25,
        max_s=lambda z: 1.2 if z.art == 'short' else 4.0, notes='staccato and sustain, trombone below F3')
def brass():
    r = repo('sgossner/VSCO-2-CE@SFZ')
    out = []
    for art, low, high in (('short', 'TromboneStac.sfz', 'TrumpetStac.sfz'), ('long', 'TromboneSus.sfz', 'TrumpetSus.sfz')):
        for sfz, lo, hi in ((low, 0, 64), (high, 65, 127)):
            zones = sfz_zones(r, sfz, keep=first_rr, art=art)
            layers = sorted({z.layer for z in zones})
            keep = [layers[len(layers) // 2], layers[-1]] if len(layers) > 1 else layers
            out += [z for z in layered(zones, keep) if lo <= z.root <= hi]
    return out


@define('vibes', name='VCSL vibraphone (soft mallets)', author='Versilian Studios (VCSL)', license='CC0-1.0',
        source='https://github.com/sgossner/VCSL', channels=1, quality=6, range=(48, 96), fade_s=0.5, max_s=5.0)
# (vibraphone sounds F3–F6)
def vibes():
    r = repo('sgossner/VCSL')
    zones = []
    for f in r.find(r'Vibraphone/Soft Mallets/Vibes_soft_[A-G]#?\d_v\d_rr1_Main\.wav$'):
        m = re.search(r'Vibes_soft_([A-G]#?\d)_v(\d)', f)
        # named an octave below sounding pitch (C3 = middle C)
        zones.append(Zone([(r, f, 0)], root=midi(m.group(1)) + 12, layer=int(m.group(2)) - 1, layers=2))
    return zones


@define('glock', name='VCSL glockenspiel', author='Versilian Studios (VCSL)', license='CC0-1.0',
        source='https://github.com/sgossner/VCSL', channels=1, quality=6, range=(64, 115), fade_s=0.4, max_s=3.0)
def glock():
    r = repo('sgossner/VCSL')
    # named an octave below sounding pitch
    return [Zone([(r, f, 0)], root=midi(re.search(r'glock_loud_([A-G]#?\d)_01', f).group(1)) + 12)
            for f in r.find(r'Glockenspiel/glock_loud_[A-G]#?\d_01\.wav$')]


@define('flute', name='VSCO 2 CE flute (sustain, vibrato)', author='Versilian Studios', license='CC0-1.0',
        source='https://github.com/sgossner/VSCO-2-CE', channels=1, quality=6, range=(59, 98), fade_s=0.4,
        max_s=4.0, tail_db=-60)
def flute():
    r = repo('sgossner/VSCO-2-CE@SFZ')
    return sfz_zones(r, 'FluteSusVib.sfz', keep=first_rr)


@define('violin', name='VSCO 2 CE solo violin (arco, vibrato)', author='Versilian Studios', license='CC0-1.0',
        source='https://github.com/sgossner/VSCO-2-CE', channels=1, quality=6, range=(55, 100), fade_s=0.5,
        max_s=4.0, tail_db=-60, notes='piano and forte layers')
def violin():
    r = repo('sgossner/VSCO-2-CE@SFZ')
    return sfz_zones(r, 'SViolinVib.sfz', keep=first_rr)


@define('tenorsax', name='VCSL tenor saxophone (sustain)', author='Versilian Studios (VCSL)', license='CC0-1.0',
        source='https://github.com/sgossner/VCSL', channels=1, quality=6, range=(44, 82), fade_s=0.3, max_s=3.5,
        tail_db=-60, notes='non-vibrato sustains, two dynamics')
def tenorsax():
    r = repo('sgossner/VCSL')
    zones = []
    for f in r.find(r'Tenor Saxophone/Non-Vibrato/BrettTenor_NV_Main_[A-G]#?\d_vl[23]_rr1\.wav$'):
        m = re.search(r'_Main_([A-G]#?\d)_vl(\d)', f)
        # named an octave below sounding pitch (C3 = middle C), like the rest of VCSL
        zones.append(Zone([(r, f, 0)], root=midi(m.group(1)) + 12, layer=int(m.group(2)) - 2, layers=2))
    return zones


# ----------------------------------------------------------------------------- more kits

@define('lofikit', name='Virtuosity Drums (lo-fi microphone)', author='Versilian Studios & Karoryfer Samples',
        license='CC0-1.0', source='https://github.com/sfzinstruments/virtuosity_drums', channels=2, quality=6,
        kind='kit', fade_s=0.15, max_s=lambda z: {'crash': 3.0, 'ride': 2.5, 'hatO': 1.4}.get(z.piece, 1.0))
def lofikit():
    r = repo(VIRT)
    s = 'Samples/{mic}/'
    m = [('lofi', 0.0)]
    z = []
    z += kit_zones(r, 'kick', s + 'kick/{mic}_kick_snoff_vl{v}_rr{rr}.flac', m, [2, 3, 4], [1])
    z += kit_zones(r, 'snare', s + 'snare/{mic}_snare_center_vl{v}.flac', m, [10, 22, 34], [1])
    z += kit_zones(r, 'rim', s + 'snare/{mic}_snare_crossstick_vl{v}.flac', m, [6, 13], [1])
    z += kit_zones(r, 'hatC', s + 'hh/{mic}_hh_closed_vl{v}_rr{rr}.flac', m, [2, 3, 4], [1, 2])
    z += kit_zones(r, 'hatO', s + 'hh/{mic}_hh_open_vl{v}_rr{rr}.flac', m, [3], [1])
    z += kit_zones(r, 'tomH', s + 'htom/{mic}_htom_center_vl{v}.flac', m, [10], [1])
    z += kit_zones(r, 'tomL', s + 'ltom/{mic}_ltom_center_vl{v}.flac', m, [10], [1])
    z += kit_zones(r, 'crash', s + 'crash/{mic}_crash_crash_vl{v}_rr{rr}.flac', m, [2], [1])
    z += kit_zones(r, 'ride', s + 'ride/{mic}_ride_ride_vl{v}_rr{rr}.flac', m, [2], [1])
    return z


RUSTY = 'sfzinstruments/karoryfer.big-rusty-drums'


@define('brushkit', name='Big Rusty Drums (brushes)', author='Karoryfer Samples', license='CC0-1.0',
        source='https://github.com/sfzinstruments/karoryfer.big-rusty-drums', channels=2, quality=6, kind='kit',
        fade_s=0.15, max_s=lambda z: {'ride': 3.5, 'bell': 3.5, 'crash': 3.5, 'hatO': 1.6}.get(z.piece, 1.4),
        notes='close and overhead microphones mixed')
def brushkit():
    r = repo(RUSTY)
    z = []
    s = 'Samples/'
    z += kit_zones(r, 'kick', s + 'kick_24/kick/{mic}/k_vl{v}_rr{rr}.flac', [('kick', 0.0), ('oh', 0.0)], [3, 5, 7], [1])
    z += kit_zones(r, 'snare', s + 'snare_14/brush/{mic}/sn_b_vl{v}_rr{rr}.flac',
                   [('top', 0.0), ('btm', -6.0), ('oh', 0.0)], [3, 5, 7, 8], [1, 2])
    z += kit_zones(r, 'hatC', s + 'hihat_14/cl_brush/{mic}/ht_cl_b_vl{v}_rr{rr}.flac', [('cl', 0.0), ('oh', 0.0)],
                   [2, 4, 5], [1])
    z += kit_zones(r, 'hatO', s + 'hihat_14/ho_brush/{mic}/ht_ho_b_vl{v}_rr{rr}.flac', [('cl', 0.0), ('oh', 0.0)], [2, 4], [1])
    z += kit_zones(r, 'hatP', s + 'hihat_14/footspl/{mic}/ht_footspl_vl{v}_rr{rr}.flac', [('cl', 0.0), ('oh', 0.0)], [2, 4], [1])
    z += kit_zones(r, 'ride', s + 'ride_22/brush/{mic}/rd_b_vl{v}_rr{rr}.flac', [('cl', 0.0), ('oh', 0.0)], [2, 3, 4], [1])
    z += kit_zones(r, 'tomH', s + 'tom_14/brush/{mic}/t14_b_vl{v}_rr{rr}.flac', [('cl', 0.0), ('oh', 0.0)], [3, 5], [1])
    z += kit_zones(r, 'tomL', s + 'tom_18/brush/{mic}/t18_b_vl{v}_rr{rr}.flac', [('cl', 0.0), ('oh', 0.0)], [3, 5], [1])
    return z


@define('perc', name='Percussion (Virtuosity Drums, VCSL claps)', author='Versilian Studios & Karoryfer Samples',
        license='CC0-1.0', source='https://github.com/sfzinstruments/virtuosity_drums', channels=2, quality=6,
        kind='kit', fade_s=0.1, max_s=lambda z: {'cowbell': 0.8, 'clap': 0.8}.get(z.piece, 0.9))
def perc():
    r = repo(VIRT)
    v = repo('sgossner/VCSL')
    z = []
    for piece, folder, layers in (('tamb', 'tambourine', [1, 2]), ('shaker', 'shaker', [1, 2]), ('cowbell', 'cowbell', [1, 2])):
        files = r.find(rf'Samples/perc/close/{folder}/.*_v(\d)_rr1_Close\.wav$')
        for li, lv in enumerate(layers):
            close = next((f for f in files if f'_v{lv}_rr1_' in f), None)
            if close:
                oh = close.replace('/close/', '/oh/').replace('_Close.wav', '_OH.wav')
                parts = [(r, close, 0.0)] + ([(r, oh, -4.0)] if oh in r.files() else [])
                z.append(Zone(parts, piece=piece, layer=li, layers=len(layers)))
    for i, f in enumerate(sorted(v.find(r'Claps/Clap_rr\d\.wav$'))[:2]):
        z.append(Zone([(v, f, 0.0)], piece='clap', layer=0, layers=1, rr=i))
    return z


def main(argv: list[str]) -> None:
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {'sets': {}}
    wanted = argv or list(SETS)
    for id in wanted:
        manifest['sets'][id] = build_set(id)
    manifest['sets'] = {k: manifest['sets'][k] for k in SETS if k in manifest['sets']}
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n')
    size = sum(s.get('bytes', 0) for s in manifest['sets'].values())
    print(f'total {size / 1e6:.1f} MB in {len(manifest["sets"])} sets')


if __name__ == '__main__':
    main(sys.argv[1:])
