/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IFCLITE_ATTR, computeStackHash, getProvenance } from '@ifc-lite/ifcx';
import { extractStackState } from '@ifc-lite/merge';
import { getRef, loadLayer, loadRefLayers, type LayerStore } from './layer-store.js';
import { ScopeViolationError, deriveScopeOps, publishLayer, verifyScopeClaims } from './layer-publish.js';
import { mergeIntoRef } from './layer-merge.js';
import { protectRef } from './ref.js';
import { CLASS, FIRE, makeDelta, setupMain, tmpStore } from './layer-test-helpers.js';

describe('publish → ref create → merge fast path', () => {
  it('fast-forwards a candidate authored against the ref head', () => {
    const store = tmpStore();
    const baseId = setupMain(store);

    const candidate = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }]),
      baseRef: 'main',
      intent: 'Bump fire rating',
      principal: 'bob',
    });
    expect(candidate.layerId).toMatch(/^blake3:[0-9a-f]+$/);
    expect(candidate.scopeVerified).toBe(true);

    const manifest = getProvenance(loadLayer(store, candidate.layerId));
    expect(manifest?.base).toEqual({ kind: 'stack', id: computeStackHash([baseId]) });
    expect(manifest?.intent).toBe('Bump fire rating');

    const outcome = mergeIntoRef(store, {
      candidateId: candidate.layerId,
      into: 'main',
      principal: 'carol',
    });
    expect(outcome.status).toBe('fast-forward');
    expect(getRef(store, 'main')?.layers).toEqual([baseId, candidate.layerId]);

    const state = extractStackState(loadRefLayers(store, 'main'));
    expect(state.get('wall-1')?.components.get('pset:Pset_FireSafety')).toEqual({
      [FIRE]: 'REI90',
    });
  });
});

describe('divergent merge', () => {
  function diverge(store: LayerStore): { first: string; second: string } {
    setupMain(store);
    const first = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }]),
      baseRef: 'main',
      intent: 'First edit',
      principal: 'bob',
    }).layerId;
    const second = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }]),
      baseRef: 'main',
      intent: 'Second edit',
      principal: 'dave',
    }).layerId;
    // First candidate lands, moving the ref past the second's base.
    expect(mergeIntoRef(store, { candidateId: first, into: 'main' }).status).toBe('fast-forward');
    return { first, second };
  }

  it('reports concurrent edits as conflicts (exit-code 2 path)', () => {
    const store = tmpStore();
    const { second } = diverge(store);
    const outcome = mergeIntoRef(store, { candidateId: second, into: 'main' });
    expect(outcome.status).toBe('conflicts');
    if (outcome.status !== 'conflicts') throw new Error('expected conflicts');
    expect(outcome.ancestorMatched).toBe(true);
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]).toMatchObject({
      kind: 'concurrent-edit',
      path: 'wall-1',
      componentKey: 'pset:Pset_FireSafety',
    });
  });

  it('completes with --resolve theirs and records the merge layer', () => {
    const store = tmpStore();
    const { second } = diverge(store);
    const outcome = mergeIntoRef(store, {
      candidateId: second,
      into: 'main',
      resolve: 'theirs',
      principal: 'carol',
    });
    expect(outcome.status).toBe('merged');
    if (outcome.status !== 'merged') throw new Error('expected merged');

    const mergeManifest = getProvenance(loadLayer(store, outcome.mergeLayerId));
    expect(mergeManifest?.merge?.candidate).toBe(second);
    expect(mergeManifest?.merge?.into).toBe('main');
    expect(mergeManifest?.merge?.resolutions).toEqual([
      { entity: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'theirs' },
    ]);

    const state = extractStackState(loadRefLayers(store, 'main'));
    expect(state.get('wall-1')?.components.get('pset:Pset_FireSafety')).toEqual({
      [FIRE]: 'REI120',
    });
  });

  it('enforces ref policy (required checks) with exit-code 3 outcome', () => {
    const store = tmpStore();
    const { second } = diverge(store);
    protectRef(store, 'main', { requiredChecks: ['fire-safety.ids'] });
    const outcome = mergeIntoRef(store, {
      candidateId: second,
      into: 'main',
      resolve: 'theirs',
    });
    expect(outcome.status).toBe('policy-failure');
    if (outcome.status !== 'policy-failure') throw new Error('expected policy failure');
    expect(outcome.reason).toContain('fire-safety.ids');

    // Waiving the check lets the merge complete and records the waiver.
    const waived = mergeIntoRef(store, {
      candidateId: second,
      into: 'main',
      resolve: 'theirs',
      waivers: [{ spec: 'fire-safety.ids', reason: 'spec not applicable' }],
      principal: 'carol',
    });
    expect(waived.status).toBe('merged');
    if (waived.status !== 'merged') throw new Error('expected merged');
    const manifest = getProvenance(loadLayer(store, waived.mergeLayerId));
    expect(manifest?.merge?.waived_checks).toEqual([
      { spec: 'fire-safety.ids', reason: 'spec not applicable', waivedBy: 'carol' },
    ]);
  });
});

describe('scope verification', () => {
  it('flags ops outside the declared claims', () => {
    const store = tmpStore();
    setupMain(store);
    const result = publishLayer(store, {
      delta: makeDelta([
        {
          path: 'wall-1',
          attributes: {
            [FIRE]: 'REI90',
            'bsi::ifc::v5a::Pset_Acoustics::SoundRating': 42,
          },
        },
      ]),
      baseRef: 'main',
      intent: 'Edit fire rating (and sneak in acoustics)',
      scope: ['model.mutate:Pset_FireSafety*@IfcWall'],
      principal: 'agent-1',
      kind: 'agent',
    });
    expect(result.scopeVerified).toBe(false);
    expect(result.violations).toEqual([
      { path: 'wall-1', capability: 'model.mutate:Pset_Acoustics', ifcType: 'IfcWall' },
    ]);
  });

  it('derives delete/create/mutate capabilities against the base state', () => {
    const store = tmpStore();
    setupMain(store);
    const base = loadRefLayers(store, 'main');
    const ops = deriveScopeOps(
      makeDelta([
        { path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } },
        { path: 'wall-2', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } },
        { path: 'storey-eg', children: { Wall2: 'wall-2' } },
      ]),
      base
    );
    expect(ops).toEqual([
      { path: 'wall-1', capability: 'model.delete', ifcType: 'IfcWall' },
      { path: 'wall-2', capability: 'model.create', ifcType: 'IfcWall' },
      { path: 'storey-eg', capability: 'model.mutate:children' },
    ]);
    const verification = verifyScopeClaims(['model.delete@IfcWall'], ops);
    expect(verification.verified).toBe(false);
    expect(verification.violations.map((op) => op.capability)).toEqual([
      'model.create',
      'model.mutate:children',
    ]);
  });

  it('hierarchy-only mutations do not bypass scope enforcement', () => {
    const store = tmpStore();
    setupMain(store);
    const base = loadRefLayers(store, 'main');
    // Reparent only — no attribute edits at all.
    const ops = deriveScopeOps(
      makeDelta([{ path: 'storey-eg', children: { Wall: 'wall-2' } }]),
      base
    );
    expect(ops).toEqual([{ path: 'storey-eg', capability: 'model.mutate:children' }]);
    expect(verifyScopeClaims(['model.mutate:Pset_FireSafety*'], ops).verified).toBe(false);
    // Unchanged children echoes are not ops.
    expect(
      deriveScopeOps(makeDelta([{ path: 'storey-eg', children: { Wall: 'wall-1' } }]), base)
    ).toEqual([]);
  });

  it('strict scope aborts before any side effect', () => {
    const store = tmpStore();
    setupMain(store);
    const layersBefore = readdirSync(join(store.dir, 'layers'));
    expect(() =>
      publishLayer(store, {
        delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }]),
        baseRef: 'main',
        intent: 'Out of scope',
        scope: ['model.mutate:Pset_Acoustics*@IfcWall'],
        strictScope: true,
      })
    ).toThrow(ScopeViolationError);
    // Nothing was stored.
    expect(readdirSync(join(store.dir, 'layers'))).toEqual(layersBefore);
  });
});
