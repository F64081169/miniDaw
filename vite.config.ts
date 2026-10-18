/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { pwa } from './scripts/pwa-plugin';

// `npm run build` → multi-file build in dist/: an installable app that works offline once
//   opened (service worker + manifest); host it on any static server, e.g. GitHub Pages
// `npm run build:single` → one self-contained dist-single/index.html (open it directly, no server needed)
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    plugins: single ? [react(), viteSingleFile()] : [react(), pwa()],
    publicDir: single ? false : 'public',
    worker: { format: 'es' },
    build: {
      outDir: single ? 'dist-single' : 'dist',
      target: 'es2022',
      chunkSizeWarningLimit: 1500,
    },
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
    },
  };
});
