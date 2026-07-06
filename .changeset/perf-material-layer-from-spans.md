---
"@ifc-lite/wasm": patch
---

Faster load: build the material-layer index from the `IfcRelAssociatesMaterial` spans the main scan already stashed, instead of re-walking the whole file. The native `process_geometry` path (CLI, server, glTF/GLB export) called `MaterialLayerIndex::from_content`, a redundant single-threaded full-file scan for the exact entities the scan loop already collects into `prepass_spans`. Switching to the existing byte-identical `from_spans` (the wasm streaming pre-pass already uses it for the same reason) removes that extra pass — measured -15% total load on a 47 MB architectural model, -9% on a 169 MB model, -6% on a 54 MB model, ~0 on geometry-bound (steel) models. Output is byte-identical (mesh/vertex/triangle counts unchanged across the fixture set; no mesh-determinism manifest change).
