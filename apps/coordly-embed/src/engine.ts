import { Renderer, DEFAULT_CHUNK_CELL_SIZE } from '@ifc-lite/renderer';
import { GeometryProcessor, decodeInstancedShard } from '@ifc-lite/geometry';
import { decodeStdParquetStreaming } from './parquet-stream.js';
import type { IfcArtifacts } from './types.js';

const GPU_BUDGET_MB = 2048;
const LOD = { screenPx: 48 };
const CONTRIB_CULL = { pixelRadius: 0.5, interactingPixelRadius: 2 };

export type LoadPhase = 'download' | 'parse' | 'decode' | 'upload';

interface EngineEvents {
  onProgress(phase: LoadPhase, done: number, total: number): void;
  onLoaded(detail: { elementCount: number; schema?: string }): void;
  onError(code: string, message: string): void;
}

export class ViewerEngine {
  private renderer!: Renderer;
  private camera: any;
  private disposed = false;
  private aborter = new AbortController();
  private restoreErrorLogged = false;

  constructor(private canvas: HTMLCanvasElement, private events: EngineEvents) {}

  async init(): Promise<boolean> {
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
    scene.setGpuResidencyBudget(GPU_BUDGET_MB * 1024 * 1024);
    scene.setLodBuildsEnabled(true);
    await this.renderer.enableQuantizedBatches();

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
    const isolated = typeof self !== 'undefined' && self.crossOriginIsolated;
    console.log(`[coordly-embed] parse: ${isolated ? 'paralelo (SAB)' : 'single-thread (sem cross-origin isolation)'}`);

    try {
      this.events.onProgress('download', 0, 1);
      const res = await fetch(fileUrl, { signal: this.aborter.signal });
      if (!res.ok) { throw new Error(`download do .ifc → ${res.status}`); }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (this.disposed) { return; }
      this.events.onProgress('download', 1, 1);

      const gp = new GeometryProcessor({ tessellationQuality: 'medium' as any });
      await gp.init();

      const scene = this.renderer.getScene();
      const device = this.renderer.getGPUDevice();
      scene.clear();

      let meshCount = 0;
      let framed = false;

      const stream = isolated
        ? gp.processAdaptive(bytes, { sizeThreshold: 2 * 1024 * 1024 })
        : gp.processStreaming(bytes);

      console.log(`[coordly-embed] parse iniciado (${(bytes.length / 1e6).toFixed(1)} MB)`);
      let batches = 0;
      for await (const ev of stream) {
        if (this.disposed) { return; }
        if (ev.type !== 'batch') { console.log(`[coordly-embed] evento ${ev.type}`); continue; }

        batches++;
        if (ev.meshes.length > 0) {
          this.renderer.addMeshes(ev.meshes, true);
          meshCount += ev.meshes.length;
        }
        if (batches % 5 === 0 || batches === 1) {
          console.log(`[coordly-embed] batch ${batches} · ${meshCount} malhas`);
        }

        // Geometria opaca repetida vem só como shard de instancing; sem subir
        // pra GPU ela some do modelo. Falha de shard é não-fatal.
        if (device && ev.instancedShards?.length) {
          for (const buf of ev.instancedShards) {
            try {
              const shard = decodeInstancedShard(new Uint8Array(buf));
              if (shard) { scene.addInstancedShard(device, shard); }
            } catch { /* geometria flat continua renderizando */ }
          }
        }

        this.renderer.requestRender();
        if (!framed && meshCount > 0) { this.renderer.fitToView(); framed = true; }
        this.events.onProgress('parse', meshCount, meshCount);
      }

      this.finishLoad(meshCount);
    } catch (err: any) {
      if (err?.name !== 'AbortError') { this.events.onError('parse-failed', String(err?.message ?? err)); }
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

      this.renderer.getScene().clear();
      let meshCount = 0;
      let framed = false;

      for await (const chunk of decodeStdParquetStreaming(blob)) {
        if (this.disposed) { return; }
        this.renderer.addMeshes(chunk as any, true);
        meshCount += chunk.length;
        this.renderer.requestRender();
        if (!framed && meshCount > 0) { this.renderer.fitToView(); framed = true; }
        this.events.onProgress('decode', meshCount, meshCount);
      }

      this.finishLoad(meshCount);
    } catch (err: any) {
      if (err?.name !== 'AbortError') { this.events.onError('decode-failed', String(err?.message ?? err)); }
    }
  }

  fitToView(): void {
    this.renderer?.fitToView();
    this.renderer?.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.aborter.abort();
    delete (globalThis as any).__ifc_lite_render_stats__;
    try { this.renderer?.dispose?.(); } catch { /* já pode estar solto */ }
  }

  private finishLoad(meshCount: number): void {
    if (this.disposed) { return; }
    console.log(`[coordly-embed] parse concluído · ${meshCount} malhas · fitToView`);
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
      this.renderer.render({ clearColor: [0.10, 0.11, 0.13, 1], contributionCull: CONTRIB_CULL, lod: LOD });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private wireControls(): void {
    const c = this.canvas;
    let dragging = false, lastX = 0, lastY = 0, button = 0;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY; button = e.button;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointerup', () => { dragging = false; });
    c.addEventListener('pointermove', (e) => {
      if (!dragging) { return; }
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
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
