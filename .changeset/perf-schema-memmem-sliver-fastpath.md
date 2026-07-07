---
"@ifc-lite/wasm": patch
---

Two byte-identical cold-load micro-optimizations found by profiling the post-parse-optimization pipeline:

- **SIMD schema detection.** Schema-version detection walked the whole file with a naive per-position `content.windows(n).any(|w| w == b"IFC4X3")` (then again for `IFC4`) — for an IFC2X3 file both scans traverse every byte and fail. Swapped to `memchr::memmem::find`, the same predicate with a SIMD scan. This sat in an untimed gap between phase counters, so it hid from the per-phase profile; measured **-14% total load on a 47 MB IFC2X3 model**, less on IFC4.
- **Skip the no-op sliver-refine pass.** `refine_high_aspect_slivers` runs after every voided host; on a clean cut (no high-aspect slivers, the common case) it still built a per-round edge→triangle `BTreeMap` and scanned it only to discover there was nothing to split. It now does one O(T) aspect scan first and returns the mesh unchanged when no triangle exceeds the sliver threshold — byte-identical to the former `changed_any == false` return — and uses an `FxHashMap` for the vertex-canonicalization lookup (ids are insertion-ordered, map never iterated). A few percent on void-heavy architectural models.

Output is byte-identical (mesh/vertex/triangle counts unchanged across the fixture set; no mesh-determinism manifest change).
