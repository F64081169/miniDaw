// WAV encode / decode (PCM 16/24-bit with TPDF dither, or 32-bit float).

export type WavFormat = 16 | 24 | 32;

export function encodeWav(channels: Float32Array[], sampleRate: number, bits: WavFormat = 16): ArrayBuffer {
  const numCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const bytesPer = bits / 8;
  const dataSize = len * numCh * bytesPer;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * bytesPer, true);
  v.setUint16(32, numCh * bytesPer, true);
  v.setUint16(34, bits, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);
  let o = 44;
  if (bits === 32) {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        v.setFloat32(o, channels[c][i], true);
        o += 4;
      }
    }
    return buf;
  }
  const max = bits === 16 ? 32767 : 8388607;
  const lsb = 1 / max;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      // triangular dither at ±1 LSB keeps quiet fades smooth
      const dither = (Math.random() - Math.random()) * lsb;
      const s = Math.max(-1, Math.min(1, channels[c][i] + dither));
      const q = Math.round(s * max);
      if (bits === 16) {
        v.setInt16(o, q, true);
        o += 2;
      } else {
        v.setUint8(o, q & 0xff);
        v.setUint8(o + 1, (q >> 8) & 0xff);
        v.setUint8(o + 2, (q >> 16) & 0xff);
        o += 3;
      }
    }
  }
  return buf;
}

export function decodeWav(buf: ArrayBuffer): { channels: Float32Array[]; sampleRate: number } {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12;
  let fmt = 1;
  let numCh = 1;
  let sampleRate = 44100;
  let bits = 16;
  while (o + 8 <= v.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = v.getUint16(o + 8, true);
      numCh = v.getUint16(o + 10, true);
      sampleRate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
    } else if (id === 'data') {
      const bytesPer = bits / 8;
      const frames = Math.floor(size / (bytesPer * numCh));
      const channels = Array.from({ length: numCh }, () => new Float32Array(frames));
      let p = o + 8;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < numCh; c++) {
          let s: number;
          if (fmt === 3 && bits === 32) s = v.getFloat32(p, true);
          else if (bits === 16) s = v.getInt16(p, true) / 32768;
          else if (bits === 24) {
            let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
            if (x & 0x800000) x -= 0x1000000;
            s = x / 8388608;
          } else if (bits === 8) s = (v.getUint8(p) - 128) / 128;
          else s = v.getInt32(p, true) / 2147483648;
          channels[c][i] = s;
          p += bytesPer;
        }
      }
      return { channels, sampleRate };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export function bufferToChannels(b: AudioBuffer): Float32Array[] {
  return Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
}
