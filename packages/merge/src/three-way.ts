/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Three-way merge: two runs of the two-way comparison joined on identity,
 * iterated over the union of touched (entity, componentKey) pairs.
 *
 * Inputs: ancestor A = the candidate layer's base, ours O = the target
 * ref's state, theirs T = the candidate applied to A. The plan's autoOps
 * apply on top of O; "keep ours" therefore emits nothing.
 *
 * Decision matrix (05 §5.3):
 *
 *   A→O unchanged, A→T changed            → take theirs (auto)
 *   A→O changed,  A→T unchanged           → keep ours (auto)
 *   both changed, equal sub-hash          → fold (auto)
 *   both changed, different               → conflict: concurrent-edit
 *   tombstoned vs changed                 → conflict: delete-vs-modify
 *   changed vs tombstoned                 → conflict: modify-vs-delete
 *   tombstoned vs tombstoned              → fold (auto)
 *
 * Relations use the same matrix over `child:<name>` slots; divergent
 * reparenting surfaces as a `hierarchy` conflict.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import type {
  ComponentAttributes,
  ComponentKey,
  MergeConflict,
  MergeOp,
  MergePlan,
} from './types.js';
import type { EntityState, StackState } from './component-state.js';
import { componentEntries, extractStackState, snapshotOf } from './component-state.js';

export interface ThreeWayInputs {
  /** The candidate layer's base, ordered weakest first. */
  ancestor: readonly IfcxFile[];
  /** The target ref's state, ordered weakest first. */
  ours: readonly IfcxFile[];
  /** The candidate applied to its base, ordered weakest first. */
  theirs: readonly IfcxFile[];
}

export function planThreeWayMerge(inputs: ThreeWayInputs): MergePlan {
  return planFromStates(
    extractStackState(inputs.ancestor),
    extractStackState(inputs.ours),
    extractStackState(inputs.theirs)
  );
}

export function planFromStates(a: StackState, o: StackState, t: StackState): MergePlan {
  const autoOps: MergeOp[] = [];
  const conflicts: MergeConflict[] = [];
  let touched = 0;

  const paths = new Set<string>([...a.keys(), ...o.keys(), ...t.keys()]);
  for (const path of paths) {
    const result = mergeEntity(path, a.get(path), o.get(path), t.get(path));
    autoOps.push(...result.ops);
    conflicts.push(...result.conflicts);
    touched += result.touched;
  }

  return {
    autoOps,
    conflicts,
    stats: { touched, autoMerged: autoOps.length, conflicting: conflicts.length },
  };
}

interface EntityMergeResult {
  ops: MergeOp[];
  conflicts: MergeConflict[];
  touched: number;
}

function alive(entity: EntityState | undefined): boolean {
  return entity !== undefined && !entity.deleted;
}

function componentsOf(entity: EntityState | undefined): Map<ComponentKey, ComponentAttributes> {
  return entity ? componentEntries(entity) : new Map();
}

function componentsEqual(
  x: Map<ComponentKey, ComponentAttributes>,
  y: Map<ComponentKey, ComponentAttributes>
): boolean {
  if (x.size !== y.size) return false;
  for (const [key, attrs] of x) {
    const other = y.get(key);
    if (!other || snapshotOf(other).hash !== snapshotOf(attrs).hash) return false;
  }
  return true;
}

function mergeEntity(
  path: string,
  aEntity: EntityState | undefined,
  oEntity: EntityState | undefined,
  tEntity: EntityState | undefined
): EntityMergeResult {
  const aAlive = alive(aEntity);
  const oAlive = alive(oEntity);
  const tAlive = alive(tEntity);
  const aComponents = componentsOf(aEntity);
  const oComponents = componentsOf(oEntity);
  const tComponents = componentsOf(tEntity);

  // Both sides agree the entity is gone (or never both created it): fold.
  if (!oAlive && !tAlive) return { ops: [], conflicts: [], touched: aAlive ? 1 : 0 };

  // Ours deleted (or never had it), theirs alive.
  if (!oAlive && tAlive) {
    const tChanged = !componentsEqual(aComponents, tComponents);
    const oDeletedExplicitly = aAlive || oEntity?.deleted === true;
    if (oDeletedExplicitly && tChanged) {
      // delete-vs-modify: ours tombstoned what theirs kept editing.
      return {
        ops: [],
        conflicts: [
          {
            kind: 'delete-vs-modify',
            path,
            theirs: snapshotOf(Object.fromEntries(tComponents.entries())),
            ...(aAlive ? { base: snapshotOf(Object.fromEntries(aComponents.entries())) } : {}),
          },
        ],
        touched: 1,
      };
    }
    if (oDeletedExplicitly && !tChanged) {
      // Theirs didn't touch it: the deletion stands.
      return { ops: [], conflicts: [], touched: 1 };
    }
    // Entity added (or resurrected) by theirs only: take theirs.
    const ops: MergeOp[] = [];
    if (oEntity?.deleted === true || (aEntity?.deleted === true && !oAlive)) {
      ops.push({ op: 'resurrect-entity', path });
    }
    ops.push(...opsForComponents(path, tComponents));
    return { ops, conflicts: [], touched: 1 };
  }

  // Ours alive, theirs deleted (or never had it).
  if (oAlive && !tAlive) {
    const tDeletedExplicitly = aAlive || tEntity?.deleted === true;
    if (!tDeletedExplicitly) {
      // Theirs simply never saw this entity (added on ours): keep ours.
      return { ops: [], conflicts: [], touched: 0 };
    }
    const oChanged = !componentsEqual(aComponents, oComponents);
    if (oChanged) {
      return {
        ops: [],
        conflicts: [
          {
            kind: 'modify-vs-delete',
            path,
            ours: snapshotOf(Object.fromEntries(oComponents.entries())),
            ...(aAlive ? { base: snapshotOf(Object.fromEntries(aComponents.entries())) } : {}),
          },
        ],
        touched: 1,
      };
    }
    return { ops: [{ op: 'tombstone-entity', path }], conflicts: [], touched: 1 };
  }

  // Both alive: component-level matrix over the union of touched keys.
  const ops: MergeOp[] = [];
  const conflicts: MergeConflict[] = [];
  let touched = 0;
  const keys = new Set<ComponentKey>([
    ...aComponents.keys(),
    ...oComponents.keys(),
    ...tComponents.keys(),
  ]);

  for (const key of keys) {
    const aAttrs = aComponents.get(key);
    const oAttrs = oComponents.get(key);
    const tAttrs = tComponents.get(key);
    const aHash = aAttrs ? snapshotOf(aAttrs).hash : undefined;
    const oHash = oAttrs ? snapshotOf(oAttrs).hash : undefined;
    const tHash = tAttrs ? snapshotOf(tAttrs).hash : undefined;

    const oChanged = aHash !== oHash;
    const tChanged = aHash !== tHash;
    if (!oChanged && !tChanged) continue;
    touched += 1;

    if (oChanged && !tChanged) continue; // keep ours
    if (oChanged && tChanged && oHash === tHash) continue; // fold

    if (!oChanged && tChanged) {
      ops.push(...opsForComponentChange(path, key, aAttrs, tAttrs));
      continue;
    }

    // Both changed, different values.
    conflicts.push({
      kind: key.startsWith('child:') || key.startsWith('inherit:') ? 'hierarchy' : 'concurrent-edit',
      path,
      componentKey: key,
      ...(aAttrs ? { base: snapshotOf(aAttrs) } : {}),
      ...(oAttrs ? { ours: snapshotOf(oAttrs) } : {}),
      ...(tAttrs ? { theirs: snapshotOf(tAttrs) } : {}),
    });
  }

  return { ops, conflicts, touched };
}

/** Ops that materialize every component of a (newly added) entity. */
function opsForComponents(
  path: string,
  components: Map<ComponentKey, ComponentAttributes>
): MergeOp[] {
  const ops: MergeOp[] = [];
  for (const [key, attrs] of components) {
    ops.push(...opsForComponentChange(path, key, undefined, attrs));
  }
  return ops;
}

/** Ops that move one component from its ancestor value to the new value. */
export function opsForComponentChange(
  path: string,
  componentKey: ComponentKey,
  ancestor: ComponentAttributes | undefined,
  next: ComponentAttributes | undefined
): MergeOp[] {
  if (componentKey.startsWith('child:')) {
    const name = componentKey.slice('child:'.length);
    if (next === undefined) return [{ op: 'remove-child', path, name }];
    return [{ op: 'set-child', path, name, child: String(next.child) }];
  }
  if (componentKey.startsWith('inherit:')) {
    const name = componentKey.slice('inherit:'.length);
    if (next === undefined) return [{ op: 'remove-inherit', path, name }];
    return [{ op: 'set-inherit', path, name, target: String(next.inherit) }];
  }
  if (next === undefined) {
    const nulled: ComponentAttributes = {};
    for (const attr of Object.keys(ancestor ?? {})) nulled[attr] = null;
    return [{ op: 'tombstone-component', path, componentKey, attributes: nulled }];
  }
  return [{ op: 'set-component', path, componentKey, attributes: next }];
}
