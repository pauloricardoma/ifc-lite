---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Fix the Google Earth (KMZ) export placing the model floating in the sky and rendering it
extremely dark (#1427).

**Placement.** The `<Model>` was emitted with `altitudeMode = relativeToGround` and
`altitude = IfcMapConversion.OrthogonalHeight`. Google Earth's terrain already carries the
site elevation, so adding the MSL orthogonal height on top of it floated the building roughly
`OrthogonalHeight` metres into the air. The KMZ exporter now clamps the model to the ground
(`altitudeMode = clampToGround`), which rests it on the terrain and is immune to a wrong /
zero / double-counted `OrthogonalHeight`. A new `AltitudeMode` option on the Rust exporter
keeps `absolute`/`relativeToGround` available for callers that trust the source height.

**Colour.** GLB materials were standard lit PBR. Google Earth provides no ambient/IBL and
lights with a single hard sun, and it ignores `KHR_materials_unlit`, so shadow-side faces went
near-black. The GLB exporter gains an `emissive` option (`exportGlbFromMeshes(..., emissive)`)
that sets each material's `emissiveFactor` to its base colour — core glTF 2.0, honoured by any
compliant renderer — so the model shows its true colour regardless of lighting. The base colour
is preserved, so a viewer that ignores emissive is never darker than before. The Google Earth
KMZ export now requests emissive materials.
