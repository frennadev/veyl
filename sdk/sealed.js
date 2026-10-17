// Veyl Phase 3: sealed batch swaps, client side. Swap and claim witnesses (zk/circuits/swap.circom, claim.circom), the
// byte formats veyl_entry/src/sealed.rs hashes, account decoders, instruction builders, the settlement maths (what a batch
// will clear at), and the wallet's sealed-swap requests. Must match the programs byte for byte.
//
//   batch key       hash_to_field("veyl-batch", bin pool, seq u64 LE)
//   swap commitment Poseidon(batchKey, direction, amount, ownerPubkey, blinding)        (direction 0 sells X, 1 sells Y)
//   ciphertext      C1 = r·B8, C2 = amount·B8 + r·PK (sdk/bjj.js), added into the batch's aggregate for its direction
//   swap bundle     Poseidon(direction, assetIn, fee, minIn, C1.x, C1.y, C2.x, C2.y, PK.x, PK.y)
//   claim bundle    Poseidon(direction, assetOut, num, den, fee);  out = floor(amount·num/den) - fee
'use strict';
const { Buffer } = require('buffer');
const { PublicKey, TransactionInstruction } = require('@solana/web3.js');
const V_ = require('./veyl.js'); const Z = require('./shield.js'); const J = require('./bjj.js');
const { u8, u16, u32, u64, be32, pk, vec, Reader } = V_;
const { P, hashToField, randField, DEPTH } = Z; const { W, R, SYS, strings } = V_;

const KIND = { SWAP: 3, CLAIM: 4 };
const STATE = ['open', 'closed', 'settled', 'failed'];
const MAX_MEMBERS = 6; const AMOUNT_LIMIT = 1n << 40n; const MAX_PER_DIRECTION = 64;
const Q128 = 1n << 128n;
const bytesVec = (b) => { const x = Z.bytes(b); return Buffer.concat([u32(x.length), x]); };

// ------------------------------------------------------------------------------------------------ hashes (= sealed.rs)
const batchKey = (binPool, seq) => hashToField(Buffer.from('veyl-batch'), pk(binPool), u64(seq));
const swapCommitment = (key, direction, amount, ownerPk, blinding) => P(key, direction, amount, ownerPk, blinding);
const swapBundle = ({ direction, asset, fee, minIn, c1, c2, pk: K }) => P(direction, asset, fee, minIn, c1[0], c1[1], c2[0], c2[1], K[0], K[1]);
const claimBundle = ({ direction, assetOut, num, den, fee }) => P(direction, assetOut, num, den, fee);
/// SwapExt { relayer, fee, enc_change, enc_swap } / ClaimExt { relayer, fee, enc_out } (borsh)
const encodeSwapExt = (e) => Buffer.concat([pk(e.relayer || Z.DEFAULT_KEY), u64(e.fee || 0n), bytesVec(e.encChange), bytesVec(e.encSwap)]);
const encodeClaimExt = (e) => Buffer.concat([pk(e.relayer || Z.DEFAULT_KEY), u64(e.fee || 0n), bytesVec(e.encOut)]);
const swapExtHash = (e) => hashToField(Buffer.from('veyl-sealed-swap'), encodeSwapExt(e));
const claimExtHash = (e) => hashToField(Buffer.from('veyl-sealed-claim'), encodeClaimExt(e));

// ------------------------------------------------------------------------------------------------ witnesses
/// Input for swap.circom. ins: up to 2 notes { amount, sk, blinding, index } of `asset`; change { amount, pk, blinding };
/// the swap: amount, direction, owner pk, blinding; fee, minIn; r; PK (the committee key, [x, y]); key (batch key).
function swapInput({ tree, asset, ins = [], change, amount, direction, swapPk, swapBlinding, fee = 0n, minIn, r = J.randScalar(J.R_BITS), PK, key, ext, sk }) {
  amount = BigInt(amount); fee = BigInt(fee); minIn = BigInt(minIn);
  if (amount < minIn || amount >= AMOUNT_LIMIT) throw new Error('a sealed swap is between the pool minimum and 2^40 - 1 atoms');
  const inn = [...ins]; while (inn.length < 2) inn.push({ amount: 0n, sk: sk || randField(), blinding: randField(), index: 0, dummy: true });
  const sumIn = inn.reduce((s, n) => s + BigInt(n.amount), 0n); if (sumIn !== BigInt(change.amount) + amount + fee) throw new Error('amounts do not balance');
  const nulls = inn.map((n) => { const c = Z.commitmentOf(asset, n.amount, P(n.sk), n.blinding); if (!n.dummy && tree.leaves[Number(n.index)] !== c) throw new Error('input note is not at its index'); return Z.nullifierOf(c, n.index, n.sk); });
  const changeCommitment = Z.commitmentOf(asset, change.amount, change.pk, change.blinding);
  const sc = swapCommitment(key, direction, amount, swapPk, swapBlinding);
  const ct = J.encrypt(PK, amount, r); const bundle = swapBundle({ direction, asset, fee, minIn, c1: ct.c1, c2: ct.c2, pk: PK }); const extDataHash = swapExtHash(ext);
  const root = tree.root();
  const input = { root, inputNullifier: nulls, changeCommitment, swapCommitment: sc, batchKey: key, bundle, extDataHash, asset: BigInt(asset),
    inAmount: inn.map((n) => BigInt(n.amount)), inKey: inn.map((n) => BigInt(n.sk)), inBlinding: inn.map((n) => BigInt(n.blinding)), inPathIndex: inn.map((n) => BigInt(n.index)),
    inPathElements: inn.map((n) => (n.dummy ? Array(DEPTH).fill(0n) : tree.path(n.index))), changeAmount: BigInt(change.amount), changePubkey: BigInt(change.pk), changeBlinding: BigInt(change.blinding),
    amount, direction: BigInt(direction), swapPubkey: BigInt(swapPk), swapBlinding: BigInt(swapBlinding), fee, minIn, r: BigInt(ct.r), pk: PK.map(BigInt) };
  return { input: strings(input), pubs: [root, ...nulls, changeCommitment, sc, key, bundle, extDataHash], nullifiers: nulls, changeCommitment, swapCommitment: sc, c1: ct.c1, c2: ct.c2 };
}
/// Input for claim.circom: spend the swap commitment `swap` ({ batchKey, direction, amount, blinding, index }) into
/// floor(amount·num/den) - fee of assetOut, for out { pk, blinding }. pubs padded to 8 (two zeros) as post_proof stores them.
function claimInput({ tree, sk, swap, assetOut, num, den, fee = 0n, out, ext }) {
  const amount = BigInt(swap.amount); num = BigInt(num); den = BigInt(den); fee = BigInt(fee); if (den === 0n) throw new Error('no ratio for this direction');
  const q = (amount * num) / den; const value = q - fee; if (value < 0n) throw new Error('the fee is larger than the output');
  const owner = P(sk); const c = swapCommitment(swap.batchKey, swap.direction, amount, owner, swap.blinding);
  if (tree.leaves[Number(swap.index)] !== c) throw new Error('swap commitment is not at its index');
  const nullifier = Z.nullifierOf(c, swap.index, sk); const outCommitment = Z.commitmentOf(assetOut, value, out.pk, out.blinding);
  const bundle = claimBundle({ direction: swap.direction, assetOut, num, den, fee }); const extDataHash = claimExtHash(ext); const root = tree.root();
  const input = { root, nullifier, outCommitment, batchKey: BigInt(swap.batchKey), bundle, extDataHash, key: BigInt(sk), direction: BigInt(swap.direction), amount, swapBlinding: BigInt(swap.blinding),
    pathIndex: BigInt(swap.index), pathElements: tree.path(swap.index), assetOut: BigInt(assetOut), num, den, fee, q, outPubkey: BigInt(out.pk), outBlinding: BigInt(out.blinding) };
  return { input: strings(input), pubs: [root, nullifier, outCommitment, BigInt(swap.batchKey), bundle, extDataHash, 0n, 0n], nullifier, outCommitment, value };
}

// ------------------------------------------------------------------------------------------------ settlement maths (= settle_batch)
/// What a batch clears at: totals [X sold, Y sold], the active bin's 128.128 price (Y per X), and a quote function for the
/// net swap (xForY, amountIn) -> amountOut (the bin pool's exact twin, or the program's simulation).
async function clearing({ totals, price, quote }) {
  const [ta, tb] = totals.map(BigInt); price = BigInt(price); const valueA = (ta * price) >> 128n;
  if (valueA >= tb) { let matchedX = (tb * Q128) / price; if (matchedX > ta) matchedX = ta; const net = ta - matchedX; const out = net > 0n ? BigInt(await quote(true, net)) : 0n;
    return { xForY: true, netIn: net, netOut: out, num: [tb + out, matchedX], den: [ta, tb], matched: [matchedX, tb] }; }
  const matchedY = valueA; const net = tb - matchedY; const out = BigInt(await quote(false, net));
  return { xForY: false, netIn: net, netOut: out, num: [matchedY, ta + out], den: [ta, tb], matched: [ta, matchedY] };
}
const claimOut = (amount, num, den, fee = 0n) => (BigInt(den) === 0n ? 0n : (BigInt(amount) * BigInt(num)) / BigInt(den) - BigInt(fee));

// ------------------------------------------------------------------------------------------------ accounts and instructions
const pt64 = (p) => (Buffer.isBuffer(p) || p instanceof Uint8Array ? Buffer.from(p) : J.enc(p));
const encParams = (p) => Buffer.concat([u64(p.epochSlots), u64(p.settleTimeout), u64(p.minIn[0]), u64(p.minIn[1]), u8(p.kMin), u8(p.maxRollovers), u16(p.maxDrift)]);

function decodeCommittee(data) { const r = new Reader(data.subarray(8)); const c = { authority: r.pk(), pendingAuthority: r.pk(), epoch: r.u32(), t: r.u8(), n: r.u8(), kind: r.u8(), bump: r.u8(), pk: J.dec(r.bytes(64)) };
  c.members = []; for (let i = 0; i < MAX_MEMBERS; i++) c.members.push(J.dec(r.bytes(64))); c.nodes = []; for (let i = 0; i < MAX_MEMBERS; i++) c.nodes.push(r.pk()); c.transcript = r.bytes(32);
  c.members = c.members.slice(0, c.n); c.nodes = c.nodes.slice(0, c.n); return c; }
function decodeSealed(data) { const r = new Reader(data.subarray(8)); return { binPool: r.pk(), mintX: r.pk(), mintY: r.pk(), seq: r.u64(), epochSlots: r.u64(), settleTimeout: r.u64(), minIn: [r.u64(), r.u64()], kMin: r.u8(), maxRollovers: r.u8(), maxDrift: r.u16(), paused: r.u8() === 1 }; }
function decodeBatch(data) { const r = new Reader(data.subarray(8));
  const b = { binPool: r.pk(), key: r.be32(), seq: r.u64(), startSlot: r.u64(), endSlot: r.u64(), closedSlot: r.u64(), settledSlot: r.u64(), totals: [r.u64(), r.u64()], num: [r.u64(), r.u64()], den: [r.u64(), r.u64()], netIn: r.u64(), netOut: r.u64(),
    count: [r.u32(), r.u32()], claims: [r.u32(), r.u32()], committeeEpoch: r.u32(), activeAtClose: r.i32(), settleId: r.i32(), stateCode: r.u8(), rollovers: r.u8(), verified: r.u8(), totalsOk: r.u8(), xForY: r.u8() === 1 };
  r.skip(7); r.skip(4 * 4 * 9 * 4); b.aggregates = [0, 1, 2, 3].map(() => J.dec(r.bytes(64))); b.shares = []; for (let i = 0; i < MAX_MEMBERS; i++) b.shares.push([J.dec(r.bytes(64)), J.dec(r.bytes(64))]);
  b.state = STATE[b.stateCode]; return b; }

function install(Veyl) {
  const P_ = Veyl.prototype;
  P_.committeePda = function () { return this.pda([Buffer.from('committee')], this.programs.entry); };
  P_.sealedPda = function (binPool) { return this.pda([Buffer.from('sealed'), pk(binPool)], this.programs.entry); };
  P_.batchPda = function (binPool, seq) { return this.pda([Buffer.from('batch'), pk(binPool), u64(seq)], this.programs.entry); };
  P_.shareJobPda = function (batch, member) { return this.pda([Buffer.from('sharejob'), pk(batch), u8(member)], this.programs.entry); };
  P_.committee = async function () { const a = await this.conn.getAccountInfo(this.committeePda()); return a ? decodeCommittee(a.data) : null; };
  P_.sealed = async function (binPool) { const a = await this.conn.getAccountInfo(this.sealedPda(binPool)); return a ? decodeSealed(a.data) : null; };
  P_.batch = async function (binPool, seq) { const addr = this.batchPda(binPool, seq); const a = await this.conn.getAccountInfo(addr); return a ? { address: addr, ...decodeBatch(a.data) } : null; };
  /// The pool's current batch with its settings, and the slot now (for the countdown).
  P_.sealedState = async function (binPool) { const s = await this.sealed(binPool); if (!s) return null; const b = await this.batch(binPool, s.seq); const slot = await this.conn.getSlot('confirmed'); return { sealed: s, batch: b, slot }; };

  // ---- committee and settings (authorities)
  P_.initCommitteeIx = function (authority) { return this.entryIx('init_committee', Buffer.alloc(0), [W(authority, true), R(this.programs.entry), R(this.programDataPda(this.programs.entry)), W(this.committeePda()), R(SYS)]); };
  P_.setCommitteeIx = function (authority, c) { return this.entryIx('set_committee', Buffer.concat([u8(c.t), u8(c.n), u8(c.kind || 0), pt64(c.pk), vec(c.members, pt64), vec(c.nodes, (x) => pk(x)), Buffer.from(c.transcript || Buffer.alloc(32))]), [R(authority, true), W(this.committeePda())]); };
  P_.committeeAuthorityIx = function (name, signer, next) { return this.entryIx(name, next ? pk(next) : Buffer.alloc(0), [R(signer, true), W(this.committeePda())]); };
  P_.initSealedPoolIx = function (authority, binPool, params) { return this.entryIx('init_sealed_pool', encParams(params), [W(authority, true), R(this.committeePda()), R(binPool), W(this.sealedPda(binPool)), W(this.batchPda(binPool, 0)), R(SYS)]); };
  P_.setSealedParamsIx = function (authority, binPool, params, paused = false) { return this.entryIx('set_sealed_params', Buffer.concat([encParams(params), u8(paused ? 1 : 0)]), [R(authority, true), R(this.committeePda()), W(this.sealedPda(binPool))]); };

  // ---- the batch lifecycle
  /// submit_swap: { binPool, seq, direction, mintIn, c1, c2, ext: { relayer, fee, encChange, encSwap }, pubs, poster }
  P_.submitSwapIx = async function (relayer, r) { const tp = await this.tokenProgram(r.mintIn); const none = R(this.programs.entry);
    return this.entryIx('submit_swap', Buffer.concat([u8(r.direction), pt64(r.c1), pt64(r.c2), encodeSwapExt(r.ext)]), [W(relayer, true), R(this.entryPda()), R(this.signerPda()), R(this.sealedPda(r.binPool)), W(this.batchPda(r.binPool, r.seq)), R(this.committeePda()),
      W(this.shieldPda()), W(this.proofPda(KIND.SWAP, r.pubs)), W(r.poster), W(this.nullifierPda(r.pubs[1])), W(this.nullifierPda(r.pubs[2])), R(r.mintIn), W(this.shieldVault(r.mintIn, tp)), BigInt(r.ext.fee || 0n) > 0n ? W(r.ext.relayer) : none, R(tp), R(this.programs.pool), R(SYS)]); };
  P_.closeBatchIx = function (payer, binPool, seq) { return this.entryIx('close_batch', Buffer.alloc(0), [W(payer, true), W(this.sealedPda(binPool)), W(this.batchPda(binPool, seq)), W(this.batchPda(binPool, BigInt(seq) + 1n)), R(binPool), R(this.committeePda()), R(SYS)]); };
  /// post_share: share = { index, Da, Db, A, Ba, Bb, s } (sdk/bjj.js partialDecrypt)
  P_.postShareIx = function (node, batch, share) { return this.entryIx('post_share', Buffer.concat([u8(share.index), ...[share.Da, share.Db, share.A, share.Ba, share.Bb].map(pt64), be32(share.s)]), [W(node, true), R(this.committeePda()), W(batch), W(this.shareJobPda(batch, share.index)), R(SYS)]); };
  P_.shareStepIx = function (cranker, batch, member, node) { return this.entryIx('share_step', Buffer.alloc(0), [R(cranker, true), R(this.committeePda()), W(batch), W(this.shareJobPda(batch, member)), W(node)]); };
  P_.cancelShareIx = function (node, batch, member) { return this.entryIx('cancel_share', Buffer.alloc(0), [W(node, true), W(this.shareJobPda(batch, member))]); };
  P_.settleVerifyIx = function (batch, direction, total) { return this.entryIx('settle_verify', Buffer.concat([u8(direction), u64(total)]), [R(this.committeePda()), W(batch)]); };
  /// settle_batch: the bin arrays the net swap may cross are passed (both directions' paths from the active bin).
  P_.settleBatchIx = async function (payer, binPool, seq, chunks = null) { const p = await this.binPool(binPool); const signer = this.signerPda(); const shield = this.shieldPda();
    const ch = chunks || [...new Set([...V_.chunksForSwap(p, true), ...V_.chunksForSwap(p, false)])];
    return this.entryIx('settle_batch', Buffer.alloc(0), [W(payer, true), R(this.entryPda()), R(signer), R(this.sealedPda(binPool)), W(this.batchPda(binPool, seq)), W(binPool), R(p.mintX), R(p.mintY), W(p.vaultX), W(p.vaultY),
      W(this.ata(p.mintX, signer, p.tokenProgramX)), W(this.ata(p.mintY, signer, p.tokenProgramY)), R(shield), W(this.ata(p.mintX, shield, p.tokenProgramX)), W(this.ata(p.mintY, shield, p.tokenProgramY)), R(p.tokenProgramX), R(p.tokenProgramY), R(this.programs.pool), R(this.programs.bin),
      ...ch.map((c) => W(this.binArrayPda(binPool, c)))]); };
  P_.failBatchIx = function (binPool, seq) { return this.entryIx('fail_batch', Buffer.alloc(0), [R(this.sealedPda(binPool)), W(this.batchPda(binPool, seq))]); };
  /// claim_swap: { binPool, seq, direction, mintOut, ext: { relayer, fee, encOut }, pubs, poster }
  P_.claimSwapIx = async function (relayer, r) { const tp = await this.tokenProgram(r.mintOut); const none = R(this.programs.entry);
    return this.entryIx('claim_swap', Buffer.concat([u8(r.direction), encodeClaimExt(r.ext)]), [W(relayer, true), R(this.entryPda()), R(this.signerPda()), R(this.sealedPda(r.binPool)), W(this.batchPda(r.binPool, r.seq)), W(this.shieldPda()),
      W(this.proofPda(KIND.CLAIM, r.pubs)), W(r.poster), W(this.nullifierPda(r.pubs[1])), R(r.mintOut), W(this.shieldVault(r.mintOut, tp)), BigInt(r.ext.fee || 0n) > 0n ? W(r.ext.relayer) : none, R(tp), R(this.programs.pool), R(SYS)]); };
  /// What a claim in this batch gets right now: { refund, mintOut, num, den } (null while the batch is open or awaiting
  /// settlement within its window).
  P_.claimTerms = async function (binPool, seq, direction) { const s = await this.sealed(binPool); const b = await this.batch(binPool, seq); if (!s || !b) return null;
    const slot = await this.conn.getSlot('confirmed'); const mintIn = direction === 0 ? s.mintX : s.mintY, mintOther = direction === 0 ? s.mintY : s.mintX;
    if (b.state === 'settled') return b.den[direction] > 0n ? { refund: false, mintOut: mintOther, num: b.num[direction], den: b.den[direction], batch: b } : null;
    if (b.state === 'failed' || (b.state === 'closed' && BigInt(slot) > b.closedSlot + s.settleTimeout)) return { refund: true, mintOut: mintIn, num: 1n, den: 1n, batch: b };
    return null; };
}
install(V_.Veyl);

// ------------------------------------------------------------------------------------------------ the wallet's requests
/// A sealed swap request from a ShieldWallet: spends notes of the token sold (amount + the relayer's flat fee), returns the
/// change, creates the swap commitment (owned by the wallet's spending key) and its encrypted opening, encrypts the amount
/// to the committee key. Returns the circuit input and everything the relayer needs.
function sealedSwapRequest(w, { binPool, seq, direction, mintIn, amount, fee = 0n, minIn, PK, relayerToken = Z.DEFAULT_KEY }) {
  const need = BigInt(amount) + BigInt(fee); const ins = w.select(mintIn, need); if (!ins) throw new Error(w.balance(mintIn) >= need ? 'merge notes first' : 'not enough shielded balance');
  const have = ins.reduce((s, n) => s + BigInt(n.amount), 0n); const change = w._note(mintIn, have - need);
  const blinding = randField(); const key = batchKey(binPool, seq);
  const encSwap = Z.seal(w.k.viewPublic, Z.encodeNote({ kind: Z.NOTE.SWAP, binPool, seq: BigInt(seq), direction, amount: BigInt(amount), blinding }));
  const ext = { relayer: new PublicKey(relayerToken), fee: BigInt(fee), encChange: change.enc, encSwap };
  const t = swapInput({ tree: w.tree, asset: Z.assetOf(mintIn), ins: ins.map((n) => ({ amount: BigInt(n.amount), sk: n.sk, blinding: BigInt(n.blinding), index: n.index })), change, amount, direction, swapPk: w.k.pk, swapBlinding: blinding, fee, minIn, PK, key, ext, sk: w.k.sk });
  return { ...t, ext, spent: ins, swap: { binPool: new PublicKey(binPool).toBase58(), seq: BigInt(seq), direction, amount: BigInt(amount), blinding, batchKey: key, commitment: t.swapCommitment } };
}
/// A claim (or refund) request for one of the wallet's sealed swaps, given the batch's terms (V.claimTerms).
function sealedClaimRequest(w, { swap, terms, fee = 0n, relayerToken = Z.DEFAULT_KEY }) {
  const mintOut = new PublicKey(terms.mintOut).toBase58(); const value = claimOut(swap.amount, terms.num, terms.den, fee);
  const out = w._note(mintOut, value); const ext = { relayer: new PublicKey(relayerToken), fee: BigInt(fee), encOut: out.enc };
  const t = claimInput({ tree: w.tree, sk: swap.sk || w.k.sk, swap, assetOut: Z.assetOf(mintOut), num: terms.num, den: terms.den, fee, out, ext });
  return { ...t, ext, mintOut, out }; }

module.exports = { KIND, STATE, MAX_MEMBERS, AMOUNT_LIMIT, MAX_PER_DIRECTION, batchKey, swapCommitment, swapBundle, claimBundle, encodeSwapExt, encodeClaimExt, swapExtHash, claimExtHash,
  swapInput, claimInput, clearing, claimOut, decodeCommittee, decodeSealed, decodeBatch, encParams, install, sealedSwapRequest, sealedClaimRequest };
