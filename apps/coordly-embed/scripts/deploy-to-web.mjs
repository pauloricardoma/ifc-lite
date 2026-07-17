// Copia o bundle buildado pra web/public/coordly3DViewer/v1.0.0/ (deploy manual,
// igual ao cad-viewer). Roda após `pnpm build`.
import { cp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const DEST = path.resolve(__dirname, '../../../../web/public/coordly3DViewer/v1.0.0');

// Preserva o css/loader.css (é do web/, não vem do build).
await rm(path.join(DEST, 'initCoordly3DViewer.js'), { force: true });
await rm(path.join(DEST, 'assets'), { recursive: true, force: true });
await mkdir(DEST, { recursive: true });

await cp(path.join(DIST, 'initCoordly3DViewer.js'), path.join(DEST, 'initCoordly3DViewer.js'));
await cp(path.join(DIST, 'assets'), path.join(DEST, 'assets'), { recursive: true });

console.log(`[deploy] bundle copiado para ${DEST}`);
