import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` → multi-file build in dist/ (for static hosting / GitHub Pages)
// `npm run build:single` → one self-contained dist-single/index.html (open it directly, no server needed)
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    plugins: single ? [react(), viteSingleFile()] : [react()],
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
