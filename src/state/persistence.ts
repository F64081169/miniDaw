// Autosave to IndexedDB (project + recorded audio) and project file save / load.

import { audioPool } from '../audio/audioPool';
import { bufferToChannels, decodeWav, encodeWav } from '../audio/wav';
import { saveFile, safeFilename } from '../core/files';
import type { Project } from '../core/types';
import { debounce } from '../core/util';
import { normalizeProject } from './project';
import { useDaw } from './store';

const DB_NAME = 'minidaw';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

interface StoredAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export async function saveAudio(id: string, buffer: AudioBuffer): Promise<void> {
  const value: StoredAudio = { sampleRate: buffer.sampleRate, channels: bufferToChannels(buffer).map((c) => c.slice()) };
  await idb('readwrite', (s) => s.put(value, `audio:${id}`));
}

function audioIdsOf(p: Project): Set<string> {
  const ids = new Set<string>();
  for (const t of p.tracks) for (const r of t.regions) if (r.kind === 'audio') ids.add(r.audioId);
  return ids;
}

export async function restoreAutosave(): Promise<boolean> {
  const raw = await idb<string>('readonly', (s) => s.get('autosave'));
  if (!raw) return false;
  try {
    const project = normalizeProject(JSON.parse(raw) as Project);
    for (const id of audioIdsOf(project)) {
      const a = await idb<StoredAudio>('readonly', (s) => s.get(`audio:${id}`));
      if (!a) continue;
      const buf = new AudioBuffer({ length: a.channels[0].length, sampleRate: a.sampleRate, numberOfChannels: a.channels.length });
      a.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      audioPool.add(buf, id);
    }
    useDaw.getState().loadProject(project);
    return true;
  } catch {
    return false;
  }
}

export async function hasAutosave(): Promise<boolean> {
  const raw = await idb<string>('readonly', (s) => s.get('autosave'));
  return !!raw;
}

let lastSaved: Project | null = null;

async function writeAutosave(): Promise<void> {
  const s = useDaw.getState();
  const p = s.project;
  if (p === lastSaved) return;
  lastSaved = p;
  await idb('readwrite', (st) => st.put(JSON.stringify({ ...p, updatedAt: Date.now() }), 'autosave'));
  // drop recordings that neither the project nor the undo history refers to
  const keep = audioIdsOf(p);
  for (const h of [...s.past, ...s.future]) for (const id of audioIdsOf(h.project)) keep.add(id);
  const keys = (await idb<IDBValidKey[]>('readonly', (st) => st.getAllKeys())) ?? [];
  for (const k of keys) {
    const key = String(k);
    if (key.startsWith('audio:') && !keep.has(key.slice(6))) await idb('readwrite', (st) => st.delete(key));
  }
}

const autosaveSoon = debounce(() => void writeAutosave(), 1500);

export function initAutosave(): void {
  useDaw.subscribe((s, prev) => {
    if (s.project !== prev.project) autosaveSoon();
  });
  window.addEventListener('beforeunload', () => autosaveSoon.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosaveSoon.flush();
  });
}

// ------------------------------------------------------------------ project files

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

interface ProjectFile {
  format: 'minidaw';
  version: 1;
  project: Project;
  audio: Record<string, string>; // base64 16-bit WAV
}

export async function saveProjectFile(): Promise<void> {
  const p = useDaw.getState().project;
  const audio: Record<string, string> = {};
  for (const id of audioIdsOf(p)) {
    const b = audioPool.get(id);
    if (b) audio[id] = toBase64(new Uint8Array(encodeWav(bufferToChannels(b), b.sampleRate, 16)));
  }
  const file: ProjectFile = { format: 'minidaw', version: 1, project: p, audio };
  await saveFile(`${safeFilename(p.name)}.minidaw.json`, new Blob([JSON.stringify(file)], { type: 'application/json' }));
}

export async function loadProjectFile(f: File): Promise<void> {
  const text = await f.text();
  const data = JSON.parse(text) as ProjectFile;
  if (data.format !== 'minidaw' || !data.project) throw new Error('這不是 miniDaw 專案檔');
  const project = normalizeProject(data.project);
  for (const [id, b64] of Object.entries(data.audio ?? {})) {
    const bytes = fromBase64(b64);
    const { channels, sampleRate } = decodeWav(bytes.buffer as ArrayBuffer);
    const buf = new AudioBuffer({ length: channels[0].length, sampleRate, numberOfChannels: channels.length });
    channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    audioPool.add(buf, id);
    void saveAudio(id, buf);
  }
  useDaw.getState().loadProject(project);
}
