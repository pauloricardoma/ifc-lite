/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Component-state extraction: the "semantic reading" of a layer stack.
 *
 * Flattens an ordered stack of IFCX documents (weakest first, later wins)
 * into per-entity component states keyed by the shared componentKey
 * vocabulary. Unlike the viewer composition path, tombstones are kept
 * visible here (`deleted` flag) — the merge matrix needs to see them.
 */

import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { ATTR, IFCLITE_ATTR, canonicalStringify } from '@ifc-lite/ifcx';
import { stableHash } from '@ifc-lite/diff';
import type { ComponentAttributes, ComponentKey, ComponentSnapshot } from './types.js';

export interface EntityState {
  path: string;
  /** Component values by key, hashes computed lazily via `snapshotOf`. */
  components: Map<ComponentKey, ComponentAttributes>;
  /** Child slots: role name → child path. */
  children: Map<string, string>;
  /** Final tombstone opinion for the path. */
  deleted: boolean;
}

export type StackState = Map<string, EntityState>;

const PSET_RE = /(?:^|::)(Pset_[A-Za-z0-9_]+)(?:::|$)/;
const QSET_RE = /(?:^|::)(Qto_[A-Za-z0-9_]+)(?:::|$)/;

/**
 * Map an IFCX attribute key onto the layer-op componentKey vocabulary.
 * Diff keys and op keys are deliberately the same words (02 §2.2).
 */
export function componentKeyForAttribute(attribute: string): ComponentKey {
  if (attribute === ATTR.CLASS) return 'attr:class';
  if (attribute === ATTR.TRANSFORM) return 'placement';
  const pset = PSET_RE.exec(attribute);
  if (pset) return `pset:${pset[1]}`;
  const qset = QSET_RE.exec(attribute);
  if (qset) return `qset:${qset[1]}`;
  if (attribute.startsWith(ATTR.PROP_PREFIX)) {
    return `attr:prop:${attribute.slice(ATTR.PROP_PREFIX.length)}`;
  }
  if (attribute.startsWith('usd::')) {
    const tier = attribute.split('::').pop() ?? 'usd';
    return `geometry:${tier}`;
  }
  return `attr:${attribute}`;
}

/**
 * Flatten an ordered stack (weakest first) into entity component states.
 * Later opinions shadow earlier ones per attribute; `null` child values
 * remove slots; `ifclite::deleted` resolves to the strongest opinion.
 */
export function extractStackState(layers: readonly IfcxFile[]): StackState {
  const state: StackState = new Map();

  const entityFor = (path: string): EntityState => {
    let entity = state.get(path);
    if (!entity) {
      entity = { path, components: new Map(), children: new Map(), deleted: false };
      state.set(path, entity);
    }
    return entity;
  };

  for (const layer of layers) {
    for (const node of layer.data) {
      applyNode(entityFor(node.path), node);
    }
  }

  // Drop empty shells created purely by child references.
  for (const [path, entity] of state) {
    if (entity.components.size === 0 && entity.children.size === 0 && !entity.deleted) {
      state.delete(path);
    }
  }
  return state;
}

function applyNode(entity: EntityState, node: IfcxNode): void {
  if (node.children) {
    for (const [name, child] of Object.entries(node.children)) {
      if (child === null) entity.children.delete(name);
      else entity.children.set(name, child);
    }
  }
  if (!node.attributes) return;
  for (const [key, value] of Object.entries(node.attributes)) {
    if (key === IFCLITE_ATTR.DELETED) {
      entity.deleted = value === true;
      continue;
    }
    if (key.startsWith(IFCLITE_ATTR.DERIVED)) continue;
    const componentKey = componentKeyForAttribute(key);
    const component = entity.components.get(componentKey) ?? {};
    if (value === null) {
      delete component[key];
      if (Object.keys(component).length === 0) {
        entity.components.delete(componentKey);
        continue;
      }
    } else {
      component[key] = value;
    }
    entity.components.set(componentKey, component);
  }
}

/** Hash + value snapshot for conflict records and fold detection. */
export function snapshotOf(attributes: ComponentAttributes): ComponentSnapshot {
  return { hash: stableHash(canonicalStringify(attributes)), attributes };
}

/**
 * Unified view used by the matrix: real components plus `child:<name>`
 * pseudo-components whose single attribute is the child path.
 */
export function componentEntries(entity: EntityState): Map<ComponentKey, ComponentAttributes> {
  const entries = new Map<ComponentKey, ComponentAttributes>(entity.components);
  for (const [name, child] of entity.children) {
    entries.set(`child:${name}`, { child });
  }
  return entries;
}
