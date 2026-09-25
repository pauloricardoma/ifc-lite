// Decode e consultas do data model FORA da thread principal. O `ModelDataStore`
// vive aqui e não volta: devolvê-lo pronto custaria desserializar milhões de
// strings (Psets) na thread da cena — a mesma travada, só que em outro lugar.
// Pela ponte passa só o que é pequeno: a árvore (uma vez) e o resultado de
// cada consulta.
import { ModelDataStore } from './data-model.js';
import { ensureInit } from './parquet-stream.js';
import type { DataModelRequest, DataModelResponse } from './data-model-client.js';

const stores = new Map<number, ModelDataStore>();

const storeOf = (storeId: number): ModelDataStore => {
  const store = stores.get(storeId);
  if (!store) { throw new Error(`data model ${storeId} não está carregado`); }
  return store;
};

async function run(req: DataModelRequest): Promise<unknown> {
  switch (req.op) {
    case 'init':
      await ensureInit();
      return null;
    case 'decode': {
      // Progresso vai por `storeId`, não pelo id do pedido: ele continua (Psets)
      // depois de a árvore já ter respondido este pedido.
      const storeId = req.storeId;
      const store = await ModelDataStore.decode(req.buffer, (progress) => {
        const message: DataModelResponse = { storeId, progress };
        (self as unknown as Worker).postMessage(message);
      });
      stores.set(req.storeId, store);
      return store.getSpatialTree();
    }
    case 'labels':
      return storeOf(req.storeId).getEntityLabels(req.expressIds);
    case 'properties': {
      const store = storeOf(req.storeId);
      await store.propertiesReady;
      return req.expressIds
        .map((expressId) => store.getEntityProperties(expressId))
        .filter((entity) => entity !== null);
    }
    case 'globalIds':
      return storeOf(req.storeId).getGlobalIds(req.expressIds);
    case 'expressIds':
      return storeOf(req.storeId).getExpressIds(req.globalIds);
    case 'release':
      stores.delete(req.storeId);
      return null;
  }
}

self.onmessage = async (event: MessageEvent<DataModelRequest>) => {
  const req = event.data;
  let response: DataModelResponse;
  try {
    response = { id: req.id, ok: true, result: await run(req) };
  } catch (err: any) {
    response = { id: req.id, ok: false, error: String(err?.message ?? err) };
  }
  (self as unknown as Worker).postMessage(response);
};
