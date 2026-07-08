---
"@ifc-lite/wasm": patch
---

Hoist the item-dedup mesh clone out of the shared cache's lock. `process_representation_item`'s content-dedup cache is a single `Arc<Mutex<FxHashMap>>` hit by every element; on a dedup miss it inserted `Arc::new(mesh.clone())` — a full mesh deep-copy that Rust evaluates *inside* the acquired lock, so under a multi-worker pool every miss serialized the pool behind one another's mesh copies. Clone into the Arc before taking the lock so the critical section is just the map insert. Byte-identical (the cache is pure memoization); most visible on high-core servers processing unique geometry (many misses, high contention).
