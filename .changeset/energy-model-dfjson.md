---
"@ifc-lite/geometry": minor
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
---

Add DFJSON (Dragonfly) energy-model export alongside HBJSON. Each `IfcSpace` becomes an extruded `Room2D` (floor polygon + floor-to-ceiling height) grouped into stories — the simpler Ladybug Tools target for mostly-vertical-wall models. Surfaces:

- `GeometryProcessor.exportDfjson(buffer, name)` (`@ifc-lite/geometry`)
- `bim.export.dfjson({ name, filename })` + `ExportDfjsonOptions` (`@ifc-lite/sdk`)
- `ifc-lite export <file> --format dfjson` (`@ifc-lite/cli`)

The Rust source of truth is `ifc-lite-export::export_dfjson`, reusing the same analytic floor-footprint extraction as HBJSON so the two energy exports cannot drift on coverage.
