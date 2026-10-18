// Renders the app icons in public/icons/ from SVG (run after changing the artwork).
// Usage: node scripts/make-icons.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const executablePath = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
const BARS = '<path d="M136 344V184M216 344V232M296 344V152M376 344V264" stroke="#f3a83b" stroke-width="44" stroke-linecap="round"/>';
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#171b21"/>${BARS}</svg>`;
// full-bleed square: platforms apply their own mask (iOS corners, Android adaptive shapes)
const square = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#171b21"/><g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${BARS}</g></svg>`;

const icons = [
  { file: 'icon-192.png', size: 192, svg: rounded },
  { file: 'icon-512.png', size: 512, svg: rounded },
  { file: 'icon-maskable-512.png', size: 512, svg: square(0.8) },
  { file: 'apple-touch-icon.png', size: 180, svg: square(0.9) },
];

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
for (const { file, size, svg } of icons) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="${size}" height="${size}">`);
  await page.screenshot({ path: `public/icons/${file}`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`public/icons/${file}`);
}
await browser.close();
