# WASM wide-arithmetic: measured win + delivery plan

Status: measurement + design (2026-06-27)
Goal: close the in-browser WASM-vs-native gap on exact-CSG/brep-heavy models
**without an install or an upload** (the hard client-side constraint), by building
the geometry kernel with the WASM wide-arithmetic proposal.

## Why this exists

The exact pure-Rust CSG kernel (`rust/geometry/src/kernel/`) runs a predicate
cascade over `bnum` fixed-width integers (I256/I512/I1024/I2048). On native those
are stack-allocated checked arithmetic; on wasm32 there is no wide-integer
hardware, so `bnum`'s 64x64->128 limb products compile to `__multi3` libcalls.
That is the structural reason heavy CSG/brep models are slower in the browser
than natively. The WASM wide-arithmetic proposal adds `i64.mul_wide_s/u`,
`i64.add128`, `i64.sub128`, which map those limb ops to single instructions.

## Measured (Apple M4, rustc 1.93-nightly / LLVM 21.1.5, wasmtime 46 / Cranelift)

Built with `-C target-feature=+wide-arithmetic`; verified the ops are emitted
(`wasm-tools print | grep`) and that output is byte-identical to baseline.

**Predicate microbench** (a 3x3 determinant = orient3d core, the exact hot path):

| tier | baseline wasm | +wide-arith | speedup | vs native |
|---|---:|---:|---:|---:|
| I256 (common) | 438 ns | 232 ns | 1.9x | within 1.23x of native |
| I512 (cache)  | 1093 ns | 358 ns | 3.1x | at native parity |

**End-to-end CSG** (a real slab-minus-9-boxes void cut through
`mesh_bridge::subtract_many`: arrangement + predicates + retriangulation):

| build | ms/cut | vs native |
|---|---:|---:|
| native | 10.25 | 1.0x |
| baseline wasm | 23.16 | 2.26x slower |
| **+wide-arith wasm** | **13.58** | **1.33x slower** |

End-to-end speedup **1.71x** — lower than the predicate-only number because a
real cut also spends time in arrangement bookkeeping / retriangulation /
allocation that wide-arith does not touch. Mechanism confirmed: 1447 wide ops in
the wide build, 0 in baseline (which instead emits `__multi3` libcalls).

**Bottom line:** wide-arithmetic takes in-browser exact CSG from ~2.3x
slower-than-native to ~1.3x, with zero algorithm change and no install/upload.
Native already beats web-ifc on the Tekla model (2.9s vs 4.9s), so closing the
wasm gap this far makes the in-browser path competitive on exactly the models
ThatOpen wins today.

## Toolchain status: reachable now

- `wide-arithmetic` is a recognized wasm target feature in our pinned toolchain.
- LLVM 21 lowers our actual `bnum` I256/I512 `checked_mul` to the wide ops with
  only `-C target-feature=+wide-arithmetic`. No `bnum` changes required.
- Gating factor for shipping is **browser engine support** (V8 / SpiderMonkey
  shipping the proposal), which is handled by feature detection below.

## Delivery plan (how WASM users get it)

This reuses the exact pattern already in place for the threaded second bundle
(`packages/wasm/pkg-threaded`, built off-by-default in `scripts/build-wasm.sh`).

1. **Build a third bundle `packages/wasm/pkg-wide`.** Same `wasm-pack` invocation
   as the default `pkg`, with `+wide-arithmetic` added to the default flags
   (`.cargo/config.toml` already sets `+simd128`). Off by default, behind
   `BUILD_WIDE=1` in `scripts/build-wasm.sh` (added in this change). CI/Vercel
   build it alongside `pkg` once we flip it on.

2. **Feature-detect at runtime** with a tiny `WebAssembly.validate()` probe of a
   40-byte module containing an `i64.add128` (opcode `0xFC 0x13`). Returns true
   only on engines that accept the proposal. Drop this into
   `packages/geometry/src/wasm-features.ts` when wiring selection:

   ```ts
   // module: (func (param i64 i64 i64 i64) (result i64 i64)
   //           local.get 0..3  i64.add128)  -- generated via `wasm-tools parse`
   const PROBE = new Uint8Array([
     0,97,115,109,1,0,0,0,1,10,1,96,4,126,126,126,126,2,126,126,3,2,1,0,
     10,14,1,12,0,32,0,32,1,32,2,32,3,252,19,11,
   ]);
   let cached: boolean | undefined;
   export function supportsWideArithmetic(): boolean {
     if (cached === undefined) {
       try { cached = typeof WebAssembly !== 'undefined' && WebAssembly.validate(PROBE); }
       catch { cached = false; }
     }
     return cached;
   }
   ```

3. **Select the bundle URL.** `geometry.worker.ts` already accepts an init
   `wasmUrl` (it otherwise falls back to `new URL('ifc-lite_bg.wasm', import.meta.url)`).
   When the probe is true, pass the `pkg-wide` wasm URL through the existing
   `wasmUrls` plumbing in `geometry-parallel.ts`; otherwise pass `pkg`. No engine
   without the feature ever loads the wide module, so it is safe to ship eagerly.

4. **Bundling.** Vite copies both `pkg` and `pkg-wide` wasm as assets (same as the
   threaded bundle). The JS glue is identical between bundles; only the `.wasm`
   differs, so the JS is shared and only the chosen `.wasm` is fetched.

Net: one extra `.wasm` artifact + a ~40-byte feature probe + a one-line URL
choice. Users on engines with wide-arithmetic transparently get ~1.7x faster
in-browser CSG; everyone else is unaffected.

## Reproduce

Two standalone bench crates (predicate microbench + end-to-end CSG) live in the
profiling repo under `wide-arith/`. Each builds twice and runs under wasmtime:

```sh
cargo build --release --lib --target wasm32-unknown-unknown
RUSTFLAGS="-C target-feature=+wide-arithmetic" \
  cargo build --release --lib --target wasm32-unknown-unknown --target-dir target-wide
wasm-tools print target-wide/wasm32-unknown-unknown/release/*.wasm | grep -c 'mul_wide\|add128'
wasmtime run -W wide-arithmetic=y --invoke <fn> target-wide/.../*.wasm <args>
```
