import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared')
    }
  },
  build: {
    sourcemap: true,
    target: 'es2021'
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
});
