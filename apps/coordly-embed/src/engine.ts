import { Renderer, DEFAULT_CHUNK_CELL_SIZE } from '@ifc-lite/renderer';
import type { SectionPlane } from '@ifc-lite/renderer';
import { GeometryProcessor, decodeInstancedShard } from '@ifc-lite/geometry';
import type { TessellationQuality } from '@ifc-lite/geometry';
import { decodeStdParquetStreaming } from './parquet-stream.js';
import { MeasureTool } from './measure-tool.js';
import type { Measurement, MeasureMode, Vec3 } from './measure.js';
import { ModelDataStore } from './data-model.js';
import type { BimEntityProperties, BimTreeNode } from './data-model.js';
import type { IfcArtifacts } from './types.js';

// O data model é escrito no cache DEPOIS da geometria (o server responde o
// parquet e grava o resto em background), então um 202 logo após o load é
// normal — não é erro, é "ainda não".
const DATA_MODEL_POLL = { intervalMs: 3000, quickAttempts: 3, attempts: 40 };

// Sufixo do `cache_key` do server: `{sha256}-{opening_filter}{-qualidade}`.
// Nunca mandamos `opening_filter` nem `tessellation_quality` nas chamadas, então
// o server resolve os defaults — `default` e `medium` (medium não gera sufixo).
const DEFAULT_OPENING_FILTER = 'default';


const GPU_BUDGET_MB = 2048;
const LOD = { screenPx: 48 };
const CONTRIB_CULL = { pixelRadius: 0.5, interactingPixelRadius: 2 };

/**
 * Kill switches de diagnóstico por query param — lidos ANTES do boot, porque knob
 * resolvido depois do load mede a config errada (lição do A/B de residência).
 *
 *   ?filter=0   não esconde nada por ifcType (abertura/espaço/zona/virtual)
 *   ?lod=0      desliga LOD1
 *   ?cull=0     desliga contribution culling
 *   ?budget=0   desliga o GPU residency budget
 */
const flag = (name: string): boolean => {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  return params.get(name) !== '0';
};

export type LoadPhase = 'download' | 'parse' | 'decode' | 'upload';

interface EngineEvents {
  onProgress(phase: LoadPhase, done: number, total: number): void;
  onLoaded(detail: { elementCount: number; schema?: string }): void;
  onError(code: string, message: string): void;
  onSelect(detail: {
    expressId: number | null;
    modelIndex: number;
    /** Seleção completa (multi-seleção); `expressId` é o último clicado. */
    expressIds: number[];
  }): void;
  // Árvore espacial e propriedades ficam disponíveis; chega depois do render
  // porque o data model é buscado sem bloquear a geometria.
  // `modelIndex` presente = data model de UM modelo federado; ausente = viewer
  // de arquivo unico. E assim que o app sabe a qual modelo a arvore pertence.
  onDataModel(detail: { available: boolean; modelIndex?: number; modelId?: string }): void;
  /** Modo + lista completa a cada mudança (criar, remover, limpar, sair). */
  onMeasure(detail: { mode: MeasureMode; measurements: Measurement[] }): void;
}

// Clique = pointerdown→up sem passar deste deslocamento acumulado (CSS px).
// Acima disso é orbit/pan, não seleção.
const CLICK_DRAG_PX = 5;

/**
 * Faixa de expressId reservada por modelo federado.
 *
 * Por que existe: a remoção da cena (`scene.removeMeshesForEntities`) é por
 * expressId e NÃO filtra por modelo — e disciplinas diferentes reusam os mesmos
 * ids. Sem separar as faixas, desligar uma disciplina apagaria malhas de outra
 * que tivessem o mesmo id. Com o offset, cada modelo ocupa um intervalo próprio
 * e sai da cena sozinho, sem o clear + re-add de todos os outros.
 *
 * O tamanho é um compromisso: o id vai pra GPU como u32 (teto ~4.29e9), então
 * 50M por modelo dá ~85 disciplinas — folgado para as 29 medidas — e cabe
 * qualquer IFC real (o de 264MB não chega a 3M entidades).
 *
 * `modelIndex` continua carimbado e é o que o highlight usa; o offset resolve
 * só a remoção. Os dois convivem.
 */
const MODEL_ID_STEP = 50_000_000;

/** Desfaz o offset: o mundo fora do engine só conhece o expressId do arquivo. */
const localExpressId = (expressId: number): number => expressId % MODEL_ID_STEP;

interface FederatedModel {
  /** Id que o app usa (no Coordly, o urn) — volta nos eventos do data model. */
  id: string;
  index: number;
  idOffset: number;
  /** Ids (já deslocados) que este modelo pôs na cena — o que `removeModel` tira. */
  ids: Set<number>;
  /**
   * Data model DESTE modelo. Na federação cada arquivo tem a sua hierarquia e
   * as suas propriedades: um store só (o campo `dataStore` do motor, usado no
   * viewer de arquivo único) seria sobrescrito a cada modelo carregado e o
   * último venceria.
   */
  dataStore: ModelDataStore | null;
}

// Tipos que o viewer de referência esconde por padrão — espelha
// `TYPE_VISIBILITY_SEMANTIC_DEFAULTS` (apps/viewer/src/store/constants.ts), com o
// motivo que eles registram lá: "they cover walls".
//
// O motor emite essa geometria de propósito (um IfcOpeningElement TEM representação
// própria no IFC); esconder é decisão do app, e o nosso é irmão do apps/viewer, não
// um fork dele — nada disso vem de graça. Sem o filtro, as aberturas desenham caixas
// sólidas dentro dos vazios de viga e o modelo parece fatiado (o "corte" que
// perseguimos no CSG e no single-thread: a geometria sempre esteve correta).
const HIDDEN_IFC_TYPES = new Set([
  'IFCOPENINGELEMENT',
  'IFCSPACE',
  'IFCSPATIALZONE',
  'IFCVIRTUALELEMENT',
]);

// O engine normaliza o tipo pra maiúsculas em alguns caminhos e preserva o casing
// de exibição em outros (#1470), então a comparação é case-insensitive.
const isHiddenIfcType = (ifcType?: string): boolean =>
  !!ifcType && HIDDEN_IFC_TYPES.has(ifcType.toUpperCase());

// Contador de diagnóstico: sem ele não dá pra distinguir "o filtro não pegou"
// (tipo com outro nome/ausente) de "o filtro pegou e o sintoma é outro".
let hiddenMeshCount = 0;

// ⚠️ Todo `catch` de carga checa `this.disposed` ANTES de reportar erro.
// Abortar um fetch depois dos headers (durante `blob()`/`arrayBuffer()`) NÃO gera
// `AbortError`: o browser devolve `TypeError: Failed to fetch` e loga
// `net::ERR_FAILED 200 (OK)`. Como o React StrictMode monta → desmonta → monta em
// dev, o engine descartado no meio do download reportava esse erro e o app caía no
// fallback Autodesk — mesmo com a segunda instância carregando normalmente.
// Filtrar pela MENSAGEM seria errado: mascararia CORS real.


/**
 * Opções do GeometryProcessor, espelhando `apps/viewer/src/hooks/useIfcLoader.ts`.
 *
 * `skipSmallCuts` é o ponto onde divergimos deles: o viewer de referência só liga
 * no modo "fast" (primeiro paint rápido, #1286) e mantém TODO corte no modo exato.
 * Nós ligávamos sempre, o que pula cortes booleanos que eles aplicam.
 *
 * Fica atrás de query param pra permitir A/B sem rebuild — e lido aqui, no load,
 * porque knob resolvido em escopo de módulo já chega tarde (lição do A/B de
 * residência/quantização).
 */
const geometryOptions = () => {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const skipSmallCuts = params.get('skipSmallCuts') !== '0';
  const tessellationQuality = (params.get('tess') ?? 'medium') as TessellationQuality;
  console.log(`[coordly-embed] geometria: skipSmallCuts=${skipSmallCuts} tess=${tessellationQuality}`);
  return { tessellationQuality, skipSmallCuts };
};

interface SseEvent {
  type: 'start' | 'progress' | 'batch' | 'complete' | 'error';
  data?: string;
  message?: string;
  processed?: number;
  total?: number;
  [k: string]: unknown;
}

/**
 * Lê eventos SSE do corpo da resposta. Um `batch` pode passar de 1MB em base64 e
 * chega picotado entre chunks da rede, então o buffer só emite em `\n\n` (fim de
 * evento) — cortar por chunk entregaria JSON pela metade.
 */
async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) { break; }
    buffer += decoder.decode(value, { stream: true });

    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const payload = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (payload) {
        try { yield JSON.parse(payload) as SseEvent; }
        catch { /* keep-alive/comentário: ignora */ }
      }
      sep = buffer.indexOf('\n\n');
    }
  }
}

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
  return out;
};

const visibleOnly = <T extends { ifcType?: string }>(meshes: T[]): T[] => {
  if (!flag('filter')) { return meshes; }
  const kept = meshes.filter((mesh) => !isHiddenIfcType(mesh.ifcType));
  hiddenMeshCount += meshes.length - kept.length;
  return kept;
};

export class ViewerEngine {
  private renderer!: Renderer;
  private camera: any;
  private disposed = false;
  private aborter = new AbortController();
  private restoreErrorLogged = false;
  private restoreConsole: (() => void) | null = null;
  // Seleção (single). Passada por frame pro renderer, que aplica o highlight
  // (instanced + flat) internamente — não é estado guardado no renderer.
  private selectedId: number | null = null;
  // Cru do pick (undefined em modelo único). NÃO coagir pra 0: o highlight do
  // caminho flat filtra por modelIndex, e as malhas de modelo único têm
  // modelIndex undefined → passar 0 filtraria o highlight fora.
  private selectedModelIndex: number | undefined = undefined;
  // Multi-seleção: ids DA CENA (com offset federado). `selectedId` é o último
  // clicado — é dele que saem as propriedades no painel.
  private selectedIds = new Set<number>();
  // Modo "adicionar à seleção" da toolbar. Ctrl/Shift no clique fazem o mesmo
  // pontualmente, sem precisar entrar no modo.
  private multiSelect = false;
  // X-Ray: tudo que não está selecionado fica translúcido. Ligado no duplo
  // clique porque enquadrar um elemento cercado de paredes não adianta se elas
  // continuam opacas na frente dele.
  private ghost = false;
  // Federação: modelId → estado do modelo na cena. O 1º modelo fixa o frame de
  // coordenadas; os demais reusam via sharedRtcOffset pra ficarem alinhados.
  private models = new Map<string, FederatedModel>();
  // Monotônico, NÃO `models.size`: remover um modelo e adicionar outro reusaria
  // o índice/offset do que saiu e misturaria os dois.
  private nextModelSlot = 0;
  // Diagnóstico de estouro da faixa de id federada: uma vez por sessão basta.
  private idOverflowLogged = false;
  private federationRtc: { x: number; y: number; z: number } | undefined;
  // Atributos/Psets/Qtos/hierarquia do MESMO artefato da geometria. Null até o
  // data model chegar (ou pra sempre, se o modelo veio por um caminho que não o
  // publica — o render nunca depende dele).
  private dataStore: ModelDataStore | null = null;
  // Visibilidade e corte são estado do app, aplicados POR FRAME no render() —
  // mesmo contrato do selectedId. O renderer compara por conteúdo, então passar
  // o mesmo Set todo frame não invalida cache.
  private hiddenIds = new Set<number>();
  private isolatedIds: Set<number> | null = null;
  private section: SectionPlane | null = null;
  // Criada no init(), quando já existe câmera para projetar o overlay.
  private measure: MeasureTool | null = null;

  constructor(private canvas: HTMLCanvasElement, private events: EngineEvents) {}

  // Campo (não método) pra manter a mesma referência no add/removeEventListener.
  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed) { return; }
    if (e.key !== 'Escape' && e.key !== 'Enter') { return; }
    // Não roubar a tecla de quem está digitando num campo do app.
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) { return; }

    if (e.key === 'Enter') {
      if (this.measure?.handleDoubleClick()) { this.renderer?.requestRender(); }
      return;
    }
    // Esc: a medição vem primeiro — é o que o usuário está fazendo. Sai da ação
    // inteira (traçado + ferramenta), por isso o cursor volta junto.
    if (this.measure?.cancel()) {
      this.canvas.style.cursor = '';
      this.renderer?.requestRender();
      return;
    }
    if (this.selectedIds.size > 0) { this.clearSelection(); }
  };

  // O motor de geometria (JS + WASM) cospe diagnóstico verboso do pipeline de
  // aberturas/camadas. Não dá pra tirar no build (parte vem do wasm) nem patchar
  // packages/ — filtramos por prefixo enquanto o viewer vive.
  private silenceEngineLogs(): void {
    const noisy = /^\[(ifc-lite|IFC-LITE)/;
    const orig = { log: console.log, warn: console.warn };
    const wrap = (fn: (...a: any[]) => void) => (...args: any[]) =>
      (typeof args[0] === 'string' && noisy.test(args[0])) ? undefined : fn(...args);
    console.log = wrap(orig.log);
    console.warn = wrap(orig.warn);
    this.restoreConsole = () => { console.log = orig.log; console.warn = orig.warn; };
  }

  async init(): Promise<boolean> {
    this.silenceEngineLogs();

    const gpu = (navigator as any).gpu;
    if (!gpu || !(await gpu.requestAdapter())) {
      this.events.onError('no-webgpu', 'WebGPU indisponível');
      return false;
    }

    this.fitCanvas();
    this.renderer = new Renderer(this.canvas);
    await this.renderer.init();
    this.camera = this.renderer.getCamera();

    // Ordem importa: o bucketing tem de ser configurado antes de qualquer
    // geometria entrar na cena. Ganho de memória medido vem do quantized (12B).
    const scene = this.renderer.getScene();
    scene.setSpatialChunking({ cellSize: DEFAULT_CHUNK_CELL_SIZE });
    if (flag('budget')) { scene.setGpuResidencyBudget(GPU_BUDGET_MB * 1024 * 1024); }
    scene.setLodBuildsEnabled(flag('lod'));
    if (flag('quant')) { await this.renderer.enableQuantizedBatches(); }
    console.log(
      `[coordly-embed] render: filter=${flag('filter')} lod=${flag('lod')} ` +
      `cull=${flag('cull')} budget=${flag('budget')} quant=${flag('quant')}`,
    );

    (globalThis as any).__ifc_lite_render_stats__ = () => ({
      frame: this.renderer.getFrameStats(),
      gpu: this.renderer.getScene().getResidentGpuBytes(),
      cpuBytes: this.renderer.getScene().getResidentCpuBytes()
    });

    this.measure = new MeasureTool({
      container: this.canvas.parentElement ?? this.canvas,
      project: (point) => this.projectToScreen(point),
      raycast: (x, y) => this.raycastWorld(x, y),
      onChange: (state) => this.events.onMeasure(state),
    });

    this.wireControls();
    this.startLoop();
    return true;
  }

  /**
   * Mundo → px CSS. `projectToScreen` devolve coordenada do DRAWING BUFFER, que
   * é alinhado pra baixo em múltiplo de 64 e portanto um pouco mais estreito que
   * a caixa CSS: sem reescalar, o overlay desgruda do cursor, cada vez mais perto
   * da borda direita.
   */
  private projectToScreen(point: Vec3): { x: number; y: number } | null {
    const projected = this.camera?.projectToScreen(point, this.canvas.width, this.canvas.height);
    if (!projected) { return null; }
    const rect = this.canvas.getBoundingClientRect();
    if (!this.canvas.width || !this.canvas.height || !rect.width) { return projected; }
    return {
      x: projected.x * (rect.width / this.canvas.width),
      y: projected.y * (rect.height / this.canvas.height),
    };
  }

  /** Ponto de superfície sob o cursor, com snap a vértice/aresta/face. */
  private raycastWorld(x: number, y: number): Vec3 | null {
    const hit = this.renderer?.raycastScene(x, y, {
      hiddenIds: this.hiddenIds,
      isolatedIds: this.isolatedIds,
      snapOptions: { snapToVertices: true, snapToEdges: true, snapToFaces: true, screenSnapRadius: 40 },
    });
    if (!hit) { return null; }
    // O snap ganha do ponto cru: medir aresta a aresta é o caso comum, e sem ele
    // cada clique cai a alguns milímetros da quina.
    return hit.snap?.position ?? hit.intersection?.point ?? null;
  }

  // Parse do .ifc no browser. Com cross-origin isolation vai pro caminho
  // paralelo (SAB + workers); sem ela, processAdaptive tentaria transferir SAB
  // pros workers e falharia — então roteamos pro processStreaming single-thread.
  // O tamanho já vem limitado pela flag (n MB), o que mantém o single-thread viável.
  async loadFromIfc(fileUrl: string): Promise<void> {
    // `?parallel=0` força o caminho single mesmo com isolamento — é o que permite
    // comparar single × paralelo no MESMO app/arquivo/máquina, sem depender de
    // COOP/COEP para trocar de caminho.
    const isolated = typeof self !== 'undefined' && self.crossOriginIsolated && flag('parallel');
    console.log(`[coordly-embed] parse: ${isolated ? 'paralelo (SAB)' : 'single-thread (sem cross-origin isolation)'}`);

    try {
      this.events.onProgress('download', 0, 1);
      const res = await fetch(fileUrl, { signal: this.aborter.signal });
      if (!res.ok) { throw new Error(`download do .ifc → ${res.status}`); }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (this.disposed) { return; }
      this.events.onProgress('download', 1, 1);

      const gp = new GeometryProcessor(geometryOptions());
      await gp.init();

      const scene = this.renderer.getScene();
      const device = this.renderer.getGPUDevice();
      scene.clear();

      let meshCount = 0;
      let framed = false;

      const stream = isolated
        ? gp.processAdaptive(bytes, { sizeThreshold: 2 * 1024 * 1024 })
        : gp.processStreaming(bytes);

      for await (const ev of stream) {
        if (this.disposed) { return; }
        if (ev.type !== 'batch') { continue; }

        const meshes = visibleOnly(ev.meshes);
        if (meshes.length > 0) {
          this.renderer.addMeshes(meshes, true);
          meshCount += meshes.length;
        }

        // Geometria opaca repetida vem só como shard de instancing; sem subir
        // pra GPU ela some do modelo.
        //
        // ⚠️ O filtro de tipo acima NÃO alcança este caminho: `DecodedInstance` só
        // carrega `entityId`, sem ifcType, então não há como saber aqui que uma
        // ocorrência é abertura. No parse paralelo as aberturas vêm justamente por
        // aqui (medido: 1477 de 2419 ocorrências instanciadas). Filtrar exige o mapa
        // expressId→ifcType do IfcDataStore, que este app ainda não constrói — é o
        // mesmo pré-requisito da fatia de propriedades. Enquanto isso o caminho
        // paralelo pode desenhar aberturas instanciadas.
        if (device && ev.instancedShards?.length) {
          for (const buf of ev.instancedShards) {
            try {
              const shard = decodeInstancedShard(new Uint8Array(buf));
              if (shard) { scene.addInstancedShard(device, shard); }
            } catch (err) {
              // Não é fatal (a geometria flat continua), mas engolir em silêncio
              // esconderia perda de modelo inteiro — 942 colunas/vigas dependem
              // deste caminho no arquivo de teste.
              console.warn('[coordly-embed] shard instanciado ignorado:', err);
            }
          }
        }

        this.renderer.requestRender();
        if (!framed && meshCount > 0) { this.renderer.fitToView(); framed = true; }
        this.events.onProgress('parse', meshCount, meshCount);
      }

      this.finishLoad(meshCount);
    } catch (err: any) {
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('parse-failed', String(err?.message ?? err));
    }
  }

  /**
   * Parse NO SERVER (ifc-lite server Rust) — caminho padrão desde 2026-07-28.
   *
   * Substitui o parse client-side, que foi descartado: o `processStreaming`
   * (single-thread) do motor perde geometria, e sem cross-origin isolation não há
   * SharedArrayBuffer para usar o caminho paralelo — isolar foi rejeitado (quebra a
   * tela de Painéis / UX de reload).
   *
   * Aqui o browser não tessela nada: manda o `.ifc`, recebe o container parquet já
   * tesselado e só decodifica por row group — o mesmo caminho provado do CDN
   * (1.3GB e 29 disciplinas). Sem CSG no cliente, sem SAB, sem isolamento.
   */
  async loadFromServerParse(fileUrl: string, serverUrl: string): Promise<void> {
    console.log('[coordly-embed] parse: SERVER (ifc-lite)');

    try {
      const geometry = await this.parseOnServer(fileUrl, serverUrl);
      if (this.disposed) { return; }
      await this.renderParquet(geometry);
    } catch (err: any) {
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('server-parse-failed', String(err?.message ?? err));
    }
  }

  /**
   * Decode por row group + append progressivo — comum ao server, ao CDN e à
   * federação. `modelIndex` (quando informado) é carimbado por malha: é o que
   * separa as disciplinas sem colisão de expressId, e é o caminho já provado com
   * as 29 disciplinas do R2.
   */
  private async renderParquet(
    geometry: Blob,
    opts: { additive?: boolean; model?: FederatedModel } = {},
  ): Promise<void> {
    if (!opts.additive) { this.renderer.getScene().clear(); }
    let meshCount = 0;
    let framed = opts.additive === true; // federação: não reenquadra a cada modelo

    for await (const chunk of decodeStdParquetStreaming(geometry)) {
      if (this.disposed) { return; }
      const meshes = this.prepareMeshes(chunk, opts.model);
      this.renderer.addMeshes(meshes as any, true);
      meshCount += meshes.length;
      this.renderer.requestRender();
      if (!framed && meshCount > 0) { this.renderer.fitToView(); framed = true; }
      this.events.onProgress('decode', meshCount, meshCount);
    }

    this.finishLoad(meshCount);
  }

  /**
   * Filtra os tipos escondidos e carimba a disciplina (federação). Compartilhado
   * pelo decode de container inteiro (`renderParquet`) e pelo de batch do SSE —
   * os dois põem malha na cena e precisam do mesmo tratamento de id.
   */
  private prepareMeshes<T extends { ifcType?: string; expressId: number }>(
    chunk: T[],
    model?: FederatedModel,
  ): T[] {
    const meshes = visibleOnly(chunk);
    if (!model) { return meshes; }

    for (const mesh of meshes) {
      (mesh as any).modelIndex = model.index;
      if (mesh.expressId >= MODEL_ID_STEP && !this.idOverflowLogged) {
        // Estourar a faixa faria o id cair no intervalo do modelo vizinho:
        // a remoção começaria a apagar a disciplina errada. Nunca visto em
        // modelo real, mas é o tipo de coisa que não pode falhar em silêncio.
        this.idOverflowLogged = true;
        console.warn(
          `[coordly-embed] expressId ${mesh.expressId} passa da faixa de ${MODEL_ID_STEP} por modelo`,
        );
      }
      mesh.expressId += model.idOffset;
      model.ids.add(mesh.expressId);
    }
    return meshes;
  }

  /**
   * Força o parse por streaming ignorando o cache (`?mode=sse`). Serve pra A/B e
   * pra reprocessar um arquivo cujo cache está velho — o caminho normal
   * (`loadFromServerCached`) já usa o streaming sozinho quando dá MISS.
   */
  async loadFromServerStream(fileUrl: string, serverUrl: string): Promise<void> {
    console.log('[coordly-embed] parse: SERVER STREAMING (SSE, forçado)');

    try {
      const ifcBlob = await this.downloadIfc(fileUrl);
      if (this.disposed) { return; }

      await this.streamFromServer(ifcBlob, serverUrl);
      if (this.disposed) { return; }

      // Hash só agora: são segundos de CPU num arquivo grande, e antes do render
      // eles atrasariam o primeiro paint sem necessidade — aqui o modelo já está
      // na tela e o que falta é só a árvore.
      void this.loadDataModel(await this.hashBlob(ifcBlob), serverUrl, ifcBlob);
    } catch (err: any) {
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('server-parse-failed', String(err?.message ?? err));
    }
  }

  /**
   * Parse no server via SSE (`/api/v1/parse/parquet-stream`), com render
   * progressivo. É o caminho de todo cache MISS.
   *
   * O endpoint não-streaming (`parse/parquet`) fica minutos calado tesselando
   * antes de responder o primeiro byte, e o gateway do Azure derruba conexão
   * ociosa (~230s) com 502 — foi o que matou o modelo de 264MB. Pior: naquele
   * endpoint a gravação do cache só acontece DEPOIS do parse inteiro, dentro do
   * mesmo handler, então o corte do gateway descartava os ~250s de trabalho e a
   * abertura seguinte dava MISS de novo. Aqui não: o SSE manda keep-alive (a
   * conexão nunca fica ociosa) e o server grava o cache incrementalmente, batch a
   * batch, além de extrair o data model num `tokio::spawn` dono dos bytes.
   *
   * O custo é o base64 dos batches, pago só na primeira abertura de cada arquivo
   * — da segunda em diante o HIT vem binário por `fetchCachedGeometry`.
   */
  private async streamFromServer(
    ifcBlob: Blob,
    serverUrl: string,
    opts: { additive?: boolean; model?: FederatedModel } = {},
  ): Promise<void> {
    const form = new FormData();
    form.append('file', ifcBlob, 'model.ifc');

    const endpoint = this.serverEndpoint(serverUrl, 'api/v1/parse/parquet-stream');
    console.log(`[coordly-embed] enviando ${(ifcBlob.size / 1024 / 1024).toFixed(1)}MB para ${endpoint}`);

    const parsed = await fetch(endpoint, {
      method: 'POST',
      body: form,
      signal: this.aborter.signal,
    }).catch((err) => {
      throw new Error(`POST ao server de parse falhou (rede/CORS): ${err?.message ?? err}`);
    });
    if (!parsed.ok) {
      const body = await parsed.text().catch(() => '');
      throw new Error(`server de parse → ${parsed.status} ${parsed.statusText} ${body}`.trim());
    }
    if (!parsed.body) { throw new Error('resposta do server sem corpo streamável'); }

    if (!opts.additive) { this.renderer.getScene().clear(); }
    let meshCount = 0;
    let framed = opts.additive === true;

    for await (const ev of readSseEvents(parsed.body)) {
      if (this.disposed) { return; }

      if (ev.type === 'error') { throw new Error(`server: ${ev.message}`); }
      if (ev.type === 'progress') {
        this.events.onProgress('parse', ev.processed ?? 0, ev.total ?? 0);
        continue;
      }
      if (ev.type !== 'batch' || !ev.data) { continue; }

      const container = new Blob([base64ToBytes(ev.data)]);
      for await (const chunk of decodeStdParquetStreaming(container)) {
        if (this.disposed) { return; }
        const meshes = this.prepareMeshes(chunk, opts.model);
        this.renderer.addMeshes(meshes as any, true);
        meshCount += meshes.length;
      }

      this.renderer.requestRender();
      if (!framed && meshCount > 0) { this.renderer.fitToView(); framed = true; }
      this.events.onProgress('decode', meshCount, meshCount);
    }

    this.finishLoad(meshCount);
  }

  /**
   * Baixa o `.ifc` como Blob — que vive no armazenamento em disco do browser, não
   * no heap — e vai direto pro FormData, sem cópia intermediária.
   *
   * ⚠️ `arrayBuffer()` aqui é armadilha: são os bytes na RAM, e montar o Blob do
   * FormData a partir deles DOBRA o pico (264MB viram ~530MB) — o Chrome derruba o
   * upload com `ERR_CONNECTION_RESET`. Medido: 280MB sobem sem erro por fora do
   * browser, então o teto não é do server (cap 500MB) nem do gateway.
   *
   * Se o `blob()` falhar com `net::ERR_FAILED 200` + `Failed to fetch`, a causa é
   * DISCO CHEIO (o corpo não tem onde ser gravado), não rede.
   */
  private async downloadIfc(fileUrl: string): Promise<Blob> {
    this.events.onProgress('download', 0, 1);
    console.log('[coordly-embed] baixando .ifc:', fileUrl);
    const res = await fetch(fileUrl, { signal: this.aborter.signal }).catch((err) => {
      // Falha de rede/CORS não tem status: sem distinguir do 4xx/5xx, o fallback
      // engole a causa e sobra só "server-parse-failed".
      throw new Error(`download do .ifc falhou (rede/CORS): ${err?.message ?? err}`);
    });
    if (!res.ok) { throw new Error(`download do .ifc → ${res.status}`); }

    const blob = await res.blob().catch((err) => {
      throw new Error(`leitura do .ifc falhou (disco cheio?): ${err?.message ?? err}`);
    });
    this.events.onProgress('download', 1, 1);
    return blob;
  }

  /**
   * Caminho padrão do modo server. Ordem: perguntar antes de mandar.
   *
   *   1. sha256 do arquivo → `cache/check`
   *   2. JÁ TEM  → baixa a geometria pronta, binária, sem upload nenhum
   *   3. NÃO TEM → sobe e renderiza pelo SSE, que grava o cache batch a batch
   *
   * A decisão é pelo ESTADO DO CACHE, não pelo tamanho do arquivo: o que estoura
   * o gateway é o parse passar dos ~230s, e isso depende da densidade do modelo,
   * não dos MB (um IFC de 90MB denso estoura, um de 150MB simples não). Assim o
   * base64 do SSE é pago só na primeira abertura de cada arquivo, que é
   * exatamente quando não existe alternativa.
   */
  async loadFromServerCached(fileUrl: string, serverUrl: string): Promise<void> {
    try {
      const ifcBlob = await this.downloadIfc(fileUrl);
      if (this.disposed) { return; }

      const hash = await this.hashBlob(ifcBlob);
      if (this.disposed) { return; }

      await this.renderFromServer(ifcBlob, hash, serverUrl);
      if (this.disposed) { return; }

      // Depois do render, nunca antes: a árvore e as propriedades não podem
      // atrasar o primeiro paint do modelo.
      void this.loadDataModel(hash, serverUrl, ifcBlob);
    } catch (err: any) {
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('server-parse-failed', String(err?.message ?? err));
    }
  }

  /**
   * Geometria na cena pelo caminho mais barato disponível: cache quando existe,
   * streaming quando não. Usado pelo modelo único e pela federação — o federado
   * tem ainda mais a ganhar, porque cada disciplina extra seria outro upload.
   */
  private async renderFromServer(
    ifcBlob: Blob,
    hash: string,
    serverUrl: string,
    opts: { additive?: boolean; model?: FederatedModel } = {},
  ): Promise<void> {
    const cached = await this.isCached(hash, serverUrl);
    console.log(`[coordly-embed] cache do server: ${cached ? 'HIT' : 'MISS'} (${hash.slice(0, 12)}…)`);

    if (cached) {
      await this.renderParquet(await this.fetchCachedGeometry(hash, serverUrl), opts);
      return;
    }
    await this.streamFromServer(ifcBlob, serverUrl, opts);
  }

  /**
   * Busca o data model do MESMO `cache_key` da geometria. Falha aqui não é falha
   * de viewer: o modelo continua na tela, só sem árvore/propriedades — por isso
   * não emite `onError` (que dispararia o fallback pro Autodesk).
   */
  private async loadDataModel(
    hash: string,
    serverUrl: string,
    ifc?: Blob,
    // Modelo federado dono deste data model. Ausente = viewer de arquivo único,
    // e o store decodificado vai para o campo do motor.
    target?: FederatedModel,
  ): Promise<void> {
    const cacheKey = `${hash}-${DEFAULT_OPENING_FILTER}`;

    // Rodada curta: se a geometria acabou de ser parseada, o data model está
    // sendo escrito agora e chega em segundos.
    if (await this.pollDataModel(cacheKey, serverUrl, DATA_MODEL_POLL.quickAttempts, target)) { return; }
    if (this.disposed) { return; }

    // Continuou 202 = cache LEGADO. Todo MISS hoje passa pelo `parquet-stream`,
    // que sempre dispara a extração num `tokio::spawn` — então geometria nova
    // sempre tem data model a caminho e o poll curto acima basta. O que cai aqui
    // é arquivo cujo cache foi gravado pelo `parse/parquet`, que respondia do
    // cache ANTES de processar e não gravava data model nenhum: por mais que a
    // gente esperasse, ele nunca apareceria. Subimos o arquivo só pra popular
    // esse cache e abandonamos a resposta (a geometria já está na tela).
    if (!ifc) {
      console.warn('[coordly-embed] data model ausente e sem o .ifc em mãos pra gerar');
      this.events.onDataModel({ available: false, modelIndex: target?.index, modelId: target?.id });
      return;
    }

    console.log('[coordly-embed] data model ausente no cache; disparando extração no server…');
    if (!await this.requestDataModelFill(ifc, serverUrl)) {
      this.events.onDataModel({ available: false, modelIndex: target?.index, modelId: target?.id });
      return;
    }

    if (await this.pollDataModel(cacheKey, serverUrl, DATA_MODEL_POLL.attempts, target)) { return; }
    if (this.disposed) { return; }
    console.warn('[coordly-embed] data model não ficou pronto a tempo');
    this.events.onDataModel({ available: false, modelIndex: target?.index, modelId: target?.id });
  }

  /** Devolve `true` quando o data model chegou e foi decodificado. */
  private async pollDataModel(
    cacheKey: string,
    serverUrl: string,
    attempts: number,
    target?: FederatedModel,
  ): Promise<boolean> {
    const url = this.serverEndpoint(serverUrl, `api/v1/parse/data-model/${cacheKey}`);

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.disposed) { return false; }
      try {
        const res = await fetch(url, { signal: this.aborter.signal });
        // 202 = ainda não existe no cache (ou está sendo escrito agora).
        if (res.status === 202) {
          await new Promise((r) => setTimeout(r, DATA_MODEL_POLL.intervalMs));
          continue;
        }
        if (!res.ok) { throw new Error(`data model → ${res.status}`); }

        const buffer = await res.arrayBuffer();
        if (this.disposed) { return false; }
        const store = await ModelDataStore.decode(buffer);
        if (this.disposed) { return false; }
        if (target) { target.dataStore = store; } else { this.dataStore = store; }
        console.log(`[coordly-embed] data model pronto (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB)`);
        this.events.onDataModel({ available: true, modelIndex: target?.index, modelId: target?.id });
        return true;
      } catch (err: any) {
        if (this.disposed || err?.name === 'AbortError') { return false; }
        console.warn('[coordly-embed] data model indisponível:', err?.message ?? err);
        return false;
      }
    }
    return false;
  }

  /**
   * Sobe o `.ifc` no endpoint SSE só pra disparar a extração do data model, e
   * **abandona a resposta**: a geometria já está renderizada, e ler o corpo
   * traria os mesmos MBs de volta em base64 sem serventia. O cancelamento não
   * aborta o trabalho — a extração roda num `tokio::spawn` independente da
   * conexão (o mesmo motivo pelo qual o cache de geometria sobrevive a um
   * gateway timeout).
   */
  private async requestDataModelFill(ifc: Blob, serverUrl: string): Promise<boolean> {
    const form = new FormData();
    form.append('file', ifc, 'model.ifc');

    const fill = new AbortController();
    // Se o viewer for descartado no meio, cancela junto.
    this.aborter.signal.addEventListener('abort', () => fill.abort(), { once: true });

    try {
      const res = await fetch(this.serverEndpoint(serverUrl, 'api/v1/parse/parquet-stream'), {
        method: 'POST',
        body: form,
        signal: fill.signal,
      });
      const ok = res.ok;
      fill.abort(); // headers recebidos = o server já está processando
      return ok;
    } catch (err: any) {
      if (this.disposed || err?.name === 'AbortError') { return !this.disposed; }
      console.warn('[coordly-embed] falha ao disparar extração do data model:', err?.message ?? err);
      return false;
    }
  }

  /**
   * SHA-256 do conteúdo — é a mesma chave que o server usa no cache
   * (`DiskCache::generate_key` = sha256 hex do arquivo), então dá pra perguntar
   * "você já tem esse modelo?" antes de subir qualquer byte.
   */
  private async hashBlob(blob: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private serverEndpoint(serverUrl: string, path: string): string {
    return new URL(path, serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`).toString();
  }

  /** O server já tem a geometria desse arquivo em cache? */
  private async isCached(hash: string, serverUrl: string): Promise<boolean> {
    try {
      const res = await fetch(this.serverEndpoint(serverUrl, `api/v1/cache/check/${hash}`), {
        signal: this.aborter.signal,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Baixa a geometria cacheada. Sem base64 e sem passar por JS: o corpo é lido em
   * pedaços só para reportar progresso e vira Blob (disco) no fim.
   *
   * Não dá pra decodificar durante o download: o server não aceita Range (pedir
   * bytes parciais devolve 200 com o arquivo inteiro) e o footer do parquet fica
   * no FIM — sem ele não se sabe onde estão os row groups. O render progressivo
   * vem depois, no decode.
   */
  private async fetchCachedGeometry(hash: string, serverUrl: string): Promise<Blob> {
    const res = await fetch(this.serverEndpoint(serverUrl, `api/v1/cache/geometry/${hash}`), {
      signal: this.aborter.signal,
    });
    if (!res.ok) { throw new Error(`geometria em cache → ${res.status}`); }

    const total = Number(res.headers.get('content-length') ?? 0);
    if (!res.body) { return res.blob(); }

    const parts: Uint8Array[] = [];
    let received = 0;
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      parts.push(value);
      received += value.length;
      this.events.onProgress('download', received, total);
    }
    return new Blob(parts as BlobPart[]);
  }

  /** Baixa o `.ifc` e devolve o container parquet tesselado pelo server. */
  private async parseOnServer(fileUrl: string, serverUrl: string): Promise<Blob> {
    const ifcBlob = await this.downloadIfc(fileUrl);

    const form = new FormData();
    form.append('file', ifcBlob, 'model.ifc');

    this.events.onProgress('parse', 0, 1);
    const endpoint = new URL('api/v1/parse/parquet', serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`);
    console.log(`[coordly-embed] enviando ${(ifcBlob.size / 1024 / 1024).toFixed(1)}MB para ${endpoint}`);
    const parsed = await fetch(endpoint.toString(), {
      method: 'POST',
      body: form,
      signal: this.aborter.signal,
    }).catch((err) => {
      throw new Error(`POST ao server de parse falhou (rede/CORS): ${err?.message ?? err}`);
    });
    if (!parsed.ok) {
      const body = await parsed.text().catch(() => '');
      throw new Error(`server de parse → ${parsed.status} ${parsed.statusText} ${body}`.trim());
    }
    this.events.onProgress('parse', 1, 1);
    // Blob (não ArrayBuffer): o decode lê row group a row group DE DENTRO dela,
    // que é o que mantém o pico de memória baixo em modelo grande.
    return parsed.blob();
  }

  /**
   * Federação via server: adiciona uma disciplina à cena SEM limpar, com a
   * geometria tesselada no server (mesmo motivo do single-model — o parse
   * client-side perde geometria).
   *
   * Alinhamento: o parquet já vem com Y-up aplicado e coordenadas absolutas, então
   * não há `sharedRtcOffset` a propagar como no client parse. Foi assim que as 29
   * disciplinas do R2 federaram alinhadas no artifact-poc.
   */
  async addModelFromServerParse(fileUrl: string, modelId: string, serverUrl: string): Promise<void> {
    if (this.disposed || this.models.has(modelId)) { return; }
    const slot = this.nextModelSlot++;
    const model: FederatedModel = {
      id: modelId,
      index: slot,
      idOffset: slot * MODEL_ID_STEP,
      ids: new Set<number>(),
      dataStore: null,
    };
    this.models.set(modelId, model);

    try {
      const ifcBlob = await this.downloadIfc(fileUrl);
      if (this.disposed) { return; }
      const hash = await this.hashBlob(ifcBlob);
      if (this.disposed) { return; }
      await this.renderFromServer(ifcBlob, hash, serverUrl, { additive: true, model });
      if (this.disposed) { return; }

      // Depois do render, como no viewer de arquivo único: árvore e propriedades
      // não podem atrasar o primeiro paint. Sem isto o federado renderizava a
      // geometria e nunca tinha data model — clicar num elemento não trazia nada.
      void this.loadDataModel(hash, serverUrl, ifcBlob, model);
    } catch (err: any) {
      this.models.delete(modelId); // o modelo não entrou na cena
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('server-parse-failed', String(err?.message ?? err));
    }
  }

  /**
   * Tira UM modelo da cena, sem tocar nos outros — o que o offset de id (§
   * `MODEL_ID_STEP`) viabiliza. Antes disso a única remoção possível era
   * `scene.clear()`, e desligar 1 de N custava re-baixar e re-parsear os N-1
   * que ficavam.
   */
  removeModel(modelId: string): void {
    const model = this.models.get(modelId);
    if (!model || !this.renderer) { return; }

    const scene = this.renderer.getScene();
    scene.removeMeshesForEntities(model.ids);
    // A remoção só marca os buckets; sem o rebuild a geometria continua na GPU
    // e desenhando.
    const device = this.renderer.getGPUDevice();
    const pipeline = this.renderer.getPipeline();
    if (device && pipeline) { scene.rebuildPendingBatches(device, pipeline); }

    let selectionChanged = false;
    for (const id of Array.from(this.selectedIds)) {
      if (model.ids.has(id)) { this.selectedIds.delete(id); selectionChanged = true; }
    }
    if (this.selectedId !== null && model.ids.has(this.selectedId)) {
      this.selectedId = null;
      this.selectedModelIndex = undefined;
    }
    if (selectionChanged) { this.emitSelection(); }
    // Visibilidade guardada por id do modelo que saiu vira lixo que voltaria a
    // valer se a faixa fosse reusada.
    for (const id of model.ids) { this.hiddenIds.delete(id); }
    if (this.isolatedIds) {
      for (const id of model.ids) { this.isolatedIds.delete(id); }
      if (this.isolatedIds.size === 0) { this.isolatedIds = null; }
    }

    this.models.delete(modelId);
    // O frame de coordenadas é do 1º modelo carregado; se ele saiu e a cena
    // esvaziou, o próximo a entrar refaz o rtc.
    if (this.models.size === 0) { this.federationRtc = undefined; }
    this.renderer.requestRender();
  }

  hasModel(modelId: string): boolean {
    return this.models.has(modelId);
  }

  // Modo server: geometria já tesselada vem do CDN. Streaming por row group é o
  // caminho provado (1.3GB renderiza; 29 disciplinas em ~5GB).
  async loadFromArtifacts(artifacts: IfcArtifacts): Promise<void> {
    const geometry = artifacts.urls?.geometry;
    if (!geometry) { this.events.onError('artifacts-missing', 'sem geometria nos artefatos'); return; }

    try {
      this.events.onProgress('download', 0, 1);
      const geometryUrl = geometry.layout === 'container' ? geometry.geometry : geometry.vertex;
      const res = await fetch(geometryUrl, { signal: this.aborter.signal });
      if (!res.ok) { throw new Error(`download da geometria → ${res.status}`); }
      const blob = await res.blob();
      if (this.disposed) { return; }
      this.events.onProgress('download', 1, 1);

      await this.renderParquet(blob);
      // Tier 2 do contrato de artefatos: quando o backend publicar o data model
      // no CDN, a árvore e as propriedades saem do mesmo pacote da geometria.
      if (artifacts.urls?.datamodel) { void this.loadDataModelFrom(artifacts.urls.datamodel); }
    } catch (err: any) {
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('decode-failed', String(err?.message ?? err));
    }
  }

  /** Data model por URL direta (CDN). Falhar aqui não derruba o viewer. */
  private async loadDataModelFrom(url: string): Promise<void> {
    try {
      const res = await fetch(url, { signal: this.aborter.signal });
      if (!res.ok) { throw new Error(`data model → ${res.status}`); }
      const buffer = await res.arrayBuffer();
      if (this.disposed) { return; }
      this.dataStore = await ModelDataStore.decode(buffer);
      if (this.disposed) { return; }
      this.events.onDataModel({ available: true });
    } catch (err: any) {
      if (this.disposed || err?.name === 'AbortError') { return; }
      console.warn('[coordly-embed] data model do CDN indisponível:', err?.message ?? err);
      this.events.onDataModel({ available: false });
    }
  }

  // Federação (client-parse): adiciona um modelo à cena SEM limpar. Cada modelo
  // ganha um modelIndex (chave composta expressId+modelIndex evita colisão entre
  // disciplinas). instancing OFF — o caminho instanced do renderer é primary-only,
  // então geometria instanciada não receberia modelIndex; flat recebe. O 1º modelo
  // fixa o rtc; os demais reusam (sharedRtcOffset) pra ficarem alinhados no mesmo frame.
  async addModelFromIfc(fileUrl: string, modelId: string): Promise<void> {
    if (this.disposed || this.models.has(modelId)) { return; }
    const slot = this.nextModelSlot++;
    const modelIndex = slot;
    const model: FederatedModel = {
      id: modelId,
      index: slot,
      idOffset: slot * MODEL_ID_STEP,
      ids: new Set<number>(),
      dataStore: null,
    };
    this.models.set(modelId, model);
    const isFirst = slot === 0;
    // `?parallel=0` força o caminho single mesmo com isolamento — é o que permite
    // comparar single × paralelo no MESMO app/arquivo/máquina, sem depender de
    // COOP/COEP para trocar de caminho.
    const isolated = typeof self !== 'undefined' && self.crossOriginIsolated && flag('parallel');

    try {
      this.events.onProgress('download', 0, 1);
      const res = await fetch(fileUrl, { signal: this.aborter.signal });
      if (!res.ok) { throw new Error(`download do .ifc → ${res.status}`); }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (this.disposed) { return; }
      this.events.onProgress('download', 1, 1);

      // Federação mantém tudo flat: o instancing do engine é primary-model only,
      // e num load federado as ocorrências opacas repetidas iriam parar em shards
      // que este caminho não consome — sumiriam em silêncio (mesmo motivo que o
      // `enableInstancing: target.kind === 'primary'` do viewer de referência).
      const gp = new GeometryProcessor({ ...geometryOptions(), enableInstancing: false });
      await gp.init();

      let meshCount = 0;
      let framed = false;
      const stream = isolated
        ? gp.processAdaptive(bytes, {
            sizeThreshold: 2 * 1024 * 1024,
            sharedRtcOffset: isFirst ? undefined : this.federationRtc
          })
        : gp.processStreaming(bytes, undefined, undefined, isFirst ? undefined : this.federationRtc);

      for await (const ev of stream) {
        if (this.disposed) { return; }
        // O 1º modelo emite o rtc do frame; guardamos pra alinhar os próximos.
        if ((ev as any).type === 'rtcOffset') {
          if (isFirst) { this.federationRtc = (ev as any).rtcOffset; }
          continue;
        }
        if (ev.type !== 'batch') { continue; }

        const meshes = visibleOnly(ev.meshes);
        if (meshes.length > 0) {
          // Mesmo offset de id do caminho server: é o que permite `removeModel`
          // tirar só este modelo da cena.
          const stamped = meshes.map((m) => {
            const expressId = m.expressId + model.idOffset;
            model.ids.add(expressId);
            return { ...m, expressId, modelIndex };
          });
          this.renderer.addMeshes(stamped, true);
          meshCount += meshes.length;
        }
        this.renderer.requestRender();
        if (!framed && meshCount > 0) { this.renderer.fitToView(); framed = true; }
        this.events.onProgress('parse', meshCount, meshCount);
      }

      if (this.disposed) { return; }
      this.renderer.fitToView(); // enquadra a união de todos os modelos
      this.renderer.requestRender();
      this.events.onLoaded({ elementCount: meshCount });
    } catch (err: any) {
      this.models.delete(modelId); // rollback do índice se este modelo falhou
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('parse-failed', String(err?.message ?? err));
    }
  }

  // Reset da sessão federada (esvazia a cena e volta a poder escolher o motor).
  clearModels(): void {
    this.renderer?.getScene().clear();
    this.models.clear();
    this.nextModelSlot = 0;
    this.federationRtc = undefined;
    this.selectedId = null;
    this.selectedModelIndex = undefined;
    // Visibilidade e corte são estado da CENA: sobreviver a um reset deixaria
    // elementos ocultos por ids que nem existem mais.
    this.hiddenIds.clear();
    this.isolatedIds = null;
    this.section = null;
    this.dataStore = null;
    this.renderer?.requestRender();
  }

  fitToView(): void {
    this.renderer?.fitToView();
    this.renderer?.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Árvore espacial e propriedades (data model)
  // ---------------------------------------------------------------------------

  /**
   * Store do modelo pedido. Os ids que cruzam a ponte são LOCAIS (veja
   * `emitSelection`), então quem identifica o modelo é o `modelIndex` — o mesmo
   * que a seleção reporta. Sem índice, é o viewer de arquivo único.
   */
  private storeFor(modelIndex?: number): ModelDataStore | null {
    if (modelIndex === undefined) { return this.dataStore; }
    for (const model of this.models.values()) {
      if (model.index === modelIndex) { return model.dataStore; }
    }
    return this.dataStore;
  }

  hasDataModel(modelIndex?: number): boolean {
    if (modelIndex !== undefined) { return this.storeFor(modelIndex) !== null; }
    if (this.dataStore !== null) { return true; }
    for (const model of this.models.values()) {
      if (model.dataStore) { return true; }
    }
    return false;
  }

  getSpatialTree(modelIndex?: number): BimTreeNode[] {
    return this.storeFor(modelIndex)?.getSpatialTree() ?? [];
  }

  getEntityProperties(expressId: number, modelIndex?: number): BimEntityProperties | null {
    return this.storeFor(modelIndex)?.getEntityProperties(expressId) ?? null;
  }

  getEntityLabels(
    expressIds: number[],
    modelIndex?: number,
  ): { expressId: number; name: string }[] {
    return this.storeFor(modelIndex)?.getEntityLabels(expressIds) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Seleção, visibilidade e corte — estado do app aplicado por frame no render()
  // ---------------------------------------------------------------------------

  /**
   * Seleção vinda de fora do canvas (clique na árvore). `null` limpa.
   * `frame` enquadra o elemento — a árvore de um prédio inteiro seleciona coisas
   * fora da tela, e destacar sem enquadrar não mostra nada ao usuário.
   */
  selectEntity(
    expressId: number | null,
    opts: { frame?: boolean; additive?: boolean; modelIndex?: number } = {},
  ): void {
    if (this.disposed || !this.renderer) { return; }

    if (expressId === null) { this.clearSelection(); return; }

    // Vem do app (árvore) com id do arquivo; o highlight compara id da cena.
    const sceneId = this.models.size === 0
      ? expressId
      : this.sceneIds([expressId], opts.modelIndex)[0] ?? expressId;

    if (opts.additive || this.multiSelect) {
      if (this.selectedIds.has(sceneId)) { this.selectedIds.delete(sceneId); }
      else { this.selectedIds.add(sceneId); }
    } else {
      this.selectedIds.clear();
      this.selectedIds.add(sceneId);
    }
    this.selectedId = this.selectedIds.has(sceneId) ? sceneId : null;
    // Sem `modelIndex` (viewer de arquivo único, ou app que não informa) fica
    // undefined, e o highlight do caminho flat não filtra por modelo — mesmo
    // motivo do pick. Com ele, a seleção reporta o modelo certo, e é isso que
    // faz as propriedades saírem do data model do arquivo clicado.
    this.selectedModelIndex = opts.modelIndex;

    if (opts.frame) { this.frameEntities([expressId], opts.modelIndex); }
    this.renderer.requestRender();
    this.emitSelection();
  }

  clearSelection(): void {
    this.selectedIds.clear();
    this.selectedId = null;
    this.selectedModelIndex = undefined;
    // O X-Ray existe pra destacar a seleção; sem seleção, ele só escureceria o
    // modelo inteiro sem motivo.
    this.ghost = false;
    this.renderer?.requestRender();
    this.emitSelection();
  }

  /** Modo "adicionar à seleção" (botão da toolbar). */
  setMultiSelect(enabled: boolean): void {
    this.multiSelect = enabled;
  }

  /** X-Ray: o que não está selecionado fica translúcido. */
  setGhostMode(enabled: boolean): void {
    this.ghost = enabled && this.selectedIds.size > 0;
    this.renderer?.requestRender();
  }

  isGhostMode(): boolean {
    return this.ghost;
  }

  /**
   * Foco (duplo clique): enquadra a seleção e liga o X-Ray. Enquadrar sozinho
   * costuma não bastar — a câmera chega numa posição em que paredes e lajes
   * ficam na frente do elemento.
   */
  focusSelection(): void {
    if (this.selectedIds.size === 0) { return; }
    this.frameEntities(Array.from(this.selectedIds));
    this.ghost = true;
    this.renderer?.requestRender();
  }

  private emitSelection(): void {
    const ids = Array.from(this.selectedIds, localExpressId);
    this.events.onSelect({
      expressId: this.selectedId === null ? null : localExpressId(this.selectedId),
      modelIndex: this.selectedModelIndex ?? 0,
      expressIds: ids,
    });
  }

  /** Enquadra a união dos bounding boxes das entidades (zoom-to-selection). */
  frameEntities(localIds: number[], modelIndex?: number): void {
    if (this.disposed || !this.renderer || localIds.length === 0) { return; }
    const scene = this.renderer.getScene();
    // Aceita id do arquivo OU da cena: `frameEntities` é chamada tanto pelo app
    // (árvore) quanto internamente pelo foco, que já trabalha com id da cena.
    const expressIds = this.models.size === 0
      ? localIds
      : this.sceneIds(localIds, modelIndex).concat(localIds);

    let min = { x: Infinity, y: Infinity, z: Infinity };
    let max = { x: -Infinity, y: -Infinity, z: -Infinity };
    let found = false;
    for (const id of expressIds) {
      const box = scene.getEntityBoundingBox(id);
      if (!box) { continue; }
      found = true;
      min = { x: Math.min(min.x, box.min.x), y: Math.min(min.y, box.min.y), z: Math.min(min.z, box.min.z) };
      max = { x: Math.max(max.x, box.max.x), y: Math.max(max.y, box.max.y), z: Math.max(max.z, box.max.z) };
    }
    // Sem geometria carregada pra esses ids (elemento sem representação, ou
    // ainda não decodificado): melhor não mover a câmera do que mandá-la pro
    // infinito.
    if (!found) { return; }

    void this.camera.frameBounds(min, max);
    this.renderer.requestRender();
  }

  /**
   * Traduz ids do ARQUIVO (o que o app conhece) para ids DA CENA (com o offset
   * federado). Single-model não tem offset, então é identidade; no federado um
   * mesmo id pode existir em várias disciplinas e todas entram.
   */
  private sceneIds(localIds: number[], modelIndex?: number): number[] {
    if (this.models.size === 0) { return localIds; }
    const out: number[] = [];
    for (const local of localIds) {
      for (const model of this.models.values()) {
        // Com `modelIndex`, só o modelo pedido. É o que a árvore federada usa:
        // ela sabe de qual arquivo é o nó, e sem o filtro um id repetido em
        // outra disciplina entraria junto — destacando o elemento errado.
        if (modelIndex !== undefined && model.index !== modelIndex) { continue; }
        const sceneId = local + model.idOffset;
        if (model.ids.has(sceneId)) { out.push(sceneId); }
      }
    }
    return out;
  }

  /** `null`/vazio desliga o isolamento. */
  isolate(expressIds: number[] | null): void {
    const ids = expressIds && expressIds.length > 0 ? this.sceneIds(expressIds) : [];
    this.isolatedIds = ids.length > 0 ? new Set(ids) : null;
    this.renderer?.requestRender();
  }

  hide(localIds: number[]): void {
    const expressIds = this.sceneIds(localIds);
    for (const id of expressIds) { this.hiddenIds.add(id); }
    // Diagnóstico: "sumiu mais do que eu selecionei" quase sempre é o conjunto
    // pedido ser maior do que o usuário imagina (nó de árvore, multi-seleção) —
    // ou um expressId que responde por várias malhas do mesmo elemento IFC.
    console.log(
      `[coordly-embed] ocultar (fantasma): ${expressIds.length} id(s) · total oculto ${this.hiddenIds.size}`,
      expressIds.slice(0, 20).map(localExpressId),
    );
    this.renderer?.requestRender();
  }

  show(localIds: number[]): void {
    for (const id of this.sceneIds(localIds)) { this.hiddenIds.delete(id); }
    this.renderer?.requestRender();
  }

  showAll(): void {
    this.hiddenIds.clear();
    this.isolatedIds = null;
    this.renderer?.requestRender();
  }

  /**
   * Liga/desliga a medição. Com um modo ativo o clique deixa de selecionar
   * elemento — senão medir uma parede a selecionaria a cada ponto.
   */
  setMeasureMode(mode: MeasureMode): void {
    this.measure?.setMode(mode);
    this.canvas.style.cursor = mode === 'none' ? '' : 'crosshair';
    this.renderer?.requestRender();
  }

  clearMeasurements(): void {
    this.measure?.clear();
    this.renderer?.requestRender();
  }

  deleteMeasurement(id: string): void {
    this.measure?.remove(id);
    this.renderer?.requestRender();
  }

  /** `null` desliga o corte. Reflete no frame seguinte, sem recarregar nada. */
  setSectionPlane(section: SectionPlane | null): void {
    this.section = section && section.enabled ? section : null;
    this.renderer?.requestRender();
  }

  // Raycast no clique. pick() espera coordenada CSS relativa ao canvas; o evento
  // dá clientX/Y (viewport), daí o offset pelo boundingRect. Reuso puro do motor:
  // o Renderer já faz o picking (CPU raycast + GPU id) e o highlight sai do render()
  // via selectedId. Clique no vazio (pick null) limpa a seleção.
  private async handlePick(
    clientX: number,
    clientY: number,
    opts: { additive?: boolean; focus?: boolean } = {},
  ): Promise<void> {
    if (this.disposed || !this.renderer) { return; }
    const rect = this.canvas.getBoundingClientRect();
    try {
      // Passa a visibilidade: o que está oculto/fora do isolamento não pode ser
      // selecionado por trás do que está na tela. O oculto continua na cena como
      // fantasma, mas segue fora do pick — ocultar é justamente tirá-lo da
      // frente do que o usuário quer alcançar.
      const hit = await this.renderer.pick(clientX - rect.left, clientY - rect.top, {
        hiddenIds: this.hiddenIds,
        isolatedIds: this.isolatedIds,
      });
      if (this.disposed) { return; }

      if (!hit) {
        // Clique no vazio limpa — a não ser que esteja somando à seleção, onde
        // errar o alvo não pode custar o que já foi selecionado.
        if (!(opts.additive || this.multiSelect)) { this.clearSelection(); }
        return;
      }

      const additive = opts.additive || this.multiSelect;
      if (additive) {
        if (this.selectedIds.has(hit.expressId)) { this.selectedIds.delete(hit.expressId); }
        else { this.selectedIds.add(hit.expressId); }
      } else {
        this.selectedIds.clear();
        this.selectedIds.add(hit.expressId);
      }
      // `selectedId` fica com o id DA CENA (deslocado) porque é ele que o
      // renderer compara no highlight; quem sai pra fora é o id do arquivo.
      this.selectedId = this.selectedIds.has(hit.expressId) ? hit.expressId : null;
      this.selectedModelIndex = hit.modelIndex;
      if (opts.focus) { this.focusSelection(); }
      this.renderer.requestRender();
      this.emitSelection();
    } catch { /* pick pode falhar em frame de transição; ignora */ }
  }

  dispose(): void {
    this.disposed = true;
    this.aborter.abort();
    window.removeEventListener('keydown', this.onKeyDown);
    this.measure?.dispose();
    this.measure = null;
    this.restoreConsole?.();
    delete (globalThis as any).__ifc_lite_render_stats__;
    try { this.renderer?.dispose?.(); } catch { /* já pode estar solto */ }
  }

  private finishLoad(meshCount: number): void {
    if (this.disposed) { return; }
    console.log(
      `[coordly-embed] parse concluído · ${meshCount} malhas visíveis · ` +
      `${hiddenMeshCount} ocultas por tipo (abertura/espaço/zona/virtual) · fitToView`,
    );
    this.renderer.fitToView();
    this.renderer.requestRender();
    this.events.onLoaded({ elementCount: meshCount });
  }


  private fitCanvas(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
  }

  // A render loop é externa no ifc-lite: requestRender() só marca dirty.
  private startLoop(): void {
    let last = performance.now();
    const frame = (now: number) => {
      if (this.disposed) { return; }
      const dt = (now - last) / 1000; last = now;

      // Reconstrói batches evictados pelo budget; sem isto o modelo ganha buracos.
      const scene = this.renderer.getScene();
      if (scene.hasResidencyRestoreWork()) {
        try {
          const device = this.renderer.getGPUDevice();
          const pipeline = this.renderer.getPipeline();
          if (device && pipeline) { scene.processResidencyRestores(device, pipeline); }
        } catch (err) {
          if (!this.restoreErrorLogged) {
            this.restoreErrorLogged = true;
            console.warn('[coordly-embed] residency restore falhou:', err);
          }
        }
      }

      this.camera.update(dt);
      this.renderer.consumeRenderRequest();
      this.renderer.render({
        clearColor: [0.10, 0.11, 0.13, 1],
        contributionCull: flag('cull') ? CONTRIB_CULL : undefined,
        lod: flag('lod') ? LOD : undefined,
        selectedId: this.selectedId,
        selectedIds: this.selectedIds,
        selectedModelIndex: this.selectedModelIndex,
        // Ocultar pelo olho da árvore não apaga o elemento: ele fica translúcido,
        // como o X-Ray. Sumir de vez tira a referência de onde a peça estava —
        // e é o isolamento que serve pra ficar só com o que interessa.
        ghostIds: this.hiddenIds,
        isolatedIds: this.isolatedIds,
        sectionPlane: this.section ?? undefined,
        // X-Ray: só o selecionado fica opaco; o resto vira contexto translúcido.
        ghostExceptIds: this.ghost && this.selectedIds.size > 0 ? this.selectedIds : null
      });
      // Depois do render: o overlay é projeção da câmera DESTE frame.
      this.measure?.sync();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private wireControls(): void {
    const c = this.canvas;
    let dragging = false, lastX = 0, lastY = 0, button = 0, moved = 0;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY; button = e.button; moved = 0;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointerup', (e) => {
      dragging = false;
      if (button !== 0 || moved >= CLICK_DRAG_PX) { return; }
      // Medindo, o clique é ponto de medida — não seleção. Orbitar continua
      // valendo (o arrasto nem chega aqui).
      const rect = c.getBoundingClientRect();
      if (this.measure?.handleClick(e.clientX - rect.left, e.clientY - rect.top)) {
        this.renderer.requestRender();
        return;
      }
      // Clique esquerdo sem arrastar = seleção.
      // Ctrl/Cmd/Shift somam à seleção sem precisar do modo da toolbar.
      void this.handlePick(e.clientX, e.clientY, {
        additive: e.ctrlKey || e.metaKey || e.shiftKey,
      });
    });
    // Duplo clique fecha a área em curso; fora da medição, foca o elemento
    // (seleciona, enquadra e liga o X-Ray).
    c.addEventListener('dblclick', (e) => {
      if (this.measure?.handleDoubleClick()) { return; }
      void this.handlePick(e.clientX, e.clientY, { focus: true });
    });
    // Esc limpa a seleção (e o X-Ray junto). No window, não no canvas: depois de
    // clicar num drawer o foco sai do canvas e a tecla não chegaria nele.
    window.addEventListener('keydown', this.onKeyDown);
    c.addEventListener('pointermove', (e) => {
      if (!dragging && this.measure?.isActive()) {
        const rect = c.getBoundingClientRect();
        this.measure.handleMove(e.clientX - rect.left, e.clientY - rect.top);
        this.renderer.requestRender();
      }
      if (!dragging) { return; }
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (button === 2 || e.shiftKey) { this.camera.pan(dx, dy); } else { this.camera.orbit(dx, dy); }
      this.renderer.requestRender();
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.zoom(e.deltaY, false, e.offsetX, e.offsetY, c.width, c.height);
      this.renderer.requestRender();
    }, { passive: false });
    window.addEventListener('resize', () => {
      this.fitCanvas();
      this.renderer.resize(c.width, c.height);
      this.renderer.requestRender();
    });
  }
}
