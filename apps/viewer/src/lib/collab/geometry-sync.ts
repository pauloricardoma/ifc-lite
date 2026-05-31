/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry hydration via content-addressed mesh blobs (plan §4.2 — option b).
 *
 * Owner: encode each tessellated `MeshData`, store it as a blob (the blob hash
 * is the geomId — identical meshes dedupe), and attach a `GeometryRef` to the
 * owning GUID entity in the Y.Doc. Recipient: walk entities' `GeometryRef`s,
 * fetch the blobs, and decode back to `MeshData[]` for the renderer.
 *
 * The collab runtime + blob store are injected so this pulls no collab code
 * eagerly. Re-tessellation (the lighter parametric path, plan §4.2 option a)
 * is a follow-up; mesh blobs are the universal fallback that works for any
 * model including imported meshes.
 */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { BlobStore, CollabSession } from '@ifc-lite/collab';
import { decodeMesh, encodeMesh } from './mesh-codec';

/** The collab doc + geometry helpers this module needs (injected). */
export interface CollabGeomApi {
  createGeometry(
    doc: CollabSession['doc'],
    geomId: string,
    opts: { type: 'mesh'; source: string; blobHash?: string },
  ): unknown;
  /** Append a geomId to an entity's geometry refs (entities can own several meshes). */
  addGeometryRef(doc: CollabSession['doc'], path: string, geomId: string): void;
  getGeometryRef(doc: CollabSession['doc'], path: string): { geomIds: string[] } | undefined;
  getGeometry(doc: CollabSession['doc'], geomId: string): { get(key: string): unknown } | undefined;
  iterEntities(doc: CollabSession['doc']): IterableIterator<[string, unknown]>;
}

/**
 * Seed tessellated meshes into the room as blobs + per-entity `GeometryRef`s.
 * `pathFor` maps a mesh's `expressId` to its GUID entity path (skipped when it
 * returns null). A single entity can own several meshes (multi-material /
 * multiple representation items), so refs are *appended* per path rather than
 * overwritten. Returns the number of meshes seeded.
 */
export async function seedGeometryToRoom(
  api: CollabGeomApi,
  session: CollabSession,
  blobStore: BlobStore,
  meshes: readonly MeshData[],
  pathFor: (expressId: number) => string | null,
): Promise<number> {
  let count = 0;
  for (const mesh of meshes) {
    const path = pathFor(mesh.expressId);
    if (!path) continue;
    const meta = await blobStore.put(encodeMesh(mesh), 'application/octet-stream');
    const geomId = meta.hash; // content-addressed → identical meshes dedupe
    session.transact(() => {
      api.createGeometry(session.doc, geomId, { type: 'mesh', source: 'mesh-blob', blobHash: meta.hash });
      api.addGeometryRef(session.doc, path, geomId);
    });
    count++;
  }
  return count;
}

/**
 * Reconstruct `MeshData[]` from the room's geometry blobs, keyed by entity. A
 * recipient that joined a seed-into-room link has no source file, so it walks
 * every entity's `GeometryRef`s, fetches the referenced blobs, and decodes
 * them back to meshes. Walking by entity path (rather than the geometry store)
 * lets us re-key each mesh's `expressId` into the recipient's own id space via
 * `pathToId` — the recipient reconstructs its `IfcDataStore` from the same
 * IFCX snapshot, so `pathToId.get(path)` is the entity's reconstructed
 * expressId, which makes 3D selection resolve to the right inspector entry.
 * Without `pathToId` (e.g. tests), the blob's embedded expressId is kept.
 * Missing blobs are skipped (the seed may still be syncing).
 */
export async function hydrateGeometryFromRoom(
  api: CollabGeomApi,
  session: CollabSession,
  blobStore: BlobStore,
  pathToId?: Map<string, number>,
): Promise<MeshData[]> {
  const out: MeshData[] = [];
  for (const [path] of api.iterEntities(session.doc)) {
    const ref = api.getGeometryRef(session.doc, path);
    if (!ref) continue;
    const expressId = pathToId?.get(path);
    for (const geomId of ref.geomIds) {
      const node = api.getGeometry(session.doc, geomId);
      const blobHash = node?.get('blobHash');
      if (typeof blobHash !== 'string') continue;
      const bytes = await blobStore.get(blobHash);
      if (!bytes) continue;
      const mesh = decodeMesh(bytes);
      if (expressId !== undefined) mesh.expressId = expressId;
      out.push(mesh);
    }
  }
  return out;
}

/**
 * Wrap hydrated meshes into a `GeometryResult` the renderer accepts. Meshes
 * arrive already in the owner's shifted coordinate space, so we report a zero
 * origin shift and just compute bounds + totals for camera framing.
 */
export function buildGeometryResultFromMeshes(meshes: MeshData[]): GeometryResult {
  let totalTriangles = 0;
  let totalVertices = 0;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const m of meshes) {
    totalTriangles += m.indices.length / 3;
    totalVertices += m.positions.length / 3;
    for (let i = 0; i + 2 < m.positions.length; i += 3) {
      const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
      if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
      if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
    }
  }
  const bounds = meshes.length
    ? { min, max }
    : { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const zero = { x: 0, y: 0, z: 0 };
  return {
    meshes,
    totalTriangles,
    totalVertices,
    coordinateInfo: {
      originShift: zero,
      originalBounds: bounds,
      shiftedBounds: bounds,
      hasLargeCoordinates: false,
    },
  };
}
