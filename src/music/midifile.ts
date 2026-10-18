// Standard MIDI File (SMF) export / import so projects move to and from Logic Pro, GarageBand, etc.

import type { Project } from '../core/types';
import { getPatch } from '../audio/instruments/patches';

const PPQ = 480;

function vlq(n: number): number[] {
  let v = Math.max(0, Math.round(n));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function textBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function chunk(type: string, data: number[]): number[] {
  const len = data.length;
  return [...textBytes(type), (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...data];
}

interface Ev {
  tick: number;
  order: number;
  bytes: number[];
}

function trackData(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out: number[] = [];
  let last = 0;
  for (const e of events) {
    out.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  out.push(0, 0xff, 0x2f, 0);
  return out;
}

export function exportMidi(p: Project): Uint8Array {
  const tracks: number[][] = [];
  // conductor track
  const us = Math.round(60000000 / p.bpm);
  const denPow = Math.round(Math.log2(p.timeSig[1]));
  const name = textBytes(p.name);
  tracks.push(
    trackData([
      { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(name.length), ...name] },
      { tick: 0, order: 1, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] },
      { tick: 0, order: 2, bytes: [0xff, 0x58, 0x04, p.timeSig[0], denPow, 24, 8] },
      ...p.markers.map((m, i) => {
        const t = textBytes(m.name);
        return { tick: Math.round(m.start * PPQ), order: 3 + i, bytes: [0xff, 0x06, ...vlq(t.length), ...t] };
      }),
    ]),
  );
  let channel = 0;
  for (const t of p.tracks) {
    if (t.kind !== 'instrument' || !t.instrument) continue;
    const patch = getPatch(t.instrument.patchId);
    const isDrum = patch.engine === 'drums';
    let ch = isDrum ? 9 : channel;
    if (!isDrum) {
      channel = (channel + 1) % 16;
      if (channel === 9) channel = 10;
      if (ch === 9) ch = 10;
    }
    const tn = textBytes(t.name);
    const evs: Ev[] = [
      { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(tn.length), ...tn] },
      { tick: 0, order: 1, bytes: [0xc0 | ch, patch.gmProgram & 0x7f] },
    ];
    const vol = Math.round(Math.max(0, Math.min(127, 100 * Math.pow(10, t.mixer.volumeDb / 40))));
    evs.push({ tick: 0, order: 2, bytes: [0xb0 | ch, 7, vol] });
    evs.push({ tick: 0, order: 3, bytes: [0xb0 | ch, 10, Math.round((t.mixer.pan + 1) * 63.5)] });
    for (const r of t.regions) {
      if (r.kind !== 'midi' || r.muted) continue;
      for (const n of r.notes) {
        if (n.start >= r.length) continue;
        const dur = Math.min(n.duration, r.length - n.start);
        const on = Math.round((r.start + n.start) * PPQ);
        const off = Math.max(on + 1, Math.round((r.start + n.start + dur) * PPQ));
        evs.push({ tick: on, order: 20, bytes: [0x90 | ch, n.pitch & 0x7f, Math.max(1, Math.min(127, Math.round(n.velocity)))] });
        evs.push({ tick: off, order: 10, bytes: [0x80 | ch, n.pitch & 0x7f, 64] });
      }
    }
    tracks.push(trackData(evs));
  }
  const header = chunk('MThd', [0, 1, (tracks.length >> 8) & 0xff, tracks.length & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff]);
  const all = [...header];
  for (const td of tracks) all.push(...chunk('MTrk', td));
  return new Uint8Array(all);
}

export interface ImportedTrack {
  name: string;
  isDrum: boolean;
  program: number;
  notes: { pitch: number; start: number; duration: number; velocity: number }[];
}

export interface ImportedMidi {
  bpm: number;
  timeSig: [number, number];
  tracks: ImportedTrack[];
}

export function importMidi(data: Uint8Array): ImportedMidi {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (o: number) => String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
  if (tag(0) !== 'MThd') throw new Error('不是有效的 MIDI 檔');
  const ntrks = v.getUint16(10);
  const division = v.getUint16(12);
  if (division & 0x8000) throw new Error('不支援 SMPTE 時間格式的 MIDI 檔');
  let o = 8 + v.getUint32(4);
  let bpm = 120;
  let tempoSet = false;
  let timeSig: [number, number] = [4, 4];
  const out: ImportedTrack[] = [];
  for (let ti = 0; ti < ntrks && o + 8 <= data.length; ti++) {
    const type = tag(o);
    const len = v.getUint32(o + 4);
    const end = o + 8 + len;
    if (type !== 'MTrk') {
      o = end;
      continue;
    }
    let p = o + 8;
    let tick = 0;
    let status = 0;
    let name = '';
    // per channel data inside this MTrk
    const chans = new Map<number, { program: number; notes: ImportedTrack['notes']; open: Map<number, { start: number; vel: number }[]> }>();
    const chan = (c: number) => {
      let x = chans.get(c);
      if (!x) {
        x = { program: 0, notes: [], open: new Map() };
        chans.set(c, x);
      }
      return x;
    };
    const readVlq = () => {
      let n = 0;
      for (let i = 0; i < 4; i++) {
        const b = data[p++];
        n = (n << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return n;
    };
    while (p < end) {
      tick += readVlq();
      let b = data[p];
      if (b & 0x80) {
        status = b;
        p++;
      } else b = status;
      const hi = status & 0xf0;
      const c = status & 0x0f;
      if (status === 0xff) {
        const metaType = data[p++];
        const ml = readVlq();
        if (metaType === 0x03 && !name) name = new TextDecoder().decode(data.subarray(p, p + ml));
        if (metaType === 0x51 && ml === 3 && !tempoSet) {
          const us = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
          bpm = Math.round((60000000 / us) * 100) / 100;
          tempoSet = true;
        }
        if (metaType === 0x58 && ml >= 2) timeSig = [data[p], Math.pow(2, data[p + 1])];
        p += ml;
      } else if (status === 0xf0 || status === 0xf7) {
        const sl = readVlq();
        p += sl;
      } else if (hi === 0x90 || hi === 0x80) {
        const pitch = data[p++];
        const vel = data[p++];
        const st = chan(c);
        const beat = tick / division;
        if (hi === 0x90 && vel > 0) {
          const list = st.open.get(pitch) ?? [];
          list.push({ start: beat, vel });
          st.open.set(pitch, list);
        } else {
          const list = st.open.get(pitch);
          const on = list?.shift();
          if (on) st.notes.push({ pitch, start: on.start, duration: Math.max(1 / 64, beat - on.start), velocity: on.vel });
        }
      } else if (hi === 0xc0) {
        chan(c).program = data[p++];
      } else if (hi === 0xd0) {
        p += 1;
      } else {
        p += 2; // 0xA0, 0xB0, 0xE0
      }
    }
    for (const [c, st] of chans) {
      if (st.notes.length === 0) continue;
      st.notes.sort((a, b) => a.start - b.start);
      out.push({ name: name || `MIDI ${out.length + 1}`, isDrum: c === 9, program: st.program, notes: st.notes });
    }
    o = end;
  }
  return { bpm, timeSig, tracks: out };
}

/** Map a General MIDI program number to one of our patches. */
export function patchForProgram(program: number, isDrum: boolean): string {
  if (isDrum) return 'drums.studio';
  const p = program;
  if (p <= 3) return p === 1 ? 'piano.bright' : 'piano.grand';
  if (p <= 5) return p === 5 ? 'ep.dx' : 'ep.classic';
  if (p <= 7) return 'piano.bright';
  if (p <= 15) return p === 11 ? 'mallet.vibes' : 'mallet.bell';
  if (p <= 23) return 'organ.tonewheel';
  if (p === 24) return 'ag.nylon';
  if (p === 25) return 'ag.steel';
  if (p <= 28) return 'eg.clean';
  if (p === 29) return 'eg.crunch';
  if (p <= 31) return 'eg.lead';
  if (p === 32) return 'bass.upright';
  if (p <= 35) return p === 34 ? 'bass.pick' : 'bass.finger';
  if (p <= 37) return 'bass.pick';
  if (p <= 39) return 'bass.synth';
  if (p <= 55) return 'strings.ensemble';
  if (p <= 71) return 'brass.section';
  if (p <= 79) return 'synth.lead';
  if (p <= 87) return 'synth.lead';
  if (p <= 95) return 'synth.pad';
  return 'synth.pad';
}
