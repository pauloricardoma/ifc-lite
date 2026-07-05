---
"@ifc-lite/cache": minor
---

Add `CacheWriteOptions.omitSourceHash`. When set, `BinaryCacheWriter.write` skips the full-file `xxhash64(sourceBuffer)`, stores `sourceHash = 0n`, and sets the new `HeaderFlags.SourceHashUnset` — for callers that validate the source another way and don't want a large source to pay a full-file main-thread hash on write. `CacheHeaderInfo` gains `hasSourceHash`; `reader.read({ sourceBuffer })` skips header validation for such entries (instead of fail-closing), and `reader.validate()` throws a clear error rather than returning a misleading `false`. Default behaviour (the writer hashes the whole source) is unchanged, and entries written before this flag existed still validate normally.
