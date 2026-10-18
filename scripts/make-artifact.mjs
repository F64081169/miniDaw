// Turns the single-file build (dist-single/index.html) into page content for a claude.ai Artifact:
// the Artifact host supplies <html>/<head>/<body>, so only title, meta, styles and scripts are kept.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const src = await readFile('dist-single/index.html', 'utf8');
const pick = (re) => [...src.matchAll(re)].map((m) => m[0]);
const title = src.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? '<title>miniDaw</title>';
const links = pick(/<link[^>]+(fonts\.googleapis|fonts\.gstatic|rel="icon")[^>]*>/g);
const styles = pick(/<style[^>]*>[\s\S]*?<\/style>/g);
const scripts = pick(/<script[^>]*>[\s\S]*?<\/script>/g);
const out = [
  title,
  '<meta name="claude:viewport-fit-sides" content="cover">',
  ...links,
  ...styles,
  '<div id="root"></div>',
  ...scripts,
].join('\n');
await mkdir('artifact', { recursive: true });
await writeFile('artifact/miniDaw.html', out);
console.log(`artifact/miniDaw.html written (${(out.length / 1024).toFixed(0)} KB)`);
