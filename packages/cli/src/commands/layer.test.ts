/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR, computeStackHash, getProvenance } from '@ifc-lite/ifcx';
import { extractStackState } from '@ifc-lite/merge';
import {
  getRef,
  loadLayer,
  loadRefLayers,
  openStore,
  type LayerStore,
} from './layer-store.js';
import { deriveScopeOps, publishLayer, verifyScopeClaims } from './layer-publish.js';
import { diffLayerStacks } from './layer-diff.js';
import { mergeIntoRef } from './layer-merge.js';
import { bakeRef, logRef, revertInRef } from './layer-history.js';
import { createRef, listRefs, moveRef, protectRef } from './ref.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const CLASS = 'bsi::ifc::class';

function tmpStore(): LayerStore {
  return openStore(mkdtempSync(join(tmpdir(), 'ifc-lite-layer-test-')));
}

function makeDelta(nodes: IfcxNode[]): IfcxFile {
  return {
    header: {
      id: '',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'test',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    imports: [],
    schemas: {},
    data: nodes,
  };
}

const baseNodes: IfcxNode[] = [
  { path: 'storey-eg', children: { Wall: 'wall-1' } },
  {
    path: 'wall-1',
    attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' },
  },
];

/** Publish a base layer and point a fresh ref `main` at it. */
function setupMain(store: LayerStore): string {
  const published = publishLayer(store, {
    delta: makeDelta(baseNodes),
    baseRef: null,
    intent: 'Import base model',
    principal: 'alice',
  });
  createRef(store, 'main');
  moveRef(store, 'main', published.layerId);
  return published.layerId;
}

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
    ]);
    const verification = verifyScopeClaims(['model.delete@IfcWall'], ops);
    expect(verification.verified).toBe(false);
    expect(verification.violations.map((op) => op.capability)).toEqual(['model.create']);
  });
});

describe('bake', () => {
  it('writes tombstone-free output', () => {
    const store = tmpStore();
    setupMain(store);
    const tombstone = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }]),
      baseRef: 'main',
      intent: 'Delete wall-1',
      principal: 'bob',
    });
    mergeIntoRef(store, { candidateId: tombstone.layerId, into: 'main' });

    const baked = bakeRef(store, 'main');
    const paths = baked.data.map((n) => n.path);
    expect(paths).not.toContain('wall-1');
    for (const node of baked.data) {
      for (const key of Object.keys(node.attributes ?? {})) {
        expect(key.startsWith('ifclite::')).toBe(false);
      }
    }
  });
});

describe('revert', () => {
  it('restores the base state and appends to the ref', () => {
    const store = tmpStore();
    const baseId = setupMain(store);
    const edit = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }]),
      baseRef: 'main',
      intent: 'Bump fire rating',
      principal: 'bob',
    });
    mergeIntoRef(store, { candidateId: edit.layerId, into: 'main' });

    const result = revertInRef(store, edit.layerId, 'main', { principal: 'carol' });
    if (result.status !== 'reverted') throw new Error('expected clean revert');
    expect(getRef(store, 'main')?.layers).toEqual([baseId, edit.layerId, result.revertLayerId]);

    const reverted = extractStackState(loadRefLayers(store, 'main'));
    const baseline = extractStackState([loadLayer(store, baseId)]);
    expect(reverted.get('wall-1')?.components.get('pset:Pset_FireSafety')).toEqual(
      baseline.get('wall-1')?.components.get('pset:Pset_FireSafety')
    );
    expect(() => revertInRef(store, 'blake3:0000', 'main')).toThrow();
  });

  it('conflicts instead of clobbering later edits to the same component', () => {
    // A→B (revert target), then a later B→C edit: reverting A→B must not
    // silently produce A.
    const store = tmpStore();
    setupMain(store);
    const toB = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'B' } }]),
      baseRef: 'main',
      intent: 'A to B',
      principal: 'bob',
    });
    mergeIntoRef(store, { candidateId: toB.layerId, into: 'main' });
    const toC = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'C' } }]),
      baseRef: 'main',
      intent: 'B to C',
      principal: 'dave',
    });
    mergeIntoRef(store, { candidateId: toC.layerId, into: 'main' });

    const outcome = revertInRef(store, toB.layerId, 'main');
    if (outcome.status !== 'conflicts') throw new Error('expected conflicts');
    expect(outcome.conflicts.map((c) => c.componentKey)).toEqual(['pset:Pset_FireSafety']);

    // ours keeps the later edit (C); the disjoint parts still revert.
    const kept = revertInRef(store, toB.layerId, 'main', { resolve: 'ours' });
    if (kept.status !== 'reverted') throw new Error('expected revert with resolution');
    const state = extractStackState(loadRefLayers(store, 'main'));
    expect(state.get('wall-1')?.components.get('pset:Pset_FireSafety')).toEqual({ [FIRE]: 'C' });
  });
});

describe('log', () => {
  it('lists intents newest first, with author and created', () => {
    const store = tmpStore();
    setupMain(store);
    const edit = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }]),
      baseRef: 'main',
      intent: 'Bump fire rating',
      principal: 'bob',
      kind: 'agent',
    });
    mergeIntoRef(store, { candidateId: edit.layerId, into: 'main' });

    const entries = logRef(store, 'main');
    expect(entries.map((e) => e.intent)).toEqual(['Bump fire rating', 'Import base model']);
    expect(entries[0]).toMatchObject({ authorKind: 'agent', principal: 'bob', hasManifest: true });
    expect(entries[0].created).toBeTruthy();
  });
});

describe('diff', () => {
  it('reports added, deleted and modified entities with component keys', () => {
    const store = tmpStore();
    setupMain(store);
    const base = loadRefLayers(store, 'main');
    const next = makeDelta([
      { path: 'wall-1', attributes: { [FIRE]: 'REI120' } },
      { path: 'wall-2', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } },
      { path: 'storey-eg', attributes: { [IFCLITE_ATTR.DELETED]: true } },
    ]);
    const result = diffLayerStacks(base, [...base, next]);
    expect(result.added).toEqual(['wall-2']);
    // Tombstoning the storey shadows its subtree: wall-1 is deleted with
    // it, so its concurrent pset edit is no longer a "modified" entry.
    expect(result.deleted).toEqual(['storey-eg', 'wall-1']);
    expect(result.modified).toEqual([]);
  });
});

describe('refs', () => {
  it('creates, moves, protects and lists refs', () => {
    const store = tmpStore();
    const baseId = setupMain(store);
    createRef(store, 'option-b', 'main');
    expect(getRef(store, 'option-b')?.layers).toEqual([baseId]);
    expect(() => createRef(store, 'main')).toThrow(/already exists/);

    protectRef(store, 'main', { requireHumanApproval: true });
    const refs = listRefs(store);
    expect(refs.map((r) => r.name)).toEqual(['main', 'option-b']);
    expect(refs[0].policy?.requireHumanApproval).toBe(true);
    expect(refs[0].stackHash).toBe(computeStackHash([baseId]));

    // requireHumanApproval blocks agent-authored fast-forwards without approval.
    const agentEdit = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }]),
      baseRef: 'main',
      intent: 'Agent edit',
      principal: 'agent-1',
      kind: 'agent',
    });
    const blocked = mergeIntoRef(store, { candidateId: agentEdit.layerId, into: 'main' });
    expect(blocked.status).toBe('policy-failure');
    const approved = mergeIntoRef(store, {
      candidateId: agentEdit.layerId,
      into: 'main',
      approvedBy: 'alice',
    });
    expect(approved.status).toBe('fast-forward');
  });
});
