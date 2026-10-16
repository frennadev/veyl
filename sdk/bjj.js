// Veyl Phase 3: Baby Jubjub (circomlib's twisted Edwards curve over BN254's scalar field) for sealed batch swaps.
//
//   curve      a·x² + y² = 1 + d·x²·y²,  a = 168700, d = 168696, over Fr (p = BN254 scalar field)
//   B          circomlib's Base8: a generator of the prime-order subgroup (order l, cofactor 8)
//   ElGamal    exponent ElGamal: Enc(m; r) = (r·B, m·B + r·PK). Ciphertexts add: Enc(m1) + Enc(m2) = Enc(m1 + m2).
//              Decrypting gives m·B; m is recovered by baby-step giant-step, so amounts are bounded (AMOUNT_BITS per swap,
//              MAX_PER_DIRECTION swaps per batch direction).
//   threshold  the committee's key PK = sk·B is shared t-of-n (Feldman VSS, joint / dealerless: dkg()). Member i holds
//              sk_i = F(i); a partial decryption of an aggregate ciphertext is D_i = sk_i·C1, proven with a Chaum–Pedersen
//              DLEQ proof (log_B PK_i = log_C1a D_ia = log_C1b D_ib). Any t verified partials give C2 - Σ λ_i·D_i = M·B.
//
// Must match zk/circuits/swap.circom (point formulas, encodings) and programs/veyl_entry/src/bjj.rs + sealed.rs (the
// DLEQ transcript, byte for byte). Pure BigInt; works in Node and in the browser bundle.
'use strict';
const { sha256 } = require('js-sha256');

const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n; // Fr
const l = 2736030358979909402780800718157159386076813972158567259200215660948447373041n; // subgroup order
const A = 168700n, D = 168696n;
const B = [5299619240641551281634865583518297030282874472190772894086521144482721001553n, 16950150798460657717958625567821834550301663161624707787222815936182638968203n];
const O = [0n, 1n];
/// Bounds: one sealed swap is at most 2^40 - 1 atoms; at most 64 swaps per direction per batch, so a direction's total is
/// below 2^46 and its discrete log is found by baby-step giant-step (2^23 x 2^23).
const AMOUNT_BITS = 40; const MAX_PER_DIRECTION = 64; const TOTAL_BITS = 46; const R_BITS = 250;

const md = (x, m = p) => { const r = x % m; return r < 0n ? r + m : r; };
function inv(x, m = p) { let a = md(x, m), b = m, u = 1n, v = 0n; if (a === 0n) throw new Error('no inverse of 0'); while (a !== 0n) { const q = b / a; [b, a] = [a, b - q * a]; [v, u] = [u, v - q * u]; } return md(v, m); }
function powm(b, e, m = p) { let r = 1n; b = md(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }

// ------------------------------------------------------------------------------------------------ points (affine API)
const isOnCurve = ([x, y]) => x >= 0n && x < p && y >= 0n && y < p && md(A * x * x + y * y - 1n - D * x * x % p * y % p * y) === 0n;
const eq = (P, Q) => P[0] === Q[0] && P[1] === Q[1];
const neg = ([x, y]) => [md(-x), y];
/// Complete twisted Edwards addition (BabyAdd in circomlib).
function add([x1, y1], [x2, y2]) { const t = D * x1 % p * x2 % p * y1 % p * y2 % p;
  return [md((x1 * y2 + y1 * x2) * inv(1n + t)), md((y1 * y2 - A * x1 * x2) * inv(1n - t))]; }
// extended coordinates for speed (X:Y:Z:T, x = X/Z, y = Y/Z, xy = T/Z), same complete law
const ext = ([x, y]) => [x, y, 1n, x * y % p];
function eadd([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) {
  const a = X1 * X2 % p, b = Y1 * Y2 % p, c = D * T1 % p * T2 % p, d = Z1 * Z2 % p;
  const e = md((X1 + Y1) * (X2 + Y2) - a - b), f = md(d - c), g = md(d + c), h = md(b - A * a);
  return [e * f % p, g * h % p, f * g % p, e * h % p]; }
const edbl = (P) => eadd(P, P);
function aff([X, Y, Z]) { const zi = inv(Z); return [X * zi % p, Y * zi % p]; }
/// k·P (any k >= 0; reduced mod l only for points of the subgroup when `sub` is set).
function mul(P, k, sub = true) { let e = BigInt(k); if (sub) e = md(e, l); if (e < 0n) throw new Error('negative scalar'); let R = ext(O); let Q = ext(P);
  while (e > 0n) { if (e & 1n) R = eadd(R, Q); Q = edbl(Q); e >>= 1n; } return aff(R); }
const mulB = (k) => mul(B, k);
const inSubgroup = (P) => isOnCurve(P) && eq(mul(P, l, false), O);

// ------------------------------------------------------------------------------------------------ encodings
const be32 = (x) => { const h = BigInt(x).toString(16).padStart(64, '0'); if (h.length > 64) throw new Error('too big'); return Buffer.from(h, 'hex'); };
const fromBe = (b) => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
/// A point as 64 bytes: x || y, big-endian (what the program stores and hashes).
const enc = (P) => Buffer.concat([be32(P[0]), be32(P[1])]);
const dec = (b) => { const u = Buffer.from(b); return [fromBe(u.subarray(0, 32)), fromBe(u.subarray(32, 64))]; };
function randScalar(bits = 250) { const b = new Uint8Array(32); (globalThis.crypto || require('crypto').webcrypto).getRandomValues(b); let x = fromBe(b) & ((1n << BigInt(bits)) - 1n); if (x === 0n) x = 1n; return md(x, l) || 1n; }

// ------------------------------------------------------------------------------------------------ ElGamal
/// Enc(m) under PK with randomness r (r < 2^250, as the circuit range-checks it).
function encrypt(PK, m, r = randScalar(R_BITS)) { if (BigInt(r) >= 1n << BigInt(R_BITS)) throw new Error('r too large'); return { c1: mulB(r), c2: add(mulB(m), mul(PK, r)), r: BigInt(r) }; }
const addCt = (a, b) => ({ c1: add(a.c1, b.c1), c2: add(a.c2, b.c2) });
const ZERO_CT = { c1: O, c2: O };
/// sk·C1 subtracted: M = C2 - sk·C1 (= m·B).
const decryptPoint = (ct, sk) => add(ct.c2, neg(mul(ct.c1, sk)));

// ------------------------------------------------------------------------------------------------ discrete log
/// Baby-step giant-step for m·G with 0 <= m < 2^bits (G defaults to B). Table of 2^ceil(bits/2) baby steps, cached per base.
const tables = new Map();
function bsgs(M, bits = TOTAL_BITS, G = B, onProgress = null) {
  if (eq(M, O)) return 0n;
  const half = Math.ceil(bits / 2); const n = 1 << half; const key = G[0].toString(16) + ':' + half;
  let t = tables.get(key);
  if (!t) { t = new Map(); let Q = ext(O); const Ge = ext(G);
    for (let i = 0; i < n; i++) { const a = aff(Q); t.set(a[0].toString(36) + a[1].toString(36).slice(-6), i); Q = eadd(Q, Ge); }
    tables.set(key, t); }
  const step = neg(mul(G, BigInt(n), false)); let cur = ext(M); const st = ext(step);
  for (let j = 0; j < n; j++) { const a = aff(cur); const i = t.get(a[0].toString(36) + a[1].toString(36).slice(-6));
    if (i !== undefined) { const m = BigInt(j) * BigInt(n) + BigInt(i); if (eq(mul(G, m, false), M)) return m; }
    cur = eadd(cur, st); if (onProgress && (j & 0xffff) === 0) onProgress(j / n); }
  return null;
}

/// The same over growing ranges (2^20, 2^28, 2^36, then `maxBits`): small totals are found at once, the full range
/// (2^46: a 2^23-entry table, about a minute and a gigabyte in JS) only when a batch really is that large.
function bsgsAuto(M, maxBits = TOTAL_BITS) { for (const b of [20, 28, 36, maxBits]) { if (b > maxBits) continue; const m = bsgs(M, b); if (m !== null) return m; if (b === maxBits) break; } return null; }

// ------------------------------------------------------------------------------------------------ threshold: Feldman VSS, joint DKG
/// One dealer's contribution: random polynomial f of degree t-1, commitments F_k = a_k·B, shares f(j) for j = 1..n.
function deal(t, n, secret = randScalar(250)) { const a = [md(BigInt(secret), l)]; for (let k = 1; k < t; k++) a.push(randScalar(250));
  const F = a.map((x) => mulB(x)); const shares = []; for (let j = 1; j <= n; j++) shares.push(evalPoly(a, BigInt(j)));
  return { coeffs: a, commitments: F, shares }; }
const evalPoly = (a, x) => a.reduceRight((acc, c) => md(acc * x + c, l), 0n);
/// Σ_k j^k·F_k: the public key of share j under a dealer's (or the joint) commitments.
function sharePublic(F, j) { let R = ext(O); let xk = 1n; for (const Fk of F) { R = eadd(R, ext(mul(Fk, xk))); xk = md(xk * BigInt(j), l); } return aff(R); }
/// Feldman check: share·B == Σ_k j^k·F_k.
const verifyShare = (F, j, share) => eq(mulB(share), sharePublic(F, j));
/// Combine dealers (the qualified set): joint commitments (sum per coefficient), member j's secret share = Σ_i s_ij.
function combineCommitments(list) { const t = list[0].length; const out = []; for (let k = 0; k < t; k++) { let R = O; for (const F of list) R = add(R, F[k]); out.push(R); } return out; }
/// The whole joint DKG simulated in one process (dev / tests). Real nodes run committee/dkg.js over HTTP, same maths.
function dkgLocal(t, n) { const dealers = []; for (let i = 0; i < n; i++) dealers.push(deal(t, n));
  for (const d of dealers) for (let j = 1; j <= n; j++) if (!verifyShare(d.commitments, j, d.shares[j - 1])) throw new Error('bad share');
  const F = combineCommitments(dealers.map((d) => d.commitments)); const shares = []; for (let j = 1; j <= n; j++) shares.push(dealers.reduce((s, d) => md(s + d.shares[j - 1], l), 0n));
  return { t, n, PK: F[0], commitments: F, members: shares.map((sk, i) => ({ index: i + 1, sk, PK: sharePublic(F, i + 1) })), dealerCommitments: dealers.map((d) => d.commitments) }; }
/// Lagrange coefficients at 0 for the index set S (mod l).
function lagrange(S) { return S.map((i) => { let num = 1n, den = 1n; for (const j of S) if (j !== i) { num = md(num * BigInt(j), l); den = md(den * BigInt(j - i), l); } return md(num * inv(den, l), l); }); }
/// Integer Lagrange coefficients scaled by Δ = n!: μ_i = Δ·λ_i (exact integers; small). What the program uses so it never
/// multiplies a share by a full-size scalar.
function lagrangeInt(S, n) { let delta = 1n; for (let k = 2n; k <= BigInt(n); k++) delta *= k;
  return { delta, mu: S.map((i) => { let num = 1n, den = 1n; for (const j of S) if (j !== i) { num *= BigInt(j); den *= BigInt(j - i); } const v = delta * num; if (v % den !== 0n) throw new Error('not integral'); return v / den; }) }; }

// ------------------------------------------------------------------------------------------------ Chaum–Pedersen DLEQ (two bases + B)
/// The batch's key (= batch_key in the program): a field element naming (bin pool, sequence number).
/// Transcript (= dleq_challenge in programs/veyl_entry/src/sealed.rs):
///   c  = first 16 bytes of sha256("veyl-dleq" || batchKey(32) || index(1) || PK_i || C1a || C1b || Da || Db || A || Ba || Bb), big-endian
///   z1 = first 16 bytes of sha256("veyl-dleq-z" || c(16) || 0x01), z3 = ... || 0x03
/// Checked: 8·(z1·(s·B - c·PK_i - A) + (s·C1a - c·Da - Ba) + z3·(s·C1b - c·Db - Bb)) == O
function dleqChallenge(batchKey, index, PKi, C1a, C1b, Da, Db, Ap, Ba, Bb) {
  const h = Buffer.from(sha256.arrayBuffer(Buffer.concat([Buffer.from('veyl-dleq'), be32(batchKey), Buffer.from([index]), ...[PKi, C1a, C1b, Da, Db, Ap, Ba, Bb].map(enc)])));
  const c = fromBe(h.subarray(0, 16));
  const z = (k) => fromBe(Buffer.from(sha256.arrayBuffer(Buffer.concat([Buffer.from('veyl-dleq-z'), h.subarray(0, 16), Buffer.from([k])]))).subarray(0, 16));
  return { c, z1: z(1), z3: z(3) }; }
/// A member's partial decryption of both aggregates and its proof.
function partialDecrypt({ batchKey, index, sk, PKi, C1a, C1b, k = randScalar(250) }) {
  const Da = mul(C1a, sk), Db = mul(C1b, sk); const Ap = mulB(k), Ba = mul(C1a, k), Bb = mul(C1b, k);
  const { c } = dleqChallenge(batchKey, index, PKi, C1a, C1b, Da, Db, Ap, Ba, Bb); const s = md(k + c * md(sk, l), l);
  return { index, Da, Db, A: Ap, Ba, Bb, s }; }
function verifyPartial({ batchKey, PKi, C1a, C1b, share }) { const { index, Da, Db, A: Ap, Ba, Bb, s } = share;
  if (![Da, Db, Ap, Ba, Bb].every(isOnCurve)) return false; const { c, z1, z3 } = dleqChallenge(batchKey, index, PKi, C1a, C1b, Da, Db, Ap, Ba, Bb);
  const e1 = add(add(mulB(s), neg(mul(PKi, c))), neg(Ap)); const e2 = add(add(mul(C1a, s), neg(mul(Da, c, false))), neg(Ba)); const e3 = add(add(mul(C1b, s), neg(mul(Db, c, false))), neg(Bb));
  const tot = add(add(mul(e1, z1, false), e2), mul(e3, z3, false)); return eq(mul(tot, 8n, false), O); }
/// t partial decryptions -> m·B for one direction (8x: cleared of any small-order part), then m by BSGS.
function combine(C2, shares, which, bits = TOTAL_BITS) { const S = shares.map((x) => x.index); const lam = lagrange(S);
  let R = C2; shares.forEach((x, i) => { R = add(R, neg(mul(which === 'a' ? x.Da : x.Db, lam[i], false))); }); return R; }
function decryptTotal(C2, shares, which, bits = TOTAL_BITS) { const M = combine(C2, shares, which); return bsgs(M, bits); }

module.exports = { p, l, A, D, B, O, AMOUNT_BITS, MAX_PER_DIRECTION, TOTAL_BITS, R_BITS, md, inv, powm, isOnCurve, eq, neg, add, mul, mulB, inSubgroup, ext, eadd, aff,
  be32, fromBe, enc, dec, randScalar, encrypt, addCt, ZERO_CT, decryptPoint, bsgs, bsgsAuto, deal, evalPoly, sharePublic, verifyShare, combineCommitments, dkgLocal, lagrange, lagrangeInt,
  dleqChallenge, partialDecrypt, verifyPartial, combine, decryptTotal };
