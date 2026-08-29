/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Removal while streaming is still live (no `finalizeStreaming()`): the
 * geometry on the GPU is in `streamingFragments`, not in the buckets. The
 * bucket-only path removed nothing from the GPU and then rebuilt the flat
 * render array from the buckets alone, which dropped every fragment — one
 * model out of a federation took the whole scene down with it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';

const device = {} as GPUDevice;
const pipeline = {} as RenderPipeline;

function makeMesh(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0, 0, 0, 1],
  } as unknown as MeshData;
}

let nextFakeId = 100;

/** Fragment over `pieces`, shaped like what `createStreamingFragments` builds. */
function fakeFragment(pieces: MeshData[]): BatchedMesh & { destroyed: number } {
  const destroy = function (this: { destroyed: number }) { this.destroyed++; };
  const fragment = {
    id: nextFakeId++,
    colorKey: 'c',
    vertexBuffer: { size: 0, destroy },
    indexBuffer: { size: 0, destroy },
    indexCount: pieces.length * 3,
    color: [0, 0, 0, 1],
    expressIds: pieces.map((p) => p.expressId),
    sourceMeshData: pieces,
    destroyed: 0,
  };
  // destroyGpuResources() destroys the buffers, so count on the fragment.
  fragment.vertexBuffer.destroy = () => { fragment.destroyed++; };
  fragment.indexBuffer.destroy = () => {};
  return fragment as unknown as BatchedMesh & { destroyed: number };
}

/** Puts `meshes` in a bucket + a fragment, the state a streaming load leaves. */
function seedStreamedScene(scene: Scene, fragments: MeshData[][]) {
  fragments.forEach((pieces, index) => {
    // A streaming append buckets the meshData (CPU side) and builds the
    // fragment (GPU side); only the fragment is drawn until finalizeStreaming().
    const bucket = { key: `bucket-${index}`, meshData: [] as MeshData[], batchedMesh: null, vertexBytes: 0 };
    scene['buckets'].set(bucket.key, bucket as never);
    for (const mesh of pieces) {
      scene.addMeshData(mesh);
      bucket.meshData.push(mesh);
      scene['meshDataBucket'].set(mesh, bucket as never);
    }
  });
  const built = fragments.map((pieces) => fakeFragment(pieces));
  scene['streamingFragments'] = built;
  scene['batchedMeshes'] = [...built];
  // The rebuild needs a GPU device; what is under test is which pieces reach it.
  scene['createBatchedMesh'] = ((pieces: MeshData[]) => fakeFragment(pieces)) as never;
  return built;
}

describe('Scene.removeMeshesForEntities — during streaming', () => {
  it('drops a fragment whose entities were all removed', () => {
    const scene = new Scene();
    const [modelA, modelB] = seedStreamedScene(scene, [
      [makeMesh(1), makeMesh(2)],
      [makeMesh(1001), makeMesh(1002)],
    ]);

    scene.removeMeshesForEntities([1, 2], device, pipeline);

    assert.strictEqual(modelA.destroyed, 1);
    assert.strictEqual(modelB.destroyed, 0);
    assert.deepStrictEqual(scene['streamingFragments'], [modelB]);
    // The regression: the surviving model must still be in the render array.
    assert.deepStrictEqual(scene.getBatchedMeshes(), [modelB]);
  });

  it('rebuilds a mixed fragment from the pieces that survive', () => {
    const scene = new Scene();
    const [mixed] = seedStreamedScene(scene, [[makeMesh(1), makeMesh(1001)]]);

    scene.removeMeshesForEntities([1], device, pipeline);

    assert.strictEqual(mixed.destroyed, 1);
    const fragments = scene['streamingFragments'];
    assert.strictEqual(fragments.length, 1);
    assert.notStrictEqual(fragments[0], mixed);
    assert.deepStrictEqual(fragments[0].expressIds, [1001]);
    assert.deepStrictEqual(scene.getBatchedMeshes(), [fragments[0]]);
  });

  it('leaves the fragments alone when nothing matched', () => {
    const scene = new Scene();
    const [fragment] = seedStreamedScene(scene, [[makeMesh(1)]]);

    scene.removeMeshesForEntities([777], device, pipeline);

    assert.strictEqual(fragment.destroyed, 0);
    assert.deepStrictEqual(scene['streamingFragments'], [fragment]);
  });

  it('does not leave the removal marking buckets for a mid-stream batch', () => {
    // Batching those buckets now would draw the survivors a second time, on
    // top of the fragments that still hold the very same geometry.
    const scene = new Scene();
    seedStreamedScene(scene, [[makeMesh(1), makeMesh(1001)]]);
    scene['pendingBatchKeys'].add('queued-before');

    scene.removeMeshesForEntities([1], device, pipeline);

    // Only what was already queued survives — the bucket the removal touched
    // is left for the next finalizeStreaming() to re-group.
    assert.deepStrictEqual([...scene['pendingBatchKeys']], ['queued-before']);
  });

  it('keeps a color-merged piece that other entities still share', () => {
    const scene = new Scene();
    const shared = {
      ...makeMesh(0),
      entityIds: new Uint32Array([10, 20]),
    } as unknown as MeshData;
    const [fragment] = seedStreamedScene(scene, [[shared]]);
    fragment.expressIds = [10, 20];

    scene.removeMeshesForEntities([10], device, pipeline);

    // Entity 10 is de-registered, but 20's geometry is the same mesh.
    assert.strictEqual(scene['meshDataMap'].get(10), undefined);
    assert.ok(scene['meshDataMap'].get(20));
    assert.strictEqual(scene['streamingFragments'].length, 1);
    assert.deepStrictEqual(scene['streamingFragments'][0].sourceMeshData, [shared]);
  });

  it('leaves fragments in the flat array when a bucket rebuild runs', () => {
    // rebuildPendingBatches() used to rebuild the array from the buckets only.
    const scene = new Scene();
    const [fragment] = seedStreamedScene(scene, [[makeMesh(1)]]);
    scene['pendingBatchKeys'].add('missing-bucket');

    scene.rebuildPendingBatches(device, pipeline);

    assert.deepStrictEqual(scene.getBatchedMeshes(), [fragment]);
  });
});
