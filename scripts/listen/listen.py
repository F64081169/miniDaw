"""Listen to rendered songs (scripts/listen/render.mjs) and describe them in numbers:

- breathing: loudness range (EBU R128 LRA), how much louder choruses are than verses, how much
  the level moves inside a section (phrase dynamics) and how often it dips (breaths, stops);
- the lead's timbre: spectral centroid, energy above 4 kHz, and psychoacoustic sharpness
  (DIN 45692) and roughness (Daniel & Weber) via MoSQITo;
- the lead's level in each section;
- what a music tagger hears: the MSD musicnn model's tags (genre, 'beautiful', 'Mellow' …),
  averaged over the song.

usage: python3 scripts/listen/listen.py <render-dir> [genre ...] [--no-tags] [--no-psy]
Writes <render-dir>/listen.json and prints one line per genre.
Needs: pip install -r scripts/listen/requirements.txt, and TF_USE_LEGACY_KERAS=1 for musicnn.
"""
import json
import os
import sys

import numpy as np
import soundfile as sf
from scipy.signal import lfilter

SR = 48000
args = [a for a in sys.argv[1:] if not a.startswith('--')]
FLAGS = {a for a in sys.argv[1:] if a.startswith('--')}
DIR = args[0]
GENRES = args[1:] or sorted({f.split('.')[0] for f in os.listdir(DIR) if f.endswith('.json') and f != 'listen.json'})

# ---------------------------------------------------------------- loudness (BS.1770 / EBU R128)


def kweight(x):
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]
    return lfilter(b2, a2, lfilter(b1, a1, x))


def windows(x, win, hop):
    """Loudness (LUFS) of sliding windows."""
    y = kweight(x) ** 2
    n, h = int(win * SR), int(hop * SR)
    cs = np.concatenate([[0.0], np.cumsum(y)])
    starts = np.arange(0, max(1, len(y) - n + 1), h)
    e = (cs[starts + n] - cs[starts]) / n
    return -0.691 + 10 * np.log10(e + 1e-12), starts / SR


def integrated(x):
    """Gated integrated loudness (LUFS) of a signal, None if silent."""
    l, _ = windows(x, 0.4, 0.1)
    e = 10 ** ((l + 0.691) / 10)
    e = e[l > -70]
    if not len(e):
        return None
    rel = -0.691 + 10 * np.log10(e.mean()) - 10
    e = e[-0.691 + 10 * np.log10(e) > rel]
    return round(float(-0.691 + 10 * np.log10(e.mean())), 1)


def lra(st):
    st = st[st > -70]
    if len(st) < 3:
        return 0.0
    rel = 10 * np.log10(np.mean(10 ** (st / 10))) - 20
    st = st[st > rel]
    return float(np.percentile(st, 95) - np.percentile(st, 10))


def breathing(x, sections):
    """How the arrangement breathes: loudness range, contrast between sections, movement
    inside them (phrase dynamics) and room left between phrases."""
    st, _ = windows(x, 3.0, 0.5)
    mo, t_mo = windows(x, 0.4, 0.1)
    out = {'lra': round(lra(st), 1), 'sections': []}
    for s in sections:
        m = mo[(t_mo >= s['start']) & (t_mo + 0.4 <= s['end'])]
        m = m[m > -70]
        if len(m) < 5:
            continue
        med = float(np.median(m))
        out['sections'].append({
            'type': s['type'], 'name': s['name'],
            'loud': round(10 * np.log10(np.mean(10 ** (m / 10))), 1),
            'move': round(float(np.percentile(m, 90) - np.percentile(m, 10)), 1),  # phrase dynamics
            'space': round(float(np.mean(m < med - 6)), 3),  # share of dips (breaths, stops)
        })
    by = {}
    for s in out['sections']:
        by.setdefault(s['type'], []).append(s['loud'])
    mean = lambda k: float(np.mean(by[k])) if k in by else None  # noqa: E731
    ch, ve = mean('chorus') or mean('drop'), mean('verse')
    out['contrast'] = round(ch - ve, 1) if ch is not None and ve is not None else None
    out['move'] = round(float(np.mean([s['move'] for s in out['sections']])), 1) if out['sections'] else 0
    out['space'] = round(float(np.mean([s['space'] for s in out['sections']])), 3) if out['sections'] else 0
    louds = [s['loud'] for s in out['sections']]
    out['arc'] = round(float(np.mean(np.abs(np.diff(louds)))), 1) if len(louds) > 1 else 0
    return out

# ---------------------------------------------------------------- lead timbre


def lead_timbre(x):
    """Spectral and psychoacoustic description of the lead playing alone (its busiest 12 s)."""
    import librosa
    mo, t = windows(x, 0.4, 0.1)
    if not np.any(mo > -60):
        return None
    act = (mo > -45).astype(float)
    k = int(12 / 0.1)
    best = int(np.argmax(np.convolve(act, np.ones(k), 'valid'))) if len(act) > k else 0
    seg = x[int(t[best] * SR): int(t[best] * SR) + 12 * SR]
    seg = seg / (np.max(np.abs(seg)) + 1e-9) * 0.5
    S = np.abs(librosa.stft(seg, n_fft=4096, hop_length=1024)) ** 2
    freqs = librosa.fft_frequencies(sr=SR, n_fft=4096)
    frame_e = S.sum(axis=0)
    S = S[:, frame_e > np.max(frame_e) * 1e-3]
    tot = S.sum() + 1e-12
    res = {
        'centroid': round(float((freqs[:, None] * S).sum() / tot), 0),
        'hf_4k': round(float(S[freqs > 4000].sum() / tot), 4),
        'presence_2_5k': round(float(S[(freqs > 2000) & (freqs < 5000)].sum() / tot), 4),
    }
    if '--no-psy' not in FLAGS:
        from mosqito.sq_metrics import roughness_dw, sharpness_din_tv
        y = seg[: 6 * SR]
        sh, _ = sharpness_din_tv(y, SR, field_type='free', skip=0.2)
        res['sharpness'] = round(float(np.mean(sh)), 3)
        res['roughness'] = round(float(np.mean(roughness_dw(y, SR, overlap=0.5)[0])), 3)
    return res

# ---------------------------------------------------------------- tags


def tagger():
    """musicnn's extractor, with its spectrogram kept in float32 (float16 overflows on loud
    mixes with numpy 2 and every song then gets the same tags)."""
    import librosa
    from musicnn import configuration as config
    from musicnn import extractor as ex

    def batch_data(audio_file, n_frames, overlap):
        audio, sr = librosa.load(audio_file, sr=config.SR)
        rep = librosa.feature.melspectrogram(y=audio, sr=sr, hop_length=config.FFT_HOP, n_fft=config.FFT_SIZE, n_mels=config.N_MELS).T
        rep = np.log10(10000 * rep.astype(np.float32) + 1)
        starts = range(0, rep.shape[0] - n_frames + 1, overlap)
        return np.stack([rep[s: s + n_frames] for s in starts]), rep

    ex.batch_data = batch_data
    return ex.extractor


def tags(path):
    taggram, labels = tagger()(path, model='MSD_musicnn', input_length=3, input_overlap=False, extract_features=False)
    return {'song': {l: round(float(v), 3) for l, v in zip(labels, taggram.mean(axis=0))}}


GENRE_TAGS = {
    'pop': ['pop', 'catchy', 'dance'], 'mandopop': ['pop', 'beautiful', 'Mellow'], 'ballad': ['beautiful', 'Mellow', 'sad'],
    'rock': ['rock', 'classic rock', 'hard rock'], 'metal': ['metal', 'heavy metal', 'hard rock'], 'country': ['country', 'folk', 'acoustic'],
    'hiphop': ['Hip-Hop', 'chill'], 'trap': ['Hip-Hop', 'electronic'], 'lofi': ['chill', 'chillout', 'Hip-Hop'],
    'rnb': ['rnb', 'soul', 'sexy'], 'house': ['House', 'dance', 'electronic'], 'edm': ['electronic', 'dance', 'House'],
    'synthwave': ['80s', 'electronic', 'electro'], 'jazz': ['jazz', 'easy listening'], 'bossa': ['jazz', 'easy listening', 'chillout'],
    'funk': ['funk', 'soul'], 'citypop': ['80s', 'pop', 'funk'], 'reggae': ['chill', 'easy listening'],
}


def main():
    path_out = os.path.join(DIR, 'listen.json')
    out = json.load(open(path_out)) if os.path.exists(path_out) else {}
    for g in GENRES:
        meta = json.load(open(os.path.join(DIR, f'{g}.json')))
        x, sr = sf.read(os.path.join(DIR, f'{g}.wav'))
        assert sr == SR
        entry = {'lead': meta.get('lead'), 'breathing': breathing(x, meta['sections'])}
        lead_path = os.path.join(DIR, f'{g}.lead.wav')
        if os.path.exists(lead_path):
            lx, _ = sf.read(lead_path)
            entry['timbre'] = lead_timbre(lx)
            entry['lead_level'] = {s['name']: integrated(lx[int(s['start'] * SR): int(s['end'] * SR)]) for s in meta['sections']}
        if '--no-tags' not in FLAGS:
            entry['tags'] = tags(os.path.join(DIR, f'{g}.wav'))
        out[g] = entry
        json.dump(out, open(path_out, 'w'), indent=1, ensure_ascii=False)
        b, tm = entry['breathing'], entry.get('timbre') or {}
        song = entry.get('tags', {}).get('song', {})
        genre_score = np.mean([song.get(t, 0) for t in GENRE_TAGS.get(g, [])]) if song else float('nan')
        top = sorted(song.items(), key=lambda kv: -kv[1])[:4]
        print(f"{g:10s} lead {str(entry['lead']):15s} LRA {b['lra']:4.1f} contrast {b['contrast']} move {b['move']} arc {b['arc']} | "
              f"sharp {tm.get('sharpness')} rough {tm.get('roughness')} | genre {genre_score:.3f} "
              f"beautiful {song.get('beautiful', float('nan')):.3f} mellow {song.get('Mellow', float('nan')):.3f} "
              f"top {[(k, round(v, 2)) for k, v in top]}", flush=True)


if __name__ == '__main__':
    main()
