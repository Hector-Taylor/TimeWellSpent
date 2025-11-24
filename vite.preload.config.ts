import { builtinModules } from 'module';
import { defineConfig } from 'vite';
import path from 'path';

const externals = [
  'electron',
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
    outDir: 'out/preload',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        preload: 'src/main/preload.ts'
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js'
      },
      external: externals
    }
  }
});
