/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which persisted-cache tier a model of a given byte length qualifies for.
 *   - `none`: too small to bother caching (parses fast), or too big for any
 *     tier, or the mesh-only tier is disabled (kill switch) and the file is >150MB.
 *   - `source`: the classic tier — persist tables + geometry AND the source
 *     buffer, so lazy property/quantity accessors + re-export read the source
 *     directly from IndexedDB.
 *   - `mesh-only`: the source-decoupled tier. Persist tables + geometry +
 *     instanced shards WITHOUT the source (too big for IndexedDB at 150-400MB);
 *     on re-open the freshly read file buffer hydrates the accessors. The hit is
 *     validated by the strengthened cache key (see `sourceFingerprint.ts`), not
 *     a full-file hash, so repeat opens have no main-thread stall.
 *
 * The ONLY difference between the two caching tiers is `persistSource` (and the
 * size band that selects them) — the save/load code is otherwise shared, so
 * {@link planCacheWrite} derives both in one place.
 */
export type CacheTier = 'none' | 'source' | 'mesh-only';

export interface CacheTierOptions {
  /** Is the mesh-only tier enabled? Default on; the kill switch is `?meshCache=0`. */
  meshOnlyEnabled: boolean;
  /** Below this, don't cache — small files parse fast (`CACHE_SIZE_THRESHOLD`). */
  minSize: number;
  /** Up to and including this, use the source-persisting tier (`CACHE_MAX_SOURCE_SIZE`). */
  maxSourceSize: number;
  /** Up to and including this, use the mesh-only tier (`CACHE_MESH_ONLY_MAX_SIZE`). */
  maxMeshOnlySize: number;
}

/** The write decision for a model: its tier and whether to persist the source. */
export interface CachePlan {
  tier: CacheTier;
  /** `true` unless the tier is `none` — whether to cache this model at all. */
  shouldCache: boolean;
  /** `true` only for the `source` tier — whether the raw source is persisted. */
  persistSource: boolean;
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
 * ceiling AND only when enabled, so the classic <=150MB path is byte-for-byte
 * unchanged whether the mesh-only tier is on or off.
 */
export function classifyCacheTier(byteLength: number, opts: CacheTierOptions): CacheTier {
  if (byteLength < opts.minSize) return 'none';
  if (byteLength <= opts.maxSourceSize) return 'source';
  if (opts.meshOnlyEnabled && byteLength <= opts.maxMeshOnlySize) return 'mesh-only';
  return 'none';
}

/**
 * Single home for the tier decision AND the `persistSource` derivation, so the
 * loader never re-derives `persistSource` from the tier name and the two tiers
 * can't drift. `source` persists the source; `mesh-only` does not; `none`
 * doesn't cache.
 */
export function planCacheWrite(byteLength: number, opts: CacheTierOptions): CachePlan {
  const tier = classifyCacheTier(byteLength, opts);
  return {
    tier,
    shouldCache: tier !== 'none',
    persistSource: tier === 'source',
  };
}
