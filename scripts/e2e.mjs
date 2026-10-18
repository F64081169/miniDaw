// End-to-end smoke test: builds are served from dist/, driven with Playwright + Chromium.
// Usage: npm run build && npm run e2e   (screenshots land in test-results/)

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
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
