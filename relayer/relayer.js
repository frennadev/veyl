// Veyl relayer for Solana. Submits proofs so the user's wallet never touches the transaction.
// It cannot steal or redirect anything (recipient, fee, route and deadline are hashed into the proof's context, and
// the pool program checks them), but it CAN see the request IP, so this server never logs IPs and only keeps a
// rate-limit counter in memory.
//
//   GET  /info                 relayer wallet, fee range, programs, lookup table
//   GET  /state?pool=<pubkey>  the pool's leaves (tree order) and approved labels, for building proofs
//   GET  /pools                bin pools with their current state (quotes are computed on the device)
//   POST /fee                  { kind, d, mint | legs, value }  -> { feeBps } that covers this relayer's cost for the request
//   POST /drip                 { to } devnet/local test tokens from the mock mints (FAUCET_KEY = the deployer, the mints' authority); never on mainnet
//   GET  /shield               Phase 2: the shielded tree (leaves in order), encrypted notes, receipts and pending deposits
//   POST /submit               { kind: relay | swap | add | remove | claim | reward | order | orderWithdraw | rebalance | zap, ... }
//                              Phase 2 (shielded pool): transact | shieldLp | shieldSwap | shieldOrder | shieldOrderWithdraw |
//                              migrate: proofs ({ proof, pubs } each) + the external data / request they commit to; the relayer
//                              posts every proof, uploads the request, and executes it. Fees are flat amounts inside the
//                              proofs (a percentage of a hidden amount would reveal it).
//                              -> { txs: [...signatures] }. Proof-bound kinds (relay, swap, add, order, zap) carry `p` (or
//                              legs[].p); kinds signed by a position's one-time key (remove, claim, reward, orderWithdraw,
//                              rebalance) carry `sig` (ed25519 over the action's digest). Same fee range and cost floor for all.
//
// Phase 3 (sealed batch swaps): POST /submit { kind: sealedSwap | sealedClaim, ... } executes a swap proof into the pool's
// current batch (or a claim / refund out of a finished one). A sealed request carries only ciphertexts and commitments: the
// relayer never learns an amount. GET /sealed?pool=<bin pool> is the pool's current batch (countdown, participants per
// direction, state, the last settled batch's public totals). It also cranks every sealed pool (close a batch whose epoch is
// over, fail one past its settlement window): anyone may, these are permissionless.
//
// It also runs the approved-set publisher ("postman") when POSTMAN_KEY is set: every 30 s it rebuilds the approved
// label tree from the chain's Deposited events, screens each deposit (relayer/denylist.json), and publishes the root; and
// for the shielded pool it admits each pending deposit whose depositor passes the same screening (approve_deposit).
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { Connection, Keypair, PublicKey, ComputeBudgetProgram } = require('@solana/web3.js');
/// A shielded liquidity action needs more than the default 32 KB heap (veyl_entry's allocator allows 256 KB when asked).
const HEAP = () => ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 });
const spl = require('@solana/spl-token');
const S = require('../sdk/veyl.js'); const { Veyl, merklePath, ASP_DEPTH, STATE_DEPTH, encodeAction, contextOf, big, j, SIZES, rentOf } = S;
const Z = require('../sdk/shield.js');
const VERSION = require('../package.json').version;
const LOW_BALANCE_LAMPORTS = Number(process.env.LOW_BALANCE_SOL || 0.05) * 1e9;
const TX_FEE = 5000; // lamports per signature (the relayer signs every transaction alone)
/// What each kind of request leaves the relayer paying at most, in lamports (rent it never gets back + fees). Published in
/// /info so the app can pick a fee that covers it; /submit checks the exact cost of each request (REVIEW.md M-1).
const WORST = {
  relay: rentOf(SIZES.spend) + rentOf(SIZES.tokenAccount) + 2 * TX_FEE,                                             // spent marker + recipient token account
  swap: rentOf(SIZES.spend) + Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + 2 * TX_FEE,       // + the output note's record (or a token account)
  add: rentOf(SIZES.spend) + rentOf(SIZES.shares) + 3 * TX_FEE,                                                      // per leg + one share account
  remove: rentOf(SIZES.nonce) + 2 * Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + TX_FEE,    // nonce + two output records
  claim: rentOf(SIZES.nonce) + 2 * Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + TX_FEE,     // as remove
  orderWithdraw: rentOf(SIZES.nonce) + 2 * Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + TX_FEE,
  reward: rentOf(SIZES.nonce) + Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + TX_FEE,         // one output
  order: rentOf(SIZES.spend) + rentOf(SIZES.shares) + rentOf(SIZES.binArray) + 3 * TX_FEE,                           // spend + share account + bin array
  zap: rentOf(SIZES.spend) + 2 * (rentOf(SIZES.shares) + rentOf(SIZES.binArray)) + 3 * TX_FEE,                       // up to two new chunks
  rebalance: rentOf(SIZES.nonce) + 2 * (rentOf(SIZES.shares) + rentOf(SIZES.binArray)) + 2 * Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + 2 * TX_FEE,
  // Phase 2: a nullifier PDA (rent never returned) per spent note; posted proofs and request buffers are refunded on execution
  transact: 2 * rentOf(0) + rentOf(SIZES.tokenAccount) + 2 * TX_FEE,
  shieldSwap: 2 * rentOf(0) + 5 * TX_FEE,
  shieldOrder: 2 * rentOf(0) + rentOf(SIZES.shares) + rentOf(SIZES.binArray) + 5 * TX_FEE,
  shieldOrderWithdraw: 2 * rentOf(0) + 5 * TX_FEE,
  shieldLp: 5 * rentOf(0) + 2 * (rentOf(SIZES.shares) + rentOf(SIZES.binArray) + rentOf(SIZES.lpAcc)) + 8 * TX_FEE,
  migrate: rentOf(SIZES.spend) + 2 * TX_FEE,
  // Phase 3: two nullifiers (a swap) / one (a claim); the posted proof's rent comes back on execution
  sealedSwap: 2 * rentOf(0) + 2 * TX_FEE,
  sealedClaim: rentOf(0) + 2 * TX_FEE,
};
const SIGNED = new Set(['remove', 'claim', 'reward', 'orderWithdraw', 'rebalance']);
const SHIELD_KINDS = new Set(['transact', 'shieldLp', 'shieldSwap', 'shieldOrder', 'shieldOrderWithdraw', 'migrate', 'sealedSwap', 'sealedClaim']);
const SE = require('../sdk/sealed.js');
const PROOF_LEGS = new Set(['add', 'order', 'zap']);
/// USD prices for the fee floor: deploy.<network>.json token prices, overridden by PRICES_JSON='{"SOL":150,"USDC":1}'.
function pricesFrom(dep, env = process.env) { const out = {}; for (const [sym, t] of Object.entries(dep.tokens || {})) if (typeof t.price === 'number' && t.price > 0) out[sym] = t.price;
  if (env.PRICES_JSON) Object.assign(out, JSON.parse(env.PRICES_JSON)); return out; }

/// Numbers sent as decimal strings back to BigInt. The default public key ("111...1", 32 ones) is all digits too: kept as is.
const DEFAULT_B58 = '11111111111111111111111111111111';
function deepBig(o) { if (Array.isArray(o)) return o.map(deepBig); if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deepBig(v)])); return o === DEFAULT_B58 ? o : big(o); }
const loadDeny = () => { try { return new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'denylist.json'), 'utf8'))); } catch { return new Set(); } };
/// Deposit screening shared by the publisher and /state. Addresses to refuse (stolen funds, sanctioned) go in denylist.json.
function isAllowed(d) { const deny = loadDeny(); return !deny.has(String(d.payer)) && !deny.has(String(d.beneficiary)); }

class Relayer {
  constructor({ connection, wallet, deploy, minFeeBps = 5, maxFeeBps = S.MAX_FEE_BPS, postman = null, prices = null, feeCover = 1 }) {
    this.conn = connection; this.wallet = wallet; this.dep = deploy; this.minFeeBps = minFeeBps; this.maxFeeBps = maxFeeBps; this.postman = postman;
    this.prices = prices || pricesFrom(deploy); this.feeCover = feeCover;
    this.symOf = Object.fromEntries(Object.entries(deploy.tokens).map(([sym, t]) => [new PublicKey(t.mint).toBase58(), { sym, decimals: t.decimals }]));
    this.V = new Veyl({ connection, programs: deploy.programs, payer: wallet }); this.V.lookupTable = deploy.lookupTable ? new PublicKey(deploy.lookupTable) : null; this.V.lookupExtra = (deploy.lookupTables || []).map((t) => new PublicKey(t));
    this.pools = Object.values(deploy.tokens).map((t) => ({ mint: new PublicKey(t.mint), pool: new PublicKey(t.pool), decimals: t.decimals }));
    this.cache = new Map(); // pool -> { at, leaves, labels, deposits }
  }
  info() { return { faucet: !!this.faucet, address: this.wallet.publicKey.toBase58(), minFeeBps: this.minFeeBps, maxFeeBps: this.maxFeeBps, minFee: this.minFeeTable(), programs: this.dep.programs, lookupTable: this.dep.lookupTable, entrySigner: this.V.signerPda().toBase58(), network: this.dep.network, postman: this.postman ? this.postman.publicKey.toBase58() : this.dep.postman, kinds: Object.keys(WORST), signedKinds: [...SIGNED] }; }
  // ---- the fee floor: the fee must at least pay back what the request costs the relayer (rent it never recovers + fees)
  /// Lamports -> atoms of `sym` at the configured prices (x feeCover, rounded up); 0n when a price is missing (no floor).
  atomsFor(lamports, sym) { const sol = this.prices.SOL, px = this.prices[sym], t = this.dep.tokens[sym]; if (!sol || !px || !t) return 0n;
    return BigInt(Math.ceil((lamports / 1e9) * (sol / px) * 10 ** t.decimals * this.feeCover)); }
  /// Per kind and token: the smallest fee in atoms that covers the worst case (what the app uses to pick feeBps).
  minFeeTable() { const out = {}; for (const [kind, lam] of Object.entries(WORST)) { out[kind] = {}; for (const sym of Object.keys(this.dep.tokens)) out[kind][sym] = this.atomsFor(lam, sym).toString(); } return out; }
  /// parts: [{ sym, atoms }] fees paid in each token; refuses unless together they cover `lamports`.
  _coverOrRefuse(lamports, parts) {
    if (parts.some((x) => this.atomsFor(1e9, x.sym) === 0n)) return; // no price for one of the tokens: no floor
    const covered = parts.reduce((acc, x) => acc + Number(x.atoms) / Number(this.atomsFor(lamports, x.sym)), 0);
    if (covered + 1e-12 < 1) { const need = parts.map((x) => `${this.atomsFor(lamports, x.sym)} ${x.sym} atoms`).join(' or ');
      throw new Error(`fee too low for this relayer: it pays ${(lamports / 1e9).toFixed(6)} SOL for this request (rent + fees); the fee must be worth at least ${need}`); }
  }
  async _missing(addrs) { const infos = await this.conn.getMultipleAccountsInfo(addrs.map((a) => new PublicKey(a))); return infos.filter((x) => !x).length; }
  /// What this exact request costs the relayer, in lamports.
  async costOf(kind, req) { const V = this.V; const d = req.d; let lam = 0;
    if (kind === 'relay') { lam = rentOf(SIZES.spend) + 2 * TX_FEE + (await this._missing([V.ata(new PublicKey(req.mint), d.recipient)])) * rentOf(SIZES.tokenAccount); }
    else if (kind === 'swap') { lam = rentOf(SIZES.spend) + 2 * TX_FEE + (d.recipient ? (await this._missing([V.ata(new PublicKey(d.tokenOut), d.recipient)])) * rentOf(SIZES.tokenAccount) : rentOf(SIZES.depositRecord)); }
    else if (kind === 'add') { const pool = new PublicKey(d.binPool); const chunks = [...new Set(d.ids.map(S.chunkOf))]; const EP = V.signerPda();
      const newArrays = await this._missing(chunks.map((c) => V.binArrayPda(pool, c))), newShares = await this._missing(chunks.map((c) => V.sharesPda(pool, d.owner, EP, c)));
      lam = req.legs.length * (rentOf(SIZES.spend) + TX_FEE) + newArrays * rentOf(SIZES.binArray) + newShares * rentOf(SIZES.shares) + (newArrays + newShares ? TX_FEE : 0) + TX_FEE; }
    else if (kind === 'remove' || kind === 'claim' || kind === 'orderWithdraw') { const bp = await V.binPool(d.binPool);
      lam = TX_FEE + (await this._missing([V.noncePda(d.owner)])) * rentOf(SIZES.nonce) + (d.recipient ? (await this._missing([V.ata(bp.mintX, d.recipient), V.ata(bp.mintY, d.recipient)])) * rentOf(SIZES.tokenAccount) : 2 * rentOf(SIZES.depositRecord)); }
    else if (kind === 'reward') { const bp = await V.binPool(d.binPool); const r = bp.rewards[Number(d.index)]; if (!r || !r.initialized) throw new Error('no such reward');
      lam = TX_FEE + (await this._missing([V.noncePda(d.owner)])) * rentOf(SIZES.nonce) + (d.recipient ? (await this._missing([V.ata(r.mint, d.recipient, r.tokenProgram)])) * rentOf(SIZES.tokenAccount) : rentOf(SIZES.depositRecord)); }
    else if (kind === 'order' || kind === 'zap' || kind === 'rebalance') { const pool = new PublicKey(d.binPool); const ids = kind === 'order' ? [d.id] : d.ids; const chunks = [...new Set(ids.map(S.chunkOf))]; const EP = V.signerPda();
      const newArrays = await this._missing(chunks.map((c) => V.binArrayPda(pool, c))), newShares = await this._missing(chunks.map((c) => V.sharesPda(pool, d.owner, EP, c)));
      lam = newArrays * rentOf(SIZES.binArray) + newShares * rentOf(SIZES.shares) + (newArrays + newShares ? TX_FEE : 0) + TX_FEE;
      if (kind === 'rebalance') { const noW = (w) => !w.some((x) => Number(x) > 0); lam += (await this._missing([V.noncePda(d.owner)])) * rentOf(SIZES.nonce) + (noW(d.weightsX) || noW(d.weightsY) ? 2 * Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) : 0); }
      else lam += req.legs.length * (rentOf(SIZES.spend) + TX_FEE); }
    return lam; }
  poolFor(pool) { const p = this.pools.find((x) => x.pool.equals(new PublicKey(pool))); if (!p) throw new Error('unknown pool'); return p; }
  /// Leaves + approved labels, read from the chain (cached 5 s).
  async state(pool) {
    const k = new PublicKey(pool).toBase58(); const c = this.cache.get(k); if (c && Date.now() - c.at < 5000) return c;
    this.poolFor(pool); const { leaves, deposits } = await this.V.readTree(pool);
    const labels = deposits.filter(isAllowed).map((d) => d.label);
    const st = { at: Date.now(), leaves, labels, deposits: deposits.map((d) => ({ label: d.label, index: d.index, value: d.value, precommitment: d.precommitment, beneficiary: d.beneficiary.toBase58() })) };
    this.cache.set(k, st); return st;
  }
  _checkCommon(d) {
    if (new PublicKey(d.feeRecipient).toBase58() !== this.wallet.publicKey.toBase58()) throw new Error('fee must go to this relayer');
    if (Number(d.feeBps) < this.minFeeBps || Number(d.feeBps) > this.maxFeeBps) throw new Error('fee out of range');
    const now = Math.floor(Date.now() / 1000); if (Number(d.deadline) < now) throw new Error('expired'); if (Number(d.deadline) > now + 3600) throw new Error('deadline too far');
  }
  _checkProof(p) { const proof = Buffer.from(p.proof, 'base64'); if (proof.length !== 256) throw new Error('bad proof'); const pubs = p.pubs.map(BigInt); if (pubs.length !== 6) throw new Error('bad public signals'); return { proof, pubs }; }
  /// The amounts a request's fee is taken from: [{ sym, atoms }] (the withdrawn values, or a removal's expected proceeds).
  async _feeBase(kind, req, fromProof = true) { const d = req.d; const symOf = (mint) => { const t = this.symOf[new PublicKey(mint).toBase58()]; if (!t) throw new Error('unknown token'); return t.sym; };
    const val = (x) => (fromProof ? this._checkProof(x.p).pubs[2] : BigInt(x.value));
    if (kind === 'relay' || kind === 'swap') return [{ sym: symOf(req.mint), atoms: val(req) }];
    if (PROOF_LEGS.has(kind)) return req.legs.map((l) => ({ sym: symOf(l.mint), atoms: val(l) }));
    if (kind === 'claim') { const bp = await this.V.binPool(d.binPool); const pos = await this.V.position(d.binPool, d.owner, this.V.signerPda(), d.ids); return [{ sym: symOf(bp.mintX), atoms: pos.fees.x }, { sym: symOf(bp.mintY), atoms: pos.fees.y }]; }
    if (kind === 'reward') { const bp = await this.V.binPool(d.binPool); const pos = await this.V.position(d.binPool, d.owner, this.V.signerPda(), d.ids); return [{ sym: symOf(bp.rewards[Number(d.index)].mint), atoms: pos.rewards[Number(d.index)] }]; }
    if (kind === 'orderWithdraw') { const bp = await this.V.binPool(d.binPool); const pos = await this.V.position(d.binPool, d.owner, this.V.signerPda(), [d.id]); const o = pos.orders.find((x) => x.id === Number(d.id) && x.isAsk === !!d.isAsk); if (!o) throw new Error('no such order');
      const part = (v) => (v * BigInt(d.shares)) / o.shares; const [ux, fy] = d.isAsk ? [part(o.unfilledX), part(o.filledY)] : [part(o.filledX), part(o.unfilledY)];
      return [{ sym: symOf(bp.mintX), atoms: ux }, { sym: symOf(bp.mintY), atoms: fy }]; }
    if (kind === 'rebalance') { const V = this.V; const bp = await V.binPool(d.binPool); const bins = await V.bins(new PublicKey(d.binPool), [...new Set(d.burnIds.map(S.chunkOf))]); let x = 0n, y = 0n;
      d.burnIds.forEach((id, i) => { const v = V.valueOf(bins.get(id), d.burnShares[i]); x += v.x; y += v.y; }); return [{ sym: symOf(bp.mintX), atoms: x }, { sym: symOf(bp.mintY), atoms: y }]; }
    if (kind === 'remove') { const V = this.V; const bp = await V.binPool(d.binPool); const bins = await V.bins(new PublicKey(d.binPool), [...new Set(d.ids.map(S.chunkOf))]); let x = 0n, y = 0n;
      d.ids.forEach((id, i) => { const v = V.valueOf(bins.get(id), d.shares[i]); x += v.x; y += v.y; }); return [{ sym: symOf(bp.mintX), atoms: x }, { sym: symOf(bp.mintY), atoms: y }]; }
    throw new Error('unknown kind'); }
  /// Refuse requests whose fee does not cover what they cost the relayer (REVIEW.md M-1).
  async checkFee(kind, req) { const bps = BigInt(req.d.feeBps); const lam = await this.costOf(kind, req);
    this._coverOrRefuse(lam, (await this._feeBase(kind, req)).map((x) => ({ sym: x.sym, atoms: (x.atoms * bps) / 10_000n }))); }
  /// POST /fee { kind, d, mint | legs: [{ mint, value }], value }: the fee (bps) this relayer will accept for that request.
  async feeQuote(req) { req = deepBig(req); const kind = req.kind; if (!WORST[kind]) throw new Error('unknown kind'); if (SHIELD_KINDS.has(kind) && kind !== 'migrate') return this.shieldFeeQuote(req);
    const lam = await this.costOf(kind, req); const base = await this._feeBase(kind, req, false);
    if (base.some((x) => this.atomsFor(1e9, x.sym) === 0n)) return { feeBps: this.minFeeBps, costLamports: lam };
    const cover = base.reduce((a, x) => a + Number(x.atoms) / Number(this.atomsFor(lam, x.sym)), 0);
    let bps = this.minFeeBps; if (cover <= 0) throw new Error('nothing to pay the relayer fee from');
    const need = Math.ceil(10_000 / cover); if (need > bps) bps = need + 1; // +1: fees are rounded down on chain
    if (bps > this.maxFeeBps) throw new Error(`that amount is too small for this relayer: covering its cost (${(lam / 1e9).toFixed(4)} SOL in rent and fees) would take more than ${this.maxFeeBps / 100}%`);
    return { feeBps: bps, costLamports: lam }; }
  /// Every request: check it (fields, fee floor), dry-run it (a request that would fail costs the relayer nothing), then send.
  async submit(req) {
    req = deepBig(req); const me = this.wallet.publicKey; const V = this.V; const txs = []; const EP = V.signerPda();
    /// The post_withdrawal instruction for a proof: it must commit to exactly this request. A spend posted earlier for the
    /// same note and never executed is replaced (its poster refunded), so nobody can park a copy of a proof to block it.
    const postIx = async (poolMint, p, kind, d) => { const { proof, pubs } = this._checkProof(p); const pool = V.poolPda(poolMint); const ctx = contextOf(EP, encodeAction(kind, d), pool);
      if (pubs[5] !== ctx) throw new Error('proof context does not match the request');
      const st = await V.prevPosterOf(pool, pubs[1]); if (st.spent) throw new Error('this note is already spent');
      return { ix: V.postWithdrawalIx(me, pool, proof, pubs, EP, S.DEFAULT_TTL_SLOTS, st.prevPoster || me), nh: pubs[1] }; };
    const post = async (poolMint, p, kind, d) => { const { ix, nh } = await postIx(poolMint, p, kind, d); txs.push(await V.send([ix], [], 1_400_000)); return nh; };
    switch (req.kind) {
      case 'relay': { const d = req.d; this._checkCommon(d); const mint = new PublicKey(req.mint); this.poolFor(V.poolPda(mint)); await this.checkFee('relay', req);
        const { ix, nh } = await postIx(mint, req.p, 'relay', d);
        const exec = [spl.createAssociatedTokenAccountIdempotentInstruction(me, V.ata(mint, d.recipient), new PublicKey(d.recipient), mint), await V.relayIx(me, mint, nh, d)];
        // post + execute in ONE transaction: there is no moment where the posted proof sits on chain unexecuted
        let atomic = null; try { atomic = await V.sendV0([ix, ...exec], [], 1_400_000); } catch (e) { if (!/too large|overrun|RangeError|exceeds/i.test(String(e.message || e))) throw e; }
        if (atomic) txs.push(atomic); else { txs.push(await V.send([ix], [], 1_400_000)); txs.push(await this._exec(exec, nh, mint)); } break; }
      case 'swap': { const d = req.d; this._checkCommon(d); const mint = new PublicKey(req.mint); this.poolFor(V.poolPda(mint)); this.poolFor(V.poolPda(d.tokenOut)); await this.checkFee('swap', req);
        const nh = await post(mint, req.p, 'swap', d);
        const ixs = []; if (d.recipient) ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(me, V.ata(d.tokenOut, d.recipient), new PublicKey(d.recipient), new PublicKey(d.tokenOut)));
        ixs.push(await V.privateSwapIx(me, mint, nh, d)); txs.push(await this._exec(ixs, nh, mint)); break; }
      case 'add': { const d = req.d; this._checkCommon(d); if (!req.legs || req.legs.length < 1 || req.legs.length > 2) throw new Error('bad legs');
        if (!Array.isArray(d.minShares) || d.minShares.length !== d.ids.length) throw new Error('minShares must give a minimum for every bin');
        for (const l of req.legs) this.poolFor(V.poolPda(new PublicKey(l.mint))); await this.checkFee('add', req);
        const legs = []; for (const l of req.legs) { const mint = new PublicKey(l.mint); legs.push({ mint, nullifierHash: await post(mint, l.p, 'add', d) }); }
        const pre = await V.ensureBinAccountsIxs(me, d.binPool, d.ids, d.owner, EP); if (pre.length) txs.push(await V.send(pre, [], 200_000));
        try { txs.push(await V.sendV0([await V.privateAddIx(me, legs, d)], [], 1_400_000)); }
        catch (e) { for (const l of legs) await this._cancel(l.mint, l.nullifierHash); throw e; } break; }
      case 'remove': case 'claim': case 'reward': case 'orderWithdraw': case 'rebalance': {
        const kind = req.kind; const d = req.d; this._checkCommon(d); const sig = Buffer.from(req.sig, 'base64'); if (sig.length !== 64) throw new Error('bad signature');
        if (kind === 'rebalance' && (!Array.isArray(d.minShares) || d.minShares.length !== d.ids.length)) throw new Error('minShares must give a minimum for every bin');
        await this.checkFee(kind, req);
        if (kind === 'rebalance') { const pre = await V.ensureBinAccountsIxs(me, d.binPool, d.ids, d.owner, EP); if (pre.length) txs.push(await V.send(pre, [], 200_000)); }
        // the ed25519 instruction must come right before the action: token-account creation goes first (REVIEW.md L-1)
        const ixs = []; const bp = await V.binPool(d.binPool);
        if (d.recipient) { const outs = kind === 'reward' ? [[bp.rewards[Number(d.index)].mint, bp.rewards[Number(d.index)].tokenProgram]] : [[bp.mintX, bp.tokenProgramX], [bp.mintY, bp.tokenProgramY]];
          for (const [m, tp] of outs) ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(me, V.ata(m, d.recipient, tp), new PublicKey(d.recipient), m, tp)); }
        if (kind === 'reward') { const r = bp.rewards[Number(d.index)]; const fa = V.ata(r.mint, me, r.tokenProgram), ea = V.ata(r.mint, EP, r.tokenProgram);
          ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(me, fa, me, r.mint, r.tokenProgram), spl.createAssociatedTokenAccountIdempotentInstruction(me, ea, EP, r.mint, r.tokenProgram)); }
        const build = { remove: () => V.privateRemoveIx(me, d), claim: () => V.privateClaimFeesIx(me, d), reward: () => V.privateClaimRewardIx(me, d), orderWithdraw: () => V.privateWithdrawOrderIx(me, d), rebalance: () => V.privateRebalanceIx(me, d) }[kind];
        ixs.push(V.signedSigIx(kind, d.owner, sig, d), await build()); txs.push(await V.sendV0(ixs, [], 1_400_000)); break; }
      case 'order': case 'zap': { const kind = req.kind; const d = req.d; this._checkCommon(d); if (!req.legs || req.legs.length !== 1) throw new Error('one leg');
        const bp = await V.binPool(d.binPool); const want = kind === 'order' ? (d.isAsk ? bp.mintX : bp.mintY) : (d.xIn ? bp.mintX : bp.mintY);
        if (!new PublicKey(req.legs[0].mint).equals(want)) throw new Error('the leg must be ' + (kind === 'order' ? 'the order token' : 'the token zapped in'));
        if (kind === 'zap' && (!Array.isArray(d.minShares) || d.minShares.length !== d.ids.length)) throw new Error('minShares must give a minimum for every bin');
        if (kind === 'zap' && BigInt(d.swapAmount) > 0n && BigInt(d.minSwapOut) === 0n) throw new Error('a zap that swaps needs minSwapOut');
        this.poolFor(V.poolPda(want)); await this.checkFee(kind, req);
        const nh = await post(want, req.legs[0].p, kind, d);
        const pre = await V.ensureBinAccountsIxs(me, d.binPool, kind === 'order' ? [d.id] : d.ids, d.owner, EP); if (pre.length) txs.push(await V.send(pre, [], 200_000));
        const leg = { mint: want, nullifierHash: nh };
        txs.push(await this._exec([kind === 'order' ? await V.privatePlaceOrderIx(me, leg, d) : await V.privateZapIx(me, leg, d)], nh, want)); break; }
      default: if (SHIELD_KINDS.has(req.kind)) return this.submitShield(req); throw new Error('unknown kind');
    }
    this.cache.clear(); // the pool changed; the next /state must be fresh
    return { txs, txHash: txs[txs.length - 1] };
  }

  // ---------------------------------------------------------------------------------------------- Phase 2: the shielded pool
  _symOfMint(mint) { const t = this.symOf[new PublicKey(mint).toBase58()]; if (!t) throw new Error('unknown token'); return t.sym; }
  _feeAta(mint) { return this.V.ata(new PublicKey(mint), this.wallet.publicKey); }
  _checkDeadline(dl) { const now = Math.floor(Date.now() / 1000); if (Number(dl) < now) throw new Error('expired'); if (Number(dl) > now + 3600) throw new Error('deadline too far'); }
  _checkProof8(p) { const proof = Buffer.from(p.proof, 'base64'); if (proof.length !== 256) throw new Error('bad proof'); const pubs = p.pubs.map(BigInt); if (pubs.length !== 8) throw new Error('bad public signals'); return { proof, pubs }; }
  /// A leg / transact spend the relayer executes: its fee goes to this relayer's token account for the leg's token.
  _checkLeg(ext, processor) { if (!new PublicKey(ext.processor).equals(processor)) throw new Error('wrong processor in the external data');
    if (BigInt(ext.fee) > 0n && !new PublicKey(ext.relayer).equals(this._feeAta(ext.mint))) throw new Error('the fee must go to this relayer'); }
  /// What a Phase 2 request costs this relayer (rent it never recovers + transaction fees), in lamports.
  async shieldCost(kind, req) { const V = this.V; let lam = WORST[kind];
    if (kind === 'shieldOrder') { lam = 2 * rentOf(0) + 5 * TX_FEE; if (req.core && req.core.binPool !== undefined) { const pool = new PublicKey(req.core.binPool); const ch = S.chunkOf(Number(req.core.id));
      lam += (await this._missing([V.binArrayPda(pool, ch)])) * rentOf(SIZES.binArray) + (await this._missing([V.sharesPda(pool, V.shieldOwner(), V.signerPda(), ch)])) * rentOf(SIZES.shares); } }
    if (kind === 'transact') lam = 2 * rentOf(0) + 2 * TX_FEE + (req.recipientOwner && BigInt(req.ext.extAmount) < 0n ? (await this._missing([req.ext.recipient])) * rentOf(SIZES.tokenAccount) : 0);
    const nLegs = Array.isArray(req.legs) ? req.legs.length : Number(req.legs || 0);
    if (kind === 'shieldLp' && !req.core) lam = (1 + 2 * nLegs) * rentOf(0) + (4 + 2 * nLegs) * TX_FEE;
    if (kind === 'shieldLp' && req.core) { const c = req.core; const pool = new PublicKey(c.binPool); const chunks = [...new Set([S.chunkOf(Number(c.lo)), S.chunkOf(Number(c.lo) + Z.K - 1)])];
      const miss = (await this._missing(chunks.map((ch) => V.binArrayPda(pool, ch)))) * rentOf(SIZES.binArray) + (await this._missing(chunks.map((ch) => V.sharesPda(pool, V.shieldOwner(), V.signerPda(), ch)))) * rentOf(SIZES.shares) + (await this._missing(chunks.map((ch) => V.lpAccPda(pool, ch)))) * rentOf(SIZES.lpAcc);
      lam = (1 + 2 * nLegs) * rentOf(0) + miss + (4 + 2 * nLegs) * TX_FEE; }
    return lam; }
  /// The fee parts a Phase 2 request pays this relayer: [{ sym, atoms }].
  _shieldFees(kind, req) { const parts = []; const add = (mint, atoms) => { if (BigInt(atoms) > 0n) parts.push({ sym: this._symOfMint(mint), atoms: BigInt(atoms) }); };
    if (kind === 'transact') add(req.ext.mint, req.ext.fee);
    else if (kind === 'shieldSwap' || kind === 'shieldOrder') add(req.leg.ext.mint, req.leg.ext.fee);
    else if (kind === 'sealedSwap' || kind === 'sealedClaim') add(req.mint, req.ext.fee);
    else if (kind === 'shieldLp' || kind === 'shieldOrderWithdraw') { for (const l of req.legs || []) add(l.ext.mint, l.ext.fee); const mx = req.mintX, my = req.mintY;
      if (req.core.claimFee) { add(mx, req.core.claimFee[0]); add(my, req.core.claimFee[1]); } add(mx, req.core.leftoverFee[0]); add(my, req.core.leftoverFee[1]); }
    return parts; }
  /// POST /fee for a Phase 2 kind: { kind, mint, ... } -> the flat fee (atoms of `mint`) that covers this relayer's cost.
  async shieldFeeQuote(req) { const lam = await this.shieldCost(req.kind, req); const sym = this._symOfMint(req.mint); const atoms = this.atomsFor(lam, sym);
    return { fee: (atoms > 0n ? atoms : 0n).toString(), costLamports: lam, sym }; }
  async _post(kind, p, txs) { const V = this.V; const { proof, pubs } = this._checkProof8(p); const pda = V.proofPda(kind, pubs);
    if (!(await this.conn.getAccountInfo(pda))) txs.push(await V.send([V.postProofIx(this.wallet.publicKey, kind, proof, pubs)], [], 1_400_000));
    const posted = await V.posted(pda); if (!posted || posted.kind !== kind) throw new Error('proof not posted'); return { pubs, poster: posted.poster }; }
  async _cancelProofs(posts) { for (const x of posts) { try { if (x.poster.equals(this.wallet.publicKey)) await this.V.send([this.V.cancelProofIx(this.wallet.publicKey, x.kind, x.pubs, x.poster)], [], 100_000); } catch { /* best effort */ } } }
  /// Bin arrays, LpAcc growth accounts and the aggregate's share accounts a shielded action needs (created by the relayer).
  async _ensureLp(pool, ids, txs, withLpAcc = true) { const V = this.V; const me = this.wallet.publicKey; pool = new PublicKey(pool); const ixs = [];
    for (const ch of [...new Set(ids.map(S.chunkOf))]) {
      if (!(await this.conn.getAccountInfo(V.binArrayPda(pool, ch)))) ixs.push(V.initBinArrayIx(me, pool, ch));
      if (!(await this.conn.getAccountInfo(V.sharesPda(pool, V.shieldOwner(), V.signerPda(), ch)))) ixs.push(V.initSharesIx(me, pool, V.shieldOwner(), V.signerPda(), ch));
      if (withLpAcc && !(await this.conn.getAccountInfo(V.lpAccPda(pool, ch)))) ixs.push(V.initLpAccIx(me, pool, ch)); }
    for (let i = 0; i < ixs.length; i += 3) txs.push(await V.send(ixs.slice(i, i + 3), [], 400_000)); }
  async submitShield(req) {
    const V = this.V; const me = this.wallet.publicKey; const EP = V.signerPda(); const txs = []; const posts = []; const kind = req.kind; const T = Z.KIND.TRANSACT;
    const cover = async () => { const lam = await this.shieldCost(kind, req); this._coverOrRefuse(lam, this._shieldFees(kind, req).length ? this._shieldFees(kind, req) : [{ sym: 'SOL', atoms: 0n }]); };
    let bufId = null;
    try {
      switch (kind) {
        case 'transact': { const ext = req.ext; if (BigInt(ext.extAmount) > 0n) throw new Error('deposits are signed by the depositor');
          if (!new PublicKey(ext.processor).equals(PublicKey.default)) throw new Error('a relayed transact names no processor');
          this._checkLeg(ext, PublicKey.default); await cover();
          const x = await this._post(T, req.p, txs); posts.push({ kind: T, ...x });
          if (BigInt(Z.extHash(ext)) !== x.pubs[2]) throw new Error('proof does not match the external data');
          const pre = []; if (BigInt(ext.extAmount) < 0n) { const mint = new PublicKey(ext.mint); if (!req.recipientOwner) throw new Error('recipientOwner?'); if (!V.ata(mint, req.recipientOwner, await V.tokenProgram(mint)).equals(new PublicKey(ext.recipient))) throw new Error('recipient is not that wallet\'s token account');
            pre.push(spl.createAssociatedTokenAccountIdempotentInstruction(me, new PublicKey(ext.recipient), new PublicKey(req.recipientOwner), mint, await V.tokenProgram(mint))); }
          txs.push(await V.sendV0([...pre, await V.shieldTransactIx(me, ext, x.pubs, x.poster)], [], 600_000)); break; }
        case 'shieldLp': { const c = req.core; if (!new PublicKey(c.relayer).equals(me)) throw new Error('fees must go to this relayer'); this._checkDeadline(c.deadline);
          const bp = await V.binPool(c.binPool); req.mintX = bp.mintX; req.mintY = bp.mintY;
          for (const l of req.legs || []) this._checkLeg(l.ext, EP); await cover();
          const legs = []; for (const l of req.legs || []) { const x = await this._post(T, l.p, txs); posts.push({ kind: T, ...x }); legs.push(x); }
          const pos = await this._post(Z.KIND.POSITION, req.position, txs); posts.push({ kind: Z.KIND.POSITION, ...pos });
          const ids = []; for (let b = 0; b < Z.K; b++) ids.push(Number(c.lo) + b); await this._ensureLp(c.binPool, [...ids, bp.activeId], txs);
          const lpReq = { core: c, legs: (req.legs || []).map((l) => l.ext) }; bufId = await V.uploadBuffer(this.wallet, Z.encodeLpRequest(lpReq));
          txs.push(await V.sendV0([HEAP(), await V.shieldLpIx(me, bufId, lpReq, pos.pubs, pos.poster, legs)], [], 1_400_000)); bufId = null; break; }
        case 'shieldSwap': { const c = req.core; this._checkDeadline(c.deadline); this._checkLeg(req.leg.ext, EP); await cover();
          const x = await this._post(T, req.leg.p, txs); posts.push({ kind: T, ...x }); await V.prepareRoutes(c.routes);
          const r = { core: c, leg: req.leg.ext, legPubs: x.pubs }; bufId = await V.uploadBuffer(this.wallet, Buffer.concat([Z.encodeSwapCore(c), Z.encodeExt(req.leg.ext)]));
          txs.push(await V.sendV0([HEAP(), await V.shieldSwapIx(me, bufId, r, x.poster)], [], 1_400_000)); bufId = null; break; }
        case 'shieldOrder': case 'shieldOrderWithdraw': { const c = req.core; this._checkDeadline(c.deadline); if (kind === 'shieldOrder') this._checkLeg(req.leg.ext, EP);
          else { if (!new PublicKey(c.relayer).equals(me)) throw new Error('fees must go to this relayer'); const bp = await V.binPool(c.binPool); req.mintX = bp.mintX; req.mintY = bp.mintY; req.legs = []; }
          await cover(); const x = await this._post(T, req.leg.p, txs); posts.push({ kind: T, ...x }); await this._ensureLp(c.binPool, [Number(c.id)], txs, false);
          const enc = kind === 'shieldOrder' ? Z.encodeOrderCore(c) : Z.encodeOrderWithdrawCore(c); const r = { core: c, leg: req.leg.ext, legPubs: x.pubs };
          bufId = await V.uploadBuffer(this.wallet, Buffer.concat([enc, Z.encodeExt(req.leg.ext)]));
          txs.push(await V.sendV0([HEAP(), kind === 'shieldOrder' ? await V.shieldOrderIx(me, bufId, r, x.poster) : await V.shieldOrderWithdrawIx(me, bufId, r, x.poster)], [], 1_400_000)); bufId = null; break; }
        case 'migrate': { const d = req.d; this._checkCommon(d); const mint = new PublicKey(req.mint); const pool = V.poolPda(mint); this.poolFor(pool);
          const { proof, pubs } = this._checkProof(req.p); if (pubs[5] !== contextOf(EP, Buffer.concat([Buffer.from([Z.MIGRATE]), Z.encodeMigrate(d)]), pool)) throw new Error('proof context does not match the request');
          this._coverOrRefuse(WORST.migrate, [{ sym: this._symOfMint(mint), atoms: (pubs[2] * BigInt(d.feeBps)) / 10_000n }]);
          const st = await V.prevPosterOf(pool, pubs[1]); if (st.spent) throw new Error('this note is already spent');
          const post = V.postWithdrawalIx(me, pool, proof, pubs, EP, S.DEFAULT_TTL_SLOTS, st.prevPoster || me);
          txs.push(await V.send([post], [], 1_400_000));
          try { txs.push(await V.sendV0([await V.shieldMigrateIx(me, mint, pubs[1], d)], [], 1_400_000)); } catch (e) { await this._cancel(mint, pubs[1]); throw e; } break; }
        case 'sealedSwap': case 'sealedClaim': { const swap = kind === 'sealedSwap'; const pool = new PublicKey(req.binPool); const s = await V.sealed(pool); if (!s) throw new Error('no sealed swaps for this pool');
          const dir = Number(req.direction); if (dir !== 0 && dir !== 1) throw new Error('direction?');
          // the token the fee is paid in: the one sold (swap) or received (claim); it must reach this relayer's account
          if (swap) req.mint = dir === 0 ? s.mintX : s.mintY; else { const t = await V.claimTerms(pool, BigInt(req.seq), dir); if (!t) throw new Error('this batch is not settled or refundable yet'); req.mint = t.mintOut; }
          if (BigInt(req.ext.fee) > 0n && !new PublicKey(req.ext.relayer).equals(this._feeAta(req.mint))) throw new Error('the fee must go to this relayer');
          if (swap) { const b = await V.batch(pool, s.seq); if (!b || b.state !== 'open' || BigInt(req.seq) !== s.seq) throw new Error('that batch is not open any more: prove again for batch ' + s.seq); }
          await cover(); const x = await this._post(swap ? SE.KIND.SWAP : SE.KIND.CLAIM, req.p, txs); posts.push({ kind: swap ? SE.KIND.SWAP : SE.KIND.CLAIM, ...x });
          const ext = { relayer: new PublicKey(req.ext.relayer), fee: BigInt(req.ext.fee), encChange: Z.bytes(req.ext.encChange), encSwap: Z.bytes(req.ext.encSwap), encOut: Z.bytes(req.ext.encOut) };
          if ((swap ? SE.swapExtHash(ext) : SE.claimExtHash(ext)) !== x.pubs[swap ? 7 : 5]) throw new Error('proof does not match the external data');
          const ix = swap ? await V.submitSwapIx(me, { binPool: pool, seq: s.seq, direction: dir, mintIn: req.mint, c1: Z.bytes(req.c1), c2: Z.bytes(req.c2), ext, pubs: x.pubs, poster: x.poster })
            : await V.claimSwapIx(me, { binPool: pool, seq: BigInt(req.seq), direction: dir, mintOut: req.mint, ext, pubs: x.pubs, poster: x.poster });
          txs.push(await V.sendV0([ix], [], 600_000)); break; }
        default: throw new Error('unknown kind');
      }
    } catch (e) {
      if (bufId !== null) { try { await V.send([V.closeBufferIx(me, bufId)], [], 100_000); } catch {} }
      await this._cancelProofs(posts); throw e;
    }
    this.shieldCache = null;
    return { txs, txHash: txs[txs.length - 1] };
  }
  /// The shielded tree and its events (cached 3 s). Clients check the leaves against the on-chain root before proving.
  async shieldState() { if (this.shieldCache && Date.now() - this.shieldCache.at < 3000) return this.shieldCache.v;
    const r = await this.V.readShield(); const v = { leaves: r.leaves.map(String), ciphertexts: [...r.ciphertexts].map(([c, x]) => ({ commitment: c, data: Buffer.from(x.data).toString('base64'), position: x.position })),
      receipts: [...r.receipts.values()].map((x) => ({ index: Number(x.index), commitment: String(x.commitment), asset: String(x.asset), amount: String(x.amount), owner: String(x.owner), blinding: String(x.blinding) })),
      pending: r.pending.map((x) => ({ pending: x.pending.toBase58(), depositor: x.depositor.toBase58(), mint: x.mint.toBase58(), amount: String(x.amount), commitments: x.commitments.map(String) })), nullified: [...r.nullified] };
    this.shieldCache = { at: Date.now(), v }; return v; }
  /// Phase 3: a pool's sealed-swap state for the app: settings, the current batch (no amounts: only counts per direction,
  /// timing and state), the last finished batch's public outcome, and the committee's key and threshold.
  async sealedState(pool) { const V = this.V; const st = await V.sealedState(new PublicKey(pool)); if (!st) return { enabled: false };
    const c = await V.committee(); const { sealed: s, batch: b, slot } = st; const last = s.seq > 0n ? await V.batch(new PublicKey(pool), s.seq - 1n) : null;
    const pub = (x) => x && { seq: String(x.seq), state: x.state, count: x.count, rollovers: x.rollovers, endSlot: String(x.endSlot), closedSlot: String(x.closedSlot), verified: x.verified, totals: x.totals.map(String), num: x.num.map(String), den: x.den.map(String), xForY: x.xForY, netIn: String(x.netIn), netOut: String(x.netOut), settleId: x.settleId };
    return { enabled: true, slot, slotMs: 400, paused: s.paused, mintX: s.mintX.toBase58(), mintY: s.mintY.toBase58(), seq: String(s.seq), epochSlots: String(s.epochSlots), settleTimeout: String(s.settleTimeout), minIn: s.minIn.map(String), kMin: s.kMin, maxRollovers: s.maxRollovers,
      batch: pub(b), last: pub(last), committee: c ? { t: c.t, n: c.n, epoch: c.epoch, kind: c.kind, pk: Buffer.from(require('../sdk/bjj.js').enc(c.pk)).toString('hex') } : null }; }
  /// Permissionless upkeep of every sealed pool: close a batch whose epoch is over; fail a closed one past its window.
  async crankSealed() { const V = this.V; let n = 0;
    for (const b of this.dep.binPools) { const pool = new PublicKey(b.address); try { const st = await V.sealedState(pool); if (!st || !st.batch) continue; const { sealed: s, batch: x, slot } = st;
      if (x.state === 'open' && BigInt(slot) >= x.endSlot + 2n) { /* 2 slots of grace: the committee's nodes usually close first */ await V.send([V.closeBatchIx(this.wallet.publicKey, pool, x.seq)], [], 1_400_000); n++; }
      for (let q = s.seq - 1n; q >= 0n && q >= s.seq - 4n; q--) { const y = await V.batch(pool, q); if (y && y.state === 'closed' && BigInt(slot) > y.closedSlot + s.settleTimeout) { await V.send([V.failBatchIx(pool, q)], [], 200_000); n++; } }
    } catch (e) { if (!/"Custom":60(16|18|19)\b/.test(e.message)) console.error('sealed crank', b.id, e.message.slice(0, 120)); } } // a node closed or settled it first: nothing to do
    return n; }
  /// The postman's other job: admit pending shielded deposits whose depositor passes screening.
  async approveDeposits() { if (!this.postman) return 0; const pv = new Veyl({ connection: this.conn, programs: this.dep.programs, payer: this.postman }); const st = await pv.readShield(); let n = 0;
    for (const d of st.pending) { if (!isAllowed({ payer: d.depositor.toBase58(), beneficiary: d.depositor.toBase58() })) continue;
      try { await pv.send([pv.approveDepositIx(this.postman.publicKey, d.pending, d.depositor)], [], 200_000); n++; } catch (e) { console.error('approve', e.message); } }
    if (n) this.shieldCache = null; return n; }
  async _exec(ixs, nh, mint) { try { return await this.V.sendV0(ixs, [], 1_400_000); } catch (e) { await this._cancel(mint, nh); throw e; } }
  /// A spend that was posted but whose execution failed: free the nullifier again so the user's note is not stuck.
  async _cancel(mint, nh) { try { await this.V.send([await this.V.cancelPostIx(this.wallet.publicKey, this.V.poolPda(mint), nh)], [], 100_000); } catch { /* best effort */ } }
  /// The postman: rebuild the approved-label tree of every pool and publish its root when it changed.
  async publish() {
    if (!this.postman) return;
    for (const { pool } of this.pools) {
      try { this.cache.delete(pool.toBase58()); const st = await this.state(pool); const root = merklePath(st.labels.length ? st.labels : [0n], 0, ASP_DEPTH).root; const p = await this.V.pool(pool);
        if (p.aspRoot !== root) { const pv = new Veyl({ connection: this.conn, programs: this.dep.programs, payer: this.postman }); await pv.send([pv.updateAspRootIx(this.postman.publicKey, pool, root, 'labels:' + st.labels.length)], [], 50_000); console.log(new Date().toISOString(), 'asp', pool.toBase58().slice(0, 8), 'approved', st.labels.length); }
      } catch (e) { console.error('asp', pool.toBase58().slice(0, 8), e.message); }
    }
  }
  /// Liveness for the host's health check: version, network, the hot wallet and its last known SOL balance (refreshed every
  /// minute in the background; it pays transaction fees and recipients' token-account rent, and never holds user funds).
  /// Test tokens for testers on devnet / local: mints a fixed amount of every mock token to `to`, plus a little SOL for network
  /// fees. Only with FAUCET_KEY (the deployer: the mock mints' authority) and never on mainnet. Rate-limited by the caller.
  async drip(to, want) { if (!this.faucet || this.dep.network === 'mainnet') throw new Error('No test tokens on this network.');
    const owner = new PublicKey(to); const out = []; // about $1,000 of every token (5 SOL), rounded to two figures
    const amt = (sym, t) => (sym === 'SOL' ? 5 : Number((1000 / (Number(t.price) || 1)).toPrecision(2)));
    // the core basket by default; a pool page asks for its own pair (at most 4 extra tokens per request)
    const CORE = ['SOL', 'USDC', 'USDT', 'JUP', 'BONK', 'WIF', 'JTO', 'PYTH', 'RAY']; const extra = (Array.isArray(want) ? want : []).filter((s) => this.dep.tokens[s] && !CORE.includes(s)).slice(0, 4);
    const pick = Array.isArray(want) && want.length ? [...new Set(['SOL', 'USDC', ...want.filter((s) => this.dep.tokens[s]).slice(0, 4)])] : [...CORE, ...extra];
    for (const [sym, t] of Object.entries(this.dep.tokens).filter(([s]) => pick.includes(s))) { const n = amt(sym, t); if (!(n > 0)) continue; const mint = new PublicKey(t.mint); const tp = (await this.conn.getAccountInfo(mint)).owner;
      const ata = await spl.getOrCreateAssociatedTokenAccount(this.conn, this.faucet, mint, owner, true, 'confirmed', { commitment: 'confirmed' }, tp);
      await spl.mintTo(this.conn, this.faucet, mint, ata.address, this.faucet, BigInt(Math.round(n * 10 ** t.decimals)), [], { commitment: 'confirmed' }, tp); out.push(n.toLocaleString('en-US') + ' ' + sym); }
    if ((await this.conn.getBalance(owner)) < 20_000_000) { const { SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
      await sendAndConfirmTransaction(this.conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: this.faucet.publicKey, toPubkey: owner, lamports: 50_000_000 })), [this.faucet], { commitment: 'confirmed' }); out.push('0.05 SOL for fees'); }
    return { sent: out }; }
  health() { return { ok: true, version: VERSION, network: this.dep.network, relayer: this.wallet.publicKey.toBase58(), balanceSol: this.balance === undefined ? null : this.balance / 1e9, lowBalance: this.balance !== undefined && this.balance < LOW_BALANCE_LAMPORTS, publisher: !!this.postman }; }
  async refreshBalance() { try { this.balance = await this.conn.getBalance(this.wallet.publicKey); if (this.balance < LOW_BALANCE_LAMPORTS) console.error('relayer balance low:', this.balance / 1e9, 'SOL'); } catch { /* RPC hiccup: keep the last value */ } }
  async binPools() { const out = []; for (const b of this.dep.binPools) { const p = await this.V.binPool(b.address); out.push({ ...b, activeId: p.activeId, lowestId: p.lowestId, highestId: p.highestId, seeded: p.seeded, fee: (await this.V.currentFee(b.address)).toString(), price: S.priceOf(p.basePrice, p.binStep, p.activeId).toString(),
      protocolShare: p.protocolShare, totalFeeX: p.totalFeeX.toString(), totalFeeY: p.totalFeeY.toString(), rewards: p.rewards.map((r, i) => (r.initialized ? { index: i, mint: r.mint.toBase58(), rateQ64: r.rate.toString(), end: Number(r.end) } : null)).filter(Boolean) }); } return out; }
}

/// Rate-limit key. Behind a proxy (Render, a CDN) every request comes from the proxy's address, so one client could use up
/// everyone's budget; TRUST_PROXY=<n> takes the address the n-th proxy from the right appended to X-Forwarded-For
/// (REVIEW.md L-2). Never logged.
function clientKey(req, trust = Number(process.env.TRUST_PROXY || 0)) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return trust > 0 && xff.length >= trust ? xff[xff.length - trust] : req.socket.remoteAddress;
}
function serve(relayer, port = 8843) {
  const hits = new Map(); // in memory only, never logged
  const drips = new Map(); // faucet: last drip per address and per caller, in memory only
  setInterval(() => hits.clear(), 60_000).unref();
  // CORS: ALLOWED_ORIGINS=https://veyl.example,https://www.veyl.example limits browsers to the site; unset = any origin.
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const json = (res, code, o, req) => { const origin = req && req.headers.origin; const allow = !allowed.length ? '*' : allowed.includes(origin) ? origin : allowed[0];
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': allow, 'access-control-allow-headers': 'content-type', vary: 'origin', 'cache-control': 'no-store' }); res.end(j(o)); };
  const srv = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, {}, req);
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/info') return json(res, 200, relayer.info(), req);
      if (url.pathname === '/health') return json(res, 200, relayer.health(), req);
      if (url.pathname === '/pools') return json(res, 200, await relayer.binPools(), req);
      if (url.pathname === '/shield') return json(res, 200, await relayer.shieldState(), req);
      if (url.pathname === '/sealed') { const pool = url.searchParams.get('pool'); if (!pool) throw new Error('pool?'); return json(res, 200, await relayer.sealedState(pool), req); }
      if (url.pathname === '/state') { const pool = url.searchParams.get('pool'); if (!pool) throw new Error('pool?'); const st = await relayer.state(pool); return json(res, 200, { leaves: st.leaves, labels: st.labels, deposits: st.deposits }, req); }
      if (req.method !== 'POST' || (url.pathname !== '/submit' && url.pathname !== '/fee' && url.pathname !== '/drip')) return json(res, 404, { error: 'not found' }, req);
      const k = clientKey(req); const n = (hits.get(k) || 0) + 1; hits.set(k, n); if (n > 30) return json(res, 429, { error: 'slow down' }, req);
      let body = ''; for await (const c of req) { body += c; if (body.length > 200_000) return json(res, 413, { error: 'too large' }, req); }
      if (url.pathname === '/fee') return json(res, 200, await relayer.feeQuote(JSON.parse(body)), req);
      if (url.pathname === '/drip') { const to = String((JSON.parse(body) || {}).to || ''); const now = Date.now(); const last = drips.get(to) || drips.get('ip:' + k) || 0;
        const wantPair = Array.isArray((JSON.parse(body) || {}).tokens) && (JSON.parse(body) || {}).tokens.length;
        if (!wantPair && now - last < 6 * 3600_000) return json(res, 429, { error: 'Test tokens already sent here recently. Try again in a few hours.' }, req);
        const want = (JSON.parse(body) || {}).tokens; const key = to + (Array.isArray(want) && want.length ? ':' + want.slice(0, 4).sort().join(',') : '');
        if (key !== to) { if (now - (drips.get(key) || 0) < 6 * 3600_000) return json(res, 429, { error: 'Test tokens for this pair were already sent here recently.' }, req); const r = await relayer.drip(to, want); drips.set(key, now); return json(res, 200, r, req); }
        const r = await relayer.drip(to); drips.set(to, now); drips.set('ip:' + k, now); return json(res, 200, r, req); }
      srv.inflight++; try { json(res, 200, await relayer.submit(JSON.parse(body)), req); } finally { srv.inflight--; }
    } catch (e) { json(res, 400, { error: String(e.message).slice(0, 300) }, req); }
  });
  srv.inflight = 0; srv.listen(port);
  if (process.env.SEALED_CRANK !== '0') { srv.crank = setInterval(() => relayer.crankSealed().catch((e) => console.error('crank', e.message)), Number(process.env.CRANK_INTERVAL_MS || 4_000)); srv.crank.unref(); }
  relayer.refreshBalance(); srv.bal = setInterval(() => relayer.refreshBalance(), 60_000); srv.bal.unref();
  if (relayer.postman) { relayer.publish(); srv.asp = setInterval(() => relayer.publish(), Number(process.env.ASP_INTERVAL_MS || 30_000)); srv.asp.unref();
    const admit = () => relayer.approveDeposits().catch((e) => console.error('admit', e.message)); admit(); srv.admit = setInterval(admit, Number(process.env.ADMIT_INTERVAL_MS || 5_000)); srv.admit.unref(); }
  return srv;
}
module.exports = { Relayer, serve, isAllowed, clientKey, pricesFrom, WORST, SIGNED, PROOF_LEGS, SHIELD_KINDS };

/// Keys come from env only: RELAYER_SECRET_KEY / POSTMAN_SECRET_KEY (a JSON byte array or base58, for hosts like Render),
/// or RELAYER_KEY / POSTMAN_KEY (a path to a keypair file). Never logged.
function keyFromEnv(env, inline, file) {
  if (env[inline]) { const v = env[inline].trim(); return Keypair.fromSecretKey(v.startsWith('[') ? Uint8Array.from(JSON.parse(v)) : require('bs58').decode(v)); }
  if (env[file]) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(env[file], 'utf8'))));
  return null;
}
/// The deployment: DEPLOY_JSON (the file's contents), DEPLOY_FILE (a path), or deploy.<NETWORK>.json in the repo.
function deployFromEnv(env) {
  if (env.DEPLOY_JSON) return JSON.parse(env.DEPLOY_JSON);
  return JSON.parse(fs.readFileSync(env.DEPLOY_FILE || path.join(__dirname, '..', `deploy.${env.NETWORK || 'local'}.json`), 'utf8'));
}
module.exports.keyFromEnv = keyFromEnv; module.exports.deployFromEnv = deployFromEnv;

if (require.main === module) {
  const env = process.env; const dep = deployFromEnv(env);
  const conn = new Connection(env.RPC_URL || dep.rpc, 'confirmed');
  const wallet = keyFromEnv(env, 'RELAYER_SECRET_KEY', 'RELAYER_KEY'); if (!wallet) { console.error('Set RELAYER_SECRET_KEY (or RELAYER_KEY=<keypair file>): the relayer\'s own fee-only hot wallet.'); process.exit(1); }
  const postman = keyFromEnv(env, 'POSTMAN_SECRET_KEY', 'POSTMAN_KEY');
  const r = new Relayer({ connection: conn, wallet, deploy: dep, postman, minFeeBps: Number(env.MIN_FEE_BPS || 5), feeCover: Number(env.FEE_COVER || 1) });
  if (dep.network !== 'mainnet') r.faucet = keyFromEnv(env, 'FAUCET_SECRET_KEY', 'FAUCET_KEY');
  if (!r.prices.SOL) console.error('no SOL price (deploy file or PRICES_JSON): the fee floor is off and small requests can drain this wallet');
  const port = Number(env.PORT || 8843); const srv = serve(r, port);
  console.log('relayer', r.wallet.publicKey.toBase58(), 'v' + VERSION, dep.network, 'listening on', port, postman ? '(+ approved-set publisher)' : '');
  // graceful stop: no new connections, let in-flight submissions finish (max 25 s), then exit
  const stop = (sig) => { console.log(sig, 'received: draining'); clearInterval(srv.asp); clearInterval(srv.bal); clearInterval(srv.crank); srv.close();
    const t0 = Date.now(); const wait = setInterval(() => { if (srv.inflight === 0 || Date.now() - t0 > 25_000) { clearInterval(wait); process.exit(0); } }, 200); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
}
