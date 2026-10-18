// Tiny static file server for dist/ (used by the e2e smoke test).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wav': 'audio/wav' };

export function serve(root = 'dist', port = 4173) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let path = normalize(join(root, decodeURIComponent(url.pathname)));
        if (!path.startsWith(normalize(root))) throw new Error('outside root');
        if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'index.html');
        const data = await readFile(path);
        res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(port, () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] ?? 'dist';
  const port = Number(process.argv[3] ?? 4173);
  await serve(root, port);
  console.log(`serving ${root} on http://localhost:${port}`);
}
