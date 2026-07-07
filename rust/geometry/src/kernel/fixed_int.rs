// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `FixedInt<K>` — a register-resident fixed-width signed integer that is a
//! drop-in replacement for the `bnum::types::I256/I512/I1024/I2048` aliases
//! used by the exact-predicate tier in [`super::fixed`].
//!
//! WHY: the predicate cascade spends its hot path in `checked_mul` /
//! `checked_add` / `checked_sub` on 256..2048-bit integers. bnum's generic
//! byte-oriented arithmetic leaves 3.9-4.4x multiply speedup on the table
//! versus a plain `[u64; K]` two's-complement schoolbook multiply with an
//! nbits no-overflow fast path (benchmarked on the LPI/TPI operand
//! distributions; value-verified against bnum on every sample).
//!
//! RISK CONTAINMENT — the design splits the trait surface in two:
//!
//! * NATIVE (hot, pure two's-complement, cheap to prove): `CheckedMul`
//!   (nbits fast path + full-widening fallback), `CheckedAdd`, `CheckedSub`,
//!   `Neg`, `Signed` (is_negative/signum/abs), `Zero`/`is_zero`,
//!   `One`/`is_one`, `FromPrimitive`, `ToPrimitive::{to_i64,to_u64,to_i128,
//!   to_u128}`, `Ord`.
//! * DELEGATED to bnum via an exact limb<->byte round-trip (bit-identity is
//!   DELICATE and the ops are NOT hot — per-output-vertex / on-grid
//!   reduction only): `ToPrimitive::{to_f64,to_f32}` (rounding), `Div`,
//!   `Rem`, `CheckedDiv`, `CheckedRem` (signed truncating division), and
//!   `Num::from_str_radix`. These are byte-identical to bnum BY CONSTRUCTION,
//!   including bnum's divide-by-zero panic behaviour that
//!   `fixed::cached_lambda` documents and guards.
//!
//! The differential-fuzz test at the bottom is the byte-identity proof: for
//! each width K in {4, 8, 16, 32} it checks >100k sample pairs (random +
//! boundary) Option-for-Option against the corresponding bnum type.
//!
//! Wired into `fixed.rs` (the alias swap at fixed.rs:252-271, 314), gated by
//! the pinned mesh-determinism / boolean-manifest suites and the
//! differential-fuzz proof in this module's tests.

use core::cmp::Ordering;
use core::ops::{Add, Div, Mul, Neg, Rem, Sub};
use num_traits::{
    CheckedAdd, CheckedDiv, CheckedMul, CheckedNeg, CheckedRem, CheckedSub, FromPrimitive, Num,
    One, Signed, ToPrimitive, Zero,
};

/// Fixed-width signed integer: `K` little-endian `u64` limbs, two's
/// complement. `K` must be >= 1 (instantiated at 4 / 8 / 16 / 32 = the
/// I256 / I512 / I1024 / I2048 widths).
#[derive(Clone, Copy, Debug)]
pub struct FixedInt<const K: usize> {
    limbs: [u64; K],
}

/// True iff every limb of `slice` equals `ext`, computed as an XOR/OR reduction
/// to a single scalar `== 0`. NOT `slice.iter().all(|&l| l == ext)`: under
/// wasm32 `+simd128` that per-element compare auto-vectorizes to a `v16i8 setcc`
/// which LLVM's wasm backend cannot select (build error). XOR/OR keeps every
/// vector op on i64 lanes (selectable) and leaves exactly one scalar compare.
#[inline(always)]
fn all_limbs_eq(slice: &[u64], ext: u64) -> bool {
    slice.iter().fold(0u64, |acc, &l| acc | (l ^ ext)) == 0
}

impl<const K: usize> PartialEq for FixedInt<K> {
    #[inline(always)]
    fn eq(&self, other: &Self) -> bool {
        // Same reason as `all_limbs_eq`: a derived `[u64; K]` equality lowers to
        // `v16i8 setcc` on wasm32 `+simd128`, which cannot be selected.
        self.limbs
            .iter()
            .zip(other.limbs.iter())
            .fold(0u64, |acc, (&a, &b)| acc | (a ^ b))
            == 0
    }
}

impl<const K: usize> Eq for FixedInt<K> {}

impl<const K: usize> core::hash::Hash for FixedInt<K> {
    // Manual (paired with the manual PartialEq): equal values have equal limbs,
    // so hashing the limbs is consistent with `eq`.
    #[inline]
    fn hash<H: core::hash::Hasher>(&self, state: &mut H) {
        self.limbs.hash(state);
    }
}

impl<const K: usize> FixedInt<K> {
    pub const ZERO: Self = Self { limbs: [0; K] };
    pub const MIN: Self = {
        let mut l = [0u64; K];
        l[K - 1] = 1u64 << 63;
        Self { limbs: l }
    };
    pub const MAX: Self = {
        let mut l = [u64::MAX; K];
        l[K - 1] = u64::MAX >> 1;
        Self { limbs: l }
    };

    #[inline(always)]
    const fn is_neg(&self) -> bool {
        (self.limbs[K - 1] >> 63) != 0
    }

    // Inherent mirrors of the num_traits methods, so callers (e.g. fixed.rs's
    // `fixed_impl!` bodies) resolve `.is_zero()` / `.is_one()` / `.is_negative()`
    // without importing the traits — matching bnum's inherent-method surface.
    #[inline(always)]
    pub fn is_zero(&self) -> bool {
        all_limbs_eq(&self.limbs, 0)
    }

    #[inline(always)]
    pub fn is_one(&self) -> bool {
        self.limbs[0] == 1 && all_limbs_eq(&self.limbs[1..], 0)
    }

    #[inline(always)]
    pub fn is_negative(&self) -> bool {
        self.is_neg()
    }

    /// The limb every position above the value's top bit holds (0 or MAX).
    #[inline(always)]
    const fn ext_limb(&self) -> u64 {
        if self.is_neg() {
            u64::MAX
        } else {
            0
        }
    }

    // ── native add / sub / neg ────────────────────────────────────────────

    #[inline]
    fn overflowing_add(&self, rhs: &Self) -> (Self, bool) {
        let mut out = [0u64; K];
        let mut carry = false;
        for i in 0..K {
            let (t, c1) = self.limbs[i].overflowing_add(rhs.limbs[i]);
            let (t, c2) = t.overflowing_add(carry as u64);
            out[i] = t;
            carry = c1 | c2;
        }
        // Signed overflow iff both operands share a sign and the result does not.
        let so = (out[K - 1] >> 63) != 0;
        let overflow = self.is_neg() == rhs.is_neg() && so != self.is_neg();
        (Self { limbs: out }, overflow)
    }

    #[inline]
    fn overflowing_sub(&self, rhs: &Self) -> (Self, bool) {
        let mut out = [0u64; K];
        let mut borrow = false;
        for i in 0..K {
            let (t, b1) = self.limbs[i].overflowing_sub(rhs.limbs[i]);
            let (t, b2) = t.overflowing_sub(borrow as u64);
            out[i] = t;
            borrow = b1 | b2;
        }
        // Signed overflow iff operand signs differ and the result's sign
        // differs from the minuend's.
        let so = (out[K - 1] >> 63) != 0;
        let overflow = self.is_neg() != rhs.is_neg() && so != self.is_neg();
        (Self { limbs: out }, overflow)
    }

    #[inline]
    pub fn checked_add(&self, rhs: &Self) -> Option<Self> {
        let (v, o) = self.overflowing_add(rhs);
        (!o).then_some(v)
    }

    #[inline]
    pub fn checked_sub(&self, rhs: &Self) -> Option<Self> {
        let (v, o) = self.overflowing_sub(rhs);
        (!o).then_some(v)
    }

    #[inline]
    fn wrapping_add(&self, rhs: &Self) -> Self {
        self.overflowing_add(rhs).0
    }

    #[inline]
    fn wrapping_sub(&self, rhs: &Self) -> Self {
        self.overflowing_sub(rhs).0
    }

    #[inline]
    pub fn wrapping_neg(&self) -> Self {
        // !x + 1
        let mut out = [0u64; K];
        let mut carry = true;
        for i in 0..K {
            let (t, c) = (!self.limbs[i]).overflowing_add(carry as u64);
            out[i] = t;
            carry = c;
        }
        Self { limbs: out }
    }

    #[inline]
    pub fn checked_neg(&self) -> Option<Self> {
        if *self == Self::MIN {
            None
        } else {
            Some(self.wrapping_neg())
        }
    }

    // ── native multiply ───────────────────────────────────────────────────

    /// Magnitude bit-length upper bound INCLUDING the sign bit: for any x,
    /// `|x| <= 2^(nbits(x) - 1)` (0 and -1 return 1). Counts limbs down from
    /// the top past redundant sign-extension limbs.
    #[inline(always)]
    fn nbits(&self) -> u32 {
        let ext = self.ext_limb();
        let mut i = K;
        while i > 0 && self.limbs[i - 1] == ext {
            i -= 1;
        }
        if i == 0 {
            return 1; // 0 or -1
        }
        let top = if ext == 0 {
            self.limbs[i - 1]
        } else {
            !self.limbs[i - 1]
        };
        (i as u32 - 1) * 64 + (64 - top.leading_zeros()) + 1
    }

    /// Low K limbs of the product. Mod 2^(64K) the two's-complement product
    /// equals the unsigned product of the bit patterns, so when overflow is
    /// excluded (see `checked_mul`) this IS the exact signed product.
    #[inline]
    fn mul_low(&self, rhs: &Self) -> Self {
        let a = &self.limbs;
        let b = &rhs.limbs;
        let mut lo = [0u64; K];
        for i in 0..K {
            let ai = a[i] as u128;
            if ai == 0 {
                continue;
            }
            let mut carry: u128 = 0;
            for j in 0..K - i {
                let t = ai * (b[j] as u128) + (lo[i + j] as u128) + carry;
                lo[i + j] = t as u64;
                carry = t >> 64;
            }
        }
        Self { limbs: lo }
    }

    /// Full-widening checked multiply: unsigned 2K-limb schoolbook product,
    /// signed correction of the high half, then overflow check (the product
    /// fits K limbs iff the high K limbs are the sign-extension of the low
    /// half). Exact for ALL inputs; used when the nbits fast path can't
    /// prove the product fits.
    pub fn checked_mul_full(&self, rhs: &Self) -> Option<Self> {
        let a = &self.limbs;
        let b = &rhs.limbs;
        // Unsigned schoolbook into split lo/hi halves (a stable-Rust stand-in
        // for the unexpressible `[u64; 2 * K]`).
        let mut lo = [0u64; K];
        let mut hi = [0u64; K];
        for i in 0..K {
            let ai = a[i] as u128;
            if ai == 0 {
                continue;
            }
            let split = K - i; // j < split writes lo[i+j]; j >= split writes hi[i+j-K]
            let mut carry: u128 = 0;
            for j in 0..split {
                let t = ai * (b[j] as u128) + (lo[i + j] as u128) + carry;
                lo[i + j] = t as u64;
                carry = t >> 64;
            }
            for j in split..K {
                let t = ai * (b[j] as u128) + (hi[i + j - K] as u128) + carry;
                hi[i + j - K] = t as u64;
                carry = t >> 64;
            }
            hi[i] = carry as u64; // fresh: rows < i wrote at most hi[i-1]
        }
        // Signed correction: wide -= (a_neg ? b : 0) << 64K; wide -= (b_neg ? a : 0) << 64K.
        if self.is_neg() {
            let mut borrow = 0u64;
            for j in 0..K {
                let (t, b1) = hi[j].overflowing_sub(b[j]);
                let (t, b2) = t.overflowing_sub(borrow);
                hi[j] = t;
                borrow = (b1 | b2) as u64;
            }
        }
        if rhs.is_neg() {
            let mut borrow = 0u64;
            for j in 0..K {
                let (t, b1) = hi[j].overflowing_sub(a[j]);
                let (t, b2) = t.overflowing_sub(borrow);
                hi[j] = t;
                borrow = (b1 | b2) as u64;
            }
        }
        // Fits iff the high half is the sign-extension of the low half.
        let sign_ext = if (lo[K - 1] >> 63) != 0 { u64::MAX } else { 0 };
        if hi.iter().any(|&h| h != sign_ext) {
            return None;
        }
        Some(Self { limbs: lo })
    }

    /// Checked multiply with the no-overflow fast path: when
    /// `nbits(a) + nbits(b) <= 64K - 1` then `|a*b| <= 2^(64K - 3) <
    /// 2^(64K-1)`, the product provably fits and only the LOW K limbs are
    /// computed. Otherwise fall to the full-widening exact check.
    #[inline]
    pub fn checked_mul(&self, rhs: &Self) -> Option<Self> {
        if self.nbits() + rhs.nbits() <= (K as u32) * 64 - 1 {
            return Some(self.mul_low(rhs));
        }
        self.checked_mul_full(rhs)
    }

    // ── native primitive conversions ──────────────────────────────────────

    #[inline]
    fn from_i64_impl(x: i64) -> Self {
        let mut limbs = [if x < 0 { u64::MAX } else { 0 }; K];
        limbs[0] = x as u64;
        Self { limbs }
    }

    #[inline]
    fn from_u64_impl(x: u64) -> Option<Self> {
        let mut limbs = [0u64; K];
        limbs[0] = x;
        let v = Self { limbs };
        // Only representable when the top bit doesn't read as a sign (K == 1 edge).
        (!v.is_neg()).then_some(v)
    }

    #[inline]
    fn from_i128_impl(x: i128) -> Option<Self> {
        if K == 1 {
            return i64::try_from(x).ok().map(Self::from_i64_impl);
        }
        let mut limbs = [if x < 0 { u64::MAX } else { 0 }; K];
        limbs[0] = x as u64;
        limbs[1] = (x >> 64) as u64;
        Some(Self { limbs })
    }

    #[inline]
    fn from_u128_impl(x: u128) -> Option<Self> {
        if K <= 2 {
            return i128::try_from(x).ok().and_then(Self::from_i128_impl);
        }
        let mut limbs = [0u64; K];
        limbs[0] = x as u64;
        limbs[1] = (x >> 64) as u64;
        Some(Self { limbs })
    }

    #[inline]
    fn to_i64_impl(self) -> Option<i64> {
        let ext = if (self.limbs[0] >> 63) != 0 {
            u64::MAX
        } else {
            0
        };
        all_limbs_eq(&self.limbs[1..], ext).then_some(self.limbs[0] as i64)
    }

    #[inline]
    fn to_u64_impl(self) -> Option<u64> {
        (!self.is_neg() && all_limbs_eq(&self.limbs[1..], 0)).then_some(self.limbs[0])
    }

    #[inline]
    fn to_i128_impl(self) -> Option<i128> {
        if K == 1 {
            return self.to_i64_impl().map(i128::from);
        }
        let raw = ((self.limbs[1] as u128) << 64) | (self.limbs[0] as u128);
        let ext = if (self.limbs[1] >> 63) != 0 {
            u64::MAX
        } else {
            0
        };
        all_limbs_eq(&self.limbs[2..], ext).then_some(raw as i128)
    }

    #[inline]
    fn to_u128_impl(self) -> Option<u128> {
        if self.is_neg() {
            return None;
        }
        if K == 1 {
            return Some(self.limbs[0] as u128);
        }
        let raw = ((self.limbs[1] as u128) << 64) | (self.limbs[0] as u128);
        all_limbs_eq(&self.limbs[2..], 0).then_some(raw)
    }

    /// Signed two's-complement compare: sign bits first, then limbs high to
    /// low as unsigned (same-sign values order like their bit patterns).
    #[inline]
    fn cmp_signed(&self, other: &Self) -> Ordering {
        let (sa, sb) = (self.is_neg(), other.is_neg());
        if sa != sb {
            return if sa {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        for i in (0..K).rev() {
            match self.limbs[i].cmp(&other.limbs[i]) {
                Ordering::Equal => {}
                o => return o,
            }
        }
        Ordering::Equal
    }
}

// ── bnum delegation (per width) ────────────────────────────────────────────
//
// The bit-identity-DELICATE, non-hot ops (float rounding, signed division,
// radix parsing) round-trip through the same-width bnum type. bnum stores
// `[u8; N]` little-endian with public `to_le_bytes`/`from_le_bytes`, so the
// conversion is an exact, endian-safe byte copy — the delegated results are
// byte-identical to bnum by construction.

/// Maps a `FixedInt<K>` to its same-width bnum type (K=4 -> I256, 8 -> I512,
/// 16 -> I1024, 32 -> I2048) with exact value-preserving conversions.
pub trait BnumDelegate: Sized + Copy {
    type Bn: Signed
        + ToPrimitive
        + FromPrimitive
        + CheckedAdd
        + CheckedSub
        + CheckedMul
        + CheckedDiv
        + CheckedRem
        + CheckedNeg
        + Ord
        + Copy;
    fn to_bnum(self) -> Self::Bn;
    fn from_bnum(x: Self::Bn) -> Self;
}

macro_rules! bnum_delegate {
    ($K:literal, $BYTES:literal, $T:ty) => {
        impl BnumDelegate for FixedInt<$K> {
            type Bn = $T;

            #[inline]
            fn to_bnum(self) -> $T {
                let mut bytes = [0u8; $BYTES];
                for (i, limb) in self.limbs.iter().enumerate() {
                    bytes[i * 8..i * 8 + 8].copy_from_slice(&limb.to_le_bytes());
                }
                <$T>::from_le_bytes(bytes)
            }

            #[inline]
            fn from_bnum(x: $T) -> Self {
                let bytes = x.to_le_bytes();
                let mut limbs = [0u64; $K];
                for (i, limb) in limbs.iter_mut().enumerate() {
                    *limb = u64::from_le_bytes(bytes[i * 8..i * 8 + 8].try_into().unwrap());
                }
                Self { limbs }
            }
        }
    };
}

bnum_delegate!(4, 32, bnum::types::I256);
bnum_delegate!(8, 64, bnum::types::I512);
bnum_delegate!(16, 128, bnum::types::I1024);
bnum_delegate!(32, 256, bnum::types::I2048);

// ── std ops ────────────────────────────────────────────────────────────────
//
// Add/Sub/Mul/Neg exist only as num_traits supertrait obligations (fixed.rs
// calls the CHECKED forms and unary Neg); they mirror the primitive-integer
// contract bnum follows — panic on overflow in debug, wrap in release.

impl<const K: usize> Add for FixedInt<K> {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self {
        if cfg!(debug_assertions) {
            self.checked_add(&rhs)
                .expect("attempt to add with overflow")
        } else {
            self.wrapping_add(&rhs)
        }
    }
}

impl<const K: usize> Sub for FixedInt<K> {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self {
        if cfg!(debug_assertions) {
            self.checked_sub(&rhs)
                .expect("attempt to subtract with overflow")
        } else {
            self.wrapping_sub(&rhs)
        }
    }
}

impl<const K: usize> Mul for FixedInt<K> {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: Self) -> Self {
        if cfg!(debug_assertions) {
            self.checked_mul(&rhs)
                .expect("attempt to multiply with overflow")
        } else {
            self.mul_low(&rhs)
        }
    }
}

impl<const K: usize> Neg for FixedInt<K> {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self {
        if cfg!(debug_assertions) {
            self.checked_neg().expect("attempt to negate with overflow")
        } else {
            self.wrapping_neg()
        }
    }
}

/// DELEGATED: signed truncating division, byte-identical to bnum (including
/// bnum's divide-by-zero / MIN÷-1 panic behaviour, which `fixed.rs` guards).
impl<const K: usize> Div for FixedInt<K>
where
    Self: BnumDelegate,
{
    type Output = Self;
    #[inline]
    fn div(self, rhs: Self) -> Self {
        Self::from_bnum(self.to_bnum() / rhs.to_bnum())
    }
}

/// DELEGATED: signed remainder, byte-identical to bnum (see `Div`).
impl<const K: usize> Rem for FixedInt<K>
where
    Self: BnumDelegate,
{
    type Output = Self;
    #[inline]
    fn rem(self, rhs: Self) -> Self {
        Self::from_bnum(self.to_bnum() % rhs.to_bnum())
    }
}

impl<const K: usize> PartialOrd for FixedInt<K> {
    #[inline]
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl<const K: usize> Ord for FixedInt<K> {
    #[inline]
    fn cmp(&self, other: &Self) -> Ordering {
        self.cmp_signed(other)
    }
}

// ── num_traits surface (the exact set fixed.rs consumes) ──────────────────

impl<const K: usize> Zero for FixedInt<K> {
    #[inline]
    fn zero() -> Self {
        Self::ZERO
    }
    #[inline]
    fn is_zero(&self) -> bool {
        all_limbs_eq(&self.limbs, 0)
    }
}

impl<const K: usize> One for FixedInt<K> {
    #[inline]
    fn one() -> Self {
        let mut limbs = [0u64; K];
        limbs[0] = 1;
        Self { limbs }
    }
    #[inline]
    fn is_one(&self) -> bool {
        self.limbs[0] == 1 && all_limbs_eq(&self.limbs[1..], 0)
    }
}

impl<const K: usize> Num for FixedInt<K>
where
    Self: BnumDelegate,
{
    type FromStrRadixErr = <<Self as BnumDelegate>::Bn as Num>::FromStrRadixErr;
    /// DELEGATED to bnum (never on a hot path).
    fn from_str_radix(s: &str, radix: u32) -> Result<Self, Self::FromStrRadixErr> {
        <Self as BnumDelegate>::Bn::from_str_radix(s, radix).map(Self::from_bnum)
    }
}

impl<const K: usize> Signed for FixedInt<K>
where
    Self: BnumDelegate,
{
    #[inline]
    fn abs(&self) -> Self {
        if self.is_neg() {
            -*self
        } else {
            *self
        }
    }
    #[inline]
    fn abs_sub(&self, other: &Self) -> Self {
        if self.cmp_signed(other) == Ordering::Greater {
            *self - *other
        } else {
            Self::ZERO
        }
    }
    #[inline]
    fn signum(&self) -> Self {
        if self.is_neg() {
            Self::one().wrapping_neg()
        } else if Zero::is_zero(self) {
            Self::ZERO
        } else {
            Self::one()
        }
    }
    #[inline]
    fn is_positive(&self) -> bool {
        !self.is_neg() && !Zero::is_zero(self)
    }
    #[inline]
    fn is_negative(&self) -> bool {
        self.is_neg()
    }
}

impl<const K: usize> CheckedAdd for FixedInt<K> {
    #[inline]
    fn checked_add(&self, v: &Self) -> Option<Self> {
        FixedInt::checked_add(self, v)
    }
}

impl<const K: usize> CheckedSub for FixedInt<K> {
    #[inline]
    fn checked_sub(&self, v: &Self) -> Option<Self> {
        FixedInt::checked_sub(self, v)
    }
}

impl<const K: usize> CheckedMul for FixedInt<K> {
    #[inline]
    fn checked_mul(&self, v: &Self) -> Option<Self> {
        FixedInt::checked_mul(self, v)
    }
}

impl<const K: usize> CheckedNeg for FixedInt<K> {
    #[inline]
    fn checked_neg(&self) -> Option<Self> {
        FixedInt::checked_neg(self)
    }
}

/// DELEGATED to bnum (division semantics).
impl<const K: usize> CheckedDiv for FixedInt<K>
where
    Self: BnumDelegate,
{
    #[inline]
    fn checked_div(&self, v: &Self) -> Option<Self> {
        CheckedDiv::checked_div(&self.to_bnum(), &v.to_bnum()).map(Self::from_bnum)
    }
}

/// DELEGATED to bnum (division semantics).
impl<const K: usize> CheckedRem for FixedInt<K>
where
    Self: BnumDelegate,
{
    #[inline]
    fn checked_rem(&self, v: &Self) -> Option<Self> {
        CheckedRem::checked_rem(&self.to_bnum(), &v.to_bnum()).map(Self::from_bnum)
    }
}

impl<const K: usize> FromPrimitive for FixedInt<K> {
    #[inline]
    fn from_i64(n: i64) -> Option<Self> {
        Some(Self::from_i64_impl(n))
    }
    #[inline]
    fn from_u64(n: u64) -> Option<Self> {
        Self::from_u64_impl(n)
    }
    #[inline]
    fn from_i128(n: i128) -> Option<Self> {
        Self::from_i128_impl(n)
    }
    #[inline]
    fn from_u128(n: u128) -> Option<Self> {
        Self::from_u128_impl(n)
    }
}

impl<const K: usize> ToPrimitive for FixedInt<K>
where
    Self: BnumDelegate,
{
    #[inline]
    fn to_i64(&self) -> Option<i64> {
        self.to_i64_impl()
    }
    #[inline]
    fn to_u64(&self) -> Option<u64> {
        self.to_u64_impl()
    }
    #[inline]
    fn to_i128(&self) -> Option<i128> {
        self.to_i128_impl()
    }
    #[inline]
    fn to_u128(&self) -> Option<u128> {
        self.to_u128_impl()
    }
    /// DELEGATED to bnum: round-to-nearest f64 conversion must stay
    /// byte-identical (it feeds `fixed::point_to_f64`, the output verts).
    #[inline]
    fn to_f64(&self) -> Option<f64> {
        self.to_bnum().to_f64()
    }
    /// DELEGATED to bnum (rounding).
    #[inline]
    fn to_f32(&self) -> Option<f32> {
        self.to_bnum().to_f32()
    }
}

// ── differential fuzz: the byte-identity proof against bnum ───────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// splitmix64 — deterministic, seedable.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
    }

    /// 2^bit as a FixedInt (bit < 64K).
    fn pow2<const K: usize>(bit: u32) -> FixedInt<K> {
        let mut limbs = [0u64; K];
        limbs[(bit / 64) as usize] = 1u64 << (bit % 64);
        FixedInt { limbs }
    }

    /// Boundary values: 0, ±1, MIN, MAX, MIN+1, MAX-1, and ±2^b, ±(2^b ± 1)
    /// at the sign bit, the half width (mul-overflow edge), the i64 edge, and
    /// near the top of the width.
    fn boundary_vals<const K: usize>() -> Vec<FixedInt<K>> {
        let one = FixedInt::<K>::one();
        let mut v = vec![
            FixedInt::<K>::ZERO,
            one,
            one.wrapping_neg(),
            FixedInt::<K>::MIN,
            FixedInt::<K>::MAX,
            FixedInt::<K>::MIN.wrapping_add(&one),
            FixedInt::<K>::MAX.wrapping_sub(&one),
        ];
        let w = 64 * K as u32;
        for bit in [62, 63, 64, w / 2 - 1, w / 2, w - 2] {
            let p = pow2::<K>(bit);
            for x in [p, p.wrapping_sub(&one), p.wrapping_add(&one)] {
                v.push(x);
                v.push(x.wrapping_neg());
            }
        }
        v
    }

    /// Random value: uniform bit-length in 1..=64K (so products straddle the
    /// overflow boundary about half the time), three fill patterns (random
    /// bits / single bit / all-ones), random sign via wrapping negate.
    fn rand_val<const K: usize>(rng: &mut Rng) -> FixedInt<K> {
        let w = 64 * K as u32;
        let nbits = 1 + (rng.next() % w as u64) as u32;
        let v = match rng.next() % 4 {
            0 => pow2::<K>(nbits - 1),
            1 => pow2::<K>(nbits - 1).wrapping_sub(&FixedInt::one()), // 2^b - 1: all ones
            _ => {
                let mut limbs = [0u64; K];
                let nlimbs = nbits.div_ceil(64) as usize;
                for l in limbs.iter_mut().take(nlimbs) {
                    *l = rng.next();
                }
                let top_bits = nbits - (nlimbs as u32 - 1) * 64;
                if top_bits < 64 {
                    limbs[nlimbs - 1] &= (1u64 << top_bits) - 1;
                }
                FixedInt { limbs }
            }
        };
        if rng.next() & 1 == 0 {
            v.wrapping_neg()
        } else {
            v
        }
    }

    /// One differential sample: every native op Option-for-Option against
    /// bnum, plus the delegated ops (locks the limb<->byte conversion).
    fn check_pair<const K: usize>(a: FixedInt<K>, b: FixedInt<K>)
    where
        FixedInt<K>: BnumDelegate,
    {
        let ba = a.to_bnum();
        let bb = b.to_bnum();
        let f = FixedInt::<K>::from_bnum;

        // Conversion round-trip.
        assert_eq!(f(ba), a, "to_bnum/from_bnum round-trip");

        // checked_mul: BOTH the nbits fast-path entry and the full-widening path.
        let bn_mul = CheckedMul::checked_mul(&ba, &bb).map(f);
        assert_eq!(
            CheckedMul::checked_mul(&a, &b),
            bn_mul,
            "checked_mul {a:?} {b:?}"
        );
        assert_eq!(
            a.checked_mul_full(&b),
            bn_mul,
            "checked_mul_full {a:?} {b:?}"
        );

        // checked_add / checked_sub.
        assert_eq!(
            CheckedAdd::checked_add(&a, &b),
            CheckedAdd::checked_add(&ba, &bb).map(f),
            "checked_add {a:?} {b:?}"
        );
        assert_eq!(
            CheckedSub::checked_sub(&a, &b),
            CheckedSub::checked_sub(&ba, &bb).map(f),
            "checked_sub {a:?} {b:?}"
        );

        // Negation / sign ops.
        assert_eq!(
            a.checked_neg(),
            CheckedNeg::checked_neg(&ba).map(f),
            "checked_neg {a:?}"
        );
        assert_eq!(Signed::signum(&a), f(Signed::signum(&ba)), "signum {a:?}");
        assert_eq!(
            Signed::is_negative(&a),
            Signed::is_negative(&ba),
            "is_negative {a:?}"
        );
        assert_eq!(
            Signed::is_positive(&a),
            Signed::is_positive(&ba),
            "is_positive {a:?}"
        );
        assert_eq!(Zero::is_zero(&a), Zero::is_zero(&ba), "is_zero {a:?}");
        assert_eq!(One::is_one(&a), One::is_one(&ba), "is_one {a:?}");
        assert_eq!(a.cmp(&b), ba.cmp(&bb), "cmp {a:?} {b:?}");

        // Primitive conversions.
        assert_eq!(ToPrimitive::to_i64(&a), ba.to_i64(), "to_i64 {a:?}");
        assert_eq!(ToPrimitive::to_u64(&a), ba.to_u64(), "to_u64 {a:?}");
        assert_eq!(ToPrimitive::to_i128(&a), ba.to_i128(), "to_i128 {a:?}");
        assert_eq!(ToPrimitive::to_u128(&a), ba.to_u128(), "to_u128 {a:?}");

        // Delegated: to_f64 bit-identical (trivially — it IS bnum — but locks
        // the conversion in front of it).
        assert_eq!(
            ToPrimitive::to_f64(&a).map(f64::to_bits),
            ba.to_f64().map(f64::to_bits),
            "to_f64 {a:?}"
        );

        // Delegated division. The panicking operators are guarded exactly
        // like fixed.rs guards them (nonzero divisor; MIN/-1 overflow); the
        // checked forms cover the guarded-out cases Option-for-Option.
        let minus_one = FixedInt::<K>::one().wrapping_neg();
        if !Zero::is_zero(&b) && (a != FixedInt::<K>::MIN || b != minus_one) {
            assert_eq!(a / b, f(ba / bb), "div {a:?} {b:?}");
            assert_eq!(a % b, f(ba % bb), "rem {a:?} {b:?}");
        } else {
            assert_eq!(
                CheckedDiv::checked_div(&a, &b),
                CheckedDiv::checked_div(&ba, &bb).map(f),
                "checked_div {a:?} {b:?}"
            );
            assert_eq!(
                CheckedRem::checked_rem(&a, &b),
                CheckedRem::checked_rem(&ba, &bb).map(f),
                "checked_rem {a:?} {b:?}"
            );
        }
    }

    fn fuzz_width<const K: usize>(seed: u64, n_random: usize)
    where
        FixedInt<K>: BnumDelegate,
    {
        let mut rng = Rng(seed);
        let bounds = boundary_vals::<K>();
        let mut samples = 0usize;

        // Boundary × boundary cross product.
        for &a in &bounds {
            for &b in &bounds {
                check_pair(a, b);
                samples += 1;
            }
        }
        // Boundary × random (hits MIN/MAX against arbitrary operands).
        for &a in &bounds {
            for _ in 0..64 {
                check_pair(a, rand_val::<K>(&mut rng));
                check_pair(rand_val::<K>(&mut rng), a);
                samples += 2;
            }
        }
        // Random × random.
        while samples < n_random {
            check_pair(rand_val::<K>(&mut rng), rand_val::<K>(&mut rng));
            samples += 1;
        }

        // from_i64 round-trip + cross-path anchor (native from_i64 vs bnum's —
        // two independent constructions of the same value).
        for _ in 0..10_000 {
            let x = rng.next() as i64;
            let v = <FixedInt<K> as FromPrimitive>::from_i64(x).unwrap();
            assert_eq!(
                ToPrimitive::to_i64(&v),
                Some(x),
                "from_i64/to_i64 round-trip"
            );
            let bn = <<FixedInt<K> as BnumDelegate>::Bn as FromPrimitive>::from_i64(x).unwrap();
            assert_eq!(v, FixedInt::<K>::from_bnum(bn), "from_i64 vs bnum from_i64");
        }
        for x in [0i64, 1, -1, i64::MIN, i64::MAX, i64::MIN + 1, i64::MAX - 1] {
            let v = <FixedInt<K> as FromPrimitive>::from_i64(x).unwrap();
            assert_eq!(ToPrimitive::to_i64(&v), Some(x));
        }

        assert!(samples >= n_random, "fuzz ran {samples} samples");
    }

    /// Independent reconstruction lock on the limb<->bnum conversion: rebuild
    /// each value in bnum via SHIFT/ADD arithmetic (never touching the byte
    /// codec) and require it to equal `to_bnum`. Per-width because it needs
    /// bnum's concrete `Shl`.
    macro_rules! conversion_lock {
        ($name:ident, $K:literal, $T:ty) => {
            #[test]
            fn $name() {
                let mut rng = Rng(0xC0FF_EE00 + $K);
                let mut vals = boundary_vals::<$K>();
                for _ in 0..1000 {
                    vals.push(rand_val::<$K>(&mut rng));
                }
                for v in vals {
                    // Two's-complement reconstruction, top limb (signed) first.
                    let mut acc = <$T as FromPrimitive>::from_i64(v.limbs[$K - 1] as i64).unwrap();
                    for &limb in v.limbs[..$K - 1].iter().rev() {
                        acc = (acc << 64u32) + <$T as FromPrimitive>::from_u64(limb).unwrap();
                    }
                    assert_eq!(v.to_bnum(), acc, "to_bnum vs shift/add reconstruction");
                    assert_eq!(FixedInt::<$K>::from_bnum(acc), v);
                }
            }
        };
    }
    conversion_lock!(conversion_lock_k4, 4, bnum::types::I256);
    conversion_lock!(conversion_lock_k8, 8, bnum::types::I512);
    conversion_lock!(conversion_lock_k16, 16, bnum::types::I1024);
    conversion_lock!(conversion_lock_k32, 32, bnum::types::I2048);

    #[test]
    fn differential_fuzz_k4_i256() {
        fuzz_width::<4>(0x1234_5678_9ABC_DEF0, 100_000);
    }
    #[test]
    fn differential_fuzz_k8_i512() {
        fuzz_width::<8>(0x0FED_CBA9_8765_4321, 100_000);
    }
    #[test]
    fn differential_fuzz_k16_i1024() {
        fuzz_width::<16>(0xDEAD_BEEF_CAFE_F00D, 100_000);
    }
    #[test]
    fn differential_fuzz_k32_i2048() {
        fuzz_width::<32>(0xFACE_FEED_0BAD_F00D, 100_000);
    }

    /// Targeted edges the fuzz also covers, kept explicit for triage value.
    #[test]
    fn targeted_edges() {
        type F4 = FixedInt<4>;
        let one = F4::one();
        let minus_one = one.wrapping_neg();
        // MIN * -1 overflows (2^255 unrepresentable).
        assert_eq!(CheckedMul::checked_mul(&F4::MIN, &minus_one), None);
        // -1 * -1 = 1 (all-MAX bit patterns through the fast path).
        assert_eq!(CheckedMul::checked_mul(&minus_one, &minus_one), Some(one));
        // MIN negate overflows; MIN+1 negates to MAX.
        assert_eq!(F4::MIN.checked_neg(), None);
        assert_eq!(F4::MIN.wrapping_add(&one).checked_neg(), Some(F4::MAX));
        // MAX + 1 / MIN - 1 overflow.
        assert_eq!(CheckedAdd::checked_add(&F4::MAX, &one), None);
        assert_eq!(CheckedSub::checked_sub(&F4::MIN, &one), None);
        // Signs.
        assert!(Signed::is_negative(&F4::MIN));
        assert!(!Signed::is_negative(&F4::ZERO));
        assert_eq!(Signed::signum(&minus_one), minus_one);
        assert_eq!(Signed::signum(&F4::ZERO), F4::ZERO);
        // Delegated division truncates toward zero like bnum.
        let seven = <F4 as FromPrimitive>::from_i64(7).unwrap();
        let minus_two = <F4 as FromPrimitive>::from_i64(-2).unwrap();
        assert_eq!(
            seven / minus_two,
            <F4 as FromPrimitive>::from_i64(-3).unwrap()
        );
        assert_eq!(seven % minus_two, one);
    }
}
