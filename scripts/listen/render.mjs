// Render generated songs for listening tests.
//
// usage: npm run build && node scripts/listen/render.mjs <out-dir> [genre ...]
//   env SEED=7       random seed of the generation (the same seed gives the same song)
//       LEAD=<patch> play the lead melody on this patch instead
//       EXCERPT=1    only the first verse and the first chorus
//
// Writes per genre: <genre>.wav (the mix, 48 kHz mono 16-bit), <genre>.lead.wav (the lead alone)
// and <genre>.json (section map, tracks and patches). scripts/listen/listen.py measures them.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '../serve.mjs';

const ALL = 'pop mandopop ballad rock metal country hiphop trap lofi rnb house edm synthwave jazz bossa funk citypop reggae'.split(' ');
const [outArg, ...rest] = process.argv.slice(2);
if (!outArg) {
  console.error('usage: node scripts/listen/render.mjs <out-dir> [genre ...]');
  process.exit(1);
}
const out = resolve(outArg);
const queue = rest.length ? rest : [...ALL];
const seed = Number(process.env.SEED ?? 7);
const leadPatch = process.env.LEAD ?? '';
const excerpt = !!process.env.EXCERPT;
mkdirSync(out, { recursive: true });

function wav(b64, rate) {
  const pcm = Buffer.from(b64, 'base64');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const server = await serve();
const executablePath =
  process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath });

async function worker() {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto('http://localhost:4173/');
  await page.waitForSelector('.controlbar');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const d = await window.__minidaw.debug();
    await Promise.all(Object.keys(d.SAMPLE_SETS).map((id) => d.sampleLibrary.load(id).catch(() => null)));
  });
  while (queue.length) {
    const g = queue.shift();
    const t0 = Date.now();
    const res = await page.evaluate(
      async ({ g, seed, leadPatch, excerpt }) => {
        // a seeded Math.random makes a render reproducible
        let a = seed >>> 0;
        Math.random = () => {
          a = (a + 0x6d2b79f5) >>> 0;
          let t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const d = await window.__minidaw.debug();
        d.generate(g);
        const st = window.__minidaw.state();
        let p = st.project;
        const lead = p.tracks.find((t) => /:(lead|melody)$/.test(t.role ?? ''));
        if (leadPatch && lead) {
          st.update('lead', (dr) => {
            const t = dr.tracks.find((x) => x.id === lead.id);
            t.instrument.patchId = leadPatch;
            t.instrument.params = d.defaultParams(d.getPatch(leadPatch));
          });
          p = window.__minidaw.state().project;
        }
        let start = 0;
        let end = Math.max(...p.markers.map((m) => m.start + m.length));
        if (excerpt) {
          // the first verse and the first chorus (in whichever order the song has them)
          const verse = p.markers.find((m) => m.section === 'verse');
          const chorus = p.markers.find((m) => m.section === 'chorus' || m.section === 'drop');
          if (verse && chorus) {
            start = Math.min(verse.start, chorus.start);
            end = Math.max(verse.start + verse.length, chorus.start + chorus.length);
          }
        }
        const enc = (buf) => {
          const n = buf.length;
          const pcm = new Int16Array(n);
          const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
          for (let i = 0; i < n; i++) {
            let s = 0;
            for (const ch of chans) s += ch[i];
            s /= chans.length;
            pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
          }
          const bytes = new Uint8Array(pcm.buffer);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(bin);
        };
        const mix = await d.bounceRange(p, { start, end, sampleRate: 48000, tail: 2 });
        const leadBuf = lead ? await d.bounceRange(p, { start, end, sampleRate: 48000, tail: 2, soloTrackId: lead.id }) : null;
        const spb = 60 / p.bpm;
        const leadNow = lead && p.tracks.find((t) => t.id === lead.id);
        return {
          bpm: p.bpm,
          lead: leadNow?.instrument?.patchId ?? null,
          sections: p.markers
            .filter((m) => m.section && m.start >= start && m.start < end)
            .map((m) => ({ type: m.section, name: m.name, start: (m.start - start) * spb, end: (m.start + m.length - start) * spb })),
          tracks: p.tracks.map((t) => ({ role: t.role, patch: t.instrument?.patchId, fader: t.mixer.volumeDb })),
          mix: enc(mix),
          leadWav: leadBuf ? enc(leadBuf) : null,
        };
      },
      { g, seed, leadPatch, excerpt },
    );
    writeFileSync(`${out}/${g}.wav`, wav(res.mix, 48000));
    if (res.leadWav) writeFileSync(`${out}/${g}.lead.wav`, wav(res.leadWav, 48000));
    delete res.mix;
    delete res.leadWav;
    writeFileSync(`${out}/${g}.json`, JSON.stringify(res, null, 1));
    console.log(g, res.lead, `${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}

await Promise.all([worker(), worker(), worker()]);
await browser.close();
server.close();
