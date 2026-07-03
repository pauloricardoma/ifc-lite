---
"@ifc-lite/wasm": patch
---

Reuse per-worker scratch buffers in the mesh-assembly funnel. `orient_mesh_outward` and `weld_indexed` allocated fresh maps/Vecs once per mesh (~100k+ times on a big model); they now take + put back a `thread_local!` scratch buffer (cleared before each use), turning allocate-fill-free cycles into allocate-once-clear-many. `thread_local!` makes it per-worker-thread by construction, so it is safe inside faceted-brep's nested `par_iter` (no shared-buffer race, no re-entrant borrow) and needs no lock. Byte-identical (buffer reuse only; the fill sequence and output order are unchanged; mesh-determinism manifest passes with no re-pin). Measured ~3.7-3.8% off the geometry phase. Both files stay under the 400-line module-size limit (no ratchet bump).
