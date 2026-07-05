---
"@ifc-lite/cache": minor
---

Add an optional `sourceHash` to `CacheWriteOptions`. When provided, `BinaryCacheWriter.write` stores it verbatim in the header and skips the internal full-buffer `xxhash64(sourceBuffer)`, so a caller that validates the source by other means (e.g. a strengthened cache key) does not pay a full-file main-thread hash on write. Default behaviour is unchanged when the option is omitted.
