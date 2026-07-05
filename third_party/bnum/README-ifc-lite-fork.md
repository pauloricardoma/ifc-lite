# Vendored `bnum` (ifc-lite fork)

This is a vendored copy of [`bnum`](https://crates.io/crates/bnum) **0.14.4**
(git `3a4494d760ceb67a7d6744e952ffe1b5dd5ecab9`, MIT OR Apache-2.0), wired in as a
`[patch.crates-io]` from the workspace root `Cargo.toml`. `bnum` provides the
fixed-width `I256`/`I512`/`I1024`/`I2048` integers the exact CSG kernel
(`rust/geometry/src/kernel/`) computes predicates and arrangements in.

## Why we fork it

The kernel's hot arithmetic is wide-integer multiply. `bnum`'s schoolbook
accumulates each partial product in a **u128** digit
(`src/integer/overflowing.rs`, `to_digits::<u128>()`). wasm32 has no 128-bit
multiply, so every partial product lowers to a `__multi3` software libcall —
measured the dominant cost of the CSG kernel on wasm, ~66% of the wasm/native
gap. Splitting the operands into **u32** digits makes each partial product a
single `u32 * u32 -> u64` (`i64.mul`, no libcall).

Measured on a CSG-dense model (`advanced_model.ifc`), single-thread wasm
geometry compute: **-9%** total (3962ms -> 3606ms), **byte-identical** mesh
output (position/index/normal checksums unchanged).

## The patch (the ONLY functional change vs crates.io 0.14.4)

`src/integer/overflowing.rs`, in the unsigned branch of `overflowing_mul`, picks
the schoolbook digit width by target:

```rust
#[cfg(target_arch = "wasm32")]
type MulDigit = u32;
#[cfg(not(target_arch = "wasm32"))]
type MulDigit = u128;
let a = self.to_digits::<MulDigit>();
let b = rhs.to_digits::<MulDigit>();
```

Everything else in this tree is upstream 0.14.4 verbatim. Verify with:

```sh
# fetch pristine 0.14.4 and diff — the ONLY difference is overflowing.rs
cargo new /tmp/x && cd /tmp/x && cargo add bnum@=0.14.4
diff -r ~/.cargo/registry/src/*/bnum-0.14.4/src third_party/bnum/src
```

## Why this is byte-identical (native <-> wasm32 determinism)

`to_digits::<D>()` is a byte **reinterpretation** (`transmute`); the schoolbook
then multiplies the same N-byte two's-complement operands. The low-N-byte product
is the same number regardless of the accumulation digit width, and whether the
product overflows the signed width is a property of the true product, not of how
it was computed. So `MulDigit = u32` and `MulDigit = u128` return the identical
`(wrapped value, overflow)` pair. Native keeps u128, so **native codegen is
unchanged** (the fork is a no-op off wasm32).

This is gated by, in the ifc-lite workspace:
- `rust/geometry/tests/wide_mul_bit_identity.rs` — a CI differential test that
  proves independent u32-limb and u64-limb schoolbooks agree with each other and
  with `bnum::checked_mul` over a random + adversarial corpus for every width.
- The wasm A/B byte-identical mesh checksums recorded in the PR (bnum's own u32
  path vs its u128 path, end to end on the real target).
- `mesh_determinism` (native path unchanged; no manifest re-pin).

## Re-syncing to a newer bnum

Drop in the new upstream `src/` and re-apply the `MulDigit` change to the
unsigned branch of `overflowing_mul` (or delete this fork entirely once upstream
selects the digit width by `target_arch` — the long-term fix). Keep the
`[patch.crates-io]` version in lockstep with the version `rust/geometry` requires.
