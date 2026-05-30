/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP IFC → collab seed-source adapter (plan §4.2).
 *
 * `@ifc-lite/collab` stays parser-independent: its `seedFromStep` consumes a
 * minimal structural `StepSeedSource`. This adapter — which lives in the
 * viewer because the viewer owns the parser — walks a parsed `IfcDataStore`
 * and yields one `StepSeedEntity` per GUID-bearing (`IfcRoot`-derived) entity,
 * keyed by its stable `IfcGloballyUniqueId`.
 *
 * v1 seeds entity identity + core attributes (Name/Description/ObjectType/Tag),
 * which is what recipients joining a seed-into-room link need for hierarchy,
 * selection, and presence. Property sets and geometry are follow-ups (psets
 * arrive via the mutation bridge in M2; geometry per plan §4.2 consequence 2).
 */

import { extractEntityAttributesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import type { StepSeedEntity, StepSeedSource } from '@ifc-lite/collab';

/** Adapt a parsed STEP `IfcDataStore` into a collab `StepSeedSource`. */
export function buildStepSeedSource(store: IfcDataStore, fileName?: string): StepSeedSource {
  function* iterate(): Generator<StepSeedEntity> {
    for (const [expressId, ref] of store.entityIndex.byId.entries()) {
      const attrs = extractEntityAttributesOnDemand(store, expressId);
      // Only IfcRoot-derived entities carry a GUID — the CRDT key.
      if (!attrs.globalId) continue;

      // Proper-cased class from the entity table; fall back to the raw
      // (UPPERCASE) STEP type for resource-level entities ('Unknown').
      const tableName = store.entities.getTypeName(expressId);
      const ifcClass = tableName && tableName !== 'Unknown' ? tableName : ref.type;

      const attributes: Record<string, unknown> = {};
      if (attrs.name) attributes.Name = attrs.name;
      if (attrs.description) attributes.Description = attrs.description;
      if (attrs.objectType) attributes.ObjectType = attrs.objectType;
      if (attrs.tag) attributes.Tag = attrs.tag;

      yield { guid: attrs.globalId, ifcClass, attributes };
    }
  }

  return {
    // A fresh iterator each time it's consumed (re-iterable).
    entities: { [Symbol.iterator]: iterate },
    header: { schema: store.schemaVersion, fileName },
  };
}
