---
"@ifc-lite/wasm": patch
---

Faster cold load in the browser: bulk-copy the streaming pre-pass's entity-index export instead of writing it one entry at a time. The pre-pass ships the completed entity index to the geometry workers (they idle until it arrives, then stop re-scanning the file), and it filled three `Uint32Array`s with a per-entry `set_index` loop — three JS↔WASM boundary crossings per entity, ~8.4M FFI calls on a 2.8M-entity model, all on the workers' critical path. The index is now packed into three contiguous Rust buffers and handed to JS in one bulk `Uint32Array::from` copy each (matching the void/style exports beside it). Measured: the entity-index event reaches the workers ~11% sooner on a 169 MB model (360 ms → 321 ms) and ~9% sooner on a 47 MB model, pulling stream-complete in accordingly; the saving scales with entity count. Byte-identical: the workers zip `ids[i]`/`starts[i]`/`lengths[i]` into a map, so iteration order carries no meaning.
