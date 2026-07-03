---
"@ifc-lite/wasm": patch
---

Make `DecodedEntity.attributes` an `Arc<Vec<AttributeValue>>` so cloning a decoded entity is a refcount bump instead of a deep clone of the whole attribute tree. The decoder deep-clones on every cache insert AND every cache hit (`decode_at`/`decode_by_id`), which was a large share of the allocator traffic in both parse and geometry on big models. Decoded attributes are never mutated after construction, so the sharing is sound and the read-through getters are unchanged. Byte-identical (mesh-determinism manifest unchanged, no re-pin). Measured ~8% faster total / ~10% parse / ~12% entity-scan on schependomlaan (47MB, 714k entities), scaling with entity count; it also cuts per-worker re-decode cost in the browser.
