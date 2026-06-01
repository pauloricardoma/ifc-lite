---
"@ifc-lite/viewer": minor
"@ifc-lite/collab": minor
"@ifc-lite/renderer": minor
---

Collaborative geometry editing parity: move, rotate, delete, create, split, and
resize now sync across a shared room, and the move gizmo + geometry-edit card
surface for a recipient whose model was reconstructed from the CRDT.

- `@ifc-lite/collab`: placement rides as the IFCX-native `usd::xformop`
  attribute, so it round-trips through `snapshotToIfcx` / the IFCX parser with
  no writer change. Adds `placementToMatrix` / `matrixToPlacement`,
  `set` / `getEntityPlacement`, `set` / `getPlacementBaseline`, the `USD_XFORMOP`
  + `PLACEMENT_BASELINE_META` constants, and the `LocalPlacement` / `Mat4` /
  `UsdXformOp` types.
- `@ifc-lite/renderer`: `Scene.rotateMeshesForEntity(expressId, angle, pivot)`
  (and the bulk `rotateMeshesForEntities`) rotate an entity's mesh in place
  about the renderer +Y axis — the Y-up image of an IFC yaw about storey Z.
- `@ifc-lite/viewer`: local geometry edits mirror to the CRDT and apply from
  peers (placement via `usd::xformop`, entity create/delete, and a geometry
  blob replace for resize); `readEntityPosition` / `readEntityRotation` fall
  back to the collab placement so the gizmo + card render on an IFCX recipient
  store; and authoring is gated by collab role via `canCollabEdit()`.
