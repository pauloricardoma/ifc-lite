---
"@ifc-lite/collab": minor
---

Recipient-facing enhancements so a peer joining a seed-into-room link can
reconstruct a fully-functional model (spatial tree + properties) from the CRDT
as IFCX:

- `GeometryRefRecord` now holds an ordered `geomIds[]` (a single entity can own
  several meshes — multi-material / multiple representation items). Adds
  `addGeometryRef` (append) and `iterGeometries`; `getGeometryRef` reads the new
  shape with a fallback to the legacy single `geomId`. Blob GC follows all refs.
- `seedFromStep` now accepts per-entity `children`, so a legacy STEP seed can
  carry spatial containment (IfcRelAggregates / ContainedInSpatialStructure) and
  round-trips through `snapshotToIfcx` into a real spatial hierarchy.
- `PresenceState` gains an advisory `role` so peers can show each other's access
  role in a presence roster (the authoritative role stays the signed token).
