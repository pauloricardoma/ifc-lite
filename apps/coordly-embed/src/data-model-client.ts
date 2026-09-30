// Lado da thread principal do data model: um worker para todos os modelos, e um
// `RemoteDataStore` por modelo apontando para o store que mora lá. A árvore fica
// em cache aqui (a UI a lê de forma síncrona e ela não muda); o resto é
// consulta assíncrona.
import type { BimEntityProperties, BimTreeNode, ClashLinks } from './data-model.js';

type DataModelOp =
  | { op: 'init' }
  | { op: 'decode'; storeId: number; buffer: ArrayBuffer }
  | { op: 'labels'; storeId: number; expressIds: number[] }
  | { op: 'properties'; storeId: number; expressIds: number[] }
  | { op: 'globalIds'; storeId: number; expressIds: number[] }
  | { op: 'expressIds'; storeId: number; globalIds: string[] }
  | { op: 'clashLinks'; storeId: number }
  | { op: 'release'; storeId: number };

export type DataModelRequest = DataModelOp & { id: number };

export type DataModelResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { storeId: number; progress: number };

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const pending = new Map<number, Pending>();
const progressListeners = new Map<number, (percent: number) => void>();
let worker: Worker | null = null;
let nextRequestId = 1;
let nextStoreId = 1;

function getWorker(): Worker {
  if (worker) { return worker; }

  const created = new Worker(new URL('./data-model.worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent<DataModelResponse>) => {
    const res = event.data;
    if ('progress' in res) {
      progressListeners.get(res.storeId)?.(res.progress);
      if (res.progress >= 100) { progressListeners.delete(res.storeId); }
      return;
    }
    const call = pending.get(res.id);
    if (!call) { return; }
    pending.delete(res.id);
    if ('error' in res) { call.reject(new Error(res.error)); } else { call.resolve(res.result); }
  };
  // Worker que morre (OOM no decode, wasm que não carrega) leva os stores junto:
  // quem esperava recebe erro em vez de ficar pendurado, e o próximo uso sobe
  // um worker novo.
  created.onerror = (event) => {
    event.preventDefault();
    const error = new Error(`worker do data model falhou: ${event.message || 'erro desconhecido'}`);
    for (const call of pending.values()) { call.reject(error); }
    pending.clear();
    created.terminate();
    if (worker === created) { worker = null; }
  };

  worker = created;
  return created;
}

function call<T>(op: DataModelOp, transfer: Transferable[] = []): Promise<T> {
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    getWorker().postMessage({ ...op, id }, transfer);
  });
}

/**
 * Sobe o worker e compila o wasm do parquet (6,5MB) de antemão. Chamado quando o
 * download do data model começa: sem isto, esse custo caía depois do download,
 * com a barra parada no início da etapa da árvore.
 */
export function warmUpDataModelWorker(): void {
  call({ op: 'init' }).catch(() => { /* o decode reporta a falha de verdade */ });
}

export class RemoteDataStore {
  private released = false;

  private constructor(
    private readonly storeId: number,
    private readonly tree: BimTreeNode[],
  ) {}

  /**
   * Transfere o buffer ao worker: depois disto ele fica vazio (detached) aqui.
   * `onProgress` (0–100) segue depois da promise: a árvore sai em
   * `TREE_READY_AT`, o resto é o processamento das propriedades.
   */
  static async decode(buffer: ArrayBuffer, onProgress?: (percent: number) => void): Promise<RemoteDataStore> {
    const storeId = nextStoreId++;
    if (onProgress) { progressListeners.set(storeId, onProgress); }
    try {
      const tree = await call<BimTreeNode[]>({ op: 'decode', storeId, buffer }, [buffer]);
      return new RemoteDataStore(storeId, tree);
    } catch (err) {
      progressListeners.delete(storeId);
      throw err;
    }
  }

  getSpatialTree(): BimTreeNode[] {
    return this.tree;
  }

  getEntityLabels(expressIds: number[]): Promise<{ expressId: number; name: string }[]> {
    return call({ op: 'labels', storeId: this.storeId, expressIds });
  }

  /** Em lote: uma ida ao worker para a seleção inteira, não uma por elemento. */
  getEntitiesProperties(expressIds: number[]): Promise<BimEntityProperties[]> {
    return call({ op: 'properties', storeId: this.storeId, expressIds });
  }

  getGlobalIds(expressIds: number[]): Promise<{ expressId: number; globalId: string }[]> {
    return call({ op: 'globalIds', storeId: this.storeId, expressIds });
  }

  /** Espera as relações (vêm na passada das propriedades, depois da árvore). */
  getClashLinks(): Promise<ClashLinks> {
    return call({ op: 'clashLinks', storeId: this.storeId });
  }

  getExpressIds(globalIds: string[]): Promise<{ globalId: string; expressId: number }[]> {
    return call({ op: 'expressIds', storeId: this.storeId, globalIds });
  }

  /** Solta o store no worker. Idempotente: o motor chama em remoção, reset e dispose. */
  release(): void {
    if (this.released) { return; }
    this.released = true;
    progressListeners.delete(this.storeId);
    call({ op: 'release', storeId: this.storeId }).catch(() => { /* worker já morto: nada a soltar */ });
  }
}
