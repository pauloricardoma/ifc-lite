import { Renderer, DEFAULT_CHUNK_CELL_SIZE } from '@ifc-lite/renderer';
import { GeometryProcessor, decodeInstancedShard } from '@ifc-lite/geometry';
import type { TessellationQuality } from '@ifc-lite/geometry';
import { decodeStdParquetStreaming } from './parquet-stream.js';
import type { IfcArtifacts } from './types.js';

// Espera pelo parse frio no server. 5min cobre modelo grande (o de 264MB levou
// ~250s de tesselação); estourando, o parse continua lá e a próxima abertura pega
// do cache — por isso a mensagem é "tente de novo", não "falhou".
const CACHE_POLL = { intervalMs: 5000, timeoutMs: 5 * 60 * 1000 };


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
  onSelect(detail: { expressId: number | null; modelIndex: number }): void;
}

// Clique = pointerdown→up sem passar deste deslocamento acumulado (CSS px).
// Acima disso é orbit/pan, não seleção.
const CLICK_DRAG_PX = 5;

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
  // Federação: modelId → modelIndex (ordem de entrada). O 1º modelo fixa o frame
  // de coordenadas; os demais reusam via sharedRtcOffset pra ficarem alinhados.
  private models = new Map<string, number>();
  private federationRtc: { x: number; y: number; z: number } | undefined;

  constructor(private canvas: HTMLCanvasElement, private events: EngineEvents) {}

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

    this.wireControls();
    this.startLoop();
    return true;
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
    opts: { additive?: boolean; modelIndex?: number } = {},
  ): Promise<void> {
    if (!opts.additive) { this.renderer.getScene().clear(); }
    let meshCount = 0;
    let framed = opts.additive === true; // federação: não reenquadra a cada modelo

    for await (const chunk of decodeStdParquetStreaming(geometry)) {
      if (this.disposed) { return; }
      const meshes = visibleOnly(chunk);
      if (opts.modelIndex !== undefined) {
        for (const mesh of meshes) { (mesh as any).modelIndex = opts.modelIndex; }
      }
      this.renderer.addMeshes(meshes as any, true);
      meshCount += meshes.length;
      this.renderer.requestRender();
      if (!framed && meshCount > 0) { this.renderer.fitToView(); framed = true; }
      this.events.onProgress('decode', meshCount, meshCount);
    }

    this.finishLoad(meshCount);
  }

  /**
   * Parse no server via SSE (`/api/v1/parse/parquet-stream`), com render
   * progressivo. É o caminho para arquivo grande.
   *
   * O endpoint não-streaming fica minutos calado tesselando antes de responder o
   * primeiro byte, e o gateway do Azure derruba conexão ociosa (~230s) com 502 —
   * foi o que aconteceu no modelo de 264MB. Aqui os eventos começam a fluir em
   * segundos: cada `batch` traz um container parquet (mesmo formato do endpoint
   * inteiro, só que parcial) que decodificamos e mandamos pra cena na hora.
   */
  async loadFromServerStream(fileUrl: string, serverUrl: string): Promise<void> {
    console.log('[coordly-embed] parse: SERVER STREAMING (SSE)');

    try {
      const ifcBlob = await this.downloadIfc(fileUrl);
      if (this.disposed) { return; }

      const form = new FormData();
      form.append('file', ifcBlob, 'model.ifc');

      const endpoint = new URL(
        'api/v1/parse/parquet-stream',
        serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`,
      );
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
      if (!parsed.body) { throw new Error('resposta do server sem corpo streamável'); }

      this.renderer.getScene().clear();
      let meshCount = 0;
      let framed = false;

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
          const meshes = visibleOnly(chunk);
      this.renderer.addMeshes(meshes as any, true);
          meshCount += meshes.length;
        }

        this.renderer.requestRender();
        if (!framed && meshCount > 0) { this.renderer.fitToView(); framed = true; }
        this.events.onProgress('decode', meshCount, meshCount);
      }

      this.finishLoad(meshCount);
    } catch (err: any) {
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('server-parse-failed', String(err?.message ?? err));
    }
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
   *   2. JÁ TEM  → baixa a geometria pronta (sem upload nenhum)
   *   3. NÃO TEM → sobe pra disparar o parse. Se a resposta vier, usa direto; se o
   *      gateway cortar (arquivo grande passa dos ~230s), NÃO é erro: o server
   *      escreve o cache num `tokio::spawn` independente da resposta, então
   *      entramos em polling no `check` até a geometria existir.
   *
   * Isso evita o que quebrava antes: subir 264MB e receber 1.8GB de SSE em base64
   * — o upload continua sendo necessário só na primeira vez de cada arquivo.
   */
  async loadFromServerCached(fileUrl: string, serverUrl: string): Promise<void> {
    try {
      const geometry = await this.geometryFromServer(fileUrl, serverUrl);
      if (this.disposed) { return; }
      await this.renderParquet(geometry);
    } catch (err: any) {
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('server-parse-failed', String(err?.message ?? err));
    }
  }

  /**
   * Geometria tesselada de um `.ifc`, com o cache do server na frente. Usado tanto
   * pelo modelo único quanto pela federação — o federado tem ainda mais a ganhar,
   * porque cada disciplina extra seria outro upload.
   */
  private async geometryFromServer(fileUrl: string, serverUrl: string): Promise<Blob> {
    const ifcBlob = await this.downloadIfc(fileUrl);

    this.events.onProgress('parse', 0, 1);
    const hash = await this.hashBlob(ifcBlob);

    let cached = await this.isCached(hash, serverUrl);
    console.log(`[coordly-embed] cache do server: ${cached ? 'HIT' : 'MISS'} (${hash.slice(0, 12)}…)`);

    if (!cached) {
      cached = await this.seedServerCache(ifcBlob, hash, serverUrl);
      if (!cached) {
        throw new Error(
          'o modelo ainda está sendo processado no servidor — tente novamente em alguns minutos',
        );
      }
    }

    return this.fetchCachedGeometry(hash, serverUrl);
  }

  /**
   * Sobe o arquivo pra popular o cache e espera ficar pronto. Devolve `false` se
   * estourar a paciência — o parse continua no server, então a próxima abertura
   * costuma ser HIT.
   */
  private async seedServerCache(ifcBlob: Blob, hash: string, serverUrl: string): Promise<boolean> {
    const form = new FormData();
    form.append('file', ifcBlob, 'model.ifc');

    console.log(`[coordly-embed] cache MISS: enviando ${(ifcBlob.size / 1024 / 1024).toFixed(1)}MB pro server`);
    try {
      // Endpoint binário (não o SSE): a resposta não passa por JS e, se o gateway
      // cortar, o parse segue no server do mesmo jeito.
      const res = await fetch(this.serverEndpoint(serverUrl, 'api/v1/parse/parquet'), {
        method: 'POST',
        body: form,
        signal: this.aborter.signal,
      });
      if (res.ok) { return true; }
      console.warn(`[coordly-embed] parse respondeu ${res.status}; seguindo pelo cache`);
    } catch (err: any) {
      if (err?.name === 'AbortError') { throw err; }
      // Conexão cortada não significa parse perdido — o cache é escrito em background.
      console.warn('[coordly-embed] conexão do parse caiu; seguindo pelo cache:', err?.message ?? err);
    }

    return this.waitForCache(hash, serverUrl);
  }

  /** Polling no `check` enquanto o server termina o parse. */
  private async waitForCache(hash: string, serverUrl: string): Promise<boolean> {
    const deadline = Date.now() + CACHE_POLL.timeoutMs;
    while (Date.now() < deadline) {
      if (this.disposed) { return false; }
      await new Promise((r) => setTimeout(r, CACHE_POLL.intervalMs));
      if (await this.isCached(hash, serverUrl)) { return true; }
      const restante = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(`[coordly-embed] aguardando parse no server… (${restante}s restantes)`);
      this.events.onProgress('parse', 0, 0);
    }
    return false;
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
    const modelIndex = this.models.size;
    this.models.set(modelId, modelIndex);

    try {
      const geometry = await this.geometryFromServer(fileUrl, serverUrl);
      if (this.disposed) { return; }
      await this.renderParquet(geometry, { additive: true, modelIndex });
    } catch (err: any) {
      this.models.delete(modelId); // libera o índice: o modelo não entrou na cena
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('server-parse-failed', String(err?.message ?? err));
    }
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
    } catch (err: any) {
      if (this.disposed || err?.name === 'AbortError') { return; }
      this.events.onError('decode-failed', String(err?.message ?? err));
    }
  }

  // Federação (client-parse): adiciona um modelo à cena SEM limpar. Cada modelo
  // ganha um modelIndex (chave composta expressId+modelIndex evita colisão entre
  // disciplinas). instancing OFF — o caminho instanced do renderer é primary-only,
  // então geometria instanciada não receberia modelIndex; flat recebe. O 1º modelo
  // fixa o rtc; os demais reusam (sharedRtcOffset) pra ficarem alinhados no mesmo frame.
  async addModelFromIfc(fileUrl: string, modelId: string): Promise<void> {
    if (this.disposed || this.models.has(modelId)) { return; }
    const modelIndex = this.models.size;
    this.models.set(modelId, modelIndex);
    const isFirst = modelIndex === 0;
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
          this.renderer.addMeshes(meshes.map((m) => ({ ...m, modelIndex })), true);
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
    this.federationRtc = undefined;
    this.selectedId = null;
    this.selectedModelIndex = undefined;
    this.renderer?.requestRender();
  }

  fitToView(): void {
    this.renderer?.fitToView();
    this.renderer?.requestRender();
  }

  // Raycast no clique. pick() espera coordenada CSS relativa ao canvas; o evento
  // dá clientX/Y (viewport), daí o offset pelo boundingRect. Reuso puro do motor:
  // o Renderer já faz o picking (CPU raycast + GPU id) e o highlight sai do render()
  // via selectedId. Clique no vazio (pick null) limpa a seleção.
  private async handlePick(clientX: number, clientY: number): Promise<void> {
    if (this.disposed || !this.renderer) { return; }
    const rect = this.canvas.getBoundingClientRect();
    try {
      const hit = await this.renderer.pick(clientX - rect.left, clientY - rect.top);
      if (this.disposed) { return; }
      this.selectedId = hit?.expressId ?? null;
      this.selectedModelIndex = hit?.modelIndex;
      this.renderer.requestRender();
      this.events.onSelect({ expressId: this.selectedId, modelIndex: hit?.modelIndex ?? 0 });
    } catch { /* pick pode falhar em frame de transição; ignora */ }
  }

  dispose(): void {
    this.disposed = true;
    this.aborter.abort();
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
        selectedModelIndex: this.selectedModelIndex
      });
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
      // Clique esquerdo sem arrastar = seleção; orbit/pan não seleciona.
      if (button === 0 && moved < CLICK_DRAG_PX) { void this.handlePick(e.clientX, e.clientY); }
    });
    c.addEventListener('pointermove', (e) => {
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
