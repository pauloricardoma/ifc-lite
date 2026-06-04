---
"@ifc-lite/extensions": patch
---

Make `packBundle` output deterministic. fflate's `gzipSync` embeds the current
time in the gzip header by default, so `.iflx` bundles were not byte-stable for
the same input (contradicting the documented contract and flaking the
determinism test). Pin `mtime: 0` for reproducible bundles.
