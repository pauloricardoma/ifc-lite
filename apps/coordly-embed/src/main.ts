import { ViewerEngine, LoadPhase } from './engine.js';
import type { IfcArtifacts } from './types.js';

// Carregado por <script src> (não textContent): assim os imports dinâmicos
// relativos do bundle resolvem contra a URL do script, e o arquivo fica
// cacheável/imutável. O web/ passa os parâmetros aqui e chama a função — sem
// string-replacement de placeholder.
export interface BimConfig {
  fileUrl?: string;
  fileName?: string;
  artifacts?: IfcArtifacts | null;
  container?: HTMLElement;
}

export interface BimInstance {
  dispose(): void;
}

const emit = (name: string, detail?: unknown) =>
  window.dispatchEvent(new CustomEvent(name, { detail }));

export function initCoordly3DViewer(config: BimConfig): BimInstance {
  const container = config.container ?? document.getElementById('bim-container');
  if (!container) { throw new Error('bim-container ausente'); }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block';
  container.appendChild(canvas);

  const engine = new ViewerEngine(canvas, {
    onProgress: (phase: LoadPhase, done, total) => emit('bim-load-progress', { phase, done, total }),
    onLoaded: (detail) => emit('bim-file-loaded', { modelId: config.fileName, ...detail }),
    onError: (code, message) => emit('bim-load-error', { code, message })
  });

  window.bimExec = (cmd: string) => {
    if (cmd === 'zoomfit' || cmd === 'home') { engine.fitToView(); }
  };
  window.bimHelpers = { fitToView: () => engine.fitToView(), dispose: () => engine.dispose() };

  engine.init().then((ok) => {
    if (!ok) { return; }
    if (config.artifacts) { return engine.loadFromArtifacts(config.artifacts); }
    if (config.fileUrl) { return engine.loadFromIfc(config.fileUrl); }
    emit('bim-load-error', { code: 'no-source', message: 'sem fileUrl nem artifacts' });
  }).catch((err) => emit('bim-load-error', { code: 'boot-failed', message: String(err?.message ?? err) }));

  return { dispose: () => engine.dispose() };
}

(window as any).initCoordly3DViewer = initCoordly3DViewer;

declare global {
  interface Window {
    bimExec: (cmd: string, args?: unknown) => void;
    bimHelpers: { fitToView(): void; dispose(): void };
  }
}
