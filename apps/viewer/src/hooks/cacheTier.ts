/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which persisted-cache tier a model of a given byte length qualifies for.
 *   - `none`: too small to bother caching (parses fast), or too big for any
 *     tier, or the mesh-only prototype is disabled and the file is >150MB.
 *   - `source`: the classic tier — persist tables + geometry AND the source
 *     buffer, so lazy property/quantity accessors + re-export read the source
 *     directly from IndexedDB. Unchanged by the mesh-only prototype.
 *   - `mesh-only`: the source-decoupled tier (bet B, prototype). Persist tables
 *     + geometry + instanced shards WITHOUT the source; on re-open the freshly
 *     read file buffer hydrates the accessors and validates the hit via the
 *     header's full-source hash.
 */
export type CacheTier = 'none' | 'source' | 'mesh-only';

export interface CacheTierOptions {
  /** Is the mesh-only prototype enabled (`?meshCache=1`)? */
  meshOnlyEnabled: boolean;
  /** Below this, don't cache — small files parse fast (`CACHE_SIZE_THRESHOLD`). */
  minSize: number;
  /** Up to and including this, use the source-persisting tier (`CACHE_MAX_SOURCE_SIZE`). */
  maxSourceSize: number;
  /** Up to and including this, use the mesh-only tier (`CACHE_MESH_ONLY_MAX_SIZE`). */
  maxMeshOnlySize: number;
}

/**
 * Classify the cache tier for a primary model by its source byte length.
 *
 * Thresholds are injected (not imported) so this stays a pure, node-testable
 * function: `ifcConfig` — where the real constants live — reads `import.meta.env`
 * at module load and can't be imported under the Node test runner (same reason
 * `acquireFileBuffer` injects `STREAM_SAB_THRESHOLD`). The loader passes the real
 * `CACHE_*` constants; tests pass representative values.
 *
 * The mesh-only tier only fires for files strictly larger than the source tier's
 * ceiling AND only when the prototype flag is on, so the classic <=150MB path is
 * byte-for-byte unchanged.
 */
export function classifyCacheTier(byteLength: number, opts: CacheTierOptions): CacheTier {
  if (byteLength < opts.minSize) return 'none';
  if (byteLength <= opts.maxSourceSize) return 'source';
  if (opts.meshOnlyEnabled && byteLength <= opts.maxMeshOnlySize) return 'mesh-only';
  return 'none';
}
