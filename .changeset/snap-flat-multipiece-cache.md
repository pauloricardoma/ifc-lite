---
"@ifc-lite/renderer": patch
---

Fix measure-snap missing all-but-one piece of a multi-piece flat mesh. The snap geometry cache
keyed flat meshes on `expressId` alone (instanced occurrences already keyed on `occurrenceKey`,
#1405), assuming one flat mesh per `expressId`. But mesh fragmentation routinely emits one
entity as several flat `MeshData` pieces — e.g. an `IfcMechanicalFastener` "Bolt assembly" of
mapped items materialized as 24 pieces sharing one `expressId` — and mapped copies share both
`expressId` and local positions, differing only in `origin`. So the first piece's deduped
vertices/edges were served for every other piece, and vertex/edge snap lit up on only one piece
(one bolt of the group) while the rest fell back to a free-point face hit. The cache now keys
flat pieces on a cheap content signature (`expressId` + `origin` + buffer sizes + sampled
vertices), so every piece snaps; genuinely identical world geometry still shares one entry.

Also fix the measure-snap radius being ~57× too small. `screenToWorldRadius` applied a
degrees→radians conversion to `fov`, but its only caller passes `Camera.getFOV()`, which is
already in radians. The shrunken radius made vertex/edge snap require sub-millimetre cursor
precision and fall back to a face hit on small features (e.g. bolts). The conversion is
removed; `fov` is treated as radians.

Also fix the CPU pick/snap mesh collection dropping mapped copies. `collectVisibleMeshData`
deduped flat pieces on a size-based key (`expressId` + `modelIndex` + buffer sizes), so the
several flat pieces a mapped entity expands to — identical template geometry at different
placements (e.g. the 4 bolts of one `IfcMechanicalFastener`) — collided and all but the first
were dropped from the raycast set. The hidden bolts then returned no ray hit at all, so neither
pick nor snap could reach them. The key now also includes the per-piece `origin` + first vertex,
so distinct placements survive while a truly identical piece reached from both the regular and
batched passes still dedups. (Mirrors the instanced-piece key fix from #1238 for the flat path.)
