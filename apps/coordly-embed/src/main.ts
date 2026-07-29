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
  // Federação: monta a cena vazia (sem auto-load); o web adiciona modelos via
  // bimHelpers.addModel(). Sem isto, ausência de fileUrl/artifacts vira erro.
  federated?: boolean;
  /**
   * URL do server ifc-lite. Presente = o `.ifc` é parseado NO SERVER e o browser
   * só decodifica o parquet. É o caminho padrão desde que o parse client-side foi
   * descartado (single-thread do motor perde geometria e não há SAB sem isolar).
   */
  serverUrl?: string;
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
    onError: (code, message) => emit('bim-load-error', { code, message }),
    onSelect: (detail) => emit('bim-selection-changed', detail)
  });

  window.bimExec = (cmd: string) => {
    if (cmd === 'zoomfit' || cmd === 'home') { engine.fitToView(); }
  };
  window.bimHelpers = {
    fitToView: () => engine.fitToView(),
    // Federação segue a mesma regra do single: com server configurado, quem
    // tessela é ele — o parse client-side perde geometria no single-thread.
    addModel: (fileUrl: string, modelId: string) => (
      config.serverUrl
        ? engine.addModelFromServerParse(fileUrl, modelId, config.serverUrl)
        : engine.addModelFromIfc(fileUrl, modelId)
    ),
    clearModels: () => engine.clearModels(),
    dispose: () => engine.dispose()
  };

  engine.init().then((ok) => {
    if (!ok) { return; }
    // Artefatos prontos (CDN) > parse no server > parse no browser. O client fica
    // só como fallback explícito, quando não há server configurado.
    if (config.artifacts) { return engine.loadFromArtifacts(config.artifacts); }
    if (config.fileUrl && config.serverUrl) {
      // Padrão: perguntar ao cache antes de subir (`loadFromServerCached`) —
      // arquivo já parseado nem faz upload, e o grande não depende de receber
      // 1.8GB de SSE em base64, que travava a aba.
      //
      // `?mode=sse` força o streaming (bom pra arquivo pequeno: progresso por
      // batch) e `?mode=post` o endpoint inteiro — os dois seguem úteis pra A/B.
      const mode = new URLSearchParams(location.search).get('mode');
      if (mode === 'sse') { return engine.loadFromServerStream(config.fileUrl, config.serverUrl); }
      if (mode === 'post') { return engine.loadFromServerParse(config.fileUrl, config.serverUrl); }
      return engine.loadFromServerCached(config.fileUrl, config.serverUrl);
    }
    if (config.fileUrl) { return engine.loadFromIfc(config.fileUrl); }
    // Federação: cena vazia, o web adiciona modelos via bimHelpers.addModel.
    if (config.federated) { return; }
    emit('bim-load-error', { code: 'no-source', message: 'sem fileUrl nem artifacts' });
  }).catch((err) => emit('bim-load-error', { code: 'boot-failed', message: String(err?.message ?? err) }));

  return { dispose: () => engine.dispose() };
}

(window as any).initCoordly3DViewer = initCoordly3DViewer;

declare global {
  interface Window {
    bimExec: (cmd: string, args?: unknown) => void;
    bimHelpers: {
      fitToView(): void;
      addModel(fileUrl: string, modelId: string): Promise<void>;
      clearModels(): void;
      dispose(): void;
    };
  }
}
