import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = (p: string) => path.resolve(__dirname, `../../packages/${p}`);
// ifc-files/ é irmão do ifc-lite/ (coordly/coordly/ifc-files)
const OUTPUT_DIR = path.resolve(__dirname, '../../../ifc-files/output');

// Serve os artefatos gerados de ifc-files/output/ em /artifacts/* (simula a CDN).
// Cai pro static do public/ se não achar (mantém brep/synthetic funcionando).
function serveOutputArtifacts() {
  const safe = (rel: string) => {
    const file = path.join(OUTPUT_DIR, rel);
    return file.startsWith(OUTPUT_DIR) ? file : null;
  };
  return {
    name: 'serve-output-artifacts',
    configureServer(server: any) {
      // POST /save/<path> → grava o body (bytes) em ifc-files/output/<path>
      server.middlewares.use((req: any, res: any, next: any) => {
        if (req.method !== 'POST' || !req.url?.startsWith('/save/')) return next();
        const file = safe(decodeURIComponent(req.url.slice('/save/'.length).split('?')[0]));
        if (!file) { res.statusCode = 403; return res.end(); }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const buf = Buffer.concat(chunks);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, buf);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, bytes: buf.length, path: file }));
        });
      });
      // GET /artifacts/<path> → serve de ifc-files/output/ (simula CDN)
      server.middlewares.use((req: any, res: any, next: any) => {
        if (!req.url?.startsWith('/artifacts/')) return next();
        const file = safe(decodeURIComponent(req.url.slice('/artifacts/'.length).split('?')[0]));
        if (!file) { res.statusCode = 403; return res.end(); }
        fs.readFile(file, (err, buf) => {
          if (err) return next(); // não achou em output/ → deixa o public/ tentar
          if (file.endsWith('.json')) res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(buf);
        });
      });
    }
  };
}

// Os pacotes @ifc-lite/* apontam pra dist/ (não buildado). Aliasamos tudo pra
// src/ — mesmo padrão do apps/viewer — pra o Vite compilar o source direto.
export default defineConfig({
  plugins: [serveOutputArtifacts(), wasm(), topLevelAwait()],
  // o GeometryProcessor roda em workers; eles também precisam do wasm/TLA
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
    port: 3200,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    },
    fs: { allow: ['../..', OUTPUT_DIR] }
  },
  build: { target: 'esnext' },
  optimizeDeps: {
    exclude: ['parquet-wasm'],
    esbuildOptions: { target: 'esnext' }
  }
});
