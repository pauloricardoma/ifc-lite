---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Make the Google Earth **Pro** (KMZ) export actually load and render correctly, and add
it to the export menu (#1427).

> Note: KMZ 3D models (`<Model>`) only render in Google Earth **Pro** (desktop). Google
> Earth on the web does not support `<Model>` — for the web, export GLB and use the web
> app's "Import 3D model". The dialog and menu say so.

**It now loads in Pro.** Google Earth's KML `<Model>` only accepts **COLLADA** — a
glTF/GLB model fails with "Unsupported element: Model". The KMZ now embeds a COLLADA
`.dae` (new `exportKmzFromMeshes` / `export_collada_from_meshes`, schema-validated against
the COLLADA 1.4.1 XSD) instead of a GLB. Large models are split into multiple `<geometry>`
chunks bounded by 60k vertices / 20k triangles (Google Earth's 64K-vertex / 21,845-triangle
per-mesh limits) and vertices are deduplicated, so big structural models render in Pro.

**It's no longer dark or floating.** COLLADA materials set `<emission>` to the element
colour (Google Earth has no ambient/IBL and a single hard sun, so plain diffuse renders
near-black) and are flagged `double_sided` for IFC's unreliable winding. The model is
placed `clampToGround` so it rests on the terrain instead of floating at its MSL
`OrthogonalHeight` (a new `AltitudeMode` keeps `absolute`/`relativeToGround` available).
Vertices are emitted in the IFC-native Z-up frame so the building stands upright.

**It's in the menu.** A new "Export KMZ (Google Earth Pro)" entry sits alongside Export
GLB / IFC / HBJSON, using the same model-name file-stem scheme (`<name>.kmz`); it reports
a clear message when a model isn't georeferenced.

Also adds a general `emissive` option to the GLB exporter (`exportGlb` /
`exportGlbFromMeshes`) — `emissiveFactor = base colour` for renderers without ambient/IBL.
