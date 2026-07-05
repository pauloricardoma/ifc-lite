// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Differential bit-identity gate for the wasm32 u32-digit multiply fork of
//! `bnum` (`third_party/bnum`, `[patch.crates-io]`).
//!
//! The fork makes the exact-CSG-kernel schoolbook accumulate partial products in
//! u32 digits on wasm32 (one `i64.mul` each) instead of u128 (a `__multi3`
//! libcall each) — a -9% single-thread geometry win on a CSG-dense model. The
//! correctness claim is that this is BYTE-IDENTICAL: a fixed-width integer
//! product, and whether it overflows the signed width, are independent of the
//! digit width used to compute them.
//!
//! This test proves that claim with two INDEPENDENT reference multipliers — a
//! u32-limb and a u64-limb schoolbook, written from scratch in plain `u128`/`Vec`
//! arithmetic (perf is irrelevant in a test) — and asserts, over a large random
//! plus adversarial corpus for every width the kernel uses (I256/I512/I1024/I2048),
//! that (a) the u32-limb and u64-limb paths agree with each other (the exact
//! digit width the fork changes), and (b) both agree with
//! `bnum::CheckedMul::checked_mul` (value when it fits, and `None` on exactly the
//! same overflow set).
//!
//! It runs on native (`cargo test -p ifc-lite-geometry`), where these oracles
//! and `bnum` all produce target-independent integer results, so agreement here
//! is agreement on wasm32. The end-to-end proof that `bnum`'s OWN u32 path
//! (the fork) matches its u128 path is the wasm A/B byte-identical mesh
//! checksum recorded in the PR.

use bnum::types::{I1024, I2048, I256, I512};
use num_traits::CheckedMul;

/// Independent schoolbook multiply of two signed fixed-width values given as
/// their little-endian magnitude bytes, in limbs of `limb_bytes` (4 or 8).
/// Returns the exact signed product truncated to `n` bytes, or `None` if it
/// overflows the signed `n`-byte width — the `checked_mul` contract.
fn oracle(a_le: &[u8], sa: bool, b_le: &[u8], sb: bool, n: usize, limb_bytes: usize) -> Option<Vec<u8>> {
    let l = n / limb_bytes;
    let base: u128 = 1u128 << (8 * limb_bytes);
    let read = |bytes: &[u8], i: usize| -> u128 {
        let mut v = 0u128;
        for k in 0..limb_bytes {
            v |= (bytes[i * limb_bytes + k] as u128) << (8 * k);
        }
        v
    };
    let al: Vec<u128> = (0..l).map(|i| read(a_le, i)).collect();
    let bl: Vec<u128> = (0..l).map(|i| read(b_le, i)).collect();

    // |a| * |b| into 2l limbs.
    let mut r = vec![0u128; 2 * l];
    for i in 0..l {
        let mut carry = 0u128;
        for j in 0..l {
            let t = al[i] * bl[j] + r[i + j] + carry;
            r[i + j] = t % base;
            carry = t / base;
        }
        r[i + l] += carry;
    }

    // Product magnitude as 2n little-endian bytes.
    let mut p = vec![0u8; 2 * n];
    for i in 0..2 * l {
        for k in 0..limb_bytes {
            p[i * limb_bytes + k] = ((r[i] >> (8 * k)) & 0xff) as u8;
        }
    }

    // Signed fit in n bytes: the high n bytes must be zero; then handle the
    // 2^(w-1) boundary (only i::MIN, a negative result, is representable).
    let high_nonzero = p[n..].iter().any(|&x| x != 0);
    let top_bit_set = (p[n - 1] & 0x80) != 0;
    let neg = sa ^ sb;
    let overflow = if high_nonzero {
        true
    } else if !top_bit_set {
        false
    } else if !neg {
        true // magnitude >= 2^(w-1) > i::MAX
    } else {
        // negative: fits iff magnitude == 2^(w-1) exactly (0x80 00..00).
        p[..n].iter().enumerate().any(|(i, &x)| if i == n - 1 { x != 0x80 } else { x != 0 })
    };
    if overflow {
        return None;
    }

    // Reconstruct |result| low bytes, then re-apply the sign in two's complement.
    let mut lo = p[..n].to_vec();
    if neg {
        // negate: two's complement over n bytes.
        let mut carry = 1u16;
        for byte in lo.iter_mut() {
            let v = (!*byte) as u16 + carry;
            *byte = v as u8;
            carry = v >> 8;
        }
    }
    Some(lo)
}

// xorshift64* deterministic stream.
fn next(s: &mut u64) -> u64 {
    let mut x = *s;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *s = x;
    x.wrapping_mul(0x2545_F491_4F6C_DD1D)
}

macro_rules! width_suite {
    ($name:ident, $t:ty, $nbytes:literal) => {
        #[test]
        fn $name() {
            type I = $t;
            const N: usize = $nbytes;

            // Compare the two independent oracles AND bnum for one (a, b).
            let check = |a: I, b: I| {
                let sa = a.is_negative();
                let sb = b.is_negative();
                let a_mag = (if sa { a.wrapping_neg() } else { a }).to_le_bytes();
                let b_mag = (if sb { b.wrapping_neg() } else { b }).to_le_bytes();

                let want = CheckedMul::checked_mul(&a, &b).map(|v| v.to_le_bytes().to_vec());
                let got32 = oracle(&a_mag, sa, &b_mag, sb, N, 4);
                let got64 = oracle(&a_mag, sa, &b_mag, sb, N, 8);

                assert_eq!(got32, got64, "u32-limb vs u64-limb disagree: a={a:?} b={b:?}");
                assert_eq!(got32, want, "u32-limb vs bnum::checked_mul disagree: a={a:?} b={b:?}");
            };

            // Adversarial fixed set: 0, +-1, MIN, MAX, and every +-2^k, whose
            // pairwise products straddle the +-2^(w-1) overflow boundary.
            let zero = I::from_le_bytes([0u8; N]);
            let one = I::from_le_bytes({
                let mut b = [0u8; N];
                b[0] = 1;
                b
            });
            let neg_one = I::from_le_bytes([0xFFu8; N]);
            let min = I::from_le_bytes({
                let mut b = [0u8; N];
                b[N - 1] = 0x80;
                b
            });
            let max = I::from_le_bytes({
                let mut b = [0xFFu8; N];
                b[N - 1] = 0x7F;
                b
            });
            let pow2 = |k: usize| -> I {
                let mut b = [0u8; N];
                b[k / 8] = 1u8 << (k % 8);
                I::from_le_bytes(b)
            };
            // Small exhaustive set.
            let small = [zero, one, neg_one, min, max];
            for &a in &small {
                for &b in &small {
                    check(a, b);
                }
            }
            // Power-of-two boundary sweep: pow2(i) * pow2(j) == 2^(i+j); walk the
            // exponent sum through the +-2^(w-1) signed-fit boundary (just below,
            // at, just over) so the exact overflow threshold is hit for every
            // sign. O(w), not the O(w^2) all-pairs product.
            let w = N * 8;
            for i in 0..w {
                for target in [w - 2, w - 1, w] {
                    if target >= i && target - i < w {
                        let (pa, pb) = (pow2(i), pow2(target - i));
                        check(pa, pb);
                        check(pa.wrapping_neg(), pb);
                        check(pa, pb.wrapping_neg());
                        check(pa.wrapping_neg(), pb.wrapping_neg());
                    }
                }
                check(pow2(i), max);
                check(pow2(i), min);
            }

            // Randomized corpus, magnitude-swept so pairs span tiny -> full width
            // and densely cross the signed-fit boundary; signs independently flipped.
            let mut s: u64 = 0xC0FF_EE00_1234_5678 ^ (N as u64);
            for _ in 0..8_000 {
                let mut ab = [0u8; N];
                let mut bb = [0u8; N];
                let mut i = 0;
                while i < N {
                    let wa = next(&mut s).to_le_bytes();
                    let wb = next(&mut s).to_le_bytes();
                    let mut k = 0;
                    while k < 8 && i + k < N {
                        ab[i + k] = wa[k];
                        bb[i + k] = wb[k];
                        k += 1;
                    }
                    i += 8;
                }
                let keep_a = (next(&mut s) as usize) % (N + 1);
                let keep_b = (next(&mut s) as usize) % (N + 1);
                for k in keep_a..N {
                    ab[k] = 0;
                }
                for k in keep_b..N {
                    bb[k] = 0;
                }
                let a = I::from_le_bytes(ab);
                let b = I::from_le_bytes(bb);
                check(a, b);
                check(a.wrapping_neg(), b);
                check(a, b.wrapping_neg());
                check(a.wrapping_neg(), b.wrapping_neg());
            }
        }
    };
}

width_suite!(u32_and_u64_limb_paths_match_bnum_i256, I256, 32);
width_suite!(u32_and_u64_limb_paths_match_bnum_i512, I512, 64);
width_suite!(u32_and_u64_limb_paths_match_bnum_i1024, I1024, 128);
width_suite!(u32_and_u64_limb_paths_match_bnum_i2048, I2048, 256);
