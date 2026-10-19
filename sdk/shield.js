// Veyl Phase 2: the shielded pool's client side. Notes with hidden amounts (2-in / 2-out transact proofs), shielded
// liquidity positions (position proofs), keys and addresses, encrypted note payloads, and the exact byte formats the
// programs hash. Works in Node and (bundled) in the browser. Must match zk/circuits/{transact,position}.circom and
// programs/veyl_pool + programs/veyl_entry byte for byte.
//
//   note        = Poseidon(asset, amount, ownerPubkey, blinding)            ownerPubkey = Poseidon(spendingKey)
//   nullifier   = Poseidon(commitment, index, Poseidon(spendingKey, commitment, index))
//   position    = Poseidon(posAsset, Poseidon(Poseidon16(shares), debtX, debtY), ownerPubkey, blinding)
//   address     = "veyl:" + base58(ownerPubkey (32 bytes, big-endian) || X25519 viewing public key (32 bytes))
//   payload     = ephemeral X25519 public key (32) || NaCl box (XSalsa20-Poly1305, zero nonce: the key is used once)
'use strict';
const { Buffer } = require('buffer');
const { PublicKey } = require('@solana/web3.js');
const { sha256 } = require('js-sha256');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const PL = require('poseidon-lite');
const { be32, fromBe32, u8, u32, i32, u64, i64, u128, pk, vec, F, Reader, zeros: zerosOf, hashToField, rand: randField, strings, packProofN, W, R, SYS, encRoute } = require('./veyl.js');

const DEPTH = 32; const K = 16; const SHARE_BITS = 112n; const Q64 = 1n << 64n; const U64MAX = Q64 - 1n;
const NOTE = { TOKEN: 1, POSITION: 2, ORDER: 3, SWAP: 4 };
const P = (...xs) => { const a = xs.map(BigInt); const f = PL['poseidon' + a.length]; if (!f) throw new Error('poseidon arity ' + a.length); return f(a); };
const mod = (x) => ((BigInt(x) % F) + F) % F;
/// sha256 of the parts (hashToField, from sdk/veyl.js, is this with the top three bits cleared: = hash_to_field in the programs).
const sha = (...parts) => Buffer.from(sha256.arrayBuffer(Buffer.concat(parts.map((p) => Buffer.from(p)))));

// ------------------------------------------------------------------------------------------------ assets
/// A token's asset id inside the shielded pool.
const assetOf = (mint) => hashToField(Buffer.from('veyl-asset'), pk(mint));
/// Limit-order shares of (bin pool, bin, side): a virtual asset the entry program mints and burns.
const orderAssetOf = (binPool, id, isAsk) => hashToField(Buffer.from('veyl-order'), pk(binPool), i32(id), u8(isAsk ? 1 : 0));
/// A position window: (bin pool, lowest bin) of K = 16 bins.
const posAssetOf = (binPool, lo) => hashToField(Buffer.from('veyl-pos'), pk(binPool), i32(lo));

// ------------------------------------------------------------------------------------------------ keys and addresses
/// Every key of a Veyl account from one 32-byte seed (random, or derived from a wallet signature so it can be recovered).
function keysFromSeed(seed) {
  const s = Buffer.from(seed); if (s.length !== 32) throw new Error('seed must be 32 bytes');
  const sk = hashToField(Buffer.from('veyl-spend'), s); const pub = P(sk);
  const viewSecret = sha(Buffer.from('veyl-view'), s); const view = nacl.box.keyPair.fromSecretKey(Uint8Array.from(viewSecret));
  return { seed: s, sk, pk: pub, viewSecret: Buffer.from(view.secretKey), viewPublic: Buffer.from(view.publicKey), address: encodeAddress(pub, view.publicKey) };
}
/// One-time keys for notes the chain creates in the clear (swap outputs, removal proceeds, order receipts): their owner
/// key and blinding are public, so each uses a fresh key derived from the seed; only the seed's holder can spend it.
function oneTime(seed, i) { const s = Buffer.from(seed); const sk = hashToField(Buffer.from('veyl-ot'), s, u32(i)); return { i, sk, pk: P(sk), blinding: hashToField(Buffer.from('veyl-otb'), s, u32(i)) }; }
function encodeAddress(pub, viewPublic) { return 'veyl:' + bs58.encode(Buffer.concat([be32(pub), Buffer.from(viewPublic)])); }
function decodeAddress(a) { const s = String(a).trim(); if (!s.startsWith('veyl:')) throw new Error('A Veyl address starts with veyl:'); let b; try { b = Buffer.from(bs58.decode(s.slice(5))); } catch { throw new Error('That is not a Veyl address.'); }
  if (b.length !== 64) throw new Error('That is not a Veyl address.'); const pub = fromBe32(b.subarray(0, 32)); if (pub >= F) throw new Error('That is not a Veyl address.'); return { pk: pub, viewPublic: b.subarray(32) }; }

// ------------------------------------------------------------------------------------------------ notes
const commitmentOf = (asset, amount, ownerPk, blinding) => P(asset, amount, ownerPk, blinding);
const nullifierOf = (commitment, index, sk) => P(commitment, index, P(sk, commitment, index));

// ------------------------------------------------------------------------------------------------ encrypted payloads
const ZERO_NONCE = new Uint8Array(24);
function seal(viewPublic, plain) { const e = nacl.box.keyPair(); const box = nacl.box(Uint8Array.from(plain), ZERO_NONCE, Uint8Array.from(viewPublic), e.secretKey); return Buffer.concat([Buffer.from(e.publicKey), Buffer.from(box)]); }
function open(viewSecret, ct) { const b = Buffer.from(ct); if (b.length < 48) return null; const m = nacl.box.open(Uint8Array.from(b.subarray(32)), ZERO_NONCE, Uint8Array.from(b.subarray(0, 32)), Uint8Array.from(viewSecret)); return m ? Buffer.from(m) : null; }
/// Plaintext of a token / order note: kind, what the asset is (mint, or bin pool + bin + side), amount, blinding.
function encodeNote(n) {
  // Phase 3: the opening of a sealed swap's commitment (its batch, direction, amount, blinding), for recovery
  if (n.kind === NOTE.SWAP) return Buffer.concat([u8(NOTE.SWAP), pk(n.binPool), u64(n.seq), u8(n.direction), u64(n.amount), be32(n.blinding)]);
  if (n.kind === NOTE.ORDER) return Buffer.concat([u8(NOTE.ORDER), pk(n.binPool), i32(n.id), u8(n.isAsk ? 1 : 0), u64(n.amount), be32(n.blinding)]);
  return Buffer.concat([u8(NOTE.TOKEN), pk(n.mint), u64(n.amount), be32(n.blinding)]);
}
/// Plaintext of a position note: window, shares, debts, blinding, and the two fee notes this action created (amount + blinding).
function encodePosition(n) { return Buffer.concat([u8(NOTE.POSITION), pk(n.binPool), i32(n.lo), ...n.shares.map((s) => u128(s)), be32(mod(n.debt[0])), be32(mod(n.debt[1])), be32(n.blinding), u64(n.claims[0]), u64(n.claims[1]), be32(n.claimBlinding[0]), be32(n.claimBlinding[1])]); }
function decodePlain(b) { const r = new Reader(b); const kind = r.u8();
  if (kind === NOTE.TOKEN) return { kind, mint: r.pk().toBase58(), amount: r.u64(), blinding: r.be32() };
  if (kind === NOTE.ORDER) return { kind, binPool: r.pk().toBase58(), id: r.i32(), isAsk: r.bool(), amount: r.u64(), blinding: r.be32() };
  if (kind === NOTE.SWAP) return { kind, binPool: r.pk().toBase58(), seq: r.u64(), direction: r.u8(), amount: r.u64(), blinding: r.be32() };
  if (kind === NOTE.POSITION) { const o = { kind, binPool: r.pk().toBase58(), lo: r.i32(), shares: [] }; for (let i = 0; i < K; i++) o.shares.push(r.u128());
    o.debt = [r.be32(), r.be32()]; o.blinding = r.be32(); o.claims = [r.u64(), r.u64()]; o.claimBlinding = [r.be32(), r.be32()]; return o; }
  return null; }
const assetOfNote = (n) => (n.kind === NOTE.ORDER ? orderAssetOf(n.binPool, n.id, n.isAsk) : n.kind === NOTE.POSITION ? posAssetOf(n.binPool, n.lo) : assetOf(n.mint));

// ------------------------------------------------------------------------------------------------ external data (borsh, = the Rust structs)
const ZERO32 = Buffer.alloc(32); const DEFAULT_KEY = new PublicKey(ZERO32);
/// Bytes from a Buffer / Uint8Array, a JSON'd Buffer ({ type: 'Buffer', data }), or a hex / base64 string (what travels to the relayer).
const bytes = (x) => { if (x === undefined || x === null) return Buffer.alloc(0); if (Buffer.isBuffer(x) || x instanceof Uint8Array) return Buffer.from(x); if (Array.isArray(x)) return Buffer.from(x);
  if (typeof x === 'object' && Array.isArray(x.data)) return Buffer.from(x.data); const s = String(x); return /^[0-9a-f]*$/i.test(s) && s.length % 2 === 0 ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64'); };
/// TransactExt { recipient, ext_amount, relayer, fee, processor, action, mint, enc_out: Vec<Vec<u8>> }
function encodeExt(e) { const act = e.action ? bytes(e.action) : ZERO32; if (act.length !== 32) throw new Error('action must be 32 bytes');
  return Buffer.concat([pk(e.recipient || DEFAULT_KEY), i64(e.extAmount || 0n), pk(e.relayer || DEFAULT_KEY), u64(e.fee || 0n), pk(e.processor || DEFAULT_KEY), act, pk(e.mint || DEFAULT_KEY), vec(e.encOut || [Buffer.alloc(0), Buffer.alloc(0)], (c) => { const b = bytes(c); return Buffer.concat([u32(b.length), b]); })]); }
/// The inverse of encodeExt, from a Reader (instruction data: shield_transact, transact_cpi).
const decodeExt = (r) => ({ recipient: r.pk(), extAmount: r.i64(), relayer: r.pk(), fee: r.u64(), processor: r.pk(), action: r.bytes(32), mint: r.pk(), encOut: r.vec(() => r.bytes(r.u32())) });
const extHash = (e) => hashToField(Buffer.from('veyl-transact'), encodeExt(e));
const publicAmountOf = (e) => mod(BigInt(e.extAmount || 0n) - BigInt(e.fee || 0n));

// ------------------------------------------------------------------------------------------------ the tree
/// The shielded tree, fully in memory (levels cached): root, and the sibling path of any leaf. Same construction as the
/// programs and the circuits (depth 32, empty leaves 0, node = Poseidon(left, right)).
class Tree {
  constructor(leaves = [], depth = DEPTH) { this.depth = depth; this.z = zerosOf(depth); this.levels = [leaves.map(BigInt)]; this._build(); }
  _build() { for (let d = 0; d < this.depth; d++) { const cur = this.levels[d]; const next = []; for (let i = 0; i < cur.length; i += 2) next.push(P(cur[i], i + 1 < cur.length ? cur[i + 1] : this.z[d])); this.levels[d + 1] = next; } }
  get leaves() { return this.levels[0]; }
  root() { const top = this.levels[this.depth]; return top.length ? top[0] : this.z[this.depth]; }
  insert(leaf) { let idx = this.levels[0].length; this.levels[0].push(BigInt(leaf)); let node = BigInt(leaf);
    for (let d = 0; d < this.depth; d++) { const left = idx % 2 === 0; const sib = left ? this.z[d] : this.levels[d][idx - 1]; node = left ? P(node, sib) : P(sib, node); idx >>= 1; this.levels[d + 1][idx] = node; } return this.levels[0].length - 1; }
  path(index) { const sib = []; let idx = Number(index); for (let d = 0; d < this.depth; d++) { const s = idx ^ 1; sib.push(s < this.levels[d].length ? this.levels[d][s] : this.z[d]); idx >>= 1; } return sib; }
  indexOf(c) { const s = String(c); return this.levels[0].findIndex((x) => String(x) === s); }
  /// The tree of `leaves`: `old` extended in place when its leaves are a prefix of them (an incremental sync hashes only
  /// the new leaves), a new tree otherwise.
  static grow(old, leaves) { const n = old ? old.levels[0].length : -1; if (n < 0 || n > leaves.length) return new Tree(leaves.map(BigInt));
    for (let i = 0; i < n; i++) if (old.levels[0][i] !== BigInt(leaves[i])) return new Tree(leaves.map(BigInt));
    for (let i = n; i < leaves.length; i++) old.insert(leaves[i]); return old; }
}

// ------------------------------------------------------------------------------------------------ transact witness
/// Input for transact.circom. ins: up to 2 notes { amount, sk, blinding, index } (missing ones become dummies with a
/// random blinding), outs: exactly 2 { amount, pk, blinding }. Checks conservation before proving.
function transactInput({ tree, asset, ins = [], outs, ext, sk }) {
  if (outs.length !== 2) throw new Error('two outputs');
  const inn = [...ins]; while (inn.length < 2) inn.push({ amount: 0n, sk: sk || randField(), blinding: randField(), index: 0, dummy: true });
  const root = tree.root(); const publicAmount = publicAmountOf(ext); const extDataHash = extHash(ext);
  const sumIn = inn.reduce((s, n) => s + BigInt(n.amount), 0n), sumOut = outs.reduce((s, n) => s + BigInt(n.amount), 0n);
  if (mod(sumIn + publicAmount) !== mod(sumOut)) throw new Error('amounts do not balance');
  const nulls = inn.map((n) => { const c = commitmentOf(asset, n.amount, P(n.sk), n.blinding); if (!n.dummy && tree.leaves[Number(n.index)] !== c) throw new Error('input note is not at its index'); return nullifierOf(c, n.index, n.sk); });
  const commits = outs.map((o) => commitmentOf(asset, o.amount, o.pk, o.blinding));
  const publicAsset = publicAmount === 0n ? 0n : BigInt(asset);
  const input = { root, publicAmount, extDataHash, publicAsset, inputNullifier: nulls, outputCommitment: commits, asset: BigInt(asset),
    inAmount: inn.map((n) => BigInt(n.amount)), inKey: inn.map((n) => BigInt(n.sk)), inBlinding: inn.map((n) => BigInt(n.blinding)), inPathIndex: inn.map((n) => BigInt(n.index)),
    inPathElements: inn.map((n) => (n.dummy ? Array(DEPTH).fill(0n) : tree.path(n.index))), outAmount: outs.map((o) => BigInt(o.amount)), outPubkey: outs.map((o) => BigInt(o.pk)), outBlinding: outs.map((o) => BigInt(o.blinding)) };
  return { input: strings(input), pubs: [root, publicAmount, extDataHash, publicAsset, ...nulls, ...commits], nullifiers: nulls, commitments: commits };
}

// ------------------------------------------------------------------------------------------------ positions
const hash16 = (v) => { if (v.length !== 16) throw new Error('16 values'); return P(P(...v.slice(0, 8).map(mod)), P(...v.slice(8).map(mod))); };
const positionDigest = (shares, debt) => P(P(...shares.map(BigInt)), mod(debt[0]), mod(debt[1]));
const positionCommitment = (posAsset, shares, debt, ownerPk, blinding) => P(posAsset, positionDigest(shares, debt), ownerPk, blinding);
/// What the program hashes for a position action: growth per bin per token, the signed deltas, the two assets, the fees.
const bundleOf = ({ growth, delta, assets, fee }) => P(hash16(growth[0]), hash16(growth[1]), hash16(delta), assets[0], assets[1], fee[0], fee[1]);
/// LpRequest (borsh): what a shielded liquidity action does (bin pool, window, signed share deltas, hints for empty bins,
/// an optional zap swap, fees, where leftovers go, the dilution cap, deadline, the encrypted payload).
function encodeLpCore(r) { return Buffer.concat([pk(r.binPool), i32(r.lo), vec(r.deltas, (d) => i128(d)), vec(r.hintX || Array(K).fill(0n), u64), vec(r.hintY || Array(K).fill(0n), u64),
  r.zap ? Buffer.concat([u8(1), u8(r.zap.xIn ? 1 : 0), u64(r.zap.amount), u64(r.zap.minOut)]) : u8(0),
  u64(r.claimFee[0]), u64(r.claimFee[1]), u64(r.leftoverFee[0]), u64(r.leftoverFee[1]), be32(r.receiptOwner[0]), be32(r.receiptOwner[1]), be32(r.receiptBlinding[0]), be32(r.receiptBlinding[1]),
  u64(r.maxCharge[0]), u64(r.maxCharge[1]), pk(r.relayer), i64(r.deadline), (() => { const b = bytes(r.ciphertext); return Buffer.concat([u32(b.length), b]); })()]); }
const i128 = (n) => { let v = BigInt(n); if (v < 0n) v += 1n << 128n; return u128(v); };
/// The inverse of encodeLpCore, from a Reader (a shield_lp request buffer, rebuilt from its write_buffer instructions).
function decodeLpCore(r) { const c = { binPool: r.pk(), lo: r.i32(), deltas: r.vec(() => { const v = r.u128(); return v >= 1n << 127n ? v - (1n << 128n) : v; }), hintX: r.vec(() => r.u64()), hintY: r.vec(() => r.u64()) };
  c.zap = r.u8() === 1 ? { xIn: r.bool(), amount: r.u64(), minOut: r.u64() } : null; c.claimFee = [r.u64(), r.u64()]; c.leftoverFee = [r.u64(), r.u64()];
  c.receiptOwner = [r.be32(), r.be32()]; c.receiptBlinding = [r.be32(), r.be32()]; c.maxCharge = [r.u64(), r.u64()]; c.relayer = r.pk(); c.deadline = r.i64(); c.ciphertext = r.bytes(r.u32()); return c; }
const lpExtHash = (r) => hashToField(Buffer.from('veyl-lp'), encodeLpCore(r));
const lpAction = (r) => sha(Buffer.from('veyl-lp-action'), encodeLpCore(r));
/// Fees a position can claim from growth H: per token { P, q, r } with P = sum(shares * H) - debt (must be in [0, 2^128)).
function claimable(shares, debt, growth) { return [0, 1].map((a) => { let s = 0n; for (let b = 0; b < K; b++) s += BigInt(shares[b]) * BigInt(growth[a][b]); const Pv = mod(s - mod(debt[a]));
  if (Pv >= 1n << 128n) throw new Error('position accounting out of range'); return { P: Pv, q: Pv >> 64n, r: Pv & U64MAX }; }); }
/// The position note an action leads to (pure: the same arguments give the same note). `note` = the current position
/// (null for a new one), `delta` = signed share change per bin, `growth` = [hx[16], hy[16]] now, `fee` = relayer fee taken
/// from the claim per token.
function nextPosition({ sk, binPool, lo, note, delta, growth, assets, fee = [0n, 0n], outBlinding = randField() }) {
  const owner = P(sk); const posAsset = posAssetOf(binPool, lo);
  const inShares = note ? note.shares.map(BigInt) : Array(K).fill(0n); const inDebt = note ? note.debt.map((d) => mod(d)) : [0n, 0n];
  const outShares = inShares.map((s, b) => s + BigInt(delta[b])); if (outShares.some((s) => s < 0n || s >= 1n << SHARE_BITS)) throw new Error('shares out of range');
  const cl = claimable(inShares, inDebt, growth); const claims = cl.map((c, a) => { const v = c.q - BigInt(fee[a]); if (v < 0n) throw new Error('fee above the claimable amount'); return v; });
  const outDebt = [0, 1].map((a) => { let s = 0n; for (let b = 0; b < K; b++) s += outShares[b] * BigInt(growth[a][b]); return mod(s - cl[a].r); });
  const claimBlinding = [P(outBlinding, 1n), P(outBlinding, 2n)];
  const commitment = P(posAsset, positionDigest(outShares, outDebt), owner, outBlinding);
  const claimCommitment = claims.map((c, a) => (c === 0n ? 0n : commitmentOf(assets[a], c, owner, claimBlinding[a])));
  return { kind: NOTE.POSITION, binPool: new PublicKey(binPool).toBase58(), lo: Number(lo), shares: outShares, debt: outDebt, blinding: outBlinding, commitment, claims, claimBlinding, claimCommitment, posAsset };
}
/// Input for position.circom (and the new note): `ext` = the LpCore the proof commits to; `outBlinding` must be the one the
/// note in the core's ciphertext was made with (nextPosition).
function positionInput({ tree, sk, binPool, lo, note, delta, growth, assets, fee = [0n, 0n], ext, outBlinding }) {
  const owner = P(sk); const posAsset = posAssetOf(binPool, lo); const exists = !!note;
  const inShares = exists ? note.shares.map(BigInt) : Array(K).fill(0n); const inDebt = exists ? note.debt.map((d) => mod(d)) : [0n, 0n];
  const inBlinding = exists ? BigInt(note.blinding) : randField(); const inIndex = exists ? Number(note.index) : 0;
  const inCommit = P(posAsset, positionDigest(inShares, inDebt), owner, inBlinding);
  if (exists && tree.leaves[inIndex] !== inCommit) throw new Error('position note is not at its index');
  const nullifier = nullifierOf(inCommit, inIndex, sk);
  const out = nextPosition({ sk, binPool, lo, note, delta, growth, assets, fee, outBlinding: outBlinding === undefined ? randField() : BigInt(outBlinding) });
  const bundle = bundleOf({ growth, delta, assets, fee }); const extDataHash = lpExtHash(ext);
  const root = tree.root();
  const input = { root, nullifier, outCommitment: out.commitment, posAsset, bundle, claimCommitment: out.claimCommitment, extDataHash, key: BigInt(sk), inExists: exists ? 1n : 0n, inShares, inDebt, inBlinding, inPathIndex: BigInt(inIndex),
    inPathElements: exists ? tree.path(inIndex) : Array(DEPTH).fill(0n), growth: growth.map((g) => g.map(BigInt)), delta: delta.map(mod), assets: assets.map(BigInt), fee: fee.map(BigInt), outBlinding: out.blinding, claimBlinding: out.claimBlinding };
  return { input: strings(input), pubs: [root, nullifier, out.commitment, posAsset, bundle, ...out.claimCommitment, extDataHash], note: out, nullifier, claimCommitment: out.claimCommitment };
}

/// Groth16 proof -> the 256 bytes the programs take, and the public signals (any count).

module.exports = { bytes, DEPTH, K, SHARE_BITS, NOTE, P, mod, hashToField, assetOf, orderAssetOf, posAssetOf, keysFromSeed, oneTime, encodeAddress, decodeAddress, commitmentOf, nullifierOf, randField,
  seal, open, encodeNote, encodePosition, decodePlain, assetOfNote, encodeExt, decodeExt, extHash, publicAmountOf, Tree, transactInput, hash16, positionDigest, positionCommitment, bundleOf, encodeLpCore, decodeLpCore, lpExtHash, lpAction,
  claimable, nextPosition, positionInput, packProofN, i128, DEFAULT_KEY };

// ================================================================================================ instruction builders
// Added to the Veyl client (sdk/veyl.js) by install(): the Phase 2 instructions of veyl_pool and veyl_entry, account order
// exactly as in the Rust structs. Optional accounts (Anchor `Option<...>`) that are absent are passed as the program id.
const { TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } = require('@solana/web3.js');
const V_ = require('./veyl.js');
const KIND = { TRANSACT: 1, POSITION: 2 };
const encodeLpRequest = (req) => Buffer.concat([encodeLpCore(req.core), vec(req.legs || [], encodeExt)]);
const encodeSwapCore = (c) => Buffer.concat([pk(c.tokenOut), vec(c.routes, encRoute), u64(c.minOut), be32(c.receiptOwner), be32(c.receiptBlinding), i64(c.deadline)]);
const encodeOrderCore = (c) => Buffer.concat([pk(c.binPool), i32(c.id), u8(c.isAsk ? 1 : 0), be32(c.receiptOwner), be32(c.receiptBlinding), i64(c.deadline)]);
const encodeOrderWithdrawCore = (c) => Buffer.concat([pk(c.binPool), i32(c.id), u8(c.isAsk ? 1 : 0), u64(c.leftoverFee[0]), u64(c.leftoverFee[1]), be32(c.receiptOwner[0]), be32(c.receiptOwner[1]), be32(c.receiptBlinding[0]), be32(c.receiptBlinding[1]), pk(c.relayer), i64(c.deadline)]);
const encodeMigrate = (d) => Buffer.concat([be32(d.owner), be32(d.blinding), pk(d.feeRecipient), V_.u16(d.feeBps), i64(d.deadline)]);
const swapAction = (c) => sha(Buffer.from('veyl-swap-action'), encodeSwapCore(c));
const orderAction = (c) => sha(Buffer.from('veyl-order-action'), encodeOrderCore(c));
const orderWithdrawAction = (c) => sha(Buffer.from('veyl-order-withdraw-action'), encodeOrderWithdrawCore(c));
const proofId = (kind, pubs) => sha(Buffer.from([kind]), ...pubs.map((p) => be32(p)));
const MIGRATE = 6;
/// The events readers rebuild the shielded tree and its notes from (veyl_pool's event CPI carries all of them).
const TREE = new Set(['NoteInserted', 'NoteCiphertext', 'PositionCiphertext', 'ReceiptNote', 'Nullified', 'DepositPending', 'DepositApproved', 'DepositCancelled']);

function install(Veyl) {
  const P_ = Veyl.prototype;
  // ---- addresses
  P_.shieldPda = function () { return this.pda([Buffer.from('shield')], this.programs.pool); };
  P_.shieldVault = function (mint, tp = V_.TOKEN_PROGRAM) { return this.ata(mint, this.shieldPda(), tp); };
  P_.proofPda = function (kind, pubs) { return this.pda([Buffer.from('proof'), proofId(kind, pubs)], this.programs.pool); };
  P_.nullifierPda = function (n) { return this.pda([Buffer.from('nf'), be32(n)], this.programs.pool); };
  P_.pendingPda = function (c0) { return this.pda([Buffer.from('pend'), be32(c0)], this.programs.pool); };
  /// veyl_pool's event authority (Anchor event-cpi): every instruction that changes the shielded tree takes it and the
  /// pool program as its last two accounts (veyl_entry's shielded actions: `pool_events`, after their named accounts).
  P_.poolEventAuthority = function () { return this.pda([Buffer.from('__event_authority')], this.programs.pool); };
  P_.shieldOwner = function () { return this.pda([Buffer.from('shielded')], this.programs.entry); };
  P_.lpAccPda = function (pool, chunk) { return this.pda([Buffer.from('lpacc'), pk(pool), i32(chunk)], this.programs.entry); };
  P_.bufferPda = function (owner, id) { return this.pda([Buffer.from('buf'), pk(owner), u64(id)], this.programs.entry); };
  P_.isNullified = async function (n) { const a = await this.conn.getAccountInfo(this.nullifierPda(n)); return !!a && a.owner.equals(this.programs.pool); };
  // ---- decoders
  P_.shield = async function () { const a = await this.conn.getAccountInfo(this.shieldPda()); if (!a) return null; const r = new Reader(a.data.subarray(8));
    const s = { authority: r.pk(), pendingAuthority: r.pk(), postman: r.pk(), nextIndex: r.u64(), currentRootIndex: r.u64(), rootSlot: r.u64(), pendingDeposits: r.u64(), bump: r.u8() }; r.skip(7); r.skip(32 * DEPTH * 2);
    s.roots = []; for (let i = 0; i < V_.ROOT_HISTORY; i++) s.roots.push(r.be32()); s.currentRoot = s.roots[Number(s.currentRootIndex)]; s.isKnownRoot = (x) => BigInt(x) !== 0n && s.roots.includes(BigInt(x)); return s; };
  P_.posted = async function (addr) { const a = await this.conn.getAccountInfo(new PublicKey(addr)); if (!a) return null; const r = new Reader(a.data.subarray(8)); const o = { poster: r.pk(), kind: r.u8(), expiresAt: r.u64(), pubs: [] }; for (let i = 0; i < 8; i++) o.pubs.push(r.be32()); return o; };
  P_.pending = async function (addr) { const a = await this.conn.getAccountInfo(new PublicKey(addr)); if (!a) return null; const r = new Reader(a.data.subarray(8)); return { address: new PublicKey(addr), depositor: r.pk(), mint: r.pk(), amount: r.u64(), commitments: [r.be32(), r.be32()], slot: r.u64() }; };
  P_.lpAcc = async function (pool, chunk) { const a = await this.conn.getAccountInfo(this.lpAccPda(pool, chunk)); if (!a) return null; const r = new Reader(a.data.subarray(8)); const o = { pool: r.pk(), chunk: r.i32() }; r.skip(4); o.hx = []; for (let i = 0; i < 60; i++) o.hx.push(r.u128()); o.hy = []; for (let i = 0; i < 60; i++) o.hy.push(r.u128()); return o; };
  /// Fee growth per shielded share for the window [lo, lo + 16): [hx[16], hy[16]] (0 where no LpAcc exists yet).
  P_.growthOf = async function (pool, lo) { const out = [[], []]; const accs = {}; for (let b = 0; b < K; b++) { const id = lo + b; const c = V_.chunkOf(id); if (!(c in accs)) accs[c] = await this.lpAcc(pool, c); const a = accs[c]; out[0].push(a ? a.hx[V_.slotOf(id)] : 0n); out[1].push(a ? a.hy[V_.slotOf(id)] : 0n); } return out; };
  /// The shielded aggregate's shares per bin of the window (what all shielded positions hold together).
  P_.aggregateOf = async function (pool, lo) { const out = []; const accs = {}; for (let b = 0; b < K; b++) { const id = lo + b; const c = V_.chunkOf(id); if (!(c in accs)) accs[c] = await this.shareAccount(pool, this.shieldOwner(), this.signerPda(), c); const a = accs[c]; out.push(a ? a.slots[V_.slotOf(id)].shares : 0n); } return out; };

  // ---- veyl_pool: the shielded pool
  /// The two accounts #[event_cpi] appends to an instruction of veyl_pool: its event authority and the program itself.
  P_.poolEvents = function () { return [R(this.poolEventAuthority()), R(this.programs.pool)]; };
  P_.initShieldIx = function (authority, postman) { return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([V_.disc('init_shield'), pk(postman)]), keys: [W(authority, true), R(this.programs.pool), R(this.programDataPda(this.programs.pool)), W(this.shieldPda()), R(SYS)] }); };
  P_.shieldAdminIx = function (name, authority, data = Buffer.alloc(0)) { return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([V_.disc(name), data]), keys: [R(authority, true), W(this.shieldPda())] }); };
  P_.postProofIx = function (poster, kind, proofBytes, pubs, ttl = V_.DEFAULT_TTL_SLOTS) { if (proofBytes.length !== 256 || pubs.length !== 8) throw new Error('bad proof');
    return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([V_.disc('post_proof'), u8(kind), proofBytes, ...pubs.map((p) => be32(p)), u64(ttl)]), keys: [W(poster, true), W(this.proofPda(kind, pubs)), R(SYS)] }); };
  P_.cancelProofIx = function (canceller, kind, pubs, poster) { return new TransactionInstruction({ programId: this.programs.pool, data: V_.disc('cancel_proof'), keys: [R(canceller, true), W(poster), W(this.proofPda(kind, pubs))] }); };
  P_.shieldDepositIx = async function (depositor, ext, pubs, poster = depositor) { const mint = new PublicKey(ext.mint); const tp = await this.tokenProgram(mint);
    return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([V_.disc('shield_deposit'), encodeExt(ext)]), keys: [W(depositor, true), W(this.shieldPda()), W(this.proofPda(KIND.TRANSACT, pubs)), W(poster), W(this.nullifierPda(pubs[4])), W(this.nullifierPda(pubs[5])),
      R(mint), W(this.shieldVault(mint, tp)), W(this.ata(mint, depositor, tp)), W(this.pendingPda(pubs[6])), R(tp), R(SYS), ...this.poolEvents()] }); };
  P_.approveDepositIx = function (postman, pending, depositor) { return new TransactionInstruction({ programId: this.programs.pool, data: V_.disc('approve_deposit'), keys: [R(postman, true), W(this.shieldPda()), W(depositor), W(pending), ...this.poolEvents()] }); };
  P_.cancelDepositIx = async function (depositor, pending, mint) { const tp = await this.tokenProgram(mint); return new TransactionInstruction({ programId: this.programs.pool, data: V_.disc('cancel_deposit'), keys: [W(depositor, true), W(this.shieldPda()), W(pending), R(mint), W(this.shieldVault(mint, tp)), W(this.ata(mint, depositor, tp)), R(tp), ...this.poolEvents()] }); };
  /// Withdrawal / transfer. ext.recipient and ext.relayer are token accounts (create them first).
  P_.shieldTransactIx = async function (submitter, ext, pubs, poster = submitter) { const none = R(this.programs.pool); const moves = BigInt(ext.extAmount || 0n) < 0n || BigInt(ext.fee || 0n) > 0n;
    let opt = [none, none, none, none, none];
    if (moves) { const mint = new PublicKey(ext.mint); const tp = await this.tokenProgram(mint); opt = [R(mint), W(this.shieldVault(mint, tp)), BigInt(ext.extAmount) < 0n ? W(ext.recipient) : none, BigInt(ext.fee || 0n) > 0n ? W(ext.relayer) : none, R(tp)]; }
    return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([V_.disc('shield_transact'), encodeExt(ext)]), keys: [W(submitter, true), W(this.shieldPda()), W(this.proofPda(KIND.TRANSACT, pubs)), W(poster), W(this.nullifierPda(pubs[4])), W(this.nullifierPda(pubs[5])), ...opt, R(SYS), ...this.poolEvents()] }); };

  // ---- veyl_entry: buffers, growth accounts, shielded actions
  P_.initLpAccIx = function (payer, pool, chunk) { return this.entryIx('init_lp_acc', i32(chunk), [W(payer, true), R(pool), W(this.lpAccPda(pool, chunk)), R(SYS)]); };
  P_.openBufferIx = function (owner, id, len) { return this.entryIx('open_buffer', Buffer.concat([u64(id), u32(len)]), [W(owner, true), W(this.bufferPda(owner, id)), R(SYS)]); };
  P_.writeBufferIx = function (owner, id, offset, bytes) { return this.entryIx('write_buffer', Buffer.concat([u64(id), u32(offset), u32(bytes.length), Buffer.from(bytes)]), [R(owner, true), W(this.bufferPda(owner, id))]); };
  P_.closeBufferIx = function (owner, id) { return this.entryIx('close_buffer', u64(id), [W(owner, true), W(this.bufferPda(owner, id))]); };
  /// Write `bytes` into a fresh buffer (several transactions); returns its id.
  P_.uploadBuffer = async function (owner, bytes, id = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))) {
    const kp = owner; await this.send([this.openBufferIx(kp.publicKey, id, bytes.length)], [kp], 100_000);
    for (let o = 0; o < bytes.length; o += 900) await this.send([this.writeBufferIx(kp.publicKey, id, o, bytes.subarray(o, o + 900))], [kp], 100_000);
    return id; };
  P_.legKeys = function (leg) { return [W(this.proofPda(KIND.TRANSACT, leg.pubs)), W(leg.poster), W(this.nullifierPda(leg.pubs[4])), W(this.nullifierPda(leg.pubs[5]))]; };
  /// The bin arrays and aggregate share accounts a shielded LP action touches: the window's chunks, the active bin's (and
  /// a zap's swap path).
  P_.lpBinKeys = function (pool, p, lo, zapXIn) { const chunks = [...new Set([V_.chunkOf(lo), V_.chunkOf(lo + K - 1)])]; const extra = [V_.chunkOf(p.activeId)]; if (zapXIn !== undefined && zapXIn !== null) extra.push(...V_.chunksForSwap(p, zapXIn));
    const all = [...new Set([...chunks, ...extra])]; return [...all.map((c) => W(this.binArrayPda(pool, c))), ...chunks.map((c) => W(this.sharesPda(pool, this.shieldOwner(), this.signerPda(), c)))]; };
  /// shield_lp: relayer, buffer id, the position proof's pubs + poster, legs [{ pubs, poster }].
  P_.shieldLpIx = async function (relayer, bufferId, req, posPubs, posPoster, legs = []) { const c = req.core; const pool = new PublicKey(c.binPool); const p = await this.binPool(pool); const signer = this.signerPda(); const shield = this.shieldPda();
    const lpChunks = [...new Set([V_.chunkOf(c.lo), V_.chunkOf(c.lo + K - 1)])];
    return this.entryIx('shield_lp', u8(lpChunks.length), [W(relayer, true), R(this.entryPda()), R(signer), W(this.bufferPda(relayer, bufferId)), W(shield), W(this.proofPda(KIND.POSITION, posPubs)), W(posPoster), W(this.nullifierPda(posPubs[1])),
      W(pool), R(p.mintX), R(p.mintY), W(p.vaultX), W(p.vaultY), W(this.ata(p.mintX, signer, p.tokenProgramX)), W(this.ata(p.mintY, signer, p.tokenProgramY)), W(this.ata(p.mintX, shield, p.tokenProgramX)), W(this.ata(p.mintY, shield, p.tokenProgramY)),
      W(this.ata(p.mintX, c.relayer, p.tokenProgramX)), W(this.ata(p.mintY, c.relayer, p.tokenProgramY)), R(p.tokenProgramX), R(p.tokenProgramY), R(this.programs.pool), R(this.programs.bin), R(SYS), R(this.poolEventAuthority()),
      ...lpChunks.map((ch) => W(this.lpAccPda(pool, ch))), ...legs.flatMap((l) => this.legKeys(l)), ...this.lpBinKeys(pool, p, c.lo, c.zap ? c.zap.xIn : null)]); };
  P_.shieldSwapIx = async function (relayer, bufferId, req, legPoster) { const c = req.core; const mintIn = new PublicKey(req.leg.mint), mintOut = new PublicKey(c.tokenOut); const tpi = await this.tokenProgram(mintIn), tpo = await this.tokenProgram(mintOut); const signer = this.signerPda(); const shield = this.shieldPda();
    return this.entryIx('shield_swap', Buffer.alloc(0), [W(relayer, true), R(this.entryPda()), R(signer), W(this.bufferPda(relayer, bufferId)), W(shield), ...this.legKeys({ pubs: req.legPubs, poster: legPoster }),
      R(mintIn), W(this.ata(mintIn, shield, tpi)), W(this.ata(mintIn, signer, tpi)), W(req.leg.relayer), R(mintOut), W(this.ata(mintOut, signer, tpo)), W(this.ata(mintOut, shield, tpo)), R(tpi), R(tpo), R(this.programs.pool), R(this.programs.bin), R(SYS), R(this.poolEventAuthority()),
      ...(await this.routeRemaining(c.routes, signer))]); };
  P_.shieldOrderIx = async function (relayer, bufferId, req, legPoster) { const c = req.core; const pool = new PublicKey(c.binPool); const p = await this.binPool(pool); const signer = this.signerPda(); const shield = this.shieldPda();
    const [mint, tp] = c.isAsk ? [p.mintX, p.tokenProgramX] : [p.mintY, p.tokenProgramY];
    return this.entryIx('shield_order', Buffer.alloc(0), [W(relayer, true), R(this.entryPda()), R(signer), W(this.bufferPda(relayer, bufferId)), W(shield), ...this.legKeys({ pubs: req.legPubs, poster: legPoster }),
      W(pool), R(p.mintX), R(p.mintY), W(p.vaultX), W(p.vaultY), W(this.ata(p.mintX, signer, p.tokenProgramX)), W(this.ata(p.mintY, signer, p.tokenProgramY)), W(this.ata(mint, shield, tp)), W(req.leg.relayer), R(p.tokenProgramX), R(p.tokenProgramY), R(this.programs.pool), R(this.programs.bin), R(SYS), R(this.poolEventAuthority()),
      W(this.binArrayPda(pool, V_.chunkOf(c.id))), W(this.sharesPda(pool, this.shieldOwner(), signer, V_.chunkOf(c.id)))]); };
  P_.shieldOrderWithdrawIx = async function (relayer, bufferId, req, legPoster) { const c = req.core; const pool = new PublicKey(c.binPool); const p = await this.binPool(pool); const signer = this.signerPda(); const shield = this.shieldPda();
    return this.entryIx('shield_order_withdraw', Buffer.alloc(0), [W(relayer, true), R(this.entryPda()), R(signer), W(this.bufferPda(relayer, bufferId)), W(shield), ...this.legKeys({ pubs: req.legPubs, poster: legPoster }),
      W(pool), R(p.mintX), R(p.mintY), W(p.vaultX), W(p.vaultY), W(this.ata(p.mintX, signer, p.tokenProgramX)), W(this.ata(p.mintY, signer, p.tokenProgramY)), W(this.ata(p.mintX, shield, p.tokenProgramX)), W(this.ata(p.mintY, shield, p.tokenProgramY)),
      W(this.ata(p.mintX, c.relayer, p.tokenProgramX)), W(this.ata(p.mintY, c.relayer, p.tokenProgramY)), R(p.tokenProgramX), R(p.tokenProgramY), R(this.programs.pool), R(this.programs.bin), R(SYS), R(this.poolEventAuthority()),
      W(this.binArrayPda(pool, V_.chunkOf(c.id))), W(this.sharesPda(pool, this.shieldOwner(), signer, V_.chunkOf(c.id)))]); };
  P_.shieldMigrateIx = async function (relayer, mint, nullifierHash, d) { const pool = this.poolPda(mint); const p = await this.pool(pool); const signer = this.signerPda(); const shield = this.shieldPda();
    return this.entryIx('shield_migrate', encodeMigrate(d), [W(relayer, true), R(this.entryPda()), R(signer), W(pool), R(mint), W(p.vault), W(this.spendPda(pool, nullifierHash)), W(this.ata(mint, signer, p.tokenProgram)), W(this.ata(mint, d.feeRecipient, p.tokenProgram)), W(shield), W(this.ata(mint, shield, p.tokenProgram)), R(p.tokenProgram), R(this.programs.pool), R(this.poolEventAuthority())]); };
  P_.shieldReturnRewardsIx = async function (pool, index, ids) { const p = await this.binPool(pool); const r = p.rewards[index]; const signer = this.signerPda();
    return this.entryIx('shield_return_rewards', Buffer.concat([u8(index), vec(ids, i32)]), [R(this.entryPda()), R(signer), W(pool), R(r.mint), W(r.vault), W(this.ata(r.mint, r.funder, r.tokenProgram)), R(r.tokenProgram), R(this.programs.bin),
      ...this.binRemaining(pool, ids, this.shieldOwner(), signer, [V_.chunkOf(p.activeId)])]); };
  /// A fetched transaction's account keys (static, then the lookup tables' writable and readonly ones).
  P_.keysOf = function (t) { const m = t.transaction.message; const la = t.meta && t.meta.loadedAddresses; return [...m.staticAccountKeys, ...(la ? [...la.writable, ...la.readonly] : [])].map((k) => new PublicKey(k)); };
  /// The events veyl_pool delivered by its event CPI (Evs in programs/veyl_pool: one self-CPI per instruction, data =
  /// EVENT_IX_TAG + the events in Anchor's encoding), from inner instructions as getTransaction returns them ({ programIdIndex,
  /// accounts, data: base58 }; `keys` = keysOf) or as a simulation does ({ programId, accounts, data: base58 }). Kept in full
  /// by the runtime whatever the transaction logs, and only veyl_pool can make one (its event authority PDA signs it; any other
  /// caller fails the whole transaction).
  P_.cpiEvents = function (inner, keys = []) { const pool = this.programs.pool.toBase58(); const out = [];
    for (const g of inner || []) for (const i of g.instructions || []) { const prog = i.programId ? String(i.programId) : keys[i.programIdIndex] ? keys[i.programIdIndex].toBase58() : null; if (prog !== pool || typeof i.data !== 'string') continue;
      let d; try { d = Buffer.from(bs58.decode(i.data)); } catch { continue; } if (d.length > 8 && d.subarray(0, 8).equals(V_.EVENT_IX_TAG)) out.push(...V_.parseEventData(d.subarray(8))); }
    return out; };
  /// The tree events of transaction `sig` from veyl_pool's event CPI ([] for a transaction from before it had one).
  P_.treeEvents = async function (sig) { const t = await this.conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); return t ? this.cpiEvents(t.meta.innerInstructions, this.keysOf(t)) : []; };
  /// The tree events of a fetched transaction: from the event CPI, or (a transaction from before it, the old programs) from
  /// the logs, where only events logged by veyl_pool itself count (and PositionCiphertext by veyl_entry, which logged it
  /// then): any program can log a line that decodes as a NoteInserted. Other events (UI) always come from the logs.
  P_.txEvents = function (t) { const cpi = this.cpiEvents(t.meta.innerInstructions, this.keysOf(t)); const pool = this.programs.pool.toBase58(), entry = this.programs.entry.toBase58();
    const logged = V_.logEvents(t.meta.logMessages).filter((e) => !TREE.has(e.name) || e.program === null || e.program === pool || (e.name === 'PositionCiphertext' && e.program === entry));
    return { evs: cpi.length ? [...cpi, ...logged.filter((e) => !TREE.has(e.name))] : logged, cpi: cpi.length > 0 }; };
  /// Every instruction of a fetched transaction, top-level and inner (CPIs): { program, accounts, data }.
  P_.ixsOf = function (t) { const m = t.transaction.message; const keys = this.keysOf(t);
    const out = m.compiledInstructions.map((i) => ({ program: keys[i.programIdIndex], accounts: [...i.accountKeyIndexes].map((j) => keys[j]), data: Buffer.from(i.data) }));
    for (const g of (t.meta && t.meta.innerInstructions) || []) for (const i of g.instructions) out.push({ program: keys[i.programIdIndex], accounts: (i.accounts || []).map((j) => keys[j]), data: Buffer.from(bs58.decode(i.data)) });
    return out; };
  /// A veyl_entry request buffer as it was when `sig` (an instruction reading it) ran, rebuilt from its open_buffer and
  /// write_buffer transactions (they come before `sig` in the buffer account's history). Null when they cannot be found.
  P_.bufferBytes = async function (buffer, sig) { const D = (n) => V_.disc(n).toString('hex'); const page = await this.conn.getSignaturesForAddress(new PublicKey(buffer), { before: sig, limit: 200 }, 'confirmed');
    const writes = []; let len = null;
    for (const s of page) { if (s.err) continue; const t = await this.conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!t) continue;
      for (const x of this.ixsOf(t).reverse()) { if (!x.program.equals(this.programs.entry) || !x.accounts[1] || !x.accounts[1].equals(new PublicKey(buffer))) continue; const tag = x.data.subarray(0, 8).toString('hex');
        if (tag === D('write_buffer')) { const r = new Reader(x.data.subarray(16)); const o = r.u32(); writes.push({ o, b: r.bytes(r.u32()) }); } else if (tag === D('open_buffer')) { len = new Reader(x.data.subarray(16)).u32(); break; } }
      if (len !== null) break; } // newest first: the open_buffer closest before `sig` starts this use of the buffer
    if (len === null) return null; const buf = Buffer.alloc(len); for (const w of writes.reverse()) w.b.copy(buf, w.o); return buf; };
  /// Note payloads a transaction carries in its instruction data that its events do not show (an old program's logs cut past
  /// ~10 KB, or no longer logging payloads): the ext of shield_transact / shield_deposit / transact_cpi, the payloads of
  /// consume_swap / consume_claim / consume_position, and an old shield_lp's payloads (position and legs, in its request
  /// buffer, fetched only when the PositionCiphertext event is missing).
  /// Each is bound into the action's proof; a scanner still checks it against the commitment.
  P_.ixCiphertexts = async function (t, sig, evs) { const D = (n) => V_.disc(n).toString('hex'); const out = [];
    const logged = new Set(evs.filter((e) => e.name === 'NoteCiphertext' || e.name === 'PositionCiphertext').map((e) => Buffer.from(e.data).toString('hex')));
    for (const x of this.ixsOf(t)) { const tag = x.data.subarray(0, 8).toString('hex'); const r = new Reader(x.data.subarray(8));
      try {
        if (x.program.equals(this.programs.pool)) {
          if (tag === D('shield_transact') || tag === D('shield_deposit') || tag === D('transact_cpi')) out.push(...decodeExt(r).encOut);
          else if (tag === D('consume_swap') || tag === D('consume_claim')) { r.skip(40); /* ext_hash, fee */ out.push(...r.vec(() => r.bytes(r.u32()))); }
          else if (tag === D('consume_position')) { r.skip(32); /* ext_hash */ out.push(r.bytes(r.u32())); }
        } else if (x.program.equals(this.programs.entry) && tag === D('shield_lp') && !evs.some((e) => e.name === 'PositionCiphertext')) { const buf = await this.bufferBytes(x.accounts[3], sig); if (buf) { const rb = new Reader(buf); out.push(decodeLpCore(rb).ciphertext); try { for (const l of rb.vec(() => decodeExt(rb))) out.push(...l.encOut); } catch { /* core only */ } } }
      } catch { /* not one of ours, or not decodable */ } }
    return out.filter((b) => b.length >= 48 && !logged.has(b.toString('hex'))); };
  /// sendV0, after a simulation shows that readers will see every tree leaf and receipt the transaction adds (logCut): with
  /// veyl_pool's event CPI in the simulation, from it (Solana's log cut no longer matters); with an old program, in logs that
  /// Solana cuts past 10,000 bytes. Otherwise nothing is sent and it throws (code 'LOG_CUT'). (Anyone can submit a shield
  /// instruction without the relayer: only the event CPI protects those.)
  P_.sendV0Checked = async function (ixs, signers = [], cu = 1_400_000) { const tx = await this.buildV0(ixs, signers, cu); let why = null;
    try { const v = (await this.conn.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed', innerInstructions: true, accounts: { encoding: 'base64', addresses: [this.shieldPda().toBase58()] } })).value;
      if (!v.err) { const a = v.accounts && v.accounts[0]; why = logCut(v.logs, a ? Buffer.from(a.data[0], 'base64').readBigUInt64LE(8 + 96) /* Shield.next_index */ : null, this.cpiEvents(v.innerInstructions)); } } catch { /* no simulation: the send's own preflight still runs */ }
    if (why) { const e = new Error('This action is too big for one Solana transaction\'s logs (' + why + '): nothing was sent. Split it (fewer funding legs, or claim fees on their own) and try again.'); e.code = 'LOG_CUT'; throw e; }
    return this.sendSigned(tx); };
  /// The shielded tree from the chain: leaves in order, ciphertexts and receipts by commitment, pending deposits, spent
  /// nullifiers, approved deposits per mint (the crowd a token's deposit blends into), `newest` (the last signature read) and
  /// `truncated` (old-program signatures whose logs Solana cut: events after the cut, a tree leaf among them, are missing).
  /// Events come from veyl_pool's event CPI (txEvents), which no log cut touches; logs only for transactions from before it.
  /// With `prev` (an earlier result, or its serializeShield form) only the newer signatures are read ('until'); the caller
  /// keeps checking the root and reads in full when that fails. A leaf with no payload in the logs gets the payloads its
  /// transaction carries in instruction data (`alt` when there are several; scan() keeps the one matching the commitment).
  P_.readShield = async function ({ prev = null } = {}) {
    const addr = this.shieldPda(); const until = (prev && prev.newest) || undefined; let before; const sigs = [];
    for (;;) { const page = await this.conn.getSignaturesForAddress(addr, { before, until, limit: 1000 }, 'confirmed'); sigs.push(...page); if (page.length < 1000) break; before = page[page.length - 1].signature; }
    const st = loadShield(until ? prev : null); /* a state without its newest signature cannot be extended */ const { leaves, ciphertexts: cts, receipts, pending, nullified, deposits } = st; if (sigs.length) st.newest = sigs[0].signature;
    sigs.reverse();
    for (const s of sigs) { if (s.err) continue; const t = await this.conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!t) continue;
      const { evs, cpi } = this.txEvents(t); const ins = []; if (!cpi && (t.meta.logMessages || []).includes('Log truncated')) st.truncated.push(s.signature);
      for (const e of evs) {
        if (e.name === 'NoteInserted') { leaves[Number(e.index)] = e.commitment; ins.push(String(e.commitment)); }
        else if (e.name === 'NoteCiphertext' || e.name === 'PositionCiphertext') cts.set(String(e.commitment), { data: e.data, position: e.name === 'PositionCiphertext', sig: s.signature });
        else if (e.name === 'ReceiptNote') receipts.set(String(e.commitment), { ...e, sig: s.signature });
        else if (e.name === 'DepositPending') pending.set(e.pending.toBase58(), { ...e, sig: s.signature });
        else if (e.name === 'DepositApproved' || e.name === 'DepositCancelled') { const p = pending.get(e.pending.toBase58()); if (p && e.name === 'DepositApproved') { const m = String(p.mint); deposits[m] = (deposits[m] || 0) + 1; } pending.delete(e.pending.toBase58()); }
        else if (e.name === 'Nullified') nullified.add(String(e.nullifier)); }
      const orphans = ins.filter((c) => !cts.has(c) && !receipts.has(c)); // a position's fee notes have no payload of their own: usually nothing to recover
      if (orphans.length) { const rec = await this.ixCiphertexts(t, s.signature, evs); if (rec.length) for (const c of orphans) cts.set(c, { data: rec[0], alt: rec.slice(1), recovered: true, sig: s.signature }); } }
    for (let i = 0; i < leaves.length; i++) if (leaves[i] === undefined) throw new Error('gap in the shielded tree history at ' + i);
    return { leaves, ciphertexts: cts, receipts, pending: [...pending.values()], nullified, deposits, newest: st.newest, truncated: st.truncated };
  };
}
/// What readers would miss of a transaction's notes: null when nothing, else the reason. `cpi` = the tree events of veyl_pool's
/// event CPI (cpiEvents): when there are any, they are what readers use, and they must hold every tree leaf up to `nextIndex`
/// (the tree's size after the transaction, from a simulation; null = unknown, skips that test). Without (old programs): null
/// when nothing was logged past the cut, or when the logs still hold every tree leaf it adds and the last NoteInserted is
/// not the final line kept (a receipt's ReceiptNote follows its NoteInserted).
function logCut(logs, nextIndex = null, cpi = null) { const known = nextIndex !== null && nextIndex !== undefined;
  if (cpi && cpi.length) { let last = -1; for (const e of cpi) if (e.name === 'NoteInserted') last = Math.max(last, Number(e.index)); return known && last >= 0 && BigInt(last + 1) < BigInt(nextIndex) ? 'tree leaves from index ' + (last + 1) + ' would be missing' : null; }
  logs = logs || []; if (!logs.includes('Log truncated')) return null; let last = -1, lastAt = -1;
  logs.forEach((l, i) => { if (!l.startsWith('Program data: ')) return; const e = V_.parseEvents([l])[0]; if (e && e.name === 'NoteInserted') { last = Math.max(last, Number(e.index)); lastAt = i; } });
  if (known && BigInt(last + 1) < BigInt(nextIndex)) return 'tree leaves from index ' + (last + 1) + ' would be missing';
  if (lastAt >= 0 && logs[lastAt + 1] === 'Log truncated') return 'the last new note\'s event would be cut';
  return null; }
/// readShield's result as plain JSON (what the relayer serves at /shield and the browser caches), and back (loadShield:
/// Maps and Sets again, for readShield's `prev`). Payloads travel as base64.
const B64_ = (x) => Buffer.from(bytes(x)).toString('base64');
function serializeShield(r) { const list = (m) => (m instanceof Map ? [...m] : (m || []).map((x) => [String(x.commitment), x]));
  return { leaves: r.leaves.map(String), ciphertexts: list(r.ciphertexts).map(([c, x]) => ({ commitment: String(c), data: B64_(x.data), position: !!x.position, ...(x.alt && x.alt.length ? { alt: x.alt.map(B64_) } : {}) })),
    receipts: (r.receipts instanceof Map ? [...r.receipts.values()] : r.receipts || []).map((x) => ({ index: Number(x.index), commitment: String(x.commitment), asset: String(x.asset), amount: String(x.amount), owner: String(x.owner), blinding: String(x.blinding) })),
    pending: (r.pending || []).map((x) => ({ pending: String(x.pending), depositor: String(x.depositor), mint: String(x.mint), amount: String(x.amount), commitments: (x.commitments || []).map(String) })),
    nullified: [...(r.nullified || [])].map(String), deposits: { ...(r.deposits || {}) }, newest: r.newest || null, truncated: [...(r.truncated || [])] }; }
function loadShield(p) { const st = { leaves: [], ciphertexts: new Map(), receipts: new Map(), pending: new Map(), nullified: new Set(), deposits: {}, newest: null, truncated: [] }; if (!p) return st;
  st.leaves = (p.leaves || []).map(BigInt); st.newest = p.newest || null; st.truncated = [...(p.truncated || [])]; st.deposits = { ...(p.deposits || {}) }; st.nullified = new Set([...(p.nullified || [])].map(String));
  for (const [c, x] of p.ciphertexts instanceof Map ? [...p.ciphertexts] : (p.ciphertexts || []).map((x) => [String(x.commitment), x])) st.ciphertexts.set(String(c), { ...x, data: bytes(x.data), ...(x.alt ? { alt: x.alt.map(bytes) } : {}) });
  for (const x of p.receipts instanceof Map ? p.receipts.values() : p.receipts || []) st.receipts.set(String(x.commitment), x);
  for (const x of p.pending || []) st.pending.set(String(x.pending), x);
  return st; }
install(V_.Veyl);
Object.assign(module.exports, { KIND, TREE, install, serializeShield, loadShield, logCut, encodeLpRequest, encodeSwapCore, encodeOrderCore, encodeOrderWithdrawCore, encodeMigrate, swapAction, orderAction, orderWithdrawAction, proofId, MIGRATE, encRoute });

// ================================================================================================ the wallet (device side)
/// Everything a Veyl account knows, rebuilt from the chain with its keys: notes (token, order and position notes, by
/// decrypting the payloads addressed to its viewing key and by recognising receipts paid to its one-time keys), which of
/// them are spent (nullifiers), balances, coin selection, and the requests (external data + circuit inputs) for every
/// action. Proving and sending are the caller's (Node: sdk/prover.js; browser: the engine's Web Worker and the relayer).
/// A note worth keeping a record of: an amount, a sealed swap, or a position that still holds shares.
const worth = (n) => (n.kind === NOTE.SWAP ? true : n.kind === NOTE.POSITION ? n.shares.some((x) => BigInt(x) > 0n) : BigInt(n.amount || 0) > 0n);
class ShieldWallet {
  constructor(seed, { mints = {}, pools = [] } = {}) {
    this.k = keysFromSeed(seed); this.seed = this.k.seed; this.ot = 0; this.notes = []; this.mints = mints; this.pools = pools; // mints: base58 -> { sym, decimals }; pools: [{ address, mintX, mintY }]
    this.assets = new Map(); for (const m of Object.keys(mints)) this.assets.set(String(assetOf(m)), { kind: NOTE.TOKEN, mint: m });
    for (const p of pools) { this.assets.set(String(assetOf(p.mintX)), { kind: NOTE.TOKEN, mint: String(p.mintX) }); this.assets.set(String(assetOf(p.mintY)), { kind: NOTE.TOKEN, mint: String(p.mintY) }); }
  }
  get address() { return this.k.address; }
  /// The next one-time key (for a receipt: swap output, removal proceeds, order shares, leftovers).
  nextOneTime() { return oneTime(this.seed, this.ot++); }
  poolOf(addr) { const a = new PublicKey(addr).toBase58(); return this.pools.find((p) => new PublicKey(p.address).toBase58() === a); }
  /// The notes one plaintext (a decrypted payload, or an outbox entry) opens for this account, each with its commitment:
  /// [the note itself, ...fee notes] (a position's plaintext also carries the fee notes its action created). Null if not ours.
  notesOfPlain(d) {
    if (!d) return null;
    if (d.kind === NOTE.SWAP) { const key = hashToField(Buffer.from('veyl-batch'), pk(d.binPool), u64(d.seq)); return [{ ...d, batchKey: key, commitment: P(key, d.direction, d.amount, this.k.pk, d.blinding), sk: this.k.sk }]; }
    if (d.kind === NOTE.POSITION) { const asset = posAssetOf(d.binPool, d.lo); const out = [{ ...d, commitment: P(asset, positionDigest(d.shares, d.debt), this.k.pk, d.blinding), sk: this.k.sk, asset }];
      const pool = this.poolOf(d.binPool); if (pool) [pool.mintX, pool.mintY].forEach((m, a) => { if (d.claims[a] > 0n) out.push({ kind: NOTE.TOKEN, mint: String(m), amount: d.claims[a], blinding: d.claimBlinding[a], asset: assetOf(m), commitment: commitmentOf(assetOf(m), d.claims[a], this.k.pk, d.claimBlinding[a]), sk: this.k.sk, fromPosition: true }); });
      return out; }
    if (d.kind === NOTE.TOKEN || d.kind === NOTE.ORDER) { const asset = assetOfNote(d); return [{ ...d, asset, commitment: commitmentOf(asset, d.amount, this.k.pk, d.blinding), sk: this.k.sk }]; }
    return null; }
  /// Outbox entries for the notes a request creates for this account, from its ciphertexts (the ones this viewing key opens):
  /// [{ c: commitment, p: plaintext (hex), nf: the nullifiers the action publishes, at }]. Kept by the caller BEFORE the
  /// request is sent: if the chain drops the note's encrypted copy, scan(state, outbox) still finds the note by its
  /// commitment. Empty notes (zero amounts, an emptied position without fee notes) are left out.
  outboxOf(ciphertexts, nf = []) { const out = [];
    for (const ct of ciphertexts) { const plain = open(this.k.viewSecret, bytes(ct)); if (!plain) continue; let ns; try { ns = this.notesOfPlain(decodePlain(plain)); } catch { continue; }
      if (ns && ns.some(worth)) out.push({ c: String(ns[0].commitment), p: plain.toString('hex'), nf: nf.map(String), at: Date.now() }); }
    return out; }
  /// Rebuild every note from the shielded tree's state: { leaves, ciphertexts: [{ commitment, data, alt?, position }] | Map,
  /// receipts: [...] | Map, nullified }. `alt`: other candidate payloads for that commitment (recovered from instruction data).
  /// `outbox`: notes this account planned (outboxOf); one whose commitment is a leaf but which no payload delivered is
  /// adopted from its plaintext (marked `outbox`). After a scan, `found` holds the commitments a payload delivered.
  scan(state, outbox = []) {
    const tree = state.tree || new Tree(state.leaves.map(BigInt)); this.tree = tree; const idx = new Map(); tree.leaves.forEach((l, i) => idx.set(String(l), i)); this.leafIndex = idx;
    const notes = []; const add = (n) => { const i = idx.get(String(n.commitment)); if (i === undefined) return; if (n.mint && typeof n.mint !== 'string') n.mint = new PublicKey(n.mint).toBase58(); n.index = i; n.nullifier = nullifierOf(n.commitment, i, n.sk); notes.push(n); };
    const found = new Set(); this.found = found;
    const cts = state.ciphertexts instanceof Map ? [...state.ciphertexts].map(([c, x]) => ({ commitment: c, ...x })) : state.ciphertexts || [];
    for (const ct of cts) for (const data of [ct.data, ...(ct.alt || [])]) { const plain = open(this.k.viewSecret, bytes(data)); if (!plain) continue; let ns; try { ns = this.notesOfPlain(decodePlain(plain)); } catch { continue; }
      if (!ns || String(ns[0].commitment) !== String(ct.commitment)) continue; ns.forEach(add); found.add(String(ct.commitment)); break; }
    for (const o of outbox || []) { if (found.has(o.c) || !idx.has(o.c)) continue; let ns; try { ns = this.notesOfPlain(decodePlain(bytes(o.p))); } catch { continue; }
      if (ns && String(ns[0].commitment) === o.c) ns.forEach((n) => add({ ...n, outbox: o.c })); }
    const recs = state.receipts instanceof Map ? [...state.receipts.values()] : state.receipts || []; const mine = new Map(); const look = Math.max(this.ot, 0) + 32;
    for (let i = 0; i < look; i++) { const o = oneTime(this.seed, i); mine.set(String(o.pk), o); }
    for (const r of recs) { const o = mine.get(String(r.owner)); if (!o) continue; if (o.i >= this.ot) this.ot = o.i + 1; const info = this.assets.get(String(r.asset)) || this.orderAssetInfo(r.asset);
      add({ ...(info || { kind: -1 /* an asset this wallet cannot name yet (e.g. an order it has not listed) */ }), amount: BigInt(r.amount), blinding: BigInt(r.blinding), asset: BigInt(r.asset), commitment: BigInt(r.commitment), sk: o.sk, receipt: true }); }
    const spent = state.nullified instanceof Set ? state.nullified : new Set((state.nullified || []).map(String));
    for (const n of notes) n.spent = spent.has(String(n.nullifier));
    const seen = new Set(); this.notes = notes.filter((n) => { const k = String(n.commitment) + ':' + n.index; if (seen.has(k)) return false; seen.add(k); return true; });
    return this.notes;
  }
  /// Order-share receipts carry only an asset id: the orders this account placed ({ pool, id, isAsk }) name them.
  orderAssetInfo(asset) { for (const o of this.orderBook || []) { const pool = new PublicKey(o.pool || o.binPool).toBase58(); if (String(orderAssetOf(pool, o.id, o.isAsk)) === String(asset)) return { kind: NOTE.ORDER, binPool: pool, id: Number(o.id), isAsk: !!o.isAsk }; } return null; }
  /// Unspent token notes of a mint (largest first) and their total.
  tokenNotes(mint) { const a = String(assetOf(mint)); return this.notes.filter((n) => !n.spent && n.kind === NOTE.TOKEN && String(n.asset) === a && BigInt(n.amount) > 0n).sort((x, y) => (BigInt(y.amount) > BigInt(x.amount) ? 1 : -1)); }
  balance(mint) { return this.tokenNotes(mint).reduce((s, n) => s + BigInt(n.amount), 0n); }
  positions() { return this.notes.filter((n) => !n.spent && n.kind === NOTE.POSITION); }
  /// Phase 3: sealed swaps not claimed yet (their commitments are in the tree, their nullifiers unpublished).
  sealedSwaps() { return this.notes.filter((n) => !n.spent && n.kind === NOTE.SWAP); }
  position(binPool, lo) { const a = String(posAssetOf(binPool, lo)); return this.positions().find((n) => String(n.asset) === a) || null; }
  orderNotes(binPool, id, isAsk) { const a = String(orderAssetOf(binPool, id, isAsk)); return this.notes.filter((n) => !n.spent && String(n.asset) === a && BigInt(n.amount) > 0n); }
  /// Up to two notes covering `amount` (null when more are needed: merge first, see mergePlan).
  select(mint, amount) { const ns = this.tokenNotes(mint); const need = BigInt(amount);
    const one = [...ns].reverse().find((n) => BigInt(n.amount) >= need); if (one) return [one];
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) if (BigInt(ns[i].amount) + BigInt(ns[j].amount) >= need) return [ns[i], ns[j]];
    return null; }
  /// Two notes to merge next (the two largest), when no pair covers an amount.
  mergePlan(mint) { const ns = this.tokenNotes(mint); return ns.length >= 2 ? ns.slice(0, 2) : null; }
  _note(mint, amount, pk = this.k.pk, view = this.k.viewPublic) { const blinding = randField(); const plain = encodeNote({ kind: NOTE.TOKEN, mint, amount, blinding }); return { amount: BigInt(amount), pk, blinding, enc: seal(view, plain) }; }
  /// A transact request: spend `ins`, create `outs` ([{ amount, to? (Veyl address) }], change last), with `extFields`.
  transact({ mint, ins = [], outs, ext: extFields }) {
    const asset = assetOf(mint); const made = outs.map((o) => { if (o.to) { const r = decodeAddress(o.to); return this._note(mint, o.amount, r.pk, r.viewPublic); } return this._note(mint, o.amount); });
    while (made.length < 2) made.push(this._note(mint, 0n));
    const ext = { ...extFields, encOut: made.map((m) => m.enc) };
    const t = transactInput({ tree: this.tree, asset, ins: ins.map((n) => ({ amount: BigInt(n.amount), sk: n.sk, blinding: BigInt(n.blinding), index: n.index })), outs: made, ext, sk: this.k.sk });
    return { ...t, ext, outs: made }; }
  /// Spend order-share notes (a virtual asset): publicAmount = -(their total), burned by the entry program.
  orderSpend({ binPool, id, isAsk, notes, processor, action }) {
    const asset = orderAssetOf(binPool, id, isAsk); const total = notes.reduce((s, n) => s + BigInt(n.amount), 0n);
    const made = [0, 1].map(() => { const blinding = randField(); return { amount: 0n, pk: this.k.pk, blinding, enc: seal(this.k.viewPublic, encodeNote({ kind: NOTE.ORDER, binPool, id, isAsk, amount: 0n, blinding })) }; });
    const ext = { extAmount: -total, processor: new PublicKey(processor), action, mint: DEFAULT_KEY, encOut: made.map((m) => m.enc) };
    const t = transactInput({ tree: this.tree, asset, ins: notes.map((n) => ({ amount: BigInt(n.amount), sk: n.sk, blinding: BigInt(n.blinding), index: n.index })), outs: made, ext, sk: this.k.sk });
    return { ...t, ext, total }; }
  /// Deposit `amount` of `mint` from a public wallet into two notes (the second empty).
  deposit(mint, amount) { return this.transact({ mint, outs: [{ amount }], ext: { extAmount: BigInt(amount), fee: 0n, mint: new PublicKey(mint) } }); }
  /// Spend notes of `mint`: `pay` leaves the pool as a public amount (to `recipient`, a token account; or to the entry
  /// program for an action), `send` goes to a Veyl address, the rest comes back as change. `fee` = the relayer's flat fee.
  spend({ mint, pay = 0n, send = 0n, to = null, fee = 0n, recipient = DEFAULT_KEY, relayer = DEFAULT_KEY, processor = DEFAULT_KEY, action = ZERO32, hideToken = false }) {
    const need = BigInt(pay) + BigInt(send) + BigInt(fee); const ins = need > 0n ? this.select(mint, need) : []; if (!ins) throw new Error(this.balance(mint) >= need ? 'merge notes first' : 'not enough shielded balance');
    const have = ins.reduce((s, n) => s + BigInt(n.amount), 0n); const outs = []; if (BigInt(send) > 0n) outs.push({ amount: BigInt(send), to }); outs.push({ amount: have - need });
    const showMint = BigInt(pay) > 0n || BigInt(fee) > 0n || !hideToken;
    const r = this.transact({ mint, ins, outs, ext: { extAmount: -BigInt(pay), fee: BigInt(fee), recipient: new PublicKey(recipient), relayer: new PublicKey(relayer), processor: new PublicKey(processor), action, mint: showMint ? new PublicKey(mint) : DEFAULT_KEY } });
    return { ...r, spent: ins }; }
}

/// Per-bin shares for amounts added to a bin pool's current state, and what minting exactly those shares will take
/// (= veyl_bin mint_exact): a bin with liquidity takes its own composition, an empty one the first-deposit formula.
/// Shares to mint per bin from the amounts set aside for it, exact against the bins as they are now. For the active bin
/// (`p.activeId`) the shares are capped so that the amounts cover them whatever the bin's x/y mix is when the action lands:
/// every swap changes that mix, and a shielded action lands seconds to minutes after it was planned. What the bins then
/// do not need comes back as a receipt note.
function planExact(p, bins, ids, ax, ay) {
  const Q = 1n << 128n; const MIN = 1000n; const shares = [], hintX = [], hintY = [], needX = [], needY = []; const ceil = (a, b, c) => { const v = a * b; return v / c + (v % c ? 1n : 0n); };
  ids.forEach((id, i) => { const b = bins.get(id) || { x: 0n, y: 0n, shares: 0n }; const x = BigInt(ax[i] || 0n), y = BigInt(ay[i] || 0n); let s = 0n, nx = 0n, ny = 0n, hx = 0n, hy = 0n;
    if (x > 0n || y > 0n) {
      if (b.shares === 0n) { const price = require('./veyl.js').priceOf(p.basePrice, p.binStep, id); const liq = (x * price) / Q + y; if (liq > MIN) { s = liq - MIN; hx = x; hy = y; nx = x; ny = y; } }
      else { const cand = []; if (b.x > 0n) cand.push((x * b.shares) / b.x); if (b.y > 0n) cand.push((y * b.shares) / b.y); if (cand.length) s = cand.reduce((m, v) => (v < m ? v : m));
        if (s > 0n && p.activeId !== undefined && id === Number(p.activeId)) { const price = require('./veyl.js').priceOf(p.basePrice, p.binStep, id); const L = (b.x * price) / Q + b.y; const cover = (x * price) / Q < y ? (x * price) / Q : y; if (L > 0n) { const cap = (cover * b.shares * 995n) / (L * 1000n); if (cap < s) s = cap; } }
        if (s > 0n) { nx = ceil(s, b.x, b.shares); ny = ceil(s, b.y, b.shares); } } }
    shares.push(s); hintX.push(hx); hintY.push(hy); needX.push(nx); needY.push(ny); });
  return { shares, hintX, hintY, needX: needX.reduce((a, b) => a + b, 0n), needY: needY.reduce((a, b) => a + b, 0n), perBin: { needX, needY } };
}
/// What `shares` of bin `b` are worth now (floor), per token.
const valueOfShares = (b, s) => (!b || !b.shares ? { x: 0n, y: 0n } : { x: (b.x * BigInt(s)) / b.shares, y: (b.y * BigInt(s)) / b.shares });
Object.assign(module.exports, { ShieldWallet, planExact, valueOfShares, worth });
