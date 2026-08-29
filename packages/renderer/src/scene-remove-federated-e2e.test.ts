/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regressão de federação: dois modelos entram por streaming (o caminho do
 * coordly-embed, que nunca chama `finalizeStreaming()`) e um deles é removido.
 *
 * O que quebrava: a remoção mexia só nos buckets e depois `rebuildPendingBatches`
 * refazia o array de desenho a partir DELES, jogando fora os fragmentos — que é
 * onde a geometria estava. Os buckets exclusivos do modelo que FICA nunca eram
 * remarcados, então não voltavam como batch: sobrava só o punhado de buckets
 * que os dois modelos dividiam. Daí o cenário reportado — desliga um switch e a
 * cena inteira some, menos alguns cacos.
 *
 * Por isso os modelos aqui têm cores próprias e uma em comum: um teste em que
 * ambos caem nos mesmos buckets passa mesmo com o bug.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { MeshData } from '@ifc-lite/geometry';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

function fakeDevice(): GPUDevice {
  return {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: { size: number }) => {
      const backing = new ArrayBuffer(Math.max(4, desc.size));
      return {
        size: desc.size,
        getMappedRange: () => backing,
        unmap() {},
        destroy() {},
      };
    },
    createBindGroup: () => ({}),
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice;
}

const pipeline = {
  getUniformBufferSize: () => 256,
  getBindGroupLayout: () => ({}),
} as unknown as RenderPipeline;

/** Malha num ponto do espaço, para o chunking espacial separar os modelos. */
function mesh(expressId: number, x: number, color: [number, number, number, number]): MeshData {
  return {
    expressId,
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color,
  } as unknown as MeshData;
}

function drawnIds(scene: Scene): Set<number> {
  const ids = new Set<number>();
  for (const batch of scene.getBatchedMeshes()) {
    for (const id of batch.expressIds) ids.add(id);
  }
  return ids;
}

describe('federação: desligar 1 de 2 modelos', () => {
  it('mantém o modelo que ficou e tira só o que saiu', () => {
    const scene = new Scene();
    const device = fakeDevice();
    // Mesma config do coordly-embed.
    scene.setSpatialChunking({ cellSize: 40 });
    scene.setLodBuildsEnabled(true);

    // Modelo A: ids 0..; modelo B: offset de faixa, como o MODEL_ID_STEP.
    // Duas disciplinas: cores próprias (buckets exclusivos) com uma cor em
    // comum (bucket compartilhado) — é a mistura real, e o bucket exclusivo do
    // modelo que FICA é justamente o que a remoção nunca remarcava.
    const modelA: MeshData[] = [];
    const modelB: MeshData[] = [];
    const cinza: [number, number, number, number] = [0.8, 0.8, 0.8, 1];
    const vermelho: [number, number, number, number] = [0.7, 0.2, 0.1, 1];
    const verde: [number, number, number, number] = [0.2, 0.8, 0.2, 1];
    for (let i = 0; i < 30; i++) {
      modelA.push(mesh(100 + i, i * 5, i % 5 === 0 ? cinza : vermelho));
      modelB.push(mesh(1_000_000 + 100 + i, i * 5, i % 5 === 0 ? cinza : verde));
    }

    // Streaming em chunks, como os row groups do server.
    for (let i = 0; i < modelA.length; i += 7) {
      scene.appendToBatches(modelA.slice(i, i + 7), device, pipeline, true);
    }
    for (let i = 0; i < modelB.length; i += 7) {
      scene.appendToBatches(modelB.slice(i, i + 7), device, pipeline, true);
    }

    const before = drawnIds(scene);
    for (const m of modelA) assert.ok(before.has(m.expressId), `A ${m.expressId} não entrou`);
    for (const m of modelB) assert.ok(before.has(m.expressId), `B ${m.expressId} não entrou`);

    // ── removeModel(B) ────────────────────────────────────────────────
    const idsB = new Set(modelB.map((m) => m.expressId));
    scene.removeMeshesForEntities(idsB, device, pipeline);
    scene.rebuildPendingBatches(device, pipeline);

    const after = drawnIds(scene);
    const perdidosA = modelA.filter((m) => !after.has(m.expressId)).map((m) => m.expressId);
    const sobrouB = modelB.filter((m) => after.has(m.expressId)).map((m) => m.expressId);

    assert.deepStrictEqual(perdidosA, [], `sumiram do modelo A: ${perdidosA.length}`);
    assert.deepStrictEqual(sobrouB, [], `sobraram do modelo B: ${sobrouB.length}`);

    // Nenhum elemento pode ser desenhado duas vezes (bucket + fragmento).
    const draws = scene.getBatchedMeshes().flatMap((b) => b.expressIds);
    assert.strictEqual(draws.length, new Set(draws).size, 'geometria desenhada em duplicidade');
  });
});
