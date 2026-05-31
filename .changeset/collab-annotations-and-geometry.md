---
"@ifc-lite/collab": minor
---

Shared annotation collection + complete-geometry seeding.

- New top-level `annotations` Y.Map with `createAnnotation` / `updateAnnotation` /
  `deleteAnnotation` / `getAnnotation` / `iterAnnotations` / `annotationsMap`
  helpers — synced alongside the model but excluded from the IFCX snapshot
  (collaboration markup, not BIM).
- Geometry refs resolve products via the entity table's GlobalId so large STEP
  models seed all of their geometry (not just the compact-index subset).
- Removed the superseded single-`geomId` geometryRef fallback (the `geomIds[]`
  shape is the only one, unreleased).
