// End-to-end smoke test: builds are served from dist/, driven with Playwright + Chromium.
// Usage: npm run build && npm run e2e   (screenshots land in test-results/)

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';
import { serve } from './serve.mjs';

const OUT = 'test-results';
const executablePath =
  process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));

await mkdir(OUT, { recursive: true });
const server = await serve();
const browser = await chromium.launch({
  executablePath,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const errors = [];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, permissions: ['microphone'] });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:4173/', { waitUntil: 'load' });
  await page.waitForSelector('.controlbar', { timeout: 15000 });
  check('app renders', true);

  const welcome = await page.locator('.welcome').count();
  check('welcome dialog on first visit', welcome === 1);
  await page.screenshot({ path: `${OUT}/01-welcome.png` });
  await page.keyboard.press('Escape');

  const regions = await page.locator('.region').count();
  check('demo song generated regions', regions > 10, `${regions} regions`);
  const tracks = await page.locator('.track-header').count();
  check('demo song has tracks', tracks >= 5, `${tracks} tracks`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/02-arrange.png` });

  // play for a bit, the LCD should move
  await page.locator('.lcd').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press('Space');
  await page.waitForTimeout(2500);
  const lcd1 = await page.locator('.lcd-big').textContent();
  await page.waitForTimeout(800);
  const lcd2 = await page.locator('.lcd-big').textContent();
  check('transport plays', lcd1 !== lcd2 && lcd1 !== '  1 1 1 001', `${lcd1?.trim()} → ${lcd2?.trim()}`);
  const level = await page.evaluate(() => {
    const e = window.__minidaw;
    return e ? e.masterPeak() : -1;
  });
  check('master output has signal', level > 0.01, `peak ${level.toFixed?.(3)}`);
  await page.screenshot({ path: `${OUT}/03-playing.png` });
  await page.keyboard.press('Space');

  // open the piano roll on the first chords region
  const keysRegion = page.locator('.lane').nth(2).locator('.region').first();
  await keysRegion.dblclick();
  await page.waitForTimeout(500);
  check('piano roll opens', (await page.locator('.roll-canvas').count()) === 1);
  await page.screenshot({ path: `${OUT}/04-pianoroll.png` });

  // drum step editor
  await page.locator('.lane').nth(0).locator('.region').nth(1).dblclick();
  await page.waitForTimeout(400);
  const stepView = await page.locator('.steps-grid').count();
  check('drum step editor opens', stepView === 1);
  await page.screenshot({ path: `${OUT}/05-steps.png` });

  // mixer
  await page.keyboard.press('x');
  await page.waitForTimeout(300);
  check('mixer shows strips', (await page.locator('.mixer .strip').count()) >= tracks);
  await page.screenshot({ path: `${OUT}/06-mixer.png` });

  // coach: pick another genre and generate everything
  await page.locator('.coach .back').click();
  await page.locator('.genre-card', { hasText: 'Trap' }).click();
  await page.locator('.btn-big', { hasText: '一鍵生成完整編曲' }).click();
  await page.waitForTimeout(600);
  const trapTracks = await page.locator('.track-header').count();
  check('coach generates a trap arrangement', trapTracks >= 4, `${trapTracks} tracks`);
  await page.screenshot({ path: `${OUT}/07-coach-trap.png` });

  // undo
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  check('undo works', (await page.locator('.toast').count()) > 0);

  // recording with the fake microphone
  await page.evaluate(() => window.__minidaw?.addAudioTrackAndArm());
  await page.waitForTimeout(300);
  await page.keyboard.press('r');
  await page.waitForTimeout(4200);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  const audioRegions = await page.locator('.region-audio').count();
  check('microphone recording creates an audio region', audioRegions >= 1, `${audioRegions} audio regions`);
  await page.screenshot({ path: `${OUT}/08-recorded.png` });

  // export a WAV mixdown
  await page.evaluate(() => window.__minidaw?.setLoop(0, 8));
  await page.evaluate(() => window.__minidaw?.openExport());
  await page.waitForSelector('.modal');
  await page.locator('label', { hasText: '循環範圍' }).locator('input').check();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('.btn', { hasText: '匯出混音 WAV' }).click()]);
  const path = `${OUT}/mix.wav`;
  await download.saveAs(path);
  const { stat } = await import('node:fs/promises');
  const size = (await stat(path)).size;
  check('WAV export downloads', size > 100000, `${(size / 1024).toFixed(0)} KB`);
  await page.keyboard.press('Escape');

  // light theme + narrow width rendering
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/09-light.png` });
  await page.setViewportSize({ width: 400, height: 820 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no horizontal page overflow at 400px', !overflow);
  await page.screenshot({ path: `${OUT}/10-phone.png` });

  // phone: touch input, an iPhone user agent, and audio that may only start from a gesture
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  await phone.addInitScript(() => {
    // like mobile browsers, resume() only takes effect while an activation event is being
    // handled (finger lifted, click, key) and otherwise never settles
    let inGesture = false;
    for (const type of ['pointerup', 'touchend', 'mousedown', 'click', 'keydown']) {
      window.addEventListener(
        type,
        (e) => {
          if (!e.isTrusted || (type === 'pointerup' && e.pointerType === 'mouse')) return;
          inGesture = true;
          setTimeout(() => (inGesture = false), 0);
        },
        true,
      );
    }
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      return inGesture ? resume.call(this) : new Promise(() => undefined);
    };
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(options) {
        super(options);
        void this.suspend();
      }
    };
  });
  const mobile = await phone.newPage();
  mobile.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[phone] ${m.text()}`);
  });
  mobile.on('pageerror', (e) => errors.push(`[phone] ${e}`));
  await mobile.goto('http://localhost:4173/', { waitUntil: 'load' });
  await mobile.waitForSelector('.welcome', { timeout: 15000 });
  await mobile.waitForTimeout(800);
  const before = await mobile.evaluate(() => window.__minidaw.audioState());
  // any first tap (here: closing the welcome dialog) should unlock sound
  await mobile.locator('.welcome .modal-head button').tap();
  await mobile.waitForTimeout(400);
  const afterTap = await mobile.evaluate(() => window.__minidaw.audioState());
  check('phone: first tap unlocks audio', before !== 'running' && afterTap === 'running', `${before} → ${afterTap}`);
  await mobile.locator('.tp-play').tap();
  await mobile.waitForTimeout(3000);
  const phoneLevel = await mobile.evaluate(() => window.__minidaw.masterPeak());
  const phoneLcd = await mobile.locator('.lcd-big').textContent();
  check('phone: tapping play makes sound', phoneLevel > 0.01, `peak ${phoneLevel.toFixed(3)}, at ${phoneLcd?.trim()}`);
  await mobile.screenshot({ path: `${OUT}/11-phone-playing.png` });

  // a sandboxed page may block workers without throwing: the transport and the sample
  // renderer must notice and carry on without them
  const locked = await browser.newContext({ ...devices['iPhone 13'] });
  await locked.addInitScript(() => {
    window.Worker = class {
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
    };
  });
  const noWorkers = await locked.newPage();
  noWorkers.on('pageerror', (e) => errors.push(`[no workers] ${e}`));
  await noWorkers.goto('http://localhost:4173/', { waitUntil: 'load' });
  await noWorkers.waitForSelector('.welcome', { timeout: 15000 });
  await noWorkers.waitForTimeout(3500);
  await noWorkers.locator('.welcome .btn-primary').tap();
  let quiet = 0;
  let loud = 0;
  for (let i = 0; i < 10; i++) {
    await noWorkers.waitForTimeout(600);
    const peak = await noWorkers.evaluate(() => window.__minidaw.masterPeak());
    if (i >= 4) peak > 0.01 ? loud++ : quiet++;
  }
  check('phone without workers keeps playing', loud >= 5, `${loud} of 6 late samples had signal`);
  await locked.close();

  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (err) {
  check('e2e run', false, String(err));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
