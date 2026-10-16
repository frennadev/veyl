//! Baby Jubjub on SBF: just enough arithmetic for Phase 3's sealed batches (aggregating ElGamal ciphertexts, checking the
//! committee's Chaum–Pedersen proofs and the decrypted totals). No syscalls exist for this curve, so it is plain integer
//! arithmetic; SBF has no 64x64->128 multiply, so the field uses radix 2^29 (9 limbs) where a column of products cannot
//! overflow a u64 and no carry is handled inside a multiplication (measured ~900 CU per multiply, vs ~1,500 for 32-bit
//! limbs and ~2,200 for 64-bit limbs through __multi3).
//!
//!   field      Fr (BN254's scalar field) in Montgomery form, R = 2^261, values kept lazily below 16p (see bjj_mul.rs)
//!   curve      circomlib's  a·x² + y² = 1 + d·x²·y² (a = 168700, d = 168696), used internally in its a = -1 model
//!              x' = s·x (s² = -a), where the extended-coordinate formulas apply (add 8M with a cached operand, double 4M+4S);
//!              points enter and leave as circomlib affine (x, y), 64 bytes big-endian (= sdk/bjj.js enc/dec)
//!   scalars    256-bit little-endian words; MSMs use signed 4-bit digits (tables of 1..8 multiples)
#![allow(clippy::needless_range_loop)]
use crate::bjj_consts::*;
pub use crate::bjj_mul::{mul, sqr};

pub type Fe = [u64; 9];
const MASK: u64 = (1 << 29) - 1;
pub const ZERO: Fe = [0; 9];

#[inline(always)]
fn norm(mut r: [u64; 9]) -> Fe { let mut c = 0u64; for i in 0..9 { let x = r[i].wrapping_add(c); r[i] = x & MASK; c = x >> 29; } r }
/// a + b (values add; keep the sum below 16p).
#[inline(never)]
pub fn add(a: &Fe, b: &Fe) -> Fe { let mut r = [0u64; 9]; for i in 0..9 { r[i] = a[i].wrapping_add(b[i]); } norm(r) }
/// a - b + 4p (b must be below 4p): never negative, at most a + 4p.
#[inline(never)]
pub fn sub(a: &Fe, b: &Fe) -> Fe {
    let mut r = [0u64; 9]; let mut c: i64 = 0;
    for i in 0..9 { let x = a[i] as i64 + P4[i] as i64 - b[i] as i64 + c; r[i] = (x as u64) & MASK; c = x >> 29; }
    r
}
fn geq(a: &Fe, b: &Fe) -> bool { for i in (0..9).rev() { if a[i] != b[i] { return a[i] > b[i]; } } true }
fn sub_plain(a: &Fe, b: &Fe) -> Fe { let mut r = [0u64; 9]; let mut c: i64 = 0; for i in 0..9 { let x = a[i] as i64 - b[i] as i64 + c; r[i] = (x as u64) & MASK; c = x >> 29; } r }
/// The representative in [0, p) of a value below 16p.
pub fn canon(a: &Fe) -> Fe {
    let mut x = *a;
    for k in [8u64, 4, 2, 1] { let kp = norm({ let mut t = [0u64; 9]; for i in 0..9 { t[i] = P[i] * k; } t }); if geq(&x, &kp) { x = sub_plain(&x, &kp); } }
    x
}
pub fn is_zero(a: &Fe) -> bool { canon(a) == ZERO }
pub fn fe_eq(a: &Fe, b: &Fe) -> bool { canon(a) == canon(b) }
/// Montgomery form of a 32-byte big-endian value (None unless it is below p).
pub fn from_be(b: &[u8; 32]) -> Option<Fe> {
    let mut w = [0u64; 4]; for i in 0..4 { w[i] = u64::from_be_bytes(b[24 - 8 * i..32 - 8 * i].try_into().unwrap()); }
    let mut x = [0u64; 9]; for i in 0..9 { let bit = 29 * i; let (q, r) = (bit / 64, bit % 64); let mut v = w[q] >> r; if r > 35 && q + 1 < 4 { v |= w[q + 1] << (64 - r); } x[i] = v & MASK; }
    if geq(&x, &P) { return None; }
    Some(mul(&x, &R2))
}
/// 32-byte big-endian canonical value of a Montgomery-form element.
pub fn to_be(a: &Fe) -> [u8; 32] {
    let mut one = [0u64; 9]; one[0] = 1; let x = canon(&mul(a, &one));
    let mut w = [0u64; 4]; for i in 0..9 { let bit = 29 * i; let (q, r) = (bit / 64, bit % 64); w[q] |= x[i] << r; if r > 35 && q + 1 < 4 { w[q + 1] |= x[i] >> (64 - r); } }
    let mut out = [0u8; 32]; for i in 0..4 { out[24 - 8 * i..32 - 8 * i].copy_from_slice(&w[i].to_be_bytes()); } out
}
/// a^(p-2) = 1/a (a != 0). 4-bit fixed window.
pub fn inv(a: &Fe) -> Fe {
    let mut tab = [ONE; 16]; tab[1] = *a; for i in 2..16 { tab[i] = mul(&tab[i - 1], a); }
    let mut r = ONE; let mut first = true;
    for wi in (0..4).rev() { for nib in (0..16).rev() {
        let d = ((PM2[wi] >> (4 * nib)) & 15) as usize;
        if !first { r = sqr(&r); r = sqr(&r); r = sqr(&r); r = sqr(&r); }
        if d != 0 { r = if first { tab[d] } else { mul(&r, &tab[d]) }; first = false; }
    } }
    r
}

// ------------------------------------------------------------------------------------------------ points (a = -1 model)
#[derive(Clone, Copy)]
pub struct Ext { pub x: Fe, pub y: Fe, pub z: Fe, pub t: Fe }
/// A point ready to be added: (Y - X, Y + X, 2d'·T, 2·Z).
#[derive(Clone, Copy)]
pub struct Cached { pub ymx: Fe, pub ypx: Fe, pub t2d: Fe, pub z2: Fe }
pub const IDENTITY: Ext = Ext { x: ZERO, y: ONE, z: ONE, t: ZERO };

/// add-2008-hwcd-3 (a = -1) with a cached operand: 8M.
#[inline(never)]
pub fn add_cached(p: &Ext, q: &Cached) -> Ext {
    let a = mul(&sub(&p.y, &p.x), &q.ymx); let b = mul(&add(&p.y, &p.x), &q.ypx);
    let c = mul(&p.t, &q.t2d); let d = mul(&p.z, &q.z2);
    let e = sub(&b, &a); let f = sub(&d, &c); let g = add(&d, &c); let h = add(&b, &a);
    Ext { x: mul(&e, &f), y: mul(&g, &h), t: mul(&e, &h), z: mul(&f, &g) }
}
/// dbl-2008-hwcd (a = -1), with F and H negated (the result is the same point scaled by -1): 4M + 4S.
#[inline(never)]
pub fn dbl(p: &Ext) -> Ext {
    let a = sqr(&p.x); let b = sqr(&p.y); let zz = sqr(&p.z); let c = add(&zz, &zz);
    let h = add(&a, &b); let e = sub(&sqr(&add(&p.x, &p.y)), &h); let g = sub(&b, &a); let f = sub(&add(&c, &a), &b);
    Ext { x: mul(&e, &f), y: mul(&g, &h), t: mul(&e, &h), z: mul(&f, &g) }
}
pub fn to_cached(p: &Ext) -> Cached { Cached { ymx: sub(&p.y, &p.x), ypx: add(&p.y, &p.x), t2d: mul(&p.t, &D2), z2: add(&p.z, &p.z) } }
pub fn neg_cached(q: &Cached) -> Cached { Cached { ymx: q.ypx, ypx: q.ymx, t2d: sub(&ZERO, &q.t2d), z2: q.z2 } }
pub fn neg(p: &Ext) -> Ext { Ext { x: sub(&ZERO, &p.x), y: p.y, z: p.z, t: sub(&ZERO, &p.t) } }
pub fn add_ext(p: &Ext, q: &Ext) -> Ext { add_cached(p, &to_cached(q)) }
pub fn is_identity(p: &Ext) -> bool { is_zero(&p.x) && fe_eq(&p.y, &p.z) }
pub fn pt_eq(p: &Ext, q: &Ext) -> bool { fe_eq(&mul(&p.x, &q.z), &mul(&q.x, &p.z)) && fe_eq(&mul(&p.y, &q.z), &mul(&q.y, &p.z)) }

/// circomlib affine (x, y), 64 bytes big-endian -> internal point. None unless both coordinates are below p and the point
/// is on the curve (it may still have a small-order component: every check that matters multiplies by the cofactor 8).
pub fn decode(b: &[u8; 64]) -> Option<Ext> {
    let x = from_be(b[..32].try_into().unwrap())?; let y = from_be(b[32..].try_into().unwrap())?;
    let (xx, yy) = (sqr(&x), sqr(&y));
    let lhs = add(&mul(&CA, &xx), &yy); let rhs = add(&ONE, &mul(&CD, &mul(&xx, &yy)));
    if !fe_eq(&lhs, &rhs) { return None; }
    let xs = mul(&x, &S); Some(Ext { x: xs, y, z: ONE, t: mul(&xs, &y) })
}
/// A point the caller knows is valid (e.g. checked by a proof): no on-curve check.
pub fn decode_trusted(b: &[u8; 64]) -> Option<Ext> {
    let x = from_be(b[..32].try_into().unwrap())?; let y = from_be(b[32..].try_into().unwrap())?;
    let xs = mul(&x, &S); Some(Ext { x: xs, y, z: ONE, t: mul(&xs, &y) })
}
/// Internal point -> circomlib affine bytes (one inversion).
pub fn encode(p: &Ext) -> [u8; 64] { let zi = inv(&p.z); encode_with_inv(p, &zi) }
pub fn encode_with_inv(p: &Ext, zi: &Fe) -> [u8; 64] {
    let x = mul(&mul(&p.x, zi), &S_INV); let y = mul(&p.y, zi);
    let mut o = [0u8; 64]; o[..32].copy_from_slice(&to_be(&x)); o[32..].copy_from_slice(&to_be(&y)); o
}
/// Several points to affine with one inversion (Montgomery's trick).
pub fn encode_many(ps: &[Ext]) -> Vec<[u8; 64]> {
    let n = ps.len(); let mut acc = Vec::with_capacity(n); let mut run = ONE;
    for p in ps { acc.push(run); run = mul(&run, &p.z); }
    let mut inv_run = inv(&run); let mut out = vec![[0u8; 64]; n];
    for i in (0..n).rev() { let zi = mul(&inv_run, &acc[i]); out[i] = encode_with_inv(&ps[i], &zi); inv_run = mul(&inv_run, &ps[i].z); }
    out
}
/// Fixed base: the table row k (B8 · 16^k · j, j = 1..8).
pub fn btab(k: usize, j: usize) -> Cached { let e = &BTAB[k][j - 1]; let f = |v: &[u32; 9]| { let mut r = [0u64; 9]; for i in 0..9 { r[i] = v[i] as u64; } r }; Cached { ymx: f(&e[0]), ypx: f(&e[1]), t2d: f(&e[2]), z2: f(&e[3]) } }
/// m·B8 for m < 2^62 (comb over the 16 table rows: no doublings).
pub fn mul_base_small(m: u64) -> Ext {
    let d = recode(&[m, 0, 0, 0]); let mut acc = IDENTITY;
    for k in 0..16 { let v = d[k]; if v != 0 { let c = btab(k, v.unsigned_abs() as usize); acc = add_cached(&acc, &if v < 0 { neg_cached(&c) } else { c }); } }
    acc
}
/// k·P for a small integer (|k| < 2^32), plain double-and-add (shares' Lagrange weights, the cofactor).
pub fn mul_small(p: &Ext, k: i64) -> Ext {
    let neg_k = k < 0; let mut e = k.unsigned_abs(); let c = to_cached(p); let mut acc = IDENTITY; let mut q_started = false;
    let mut bits = 0; while (e >> bits) > 0 { bits += 1; }
    for i in (0..bits).rev() { if q_started { acc = dbl(&acc); } if (e >> i) & 1 == 1 { acc = add_cached(&acc, &c); q_started = true; } }
    e = 0; let _ = e;
    if neg_k { neg(&acc) } else { acc }
}
pub fn times8(p: &Ext) -> Ext { dbl(&dbl(&dbl(p))) }

// ------------------------------------------------------------------------------------------------ scalars
/// Signed 4-bit digits of a 256-bit scalar (little-endian words), 65 of them: d in [-8, 8), Σ d_i·16^i = k.
pub fn recode(k: &[u64; 4]) -> [i8; 65] {
    let mut d = [0i8; 65]; let mut carry = 0u64;
    for i in 0..64 { let w = ((k[i / 16] >> (4 * (i % 16))) & 15) + carry; if w >= 8 { d[i] = (w as i64 - 16) as i8; carry = 1; } else { d[i] = w as i8; carry = 0; } }
    d[64] = carry as i8; d
}
