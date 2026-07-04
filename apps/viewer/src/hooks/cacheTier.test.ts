/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { classifyCacheTier, type CacheTierOptions } from './cacheTier.js';

// Mirror the production constants (ifcConfig.ts). Not imported: ifcConfig reads
// import.meta.env at module load and can't be evaluated under `node:test`.
const MB = 1024 * 1024;
const MIN = 10 * MB; // CACHE_SIZE_THRESHOLD
const MAX_SOURCE = 150 * MB; // CACHE_MAX_SOURCE_SIZE
const MAX_MESH_ONLY = 400 * MB; // CACHE_MESH_ONLY_MAX_SIZE

const base: Omit<CacheTierOptions, 'meshOnlyEnabled'> = {
  minSize: MIN,
  maxSourceSize: MAX_SOURCE,
  maxMeshOnlySize: MAX_MESH_ONLY,
};
const on: CacheTierOptions = { ...base, meshOnlyEnabled: true };
const off: CacheTierOptions = { ...base, meshOnlyEnabled: false };

describe('classifyCacheTier', () => {
  it('does not cache files below the min threshold', () => {
    assert.equal(classifyCacheTier(MIN - 1, on), 'none');
    assert.equal(classifyCacheTier(0, on), 'none');
  });

  it('uses the source tier from the min threshold up to and including 150MB', () => {
    assert.equal(classifyCacheTier(MIN, on), 'source');
    assert.equal(classifyCacheTier(MAX_SOURCE, on), 'source');
    // The source tier never depends on the mesh-only flag.
    assert.equal(classifyCacheTier(MAX_SOURCE, off), 'source');
  });

  it('uses the mesh-only tier in (150MB, 400MB] when the flag is on', () => {
    assert.equal(classifyCacheTier(MAX_SOURCE + 1, on), 'mesh-only');
    assert.equal(classifyCacheTier(MAX_MESH_ONLY, on), 'mesh-only');
  });

  it('never uses the mesh-only tier when the flag is off (no <=150MB regression)', () => {
    assert.equal(classifyCacheTier(MAX_SOURCE + 1, off), 'none');
    assert.equal(classifyCacheTier(MAX_MESH_ONLY, off), 'none');
  });

  it('does not cache files above the mesh-only ceiling even with the flag on', () => {
    assert.equal(classifyCacheTier(MAX_MESH_ONLY + 1, on), 'none');
  });
});
