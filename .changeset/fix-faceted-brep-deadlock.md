---
"@ifc-lite/wasm": patch
---

Fix a native multithreaded self-deadlock in `process_geometry`. The persistent per-worker CartesianPoint cache is a `Vec<Mutex<FxHashMap>>` indexed by `rayon::current_thread_index()` and locked across the whole element job; faceted-brep triangulation nests a rayon `par_iter`, so a worker blocked at that nested join can work-steal another element job onto its own thread index and re-lock the non-reentrant `Mutex` it already holds, deadlocking the pool (reproduced reliably on faceted-brep-heavy models). The cache is now acquired with `try_lock`, and the rare re-entrant work-stolen job falls back to a throwaway cache. Output is byte-identical (the cache is pure memoization of deterministic coordinates, so a miss just re-decodes). The browser meshes single-threaded per worker and was never affected; this corrects the native path (FFI / Python wheel / native harnesses).
