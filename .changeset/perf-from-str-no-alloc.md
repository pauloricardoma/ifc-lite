---
"@ifc-lite/wasm": patch
---

Make `IfcType::from_str` allocation-free on the hot path. It previously called `s.to_uppercase()` (a `String` allocation) on every invocation, and it is called once per scanned entity (millions of times on large models). STEP entity keywords are already uppercase ASCII, so the common case now matches the input slice directly and only rare lowercase/non-ASCII input allocates an owned uppercase copy. Byte-identical: a pure-uppercase-ASCII input equals its own `to_uppercase()`, so both the recognized-type match arms and the `Unknown(crc32_hash(..))` fallback produce the same result. A profiling `sample` attributed ~5% of busy CPU to this allocation on a 109k-element model.
