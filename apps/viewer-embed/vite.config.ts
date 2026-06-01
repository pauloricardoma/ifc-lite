import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import fs from 'fs';

// Read version from root package.json
const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')
);

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __RELEASE_HISTORY__: JSON.stringify([]),
  },
  resolve: {
    alias: {
      // Point @ to the main viewer's src so Viewport, hooks, and store resolve correctly
      '@': path.resolve(__dirname, '../viewer/src'),
      '@ifc-lite/parser': path.resolve(__dirname, '../../packages/parser/src'),
      '@ifc-lite/geometry': path.resolve(__dirname, '../../packages/geometry/src'),
      '@ifc-lite/renderer': path.resolve(__dirname, '../../packages/renderer/src'),
      '@ifc-lite/query': path.resolve(__dirname, '../../packages/query/src'),
      '@ifc-lite/server-client': path.resolve(__dirname, '../../packages/server-client/src'),
      '@ifc-lite/spatial': path.resolve(__dirname, '../../packages/spatial/src'),
      '@ifc-lite/data': path.resolve(__dirname, '../../packages/data/src'),
      '@ifc-lite/bcf': path.resolve(__dirname, '../../packages/bcf/src'),
      '@ifc-lite/cache': path.resolve(__dirname, '../../packages/cache/src'),
      // Resolve collab from source: the embed pulls it via the viewer's source
      // (not its own package.json), so it's outside Vercel's scoped build and
      // its dist isn't produced — aliasing to src avoids the missing-entry fail.
      '@ifc-lite/collab': path.resolve(__dirname, '../../packages/collab/src'),
      '@ifc-lite/drawing-2d': path.resolve(__dirname, '../../packages/drawing-2d/src'),
      '@ifc-lite/export': path.resolve(__dirname, '../../packages/export/src'),
      '@ifc-lite/ids': path.resolve(__dirname, '../../packages/ids/src'),
      '@ifc-lite/ifcx': path.resolve(__dirname, '../../packages/ifcx/src'),
      '@ifc-lite/mutations': path.resolve(__dirname, '../../packages/mutations/src'),
      '@ifc-lite/sandbox/schema': path.resolve(__dirname, '../../packages/sandbox/src/bridge-schema.ts'),
      '@ifc-lite/sdk': path.resolve(__dirname, '../../packages/sdk/src'),
      '@ifc-lite/sandbox': path.resolve(__dirname, '../../packages/sandbox/src'),
      '@ifc-lite/embed-protocol': path.resolve(__dirname, '../../packages/embed-protocol/src'),
      '@ifc-lite/encoding': path.resolve(__dirname, '../../packages/encoding/src'),
      '@ifc-lite/lens': path.resolve(__dirname, '../../packages/lens/src'),
      '@ifc-lite/lists': path.resolve(__dirname, '../../packages/lists/src'),
      '@ifc-lite/create': path.resolve(__dirname, '../../packages/create/src'),
      '@ifc-lite/wasm': path.resolve(__dirname, '../../packages/wasm/pkg/ifc-lite.js'),
      // `@ifc-lite/collab` lazily `import('y-webrtc')` for its optional WebRTC
      // transport, which the embed never uses (it runs indexeddb+websocket).
      // y-webrtc isn't installed, so alias it to the viewer's stub — otherwise
      // Vite/Rollup fails resolving the never-executed import. (Mirrors the
      // viewer's config; also marked external in rollupOptions below.)
      'y-webrtc': path.resolve(__dirname, '../viewer/src/services/y-webrtc-stub.ts'),
    },
  },
  server: {
    port: 3001,
    headers: {
      // Use credentialless instead of require-corp for iframe compatibility
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    fs: {
      allow: ['../..'],
    },
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      // Desktop-only Tauri APIs are dynamically imported in shared viewer code.
      // They are never reached at runtime in the embed build, but Rollup still
      // resolves them statically. Externalizing prevents the build failure.
      external: [
        '@tauri-apps/api/core',
        '@tauri-apps/plugin-dialog',
        '@tauri-apps/plugin-fs',
        '@tauri-apps/plugin-shell',
        // Optional collab WebRTC transport — not installed, never used in the
        // embed (lazy `import('y-webrtc')` with a runtime fallback).
        'y-webrtc',
      ],
    },
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm', '@ifc-lite/wasm', 'parquet-wasm', 'y-webrtc'],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
});
