import { ViewerEngine, LoadPhase } from './engine.js';
import type { BimEntityProperties, BimTreeNode } from './data-model.js';
import type { Measurement, MeasureMode } from './measure.js';
import type { IfcArtifacts } from './types.js';
import type { SectionPlane } from '@ifc-lite/renderer';

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
    onSelect: (detail) => emit('bim-selection-changed', detail),
    onDataModel: (detail) => emit('bim-datamodel-ready', detail),
    onMeasure: (detail) => emit('bim-measure-changed', detail)
  });

  window.bimExec = (cmd: string) => {
    if (cmd === 'zoomfit' || cmd === 'home') { engine.fitToView(); }
    if (cmd === 'showall') { engine.showAll(); }
  };
  window.bimHelpers = {
    fitToView: () => engine.fitToView(),
    // Árvore espacial e propriedades: dados do MESMO artefato da geometria.
    hasDataModel: () => engine.hasDataModel(),
    getSpatialTree: () => engine.getSpatialTree(),
    getEntityProperties: (expressId: number) => engine.getEntityProperties(expressId),
    getEntityLabels: (expressIds: number[]) => engine.getEntityLabels(expressIds),
    // Seleção da árvore → 3D (o inverso já sai por 'bim-selection-changed').
    select: (expressId: number | null, opts?: { frame?: boolean; additive?: boolean }) =>
      engine.selectEntity(expressId, opts ?? {}),
    clearSelection: () => engine.clearSelection(),
    // Modo "adicionar à seleção" (o botão da toolbar); Ctrl/Shift no clique
    // fazem o mesmo pontualmente.
    setMultiSelect: (enabled: boolean) => engine.setMultiSelect(enabled),
    // X-Ray: o não-selecionado fica translúcido. Ligado sozinho no duplo clique.
    setGhostMode: (enabled: boolean) => engine.setGhostMode(enabled),
    focusSelection: () => engine.focusSelection(),
    frameEntities: (expressIds: number[]) => engine.frameEntities(expressIds),
    isolate: (expressIds: number[] | null) => engine.isolate(expressIds),
    hide: (expressIds: number[]) => engine.hide(expressIds),
    show: (expressIds: number[]) => engine.show(expressIds),
    showAll: () => engine.showAll(),
    setSectionPlane: (section: SectionPlane | null) => engine.setSectionPlane(section),
    // Medição: com um modo ativo o clique vira ponto de medida, não seleção.
    // O resultado sai por 'bim-measure-changed', já com o rótulo formatado.
    setMeasureMode: (mode: MeasureMode) => engine.setMeasureMode(mode),
    clearMeasurements: () => engine.clearMeasurements(),
    deleteMeasurement: (id: string) => engine.deleteMeasurement(id),
    // Federação segue a mesma regra do single: com server configurado, quem
    // tessela é ele — o parse client-side perde geometria no single-thread.
    addModel: (fileUrl: string, modelId: string) => (
      config.serverUrl
        ? engine.addModelFromServerParse(fileUrl, modelId, config.serverUrl)
        : engine.addModelFromIfc(fileUrl, modelId)
    ),
    // Tira UM modelo da cena; os outros ficam como estão (sem re-parse).
    removeModel: (modelId: string) => engine.removeModel(modelId),
    hasModel: (modelId: string) => engine.hasModel(modelId),
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
      hasDataModel(): boolean;
      getSpatialTree(): BimTreeNode[];
      getEntityProperties(expressId: number): BimEntityProperties | null;
      getEntityLabels(expressIds: number[]): { expressId: number; name: string }[];
      select(expressId: number | null, opts?: { frame?: boolean; additive?: boolean }): void;
      clearSelection(): void;
      setMultiSelect(enabled: boolean): void;
      setGhostMode(enabled: boolean): void;
      focusSelection(): void;
      frameEntities(expressIds: number[]): void;
      isolate(expressIds: number[] | null): void;
      hide(expressIds: number[]): void;
      show(expressIds: number[]): void;
      showAll(): void;
      setSectionPlane(section: SectionPlane | null): void;
      setMeasureMode(mode: MeasureMode): void;
      clearMeasurements(): void;
      deleteMeasurement(id: string): void;
      addModel(fileUrl: string, modelId: string): Promise<void>;
      removeModel(modelId: string): void;
      hasModel(modelId: string): boolean;
      clearModels(): void;
      dispose(): void;
    };
  }
}
