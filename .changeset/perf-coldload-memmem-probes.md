---
"@ifc-lite/wasm": patch
---

Replace three naive full-file substring probes with SIMD `memchr::memmem::find`. `IFCMATERIALLAYERSET` / `IFCINDEXEDCOLOURMAP` / `IFCINDEXEDTRIANGLETEXTUREMAP` presence were tested with `content.windows(K).any(|w| w == KW)` (O(n*k)); each geometry worker runs these over the WHOLE file on its first batch call, so on a 200-340MB model they cost ~100-400ms per worker of pure redundant scanning (and it multiplies with worker count). `memmem::find` is the SIMD O(n) equivalent and byte-identical (same "does this keyword appear" boolean). Part of removing per-worker O(file) redundancy on the cold-load critical path.
