import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = (p: string) => path.resolve(__dirname, `../../packages/${p}`);

// base absoluto: worker/wasm viram URLs /coordly3DViewer/v1.0.0/assets/*, que
// resolvem pela origem mesmo com o entry injetado inline (textContent) no web/,
// onde import.meta.url apontaria pro documento.
const BASE = '/coordly3DViewer/v1.0.0/';

export default defineConfig({
  base: BASE,
  plugins: [wasm(), topLevelAwait()],
  worker: { format: 'es', plugins: () => [wasm(), topLevelAwait()] },
  resolve: {
    alias: {
      '@ifc-lite/geometry': pkg('geometry/src'),
      '@ifc-lite/renderer': pkg('renderer/src'),
      '@ifc-lite/spatial': pkg('spatial/src'),
      '@ifc-lite/server-client': pkg('server-client/src'),
      '@ifc-lite/data': pkg('data/src'),
      '@ifc-lite/cache': pkg('cache/src'),
      '@ifc-lite/encoding': pkg('encoding/src'),
      '@ifc-lite/wasm': pkg('wasm/pkg/ifc-lite.js')
    }
  },
  server: {
    port: 3300,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    },
    fs: { allow: ['../..'] }
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      input: path.resolve(__dirname, 'src/main.ts'),
      output: {
        entryFileNames: 'initCoordly3DViewer.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  optimizeDeps: {
    exclude: ['parquet-wasm'],
    esbuildOptions: { target: 'esnext' }
  }
});
