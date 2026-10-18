// Read design tokens for canvas drawing; cached and invalidated when the theme changes.

const cache = new Map<string, string>();
const listeners = new Set<() => void>();

function invalidate(): void {
  cache.clear();
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  new MutationObserver(invalidate).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', invalidate);
}

export function cssVar(name: string): string {
  let v = cache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
    cache.set(name, v);
  }
  return v;
}

export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function applyTheme(theme: 'auto' | 'dark' | 'light'): void {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** Canvas sized for the device pixel ratio; returns the 2D context already scaled. */
export function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.floor(width * dpr));
  const h = Math.max(1, Math.floor(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
