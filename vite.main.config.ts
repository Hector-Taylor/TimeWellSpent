import { builtinModules } from 'module';
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const externals = [
  'electron',
  'bufferutil',
  'utf-8-validate',
  'better-sqlite3',
  'active-win',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`)
];

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
      '@main': path.resolve(__dirname, './src/main'),
      '@renderer': path.resolve(__dirname, './src/renderer'),
      '@backend': path.resolve(__dirname, './src/backend')
    }
  },
  build: {
    outDir: 'out/main',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        main: 'src/main/main.ts'
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js'
      },
      external: externals
    }
  }
});
