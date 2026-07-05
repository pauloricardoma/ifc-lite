---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
---

Fail gracefully on models that exceed the browser's WebAssembly memory ceiling instead of a bare `unreachable executed` crash. The streaming prepass copies the whole file into wasm linear memory and builds the entity index alongside it; on wasm32 (4GB address space) a ~3GB+ model can't fit, so the allocator aborted with an opaque trap. Two changes: (1) cap the entity-index up-front reservation (`content.len() / 50` reserved ~1GB of hash slots for a ~4GB file, on top of the resident file — that alone blew the budget before the scan; now capped, a rare huge model grows the map via rehash instead of aborting), which lifts the practical browser ceiling and lowers peak memory for every large model; (2) when the prepass still traps on a very large file, surface an actionable error ("This model is X GB, which exceeds the browser's ~3GB WebAssembly ceiling — open it in the desktop app") rather than the cryptic wasm trap. Ordinary (<2GB) models are unaffected (their reservation stays under the cap; the error helper never fires).
