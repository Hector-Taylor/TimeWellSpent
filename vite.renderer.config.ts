import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Keep dev server rooted at src/renderer for convenience, but build from
  // repo root so Forge writes packaged renderer files to .vite/renderer/*.
  root: command === 'serve' ? 'src/renderer' : '.',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared')
    }
  },
  build: {
    sourcemap: true,
    target: 'es2021',
    rollupOptions: {
      input: {
        app: path.resolve(__dirname, './src/renderer/index.html'),
        home: path.resolve(__dirname, './src/renderer/home.html')
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
}));
