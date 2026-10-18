// Saving and opening files. Inside a claude.ai Artifact the page cannot trigger downloads itself,
// so we go through the `downloads` capability (wrapping formats it doesn't accept into a .zip).

import { zipFiles } from './zip';

interface DownloadsApi {
  save(req: { filename: string; data: Blob }): Promise<unknown>;
}
interface ClaudeRuntime {
  use(name: string): Promise<unknown>;
}

const ARTIFACT_EXTENSIONS = new Set(['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'txt', 'json', 'md', 'csv', 'html', 'svg', 'pdf', 'zip']);

function runtime(): ClaudeRuntime | null {
  const c = (window as unknown as { claude?: ClaudeRuntime }).claude;
  return c && typeof c.use === 'function' ? c : null;
}

export async function saveFile(filename: string, blob: Blob): Promise<void> {
  const rt = runtime();
  if (rt) {
    const dl = (await rt.use('downloads')) as DownloadsApi | null;
    if (dl) {
      let name = filename;
      let data = blob;
      const ext = (name.split('.').pop() ?? '').toLowerCase();
      if (!ARTIFACT_EXTENSIONS.has(ext)) {
        data = new Blob([zipFiles([{ name: filename, data: new Uint8Array(await blob.arrayBuffer()) }])], { type: 'application/zip' });
        name = filename.replace(/\.[^.]+$/, '') + '.zip';
      }
      await dl.save({ filename: name, data });
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Ask the user for a file (or several) via a hidden <input type="file">. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.onchange = () => {
      resolve(input.files ? [...input.files] : []);
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'miniDaw';
}
