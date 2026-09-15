import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = (p: string) => path.resolve(__dirname, `../../packages/${p}`);
// ifc-files/ é irmão do ifc-lite/ (coordly/coordly/ifc-files); é onde o
// scripts/coordly-ingest.mjs grava os 6 artefatos de cada modelo.
const OUTPUT_DIR = path.resolve(__dirname, '../../../ifc-files/output');

// base absoluto: worker/wasm viram URLs /coordly3DViewer/v1.0.0/assets/*, que
// resolvem pela origem mesmo com o entry injetado inline (textContent) no web/,
// onde import.meta.url apontaria pro documento.
const BASE = '/coordly3DViewer/v1.0.0/';

/**
 * Só no dev: serve ifc-files/output/ em /artifacts/* COM Range, simulando o Blob
 * Storage. Sem 206 aqui o parquet-wasm baixaria o arquivo inteiro a cada leitura
 * e o teste do split seria falso (mesma lição do apps/artifact-poc).
 */
function serveOutputArtifacts() {
  return {
    name: 'serve-output-artifacts',
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        if (!req.url?.startsWith('/artifacts/')) return next();
        const rel = decodeURIComponent(req.url.slice('/artifacts/'.length).split('?')[0]);
        const file = path.join(OUTPUT_DIR, rel);
        if (!file.startsWith(OUTPUT_DIR)) { res.statusCode = 403; return res.end(); }
        fs.stat(file, (err, st) => {
          if (err) { res.statusCode = 404; return res.end(); }
          if (file.endsWith('.json')) res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Accept-Ranges', 'bytes');

          // `bytes=a-b`, `bytes=a-` e o sufixo `bytes=-n` (últimos n bytes — é
          // assim que o fromUrl acha o footer).
          const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
          if (!m || (!m[1] && !m[2])) {
            res.setHeader('Content-Length', st.size);
            return fs.createReadStream(file).pipe(res);
          }
          const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
          const end = m[1] ? (m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1) : st.size - 1;
          if (start > end || start >= st.size) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${st.size}`);
            return res.end();
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
          res.setHeader('Content-Length', end - start + 1);
          fs.createReadStream(file, { start, end }).pipe(res);
        });
      });
    }
  };
}

export default defineConfig({
  base: BASE,
  // Carimbo do build: o bundle é copiado à mão pro web/, então "o que está na tela
  // é a versão nova?" é a primeira pergunta de todo bug daqui.
  define: {
    __ENGINE_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  plugins: [serveOutputArtifacts(), wasm(), topLevelAwait()],
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
    fs: { allow: ['../..', OUTPUT_DIR] }
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
