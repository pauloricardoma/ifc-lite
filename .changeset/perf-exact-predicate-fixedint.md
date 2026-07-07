---
"@ifc-lite/wasm": patch
---

Replace `bnum` with a register-resident `FixedInt<K>` in the exact-predicate tier — a byte-identical **~15-28% geometry-phase** speedup on CSG- and geometry-heavy models.

Profiling the post-parse pipeline showed the single dominant self-time cost in the geometry phase is `bnum::overflowing_mul` (19.7% brep / 28.6% CSG): the Shewchuk-style adaptive predicate kernel spends its hot path in `checked_mul`/`checked_add`/`checked_sub` on 256-2048-bit integers when the interval filter can't certify a sign (welds, on-plane, axis ties — genuinely irreducible exact work). `bnum` 0.14.4 stores those integers as align-1 byte arrays (unaligned u128 loads per digit) and its signed `overflowing_mul` does a full-limb abs of both operands + digit conversions + an overflow-scan + sign correction on every call.

`kernel/fixed_int.rs` replaces the `bnum::types::I256/I512/I1024/I2048` aliases with a `[u64; K]` two's-complement type that keeps limbs in registers and, when a magnitude bit-length precheck proves the product fits, computes only the low K limbs. The hot ops (mul/add/sub/neg/sign/conversions) are native; the rounding- and division-delicate cold ops (`to_f64`, `Div`/`Rem`) delegate to `bnum` via an exact limb round-trip, so they stay bnum-identical by construction.

Byte-identical, proven at three levels: a differential fuzz of ~6M assertions per-op vs bnum across all four widths (boundary + overflow-straddling inputs; a mutation of the fast-path bound fails it on the first case); the pinned `boolean_manifest`/`retriangulation_manifest`/`indirect_sign_manifest`/`exact_predicate_determinism` gates; and mesh byte-parity across rvt01, skolebygg, dental, schependomlaan, Holter, and advanced_model (2.8M verts, exact).
