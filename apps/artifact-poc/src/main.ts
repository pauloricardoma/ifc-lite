// Harness POC: busca os 4 artefatos como se fossem CDN (/artifacts/<modelo>/),
// decodifica no browser (SEM parse de IFC, SEM server) e renderiza com o @ifc-lite/renderer.
// Prova o caminho quente do next_04 (Blob/CDN → decoder → renderer).
import { Renderer, DEFAULT_CHUNK_CELL_SIZE } from '@ifc-lite/renderer';
import { decodeOptimizedParquetGeometry } from '@ifc-lite/server-client';
import { decodeStdParquetStreaming } from './parquet-stream.js';
import { GeometryProcessor, decodeInstancedShard } from '@ifc-lite/geometry';

// Residência/LOD do upstream #1682. Espelha os defaults do apps/viewer
// (gpuBudgetConfig/lodConfig/contributionCull), que NÃO valem aqui: são do app
// deles, não do renderer. Sobrescreva no console p/ A/B, ex.:
//   __IFC_LITE_GPU_BUDGET_MB = 0   → desliga o budget (baseline pré-#1682)
const GPU_BUDGET_MB = (globalThis as any).__IFC_LITE_GPU_BUDGET_MB ?? 2048;
const LOD_SCREEN_PX = (globalThis as any).__IFC_LITE_LOD_PX ?? 48;
const CONTRIB_CULL = { pixelRadius: 0.5, interactingPixelRadius: 2 };

const canvas = document.getElementById('c') as HTMLCanvasElement;
const statusEl = document.getElementById('status')!;
const modelInput = document.getElementById('model') as HTMLInputElement;
const loadBtn = document.getElementById('load') as HTMLButtonElement;

const say = (msg: string, err = false) => {
  statusEl.textContent = msg;
  statusEl.classList.toggle('err', err);
  (err ? console.error : console.log)('[poc]', msg);
};

// dev: serve local (middleware do Vite em /artifacts/). prod (Vercel): pede URL
// assinada ao /api/sign (bucket R2 privado). `key` = caminho após /artifacts/.
const PROD = (import.meta as any).env?.PROD;
let accessCode = sessionStorage.getItem('poc_code') || '';
async function artifactUrl(key: string): Promise<string> {
  if (!PROD) return `/artifacts/${key}`;
  if (!accessCode) {
    accessCode = (window.prompt('Código de acesso:') || '').trim();
    sessionStorage.setItem('poc_code', accessCode);
  }
  const r = await fetch(`/api/sign?key=${encodeURIComponent(key)}&code=${encodeURIComponent(accessCode)}`);
  if (r.status === 403) {
    accessCode = ''; sessionStorage.removeItem('poc_code');
    throw new Error('código de acesso inválido');
  }
  if (!r.ok) throw new Error(`sign ${key} → ${r.status}`);
  return (await r.json()).url;
}

// Qualquer erro não tratado (inclui rejeição de top-level await) vai pra tela.
window.addEventListener('error', (e) => say(`window.error: ${e.message}`, true));
window.addEventListener('unhandledrejection', (e) =>
  say(`unhandledrejection: ${(e.reason?.message ?? e.reason)}`, true));

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
}

let renderer: Renderer;
let camera: any;

async function boot() {
  // 1) WebGPU disponível?
  if (!('gpu' in navigator)) {
    say('WebGPU indisponível — abra no Chrome/Edge recente (ou Safari 17+ com flag).', true);
    return;
  }
  say('WebGPU: pedindo adapter…');
  const adapter = await (navigator as any).gpu.requestAdapter();
  if (!adapter) { say('WebGPU: requestAdapter() retornou null (GPU/driver não disponível).', true); return; }

  // 2) init do renderer
  say('inicializando renderer…');
  fitCanvas();
  renderer = new Renderer(canvas);
  await renderer.init();
  camera = renderer.getCamera();

  // Residência/LOD do upstream #1682. ATENÇÃO: NÃO é "ligado por padrão" no
  // renderer — os defaults (2048MB/32m/48px) moram no apps/viewer, que os passa
  // à Scene. Aqui a POC liga na mão. Ordem importa: o bucketing tem de ser
  // configurado ANTES de qualquer geometria entrar na cena.
  const scene = renderer.getScene();
  scene.setSpatialChunking({ cellSize: DEFAULT_CHUNK_CELL_SIZE });
  scene.setGpuResidencyBudget(GPU_BUDGET_MB * 1024 * 1024);
  scene.setLodBuildsEnabled(true);
  // setHostResidencyBudget é NO-OP aqui: o tier cold precisa de um restore
  // source (cache v13 em disco) que o caminho parquet/CDN não tem.
  const quantized = await renderer.enableQuantizedBatches();
  console.log(`[poc] chunking=${DEFAULT_CHUNK_CELL_SIZE}m · gpuBudget=${GPU_BUDGET_MB}MB · lod=${LOD_SCREEN_PX}px · quantized=${quantized ? 'on (12B)' : 'INDISPONÍVEL (probe falhou)'}`);

  // Hook de medição (mesma convenção do apps/viewer): bytes residentes exatos.
  (globalThis as any).__ifc_lite_render_stats__ = () => ({
    frame: renderer.getFrameStats(),
    gpu: renderer.getScene().getResidentGpuBytes(),
    cpuBytes: renderer.getScene().getResidentCpuBytes(),
  });

  wireControls();
  startLoop();
  say('renderer pronto ✓ — carregando modelo…');

  // 3) primeiro modelo
  const initial = new URLSearchParams(location.search).get('model') || modelInput.value;
  modelInput.value = initial;
  await load(initial);
}

async function load(model: string) {
  const base = `/artifacts/${model}`;
  say(`buscando ${base}/ …`);
  const t0 = performance.now();
  try {
    const [geoBlob, meta] = await Promise.all([
      fetch(`${base}/geometry.parquet`).then((r) => {
        if (!r.ok) throw new Error(`geometry.parquet → ${r.status}`);
        return r.blob(); // Blob (lazy, disco) — não segura o arquivo no heap JS.
      }),
      fetch(`${base}/metadata.json`).then((r) => (r.ok ? r.json() : null))
    ]);
    say(`decodificando ${(geoBlob.size / 1e6).toFixed(0)} MB (streaming por row group)…`);
    renderer.getScene().clear();
    let meshCount = 0, tris = 0, framed = false;
    for await (const chunk of decodeStdParquetStreaming(geoBlob)) {
      renderer.addMeshes(chunk as any, true);
      meshCount += chunk.length;
      for (const m of chunk) tris += (m.indices?.length ?? 0) / 3;
      renderer.requestRender();
      if (!framed && meshCount > 0) { renderer.fitToView(); framed = true; }
    }
    renderer.fitToView();
    renderer.requestRender();
    const dt = (performance.now() - t0).toFixed(0);
    say(`${model} · ${meshCount} malhas · ~${tris | 0} triângulos · ${dt}ms\n(render sem tocar o server ✓)`);
  } catch (e: any) {
    say(`erro ao carregar: ${e.message}`, true);
  }
}

// A render loop é EXTERNA no ifc-lite: requestRender() só marca dirty; alguém
// precisa rodar o rAF, avançar a câmera (update) e chamar render(). (padrão do useAnimationLoop)
function startLoop() {
  let last = performance.now();
  let restoreErrorLogged = false;
  const frame = (now: number) => {
    const dt = (now - last) / 1000; last = now;

    // Reconstrói os batches que o budget de GPU evictou e o último frame pediu
    // de volta. SEM isto o modelo ganha buracos: o budget evicta e nada restaura.
    const scene = renderer.getScene();
    if (scene.hasResidencyRestoreWork()) {
      try {
        const device = renderer.getGPUDevice();
        const pipeline = renderer.getPipeline();
        if (device && pipeline) scene.processResidencyRestores(device, pipeline);
      } catch (err) {
        if (!restoreErrorLogged) {
          restoreErrorLogged = true;
          console.warn('[poc] residency restore falhou (segue renderizando):', err);
        }
      }
    }

    camera.update(dt);                 // avança animação de câmera / inércia
    renderer.consumeRenderRequest();
    renderer.render({
      clearColor: [0.10, 0.11, 0.13, 1],  // pinta todo frame (POC)
      contributionCull: CONTRIB_CULL,
      lod: { screenPx: LOD_SCREEN_PX },
    });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function wireControls() {
  let dragging = false, lastX = 0, lastY = 0, button = 0;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY; button = e.button;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (button === 2 || e.shiftKey) camera.pan(dx, dy); else camera.orbit(dx, dy);
    renderer.requestRender();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.zoom(e.deltaY, false, e.offsetX, e.offsetY, canvas.width, canvas.height);
    renderer.requestRender();
  }, { passive: false });
  window.addEventListener('resize', () => {
    fitCanvas(); renderer.resize(canvas.width, canvas.height); renderer.requestRender();
  });
}

// ── CLIENT PARSE: parseia o .ifc no browser (WASM), igual o demo do ifc-lite ──
const fileInput = document.getElementById('file') as HTMLInputElement;
const mem = () => (performance as any).memory?.usedJSHeapSize ?? 0;
const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
// Quantos modelos .ifc já foram federados via upload (define o próximo modelIndex).
let uploadModels = 0;

async function parseClientSide(file: File) {
  const t0 = performance.now();
  say(`lendo ${file.name} (${mb(file.size)} MB)…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const memStart = mem();

  const tier = (document.getElementById('tier') as HTMLSelectElement).value as any;
  say(`init do parser WASM… (tessellation=${tier})`);
  // enableInstancing NÃO é setado → default TRUE, igual ao viewer oficial: a
  // geometria opaca repetida sai como instancedShards (economia de memória).
  const gp = new GeometryProcessor({ tessellationQuality: tier }); // tier baixo = menos triângulos
  await gp.init();

  // Federar: somar à cena (não limpar) e dar um modelIndex distinto por modelo,
  // pra seleção/picking multi-modelo não colidir expressId entre disciplinas.
  // Desligado = substitui (limpa a cena antes de streamar).
  const federate = (document.getElementById('federate') as HTMLInputElement)?.checked ?? false;
  const scene = renderer.getScene();
  const device = renderer.getGPUDevice();
  if (!federate) {
    // Append progressivo NÃO reseta como loadGeometry — limpar explicitamente.
    scene.clear();
    uploadModels = 0;
  }
  const modelIndex = uploadModels;

  let batches = 0, meshCount = 0, shardCount = 0, tris = 0;
  let framed = false;
  const tParse = performance.now();

  // processAdaptive: arquivos ≥2MB seguem o caminho PARALELO (SAB + pool de
  // workers multi-core), igual ao ifclite.com — em vez do processStreaming
  // single-thread. Emite batches progressivos + shards de instancing.
  for await (const ev of gp.processAdaptive(bytes, { sizeThreshold: 2 * 1024 * 1024 })) {
    if (ev.type !== 'batch') continue;

    // Append PROGRESSIVO por batch: não acumulamos as malhas no heap JS. É isso
    // que corta o pico de memória e dá o carregamento "particionado" na tela.
    if (ev.meshes.length > 0) {
      for (const m of ev.meshes) (m as any).modelIndex = modelIndex;
      renderer.addMeshes(ev.meshes, true);
      meshCount += ev.meshes.length;
      for (const m of ev.meshes) tris += (m.indices?.length ?? 0) / 3;
    }

    // Geometria opaca repetida vem SÓ como shard de instancing — precisa
    // decodificar + subir pra GPU, senão some do modelo. Falha de shard é
    // não-fatal (a geometria flat continua renderizando).
    if (device && ev.instancedShards?.length) {
      for (const buf of ev.instancedShards) {
        try {
          const shard = decodeInstancedShard(new Uint8Array(buf));
          if (shard) { scene.addInstancedShard(device, shard); shardCount++; }
        } catch (err) {
          console.warn('[poc] instanced shard falhou, pulando:', err);
        }
      }
    }

    batches++;
    renderer.requestRender();
    // Enquadra assim que houver algo visível (primeiro frame rápido).
    if (!framed && (meshCount > 0 || shardCount > 0)) { renderer.fitToView(); framed = true; }
    if (batches % 10 === 0) say(`parseando… ${meshCount} malhas · ${shardCount} shards · ${(tris / 1e6).toFixed(1)}M tri · RAM ~${mb(mem() - memStart)} MB`);
  }
  const parseMs = performance.now() - tParse;

  renderer.fitToView();
  renderer.requestRender();
  // Este modelo passou a ocupar `modelIndex`; o próximo federado usa o seguinte.
  uploadModels = modelIndex + 1;

  const totalMs = performance.now() - t0;
  const memPeak = mem() - memStart;

  // OBS: exportGlb no browser OOMa em arquivo grande (roda sobre o heap já cheio).
  // A medição de GLB vai pro SERVER (Rust, sem teto de 4 GB) — caminho seguro.
  const fedLine = federate ? `federado ✓ · ${uploadModels} modelo(s) na cena\n` : '';
  say(
    `CLIENT PARSE ✓  ${file.name} (${mb(file.size)} MB) · tier=${tier}\n` +
    fedLine +
    `${meshCount} malhas · ${shardCount} shards · ${(tris / 1e6).toFixed(1)}M triângulos\n` +
    `parse: ${(parseMs / 1000).toFixed(1)}s · total: ${(totalMs / 1000).toFixed(1)}s\n` +
    `RAM JS: +${mb(memPeak)} MB (heap usado)`
  );
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) parseClientSide(f).catch((e) => say(`erro no client parse: ${e?.message ?? e}`, true));
});

// ── FEDERADO por disciplina: cada botão adiciona um modelo à MESMA cena ───────
let loadedMeshes = 0;
const loadedSet = new Set<number>();

async function loadDiscipline(model: any, index: number, btn: HTMLButtonElement) {
  if (loadedSet.has(index)) return;
  btn.disabled = true;
  say(`carregando ${model.slug} (${model.geomMB} MB)…`);
  try {
    const url = await artifactUrl(`federated/${model.slug}/geometry.parquet`);
    const geoBlob = await fetch(url).then((r) => r.blob());
    // Streaming row-group: sobe por batch (federado NÃO limpa a cena — soma).
    for await (const chunk of decodeStdParquetStreaming(geoBlob)) {
      for (const m of chunk) (m as any).modelIndex = index;
      renderer.addMeshes(chunk as any, true);
      loadedMeshes += chunk.length;
      renderer.requestRender();
    }
    loadedSet.add(index);
    renderer.fitToView();
    renderer.requestRender();
    btn.style.background = '#9ece6a'; btn.style.color = '#0f1116';
    say(`+${model.slug}\n${loadedSet.size} disciplina(s) · ${loadedMeshes} malhas · RAM heap ~${mb(mem())} MB`);
  } catch (e: any) {
    say(`${model.slug} FALHOU: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function clearScene() {
  renderer.getScene().clear();
  renderer.requestRender();
  loadedMeshes = 0; loadedSet.clear(); uploadModels = 0;
  document.querySelectorAll('#disc button').forEach((b) => {
    (b as HTMLButtonElement).style.background = '#0f1116';
    (b as HTMLButtonElement).style.color = '#e6e6e6';
  });
  say('cena limpa — escolha disciplinas');
}

async function buildDisciplineButtons() {
  const disc = document.getElementById('disc')!;
  let manifest: any[];
  try {
    manifest = await fetch(await artifactUrl('federated/manifest.json')).then((r) => r.json());
  } catch { disc.textContent = '(sem manifest federado)'; return; }
  manifest.forEach((m, i) => {
    const code = (m.name.split('-')[1] || m.slug).toUpperCase();
    const heavy = m.geomMB > 100;
    const b = document.createElement('button');
    b.textContent = `${code}·${m.geomMB}MB`;
    b.title = `${m.name}  (${m.geomMB} MB)${heavy ? ' — PESADO' : ''}`;
    b.style.cssText = `background:#0f1116;color:${heavy ? '#f7768e' : '#e6e6e6'};border:1px solid #2c2f38;border-radius:5px;padding:4px 7px;font:11px ui-monospace,monospace;cursor:pointer`;
    b.addEventListener('click', () => loadDiscipline(m, i, b));
    disc.appendChild(b);
  });
}

(document.getElementById('clear') as HTMLButtonElement).addEventListener('click', clearScene);
buildDisciplineButtons();

// ── DOR: comparar variantes de opening-filter (standalone, pesado) ────────────
// std = default (todas aberturas + cortes CSG) · opt = default otimizado
// fast = ignore_all (sem janelas/portas) · opaque = ignore_opaque (mantém vidros)
const DOR_LABEL: Record<'std' | 'opt' | 'fast' | 'opaque', string> = {
  std: 'padrão (default)', opt: 'otimizado (default)',
  fast: 'fast (ignore_all)', opaque: 'opaque (ignore_opaque)',
};
async function loadDor(kind: 'std' | 'opt' | 'fast' | 'opaque') {
  clearScene();
  const t0 = performance.now();
  say(`DOR ${kind}: buscando…`);
  try {
    const [geoUrl, metaUrl] = await Promise.all([
      artifactUrl(`dor/${kind}/geometry.parquet`),
      artifactUrl(`dor/${kind}/metadata.json`),
    ]);
    const [geoBlob, meta] = await Promise.all([
      fetch(geoUrl).then((r) => r.blob()),
      fetch(metaUrl).then((r) => r.json()),
    ]);
    say(`DOR ${kind}: decodificando ${mb(geoBlob.size)} MB…`);
    let meshCount = 0, tris = 0, framed = false;
    if (kind === 'opt') {
      // Formato otimizado/instanced ainda não tem decoder row-group — caminho antigo
      // (buffer inteiro; ainda pode estourar o WASM em modelo grande — TODO chunked).
      const decoded = await decodeOptimizedParquetGeometry(await geoBlob.arrayBuffer(), meta.vertex_multiplier ?? 10000);
      const meshes = decoded.map((m: any) => ({
        expressId: m.express_id, ifcType: m.ifc_type,
        positions: m.positions, normals: m.normals, indices: m.indices, color: m.color,
      }));
      renderer.addMeshes(meshes as any, true);
      meshCount = meshes.length;
      for (const m of meshes) tris += (m.indices?.length ?? 0) / 3;
    } else {
      // Streaming row-group: decodifica 1 RG por vez (é o que faz o 1.3GB renderizar).
      for await (const chunk of decodeStdParquetStreaming(geoBlob)) {
        renderer.addMeshes(chunk as any, true);
        meshCount += chunk.length;
        for (const m of chunk) tris += (m.indices?.length ?? 0) / 3;
        renderer.requestRender();
        if (!framed && meshCount > 0) { renderer.fitToView(); framed = true; }
      }
    }
    renderer.fitToView();
    renderer.requestRender();
    say(`DOR ${DOR_LABEL[kind]} ✓\n${meshCount} malhas · ${(tris / 1e6).toFixed(1)}M tri · ${((performance.now() - t0) / 1000).toFixed(1)}s · RAM ~${mb(mem())} MB`);
  } catch (e: any) { say(`DOR ${kind} FALHOU: ${e.message}`, true); }
}
(document.getElementById('dor-std') as HTMLButtonElement).addEventListener('click', () => loadDor('std'));
(document.getElementById('dor-opt') as HTMLButtonElement).addEventListener('click', () => loadDor('opt'));
(document.getElementById('dor-fast') as HTMLButtonElement).addEventListener('click', () => loadDor('fast'));
(document.getElementById('dor-opaque') as HTMLButtonElement).addEventListener('click', () => loadDor('opaque'));

loadBtn.addEventListener('click', () => load(modelInput.value.trim()));
modelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(modelInput.value.trim()); });

boot().catch((e) => say(`boot falhou: ${e?.message ?? e}`, true));