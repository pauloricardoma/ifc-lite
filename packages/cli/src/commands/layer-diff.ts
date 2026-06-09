/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite layer diff` — compare two composed states. Each side resolves
 * to an ordered layer list (a ref's stack, a stored layer, or an .ifcx
 * file) and the two `extractStackState` results are diffed per entity and
 * per component (component identity via `snapshotOf` hashes).
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import {
  componentEntries,
  extractStackState,
  snapshotOf,
  type StackState,
} from '@ifc-lite/merge';
import { getFlag, hasFlag, printJson } from '../output.js';
import { resolveSide, storeFromArgs } from './layer-store.js';

export interface ModifiedEntity {
  path: string;
  /** Component keys whose value changed, was added, or was removed. */
  components: string[];
}

export interface LayerDiffResult {
  added: string[];
  deleted: string[];
  modified: ModifiedEntity[];
}

function alive(state: StackState, path: string): boolean {
  const entity = state.get(path);
  return entity !== undefined && !entity.deleted;
}

/** Diff two composed states: `from` (base) → `to` (target). */
export function diffStates(from: StackState, to: StackState): LayerDiffResult {
  const added: string[] = [];
  const deleted: string[] = [];
  const modified: ModifiedEntity[] = [];

  const paths = [...new Set<string>([...from.keys(), ...to.keys()])].sort();
  for (const path of paths) {
    const inFrom = alive(from, path);
    const inTo = alive(to, path);
    if (!inFrom && inTo) {
      added.push(path);
      continue;
    }
    if (inFrom && !inTo) {
      deleted.push(path);
      continue;
    }
    if (!inFrom && !inTo) continue;

    const fromEntity = from.get(path);
    const toEntity = to.get(path);
    if (!fromEntity || !toEntity) continue;
    const fromComponents = componentEntries(fromEntity);
    const toComponents = componentEntries(toEntity);
    const keys = [...new Set<string>([...fromComponents.keys(), ...toComponents.keys()])].sort();
    const changed: string[] = [];
    for (const key of keys) {
      const a = fromComponents.get(key);
      const b = toComponents.get(key);
      const aHash = a === undefined ? undefined : snapshotOf(a).hash;
      const bHash = b === undefined ? undefined : snapshotOf(b).hash;
      if (aHash !== bHash) changed.push(key);
    }
    if (changed.length > 0) modified.push({ path, components: changed });
  }

  return { added, deleted, modified };
}

/** Diff two ordered layer lists (`from` is the base side). */
export function diffLayerStacks(
  from: readonly IfcxFile[],
  to: readonly IfcxFile[]
): LayerDiffResult {
  return diffStates(extractStackState(from), extractStackState(to));
}

export async function layerDiffCommand(args: string[]): Promise<void> {
  const store = storeFromArgs(args);
  const target = args[0];
  if (!target || target.startsWith('-')) {
    throw new Error(
      'Usage: ifc-lite layer diff <layer-id|ref|file.ifcx> [--against <layer-id|ref|file.ifcx>] [--components] [--json]'
    );
  }
  const againstSpec = getFlag(args, '--against');

  const to = resolveSide(store, target);
  const from = againstSpec
    ? resolveSide(store, againstSpec)
    : { kind: 'ref' as const, layers: [], label: '(empty)' };
  const result = diffLayerStacks(from.layers, to.layers);

  if (hasFlag(args, '--json')) {
    printJson(result);
    return;
  }

  process.stdout.write(`diff ${from.label} → ${to.label}\n`);
  process.stdout.write(
    `${result.added.length} added, ${result.deleted.length} deleted, ${result.modified.length} modified\n`
  );
  for (const path of result.added) process.stdout.write(`  A ${path}\n`);
  for (const path of result.deleted) process.stdout.write(`  D ${path}\n`);
  const showComponents = hasFlag(args, '--components');
  for (const entry of result.modified) {
    process.stdout.write(`  M ${entry.path}\n`);
    if (showComponents) {
      for (const key of entry.components) process.stdout.write(`      ~ ${key}\n`);
    }
  }
}
