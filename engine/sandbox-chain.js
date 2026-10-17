// Veyl Sandbox: an in-browser chain. No RPC, no tokens of value, nothing is ever sent anywhere.
//
// It runs the project's own logic on in-memory state:
//   bin pools   = programs/veyl_bin ported line by line onto the SDK's exact JS twin (sdk/veyl.js: simulateSwap is the
//                 executed swap, sharesForMint, owedOf, distribute, sideWeights); mint / burn / settle / claim / limit
//                 orders / rebalance / swap_and_add / mint_exact / harvest / farm rewards follow the Rust functions.
//   shielded    = programs/veyl_pool's Phase 2 checks (check_transact, use_nullifier, insert_outputs, consume_position,
//                 deposit_receipt) and veyl_entry's shield_swap / shield_order / shield_order_withdraw / shield_lp steps,
//                 over the SDK's Poseidon tree (sdk/shield.js). Every proof is verified with snarkjs against the circuits'
//                 own verifying keys before anything is applied.
//   sealed      = veyl_entry/src/sealed.rs: submit_swap (bundle + ciphertext aggregation), close_batch (k floor, rollovers),
//                 the 2-of-3 committee's partial decryptions with Chaum-Pedersen proofs (sdk/bjj.js), settle_verify,
//                 settle_batch (clearing at the active bin, one net swap), claim_swap.
// What is simulated, and said so in the app: the clock (wall time), the committee (three members in this page), the
// approved-set publisher (admits deposits after a few seconds), and the other participants (bots that swap in public,
// and seal swaps into batches with real ElGamal ciphertexts but without proofs of their own).
import { Buffer } from 'buffer';
import { PublicKey, Keypair } from '@solana/web3.js';
import { sha256 } from 'js-sha256';
const S = require('../sdk/veyl.js');
const Z = require('../sdk/shield.js');
const SE = require('../sdk/sealed.js');
const J = require('../sdk/bjj.js');
const { Q, U128, MIN_LIQUIDITY, BINS_PER_ARRAY, MIN_CHUNK, CHUNKS, EMPTY_BIN, priceOf, stepQ, simulateSwap, refsOf, feeOf, accOf, owedOf, distribute, sideWeights, chunkOf, slotOf, mulDiv, mulDivCeil, TOKEN_PROGRAM } = S;
const BITMAP_WORDS = 32; const BUCKET = 300; const U64MAX = (1n << 64n) - 1n; const PIPS = 1_000_000n; const BPS = 10_000n; const K = Z.K;

export const keyFrom = (label) => Keypair.fromSeed(Uint8Array.from(Buffer.from(sha256.arrayBuffer('veyl-sandbox:' + label)))).publicKey;
const b58 = (k) => new PublicKey(k).toBase58();
const nowS = () => Math.floor(Date.now() / 1000);
const big = (v) => BigInt(v);
const fieldEq = (a, b) => BigInt(a) === BigInt(b);
/// 128.128 price of raw Y per raw X from a human price (= scripts/lib.js priceQ).
export const priceQ = (human, decX, decY) => { const scaled = Number(human) * 10 ** (decY - decX); const [i, f = ''] = scaled.toExponential(15).split('e'); const m = BigInt(Math.round(Number(i) * 1e15)); const e = Number(f) - 15; return e >= 0 ? m * 10n ** BigInt(e) * Q : (m * Q) / 10n ** BigInt(-e); };

class ChainError extends Error {}
const need = (ok, msg) => { if (!ok) throw new ChainError(msg); };

const emptySlot = () => ({ shares: 0n, feeCpX: 0n, feeCpY: 0n, rewardCp: [0n, 0n], askShares: 0n, bidShares: 0n });
const emptyShareAccount = (pool, owner, authority, chunk) => ({ pool, owner, authority, chunk, pendingFeeX: 0n, pendingFeeY: 0n, pendingReward: [0n, 0n], slots: Array.from({ length: BINS_PER_ARRAY }, emptySlot) });
const freshBin = (id) => ({ id, x: 0n, y: 0n, shares: 0n, feeGx: 0n, feeGy: 0n, rewardG: [0n, 0n], askShares: 0n, askX: 0n, askFilledY: 0n, bidShares: 0n, bidY: 0n, bidFilledX: 0n });
const hasX = (b) => b.x > 0n || b.askX > 0n; const hasY = (b) => b.y > 0n || b.bidY > 0n;

export class SandboxChain {
  /// tokens: [{ sym, decimals, price }]; pools: [{ id, x, y, binStep, baseFee, vfc, price, protocolShareBps }]
  constructor({ tokens, pools, verify }) {
    this.verifyProof = verify; // async (circuit, p) -> { ok, ms }
    this.programs = { pool: keyFrom('program:pool'), bin: keyFrom('program:bin'), entry: keyFrom('program:entry') };
    this.V = new S.Veyl({ connection: { rpcEndpoint: 'sandbox' }, programs: this.programs });
    this.signer = this.V.signerPda(); this.shieldOwner = this.V.shieldOwner();
    this.relayer = keyFrom('relayer'); this.postman = keyFrom('postman');
    this.tokens = {}; for (const t of tokens) { const mint = keyFrom('mint:' + t.sym); this.tokens[t.sym] = { ...t, mint: mint.toBase58(), asset: Z.assetOf(mint) }; }
    this.poolCfg = pools; this.pools = new Map(); this.lpacc = new Map(); this.balances = new Map();
    this.shield = { leaves: [], tree: new Z.Tree([]), roots: [], ciphertexts: new Map(), receipts: [], nullified: new Set(), vault: {}, pending: [] };
    this.sealed = new Map(); this.committee = null; this.seq = 0; this.events = new Map(); this.log = []; this.t0 = Date.now(); this.holds = new Map();
    this.listeners = new Set();
  }
  // ---------------------------------------------------------------------------------------------- bookkeeping
  sym(mint) { const m = b58(mint); return Object.values(this.tokens).find((t) => t.mint === m); }
  bal(owner, sym) { const m = this.balances.get(b58(owner)); return (m && m[sym]) || 0n; }
  credit(owner, sym, v) { const k = b58(owner); const m = this.balances.get(k) || {}; m[sym] = (m[sym] || 0n) + big(v); need(m[sym] >= 0n, 'Not enough ' + sym + '.'); this.balances.set(k, m); }
  debit(owner, sym, v) { need(this.bal(owner, sym) >= big(v), 'Not enough ' + sym + ' in that account.'); this.credit(owner, sym, -big(v)); }
  vaultS(sym, dv) { this.shield.vault[sym] = (this.shield.vault[sym] || 0n) + big(dv); need(this.shield.vault[sym] >= 0n, 'The shielded vault cannot pay that.'); }
  /// A sandbox transaction: an id ("sandbox #12"), its events, what an observer of the chain would see.
  tx(kind, events = [], seen = null, proofs = null) { const id = 'sandbox #' + (++this.seq); this.events.set(id, events); const pr = proofs ? (Array.isArray(proofs) ? proofs : [proofs]).map((v) => ({ circuit: v.circuit, ms: v.ms, verifyMs: v.verifyMs, ok: v.ok })) : []; this.log.unshift({ id, kind, at: Date.now(), seen, proofs: pr }); if (this.log.length > 400) this.log.length = 400; this.emit({ type: 'tx', id, kind }); return id; }
  emit(e) { for (const f of this.listeners) { try { f(e); } catch { /* a listener's problem */ } } }
  slot() { return Math.floor((Date.now() - this.t0) / 400); }

  // ---------------------------------------------------------------------------------------------- pools (veyl_bin)
  createPool(c, price = c.price) {
    const X = this.tokens[c.x], Y = this.tokens[c.y]; const address = this.V.binPoolPda(new PublicKey(X.mint), new PublicKey(Y.mint), c.binStep);
    const bp = { address, factory: this.V.factoryPda(), mintX: new PublicKey(X.mint), mintY: new PublicKey(Y.mint), vaultX: keyFrom('vault:x:' + c.id), vaultY: keyFrom('vault:y:' + c.id), tokenProgramX: TOKEN_PROGRAM, tokenProgramY: TOKEN_PROGRAM,
      basePrice: priceQ(price, X.decimals, Y.decimals), stepQ: stepQ(c.binStep), variableFeeControl: BigInt(c.vfc), volAcc: 0n, volRef: 0n, lastSwapAt: 0n, activeId: 0, lowestId: 0, highestId: 0, idRef: 0, baseFee: c.baseFee, binStep: c.binStep, seeded: false,
      protocolShare: c.protocolShareBps ?? 1000, protocolFeeX: 0n, protocolFeeY: 0n, totalFeeX: 0n, totalFeeY: 0n, bitmapX: Array(BITMAP_WORDS).fill(0n), bitmapY: Array(BITMAP_WORDS).fill(0n),
      rewards: [0, 1].map(() => ({ mint: PublicKey.default, vault: PublicKey.default, funder: PublicKey.default, tokenProgram: TOKEN_PROGRAM, rate: 0n, duration: 0n, end: 0n, lastUpdate: 0n, ineligible: 0n, initialized: false })) };
    const P = { id: c.id, x: c.x, y: c.y, cfg: c, address: address.toBase58(), p: bp, bins: new Map(), shares: new Map(), vault: { x: 0n, y: 0n }, rewardVault: [0n, 0n], buckets: [], createdAt: nowS() };
    this.pools.set(P.address, P); return P;
  }
  pool(addr) { const P = this.pools.get(b58(addr)); need(P, 'Unknown pool.'); return P; }
  bin(P, id) { let b = P.bins.get(id); if (!b) { b = freshBin(id); P.bins.set(id, b); } return b; }
  shareKey(P, owner, auth, chunk) { return b58(owner) + '|' + b58(auth) + '|' + chunk; }
  shareAcc(P, owner, auth, chunk, create = true) { const k = this.shareKey(P, owner, auth, chunk); let a = P.shares.get(k); if (!a && create) { a = emptyShareAccount(P.p.address, new PublicKey(owner), new PublicKey(auth), chunk); P.shares.set(k, a); } return a || null; }
  syncChunk(P, c) { const i = c - MIN_CHUNK; if (i < 0 || i >= CHUNKS) return; let hx = false, hy = false; for (let s = 0; s < BINS_PER_ARRAY; s++) { const b = P.bins.get(c * BINS_PER_ARRAY + s); if (b) { hx = hx || hasX(b); hy = hy || hasY(b); } }
    const w = Math.floor(i / 64), m = 1n << BigInt(i % 64); P.p.bitmapX[w] = hx ? P.p.bitmapX[w] | m : P.p.bitmapX[w] & ~m; P.p.bitmapY[w] = hy ? P.p.bitmapY[w] | m : P.p.bitmapY[w] & ~m; }
  extendRange(P, lo, hi) { const p = P.p; if (!p.seeded) { p.lowestId = lo; p.highestId = hi; p.seeded = true; } else { p.lowestId = Math.min(p.lowestId, lo); p.highestId = Math.max(p.highestId, hi); } }
  feeNow(P, now = nowS()) { const { ref, iref } = refsOf(P.p, now); return feeOf(P.p, accOf(ref, iref, P.p.activeId)); }
  /// = BinPool::update_rewards (via update_active): accrue live reward slots into the active bin's growth.
  updateActive(P, now = nowS()) { const p = P.p; if (!p.rewards.some((r) => r.initialized)) return; const a = P.bins.get(p.activeId); const eligible = a && a.shares > MIN_LIQUIDITY ? a.shares - MIN_LIQUIDITY : 0n;
    p.rewards.forEach((r) => { if (!r.initialized) return; const t = BigInt(Math.min(now, Number(r.end))); if (t > r.lastUpdate) { const emitted = r.rate * (t - r.lastUpdate); if (eligible > 0n) { const b = this.bin(P, p.activeId); const i = p.rewards.indexOf(r); b.rewardG[i] = (b.rewardG[i] + emitted / eligible) % U128; } else r.ineligible += emitted >> 64n; } if (BigInt(now) > r.lastUpdate) r.lastUpdate = BigInt(now); }); }
  /// = settle: bring a slot's fees and rewards into its account's pending balances, move its checkpoints.
  settle(sa, s, b) { const sl = sa.slots[s]; const sh = sl.shares;
    if (sh > 0n) { sa.pendingFeeX += owedOf(b.feeGx, sl.feeCpX, sh); sa.pendingFeeY += owedOf(b.feeGy, sl.feeCpY, sh); for (let i = 0; i < 2; i++) sa.pendingReward[i] += owedOf(b.rewardG[i], sl.rewardCp[i], sh); }
    sl.feeCpX = b.feeGx; sl.feeCpY = b.feeGy; sl.rewardCp = [...b.rewardG]; }
  /// = swap_inner: the executed swap is the twin's simulation, applied.
  swapInner(P, xForY, amountIn, now = nowS()) {
    need(amountIn > 0n, 'Enter an amount.'); this.updateActive(P, now); const p = P.p; const refs = refsOf(p, now);
    const r = simulateSwap(p, P.bins, xForY, amountIn, now); const chunks = new Set();
    for (const t of r.touched) { const { mmFee, loFee, proto, ...b } = t; P.bins.set(t.id, b); chunks.add(chunkOf(t.id)); }
    for (const c of chunks) this.syncChunk(P, c);
    p.activeId = r.endId; p.volAcc = r.volAcc; p.volRef = refs.ref; p.idRef = refs.iref; p.lastSwapAt = BigInt(now);
    if (xForY) { p.protocolFeeX += r.protocolFee; p.totalFeeX += r.fee; P.vault.x += amountIn; P.vault.y -= r.out; } else { p.protocolFeeY += r.protocolFee; p.totalFeeY += r.fee; P.vault.y += amountIn; P.vault.x -= r.out; }
    // history in 5-minute buckets (volume and fees per side, swaps, the active bin at the end): the pools table's 1h / 6h / 24h figures and charts
    const k = Math.floor(now / BUCKET); let bk = P.buckets[P.buckets.length - 1];
    if (!bk || bk.k !== k) { bk = { k, vx: 0n, vy: 0n, fx: 0n, fy: 0n, px: 0n, py: 0n, n: 0, open: bk ? bk.close : r.endId, close: r.endId }; P.buckets.push(bk); while (P.buckets.length > 400) P.buckets.shift(); }
    if (xForY) { bk.vx += amountIn; bk.fx += r.fee; bk.px += r.protocolFee; } else { bk.vy += amountIn; bk.fy += r.fee; bk.py += r.protocolFee; } bk.n += 1; bk.close = r.endId;
    this.emit({ type: 'swap', pool: P.address, xForY, endId: r.endId }); return r;
  }
  /// = mint_inner
  mintInner(P, owner, auth, ids, ax, ay, minShares = [], skipEmpty = false, now = nowS()) {
    const p = P.p; const active = p.activeId; const fee = this.feeNow(P, now); const minted = []; let lo = Infinity, hi = -Infinity; const chunks = new Set();
    for (let i = 0; i < ids.length; i++) { const id = ids[i]; const x = big(ax[i] || 0n), y = big(ay[i] || 0n);
      if (skipEmpty && x === 0n && y === 0n) { need(!minShares.length || big(minShares[i]) === 0n, 'Too few shares.'); minted.push(0n); continue; }
      need(!((id > active && y > 0n) || (id < active && x > 0n) || (x === 0n && y === 0n)), 'Wrong side of the price for bin ' + id + '.');
      const price = priceOf(p.basePrice, p.binStep, id); const b = this.bin(P, id); let supply = b.shares;
      const xv = mulDiv(x, price, Q); let liq = xv + y; const bxv = mulDiv(b.x, price, Q); const lb = bxv + b.y; let s;
      if (supply === 0n || lb === 0n) { if (supply === 0n) { need(liq > MIN_LIQUIDITY, 'Too small for an empty bin.'); s = liq - MIN_LIQUIDITY; supply = MIN_LIQUIDITY; } else s = liq; }
      else { if (id === active) { const ideal = mulDiv(liq, bxv, lb); const excess = xv > ideal ? xv - ideal : ideal - xv; liq -= mulDivCeil(excess, fee, PIPS); } s = mulDiv(liq, supply, lb); }
      need(s > 0n, 'Zero shares.'); if (minShares.length) need(s >= big(minShares[i]), 'The bins moved: fewer shares than the minimum.');
      const sa = this.shareAcc(P, owner, auth, chunkOf(id)); this.settle(sa, slotOf(id), b);
      b.x += x; b.y += y; b.shares = supply + s; sa.slots[slotOf(id)].shares += s;
      minted.push(s); lo = Math.min(lo, id); hi = Math.max(hi, id); chunks.add(chunkOf(id)); }
    for (const c of chunks) this.syncChunk(P, c); if (lo <= hi) this.extendRange(P, lo, hi); return minted;
  }
  /// = burn_inner
  burnInner(P, owner, auth, ids, sharesIn) { let ox = 0n, oy = 0n; const chunks = new Set();
    ids.forEach((id, i) => { const s = big(sharesIn[i]); const sa = this.shareAcc(P, owner, auth, chunkOf(id), false); need(sa, 'No position in bin ' + id + '.'); const sl = sa.slots[slotOf(id)];
      need(s > 0n && s <= sl.shares, 'Not enough shares in bin ' + id + '.'); const b = this.bin(P, id); this.settle(sa, slotOf(id), b);
      const x = mulDiv(b.x, s, b.shares), y = mulDiv(b.y, s, b.shares); b.x -= x; b.y -= y; b.shares -= s; sl.shares -= s; ox += x; oy += y; chunks.add(chunkOf(id)); });
    for (const c of chunks) this.syncChunk(P, c); return { x: ox, y: oy }; }
  payXY(P, to, x, y) { if (x > 0n) { P.vault.x -= x; need(P.vault.x >= 0n, 'Vault X short.'); this.credit(to, P.x, x); } if (y > 0n) { P.vault.y -= y; need(P.vault.y >= 0n, 'Vault Y short.'); this.credit(to, P.y, y); } }
  pullXY(P, from, x, y) { if (x > 0n) { this.debit(from, P.x, x); P.vault.x += x; } if (y > 0n) { this.debit(from, P.y, y); P.vault.y += y; } }
  // public instructions (the wallet signs; `from` / `to` are its token balances)
  mint(P, from, owner, auth, ids, ax, ay, minShares = []) { const now = nowS(); if (ids.includes(P.p.activeId)) this.updateActive(P, now);
    const sx = ax.reduce((s, v) => s + big(v), 0n), sy = ay.reduce((s, v) => s + big(v), 0n); need(this.bal(from, P.x) >= sx && this.bal(from, P.y) >= sy, 'Not enough tokens in the wallet.');
    const minted = this.mintInner(P, owner, auth, ids, ax, ay, minShares, false, now); this.pullXY(P, from, sx, sy); return minted; }
  burn(P, auth, owner, ids, shares, to = auth) { if (ids.includes(P.p.activeId)) this.updateActive(P); const o = this.burnInner(P, owner, auth, ids, shares); this.payXY(P, to, o.x, o.y); return o; }
  claimFees(P, auth, owner, ids, to = auth) { const chunks = [...new Set(ids.map(chunkOf))]; for (const id of ids) { const sa = this.shareAcc(P, owner, auth, chunkOf(id), false); if (sa) this.settle(sa, slotOf(id), this.bin(P, id)); }
    let fx = 0n, fy = 0n; for (const c of chunks) { const sa = this.shareAcc(P, owner, auth, c, false); if (!sa) continue; fx += sa.pendingFeeX; fy += sa.pendingFeeY; sa.pendingFeeX = 0n; sa.pendingFeeY = 0n; } this.payXY(P, to, fx, fy); return { x: fx, y: fy }; }
  claimReward(P, auth, owner, index, ids, to = auth) { this.updateActive(P); const r = P.p.rewards[index]; need(r && r.initialized, 'No such reward.'); const chunks = [...new Set(ids.map(chunkOf))];
    for (const id of ids) { const sa = this.shareAcc(P, owner, auth, chunkOf(id), false); if (sa) this.settle(sa, slotOf(id), this.bin(P, id)); }
    let a = 0n; for (const c of chunks) { const sa = this.shareAcc(P, owner, auth, c, false); if (!sa) continue; a += sa.pendingReward[index]; sa.pendingReward[index] = 0n; }
    if (a > 0n) { P.rewardVault[index] -= a; need(P.rewardVault[index] >= 0n, 'Reward vault short.'); this.credit(to, this.sym(r.mint).sym, a); } return a; }
  /// = place_limit_order
  placeOrder(P, from, owner, auth, id, isAsk, amount) { const p = P.p; need(amount > 0n, 'Enter an amount.'); need((isAsk && id > p.activeId) || (!isAsk && id < p.activeId), isAsk ? 'A sell order sits above the current price.' : 'A buy order sits below the current price.');
    const price = priceOf(p.basePrice, p.binStep, id); const b = this.bin(P, id);
    const [supply, unfilled, filled] = isAsk ? [b.askShares, b.askX, b.askFilledY] : [b.bidShares, b.bidY, b.bidFilledX];
    const conv = isAsk ? mulDiv(filled, Q, price) : mulDiv(filled, price, Q); const value = unfilled + conv;
    let shares; if (supply === 0n) shares = amount; else { need(value > 0n, 'Zero shares.'); shares = mulDiv(amount, supply, value); } need(shares > 0n, 'Zero shares.');
    if (isAsk) { b.askX += amount; b.askShares = supply + shares; } else { b.bidY += amount; b.bidShares = supply + shares; }
    const sa = this.shareAcc(P, owner, auth, chunkOf(id)); if (isAsk) sa.slots[slotOf(id)].askShares += shares; else sa.slots[slotOf(id)].bidShares += shares;
    this.syncChunk(P, chunkOf(id)); this.extendRange(P, id, id);
    if (isAsk) { this.debit(from, P.x, amount); P.vault.x += amount; } else { this.debit(from, P.y, amount); P.vault.y += amount; } return shares; }
  /// = withdraw_limit_order: returns (x, y) paid out
  withdrawOrder(P, auth, owner, id, isAsk, shares, to = auth) { const sa = this.shareAcc(P, owner, auth, chunkOf(id), false); need(sa, 'No such order.'); const sl = sa.slots[slotOf(id)];
    const mine = isAsk ? sl.askShares : sl.bidShares; need(shares > 0n && shares <= mine, 'Not enough order shares.'); if (isAsk) sl.askShares -= shares; else sl.bidShares -= shares;
    const b = this.bin(P, id); const supply = isAsk ? b.askShares : b.bidShares; const [unf, fil] = isAsk ? [b.askX, b.askFilledY] : [b.bidY, b.bidFilledX];
    const ou = mulDiv(unf, shares, supply), of = mulDiv(fil, shares, supply); let ox, oy;
    if (isAsk) { b.askX -= ou; b.askFilledY -= of; b.askShares = supply - shares; ox = ou; oy = of; } else { b.bidY -= ou; b.bidFilledX -= of; b.bidShares = supply - shares; ox = of; oy = ou; }
    this.syncChunk(P, chunkOf(id)); this.payXY(P, to, ox, oy); return { x: ox, y: oy }; }
  /// = rebalance_position
  rebalance(P, auth, owner, burnIds, burnShares, ids, wx, wy, minShares = [], withholdBps = 0, to = auth) { const now = nowS(); const active = P.p.activeId;
    if (burnIds.includes(active) || ids.includes(active)) this.updateActive(P, now); const o = this.burnInner(P, owner, auth, burnIds, burnShares);
    const wxb = (o.x * BigInt(withholdBps)) / BPS, wyb = (o.y * BigInt(withholdBps)) / BPS; const ax = o.x - wxb, ay = o.y - wyb;
    const sw = sideWeights(ids, wx, wy, active); const hx = sw.weightsX.some((w) => w > 0), hy = sw.weightsY.some((w) => w > 0);
    const dx = hx ? distribute(ax, sw.weightsX) : ids.map(() => 0n), dy = hy ? distribute(ay, sw.weightsY) : ids.map(() => 0n);
    const shares = ids.length ? this.mintInner(P, owner, auth, ids, dx, dy, minShares, true, now) : [];
    const rx = hx ? ax : 0n, ry = hy ? ay : 0n; this.payXY(P, to, o.x - rx, o.y - ry); return { burned: o, shares, readded: { x: rx, y: ry } }; }
  /// = swap_and_add
  swapAndAdd(P, from, owner, auth, xIn, amountIn, swapAmount, minSwapOut, ids, wx, wy, minShares = []) { const now = nowS(); need(swapAmount <= amountIn, 'Bad zap.');
    this.debit(from, xIn ? P.x : P.y, amountIn); if (xIn) P.vault.x += amountIn; else P.vault.y += amountIn; let out = 0n;
    if (swapAmount > 0n) { // the swap's output never leaves the vault: the swap's input is already in it
      if (xIn) P.vault.x -= swapAmount; else P.vault.y -= swapAmount; const r = this.swapInner(P, xIn, swapAmount, now); need(r.out >= minSwapOut, 'The price moved: less than the minimum out.'); out = r.out; if (xIn) P.vault.y += out; else P.vault.x += out; }
    const tx = xIn ? amountIn - swapAmount : out, ty = xIn ? out : amountIn - swapAmount; const active = P.p.activeId; const sw = sideWeights(ids, wx, wy, active);
    need((tx === 0n || sw.weightsX.some((w) => w > 0)) && (ty === 0n || sw.weightsY.some((w) => w > 0)), 'The range does not take both tokens after the swap.');
    const dx = distribute(tx, sw.weightsX), dy = distribute(ty, sw.weightsY); if (ids.includes(active)) this.updateActive(P, now);
    return { shares: this.mintInner(P, owner, auth, ids, dx, dy, minShares, true, now), swapOut: out }; }
  /// = mint_exact (the shielded aggregate mints shares, not amounts): returns (x, y) taken from `pay`
  mintExact(P, owner, auth, ids, shares, hintX, hintY, maxX, maxY) { const now = nowS(); const active = P.p.activeId; if (ids.includes(active)) this.updateActive(P, now);
    let tx = 0n, ty = 0n; const chunks = new Set(); let lo = Infinity, hi = -Infinity;
    ids.forEach((id, i) => { const s = big(shares[i]); need(s > 0n, 'Bad shares.'); const b = this.bin(P, id); const supply = b.shares; let x, y, ns;
      if (supply === 0n) { x = big(hintX[i]); y = big(hintY[i]); need(!((id > active && y > 0n) || (id < active && x > 0n) || (x === 0n && y === 0n)), 'Wrong side for bin ' + id + '.');
        const liq = mulDiv(x, priceOf(P.p.basePrice, P.p.binStep, id), Q) + y; need(liq > MIN_LIQUIDITY && liq - MIN_LIQUIDITY === s, 'The bin was seeded by someone else first.'); ns = MIN_LIQUIDITY + s; }
      else { need(b.x > 0n || b.y > 0n, 'Zero shares.'); x = mulDivCeil(s, b.x, supply); y = mulDivCeil(s, b.y, supply); ns = supply + s; }
      const sa = this.shareAcc(P, owner, auth, chunkOf(id)); this.settle(sa, slotOf(id), b); b.x += x; b.y += y; b.shares = ns; sa.slots[slotOf(id)].shares += s;
      tx += x; ty += y; lo = Math.min(lo, id); hi = Math.max(hi, id); chunks.add(chunkOf(id)); });
    need(tx <= maxX && ty <= maxY, 'Slippage: the bins need more than this action holds.'); for (const c of chunks) this.syncChunk(P, c); this.extendRange(P, lo, hi);
    P.vault.x += tx; P.vault.y += ty; return { x: tx, y: ty }; }
  /// = harvest: settle (owner, auth)'s fees bin by bin; returns per bin [x, y] collected and what was pending before.
  harvest(P, owner, auth, ids) { const chunks = [...new Set(ids.map(chunkOf))]; let px = 0n, py = 0n; for (const c of chunks) { const sa = this.shareAcc(P, owner, auth, c, false); if (sa) { px += sa.pendingFeeX; py += sa.pendingFeeY; } }
    const got = ids.map((id) => { const sa = this.shareAcc(P, owner, auth, chunkOf(id), false); if (!sa) return [0n, 0n]; const bx = sa.pendingFeeX, by = sa.pendingFeeY; this.settle(sa, slotOf(id), this.bin(P, id)); return [sa.pendingFeeX - bx, sa.pendingFeeY - by]; });
    let fx = px, fy = py; for (const g of got) { fx += g[0]; fy += g[1]; } for (const c of chunks) { const sa = this.shareAcc(P, owner, auth, c, false); if (sa) { sa.pendingFeeX = 0n; sa.pendingFeeY = 0n; } }
    P.vault.x -= fx; P.vault.y -= fy; return { got, total: { x: fx, y: fy } }; }
  initReward(P, index, rewardSym, amount, duration) { const r = P.p.rewards[index]; const now = BigInt(nowS()); const mint = new PublicKey(this.tokens[rewardSym].mint);
    Object.assign(r, { mint, vault: keyFrom('rvault:' + P.id + index), funder: keyFrom('funder'), initialized: true, duration: BigInt(duration), rate: (big(amount) << 64n) / BigInt(duration), end: now + BigInt(duration), lastUpdate: now }); P.rewardVault[index] += big(amount); }
  // ---------------------------------------------------------------------------------------------- reads (shapes of sdk/veyl.js)
  binsOf(P, chunks) { const m = new Map(); for (const c of chunks) for (let s = 0; s < BINS_PER_ARRAY; s++) { const b = P.bins.get(c * BINS_PER_ARRAY + s); if (b) m.set(b.id, b); } m.chunks = new Set(chunks); return m; }
  lpAcc(P, chunk) { const k = P.address + ':' + chunk; let a = this.lpacc.get(k); if (!a) { a = { chunk, hx: Array(BINS_PER_ARRAY).fill(0n), hy: Array(BINS_PER_ARRAY).fill(0n) }; this.lpacc.set(k, a); } return a; }
  /// Volume, fees (total and to LPs) and swap count over the last `secs` seconds, from the 5-minute buckets.
  stats(P, secs = 86400, now = nowS()) { const k0 = Math.floor((now - secs) / BUCKET); const o = { x: 0n, y: 0n, feeX: 0n, feeY: 0n, lpX: 0n, lpY: 0n, count: 0 };
    for (const b of P.buckets) { if (b.k <= k0) continue; o.x += b.vx; o.y += b.vy; o.feeX += b.fx; o.feeY += b.fy; o.lpX += b.fx - b.px; o.lpY += b.fy - b.py; o.count += b.n; } return o; }
  /// The active bin at the close of each bucket over the last `secs` (for charts), and the active bin `secs` ago.
  history(P, secs = 86400, now = nowS()) { const k0 = Math.floor((now - secs) / BUCKET); const pts = P.buckets.filter((b) => b.k > k0).map((b) => ({ t: b.k * BUCKET + BUCKET, id: b.close }));
    const before = [...P.buckets].reverse().find((b) => b.k <= k0); const start = before ? before.close : pts.length ? (P.buckets.find((b) => b.k > k0) || {}).open ?? pts[0].id : P.p.activeId; return { pts, start }; }
  volume24h(P) { const o = this.stats(P, 86400); return { x: o.x, y: o.y, feeX: o.feeX, feeY: o.feeY, count: o.count }; }

  // ---------------------------------------------------------------------------------------------- the shielded pool (veyl_pool Phase 2)
  insertLeaf(c) { const i = this.shield.tree.insert(BigInt(c)); this.shield.roots.push(String(this.shield.tree.root())); if (this.shield.roots.length > 192) this.shield.roots.shift(); return i; }
  knownRoot(r) { return this.shield.roots.includes(String(BigInt(r))) || (this.shield.tree.leaves.length === 0 && String(BigInt(r)) === String(this.shield.tree.root())); }
  useNullifier(n) { const k = String(BigInt(n)); need(!this.shield.nullified.has(k), 'Already spent: that note was used before.'); this.shield.nullified.add(k); }
  ct(commitment, data) { if (data && Z.bytes(data).length) this.shield.ciphertexts.set(String(BigInt(commitment)), { data: Buffer.from(Z.bytes(data)).toString('hex') }); }
  /// = check_transact (after the proof is verified): root, external data hash, public amount, asset.
  checkTransact(pubs, ext, asset) { const P_ = pubs.map(BigInt);
    need(this.knownRoot(P_[0]), 'Unknown root: the shielded tree moved on; try again.'); need(fieldEq(Z.extHash(ext), P_[2]), 'The proof is for different external data.');
    const pub = BigInt(ext.extAmount || 0n) - BigInt(ext.fee || 0n); need(fieldEq(Z.mod(pub), P_[1]), 'The proof\'s public amount does not match.');
    if (pub !== 0n) need(asset !== null && fieldEq(P_[3], asset), 'The proof is for a different token.'); else need(P_[3] === 0n, 'The proof reveals a token it should not.');
    return P_; }
  insertOutputs(P_, ext) { const enc = ext.encOut || []; [P_[6], P_[7]].forEach((c, i) => { this.insertLeaf(c); this.ct(c, enc[i]); }); }
  receipt(asset, amount, owner, blinding) { need(amount > 0n, 'Zero receipt.'); const c = Z.commitmentOf(asset, amount, owner, blinding); const index = this.insertLeaf(c); this.shield.receipts.push({ owner: String(owner), asset: String(asset), amount: String(amount), blinding: String(blinding), commitment: String(c), index }); return c; }
  async verified(circuit, p) { const r = await this.verifyProof(circuit, p); need(r && r.ok, 'The ' + circuit + ' proof did not verify.'); return r; }
  /// shield_deposit (the wallet signs) -> pending until the publisher admits it (approveDeposits).
  async shieldDeposit(depositor, ext, p) { const v = await this.verified('transact', p); need(BigInt(ext.extAmount) > 0n && BigInt(ext.fee || 0n) === 0n, 'A deposit has a positive amount and no fee.');
    const t = this.sym(ext.mint); need(t, 'Unknown token.'); const P_ = this.checkTransact(p.pubs, ext, t.asset);
    this.debit(depositor, t.sym, BigInt(ext.extAmount)); this.vaultS(t.sym, BigInt(ext.extAmount)); this.useNullifier(P_[4]); this.useNullifier(P_[5]);
    const pend = { pending: keyFrom('pending:' + this.seq + ':' + Math.random()).toBase58(), depositor: b58(depositor), mint: t.mint, amount: String(ext.extAmount), commitments: [String(P_[6]), String(P_[7])], enc: (ext.encOut || []).map((e) => Buffer.from(Z.bytes(e)).toString('hex')), at: Date.now() };
    this.shield.pending.push(pend);
    const id = this.tx('shield_deposit', [{ name: 'DepositPending', ...pend }], { pub: [['Instruction', 'post_proof + shield_deposit (two transactions)'], ['Signer', 'your wallet ' + short(b58(depositor))], ['Token and amount', fmtA(this, t.sym, BigInt(ext.extAmount))], ['Two note commitments', short(String(P_[6])) + ', ' + short(String(P_[7]))], ['Two nullifiers (fresh: nothing spent)', short(String(P_[4])) + ', ' + short(String(P_[5]))]], hidden: [['Who owns the notes', 'only a commitment is public'], ['How the amount is split between them', 'hidden in the commitments']] }, v);
    return { tx: id, pending: pend }; }
  approveDeposits(maxAgeMs = 2500) { let n = 0; for (const d of [...this.shield.pending]) { if (Date.now() - d.at < maxAgeMs) continue; d.commitments.forEach((c, i) => { this.insertLeaf(c); if (d.enc[i]) this.shield.ciphertexts.set(String(c), { data: d.enc[i] }); }); this.shield.pending.splice(this.shield.pending.indexOf(d), 1); n++; }
    if (n) this.tx('approve_deposit', [], { pub: [['Instruction', 'approve_deposit (the approved-set publisher)'], ['Admitted', n + ' deposit' + (n > 1 ? 's' : '')]], hidden: [] }); return n; }
  /// shield_transact: a transfer inside the pool or a withdrawal (ext_amount < 0 to `recipientOwner`).
  async shieldTransact(ext, p, recipientOwner) { const v = await this.verified('transact', p); need(BigInt(ext.extAmount || 0n) <= 0n, 'Use a deposit to add funds.');
    const moves = BigInt(ext.extAmount || 0n) < 0n || BigInt(ext.fee || 0n) > 0n; const t = moves ? this.sym(ext.mint) : null; need(!moves || t, 'Unknown token.');
    const P_ = this.checkTransact(p.pubs, ext, t ? t.asset : null); this.useNullifier(P_[4]); this.useNullifier(P_[5]);
    const out = -BigInt(ext.extAmount || 0n), fee = BigInt(ext.fee || 0n);
    if (out > 0n) { need(recipientOwner, 'No recipient.'); this.vaultS(t.sym, -out); this.credit(recipientOwner, t.sym, out); }
    if (fee > 0n) { this.vaultS(t.sym, -fee); this.credit(this.relayer, t.sym, fee); }
    this.insertOutputs(P_, ext);
    const id = this.tx('shield_transact', [{ name: 'Transacted', extAmount: ext.extAmount, fee }], out > 0n
      ? { pub: [['Instruction', 'post_proof + shield_transact, submitted by the relayer'], ['Leaves the pool', fmtA(this, t.sym, out) + ' to ' + short(b58(recipientOwner))], ['Relayer fee', fmtA(this, t.sym, fee)], ['Two nullifiers, two new commitments', 'unlinkable to the notes they spend']], hidden: [['Which notes were spent, and whose', 'nullifiers cannot be traced to commitments'], ['Your remaining balance', 'the change note hides its amount'], ['Your wallet', 'never signs']] }
      : { pub: [['Instruction', 'post_proof + shield_transact, submitted by the relayer'], ['Two nullifiers, two new commitments', 'no amounts'], ['Relayer fee', fee > 0n ? fmtA(this, t.sym, fee) + ' (so the token is visible)' : 'none: not even the token is visible']], hidden: [['Amount', 'inside the commitments'], ['Sender and receiver', 'neither appears'], ['Which notes were spent', 'nullifiers are unlinkable']] }, v);
    return { txHash: id }; }
  /// = leg_cpi / transact_cpi: a transact proof that funds an entry action (processor = the entry's signer).
  async leg(leg, action, { virt = null } = {}) { const ext = leg.ext; const v = await this.verified('transact', leg.p);
    need(ext.processor && b58(ext.processor) === b58(this.signer), 'The leg is not for the entry program.'); need(BigInt(ext.extAmount || 0n) <= 0n, 'Bad leg.');
    need(Buffer.from(Z.bytes(ext.action)).equals(Buffer.from(action)), 'The proof is bound to a different action.');
    let t = null, asset; if (virt) { need(BigInt(ext.fee || 0n) === 0n, 'Bad leg.'); asset = virt; } else { t = this.sym(ext.mint); need(t, 'Unknown token.'); asset = t.asset; }
    const P_ = this.checkTransact(leg.p.pubs, ext, asset); this.useNullifier(P_[4]); this.useNullifier(P_[5]);
    const amount = -BigInt(ext.extAmount || 0n), fee = BigInt(ext.fee || 0n);
    if (t) { if (amount > 0n) this.vaultS(t.sym, -amount); if (fee > 0n) { this.vaultS(t.sym, -fee); this.credit(this.relayer, t.sym, fee); } }
    this.insertOutputs(P_, ext); return { amount, sym: t && t.sym, fee, v, nullifiers: [P_[4], P_[5]] }; }
  /// shield_swap: one leg pays the route; the output becomes a receipt note (amount public, owner a one-time key).
  async shieldSwap(core, leg) { const L = await this.leg(leg, Z.swapAction(core)); let total = 0n; for (const r of core.routes) total += BigInt(r.amountIn); need(core.routes.length && total === L.amount, 'The route does not spend the leg.');
    let out = 0n; const names = []; for (const r of core.routes) { let amt = BigInt(r.amountIn); for (const h of r.hops) { const P = this.pool(h.pool); const res = this.swapInner(P, !!h.xForY, amt); amt = res.out; names.push(P.x + '–' + P.y); } out += amt; }
    need(out >= BigInt(core.minOut), 'The price moved: less than the minimum out.'); const outT = this.sym(core.tokenOut); this.vaultS(outT.sym, out);
    this.receipt(outT.asset, out, BigInt(core.receiptOwner), BigInt(core.receiptBlinding));
    const id = this.tx('shield_swap', [{ name: 'ShieldSwapped', amountIn: L.amount, amountOut: out, fee: L.fee }], { pub: [['Instruction', 'shield_swap, submitted by the relayer'], ['Route', names.join(' → ')], ['In and out', fmtA(this, L.sym, L.amount) + ' → ' + fmtA(this, outT.sym, out)], ['Output note', 'a receipt to a one-time key: amount public, owner a key never used before'], ['Relayer fee', fmtA(this, L.sym, L.fee)]], hidden: [['Who swapped', 'the proof shows notes were spent, not whose'], ['Your balance before and after', 'change note'], ['Your wallet', 'never signs']] }, L.v);
    return { txHash: id }; }
  /// shield_order / shield_order_withdraw: the shielded aggregate holds the order; order shares are a virtual asset.
  async shieldOrder(core, leg) { const P = this.pool(core.binPool); const L = await this.leg(leg, Z.orderAction(core)); need(L.sym === (core.isAsk ? P.x : P.y), 'The leg must be the order token.');
    this.credit(this.signer, L.sym, L.amount); const shares = this.placeOrder(P, this.signer, this.shieldOwner, this.signer, core.id, !!core.isAsk, L.amount);
    this.receipt(Z.orderAssetOf(P.address, core.id, !!core.isAsk), shares, BigInt(core.receiptOwner), BigInt(core.receiptBlinding));
    const id = this.tx('shield_order', [{ name: 'ShieldOrderPlaced', amount: L.amount, shares }], { pub: [['Instruction', 'shield_order, submitted by the relayer'], ['Order', (core.isAsk ? 'sell ' + P.x : 'buy ' + P.x) + ' in bin ' + core.id + ' of ' + P.x + '–' + P.y], ['Amount', fmtA(this, L.sym, L.amount)], ['Owner on the pool', 'the shielded aggregate (every shielded order together)']], hidden: [['Whose order it is', 'the order shares are a note only you can spend'], ['Your wallet and balance', 'never appear']] }, L.v);
    return { txHash: id }; }
  async shieldOrderWithdraw(core, leg) { const P = this.pool(core.binPool); const asset = Z.orderAssetOf(P.address, core.id, !!core.isAsk); const L = await this.leg(leg, Z.orderWithdrawAction(core), { virt: asset });
    need(L.amount > 0n, 'Nothing to withdraw.'); const o = this.withdrawOrder(P, this.signer, this.shieldOwner, core.id, !!core.isAsk, L.amount, this.signer);
    let lx = o.x, ly = o.y; const fees = (core.leftoverFee || [0n, 0n]).map(BigInt); if (fees[0] > 0n) { this.debit(this.signer, P.x, fees[0]); this.credit(this.relayer, P.x, fees[0]); lx -= fees[0]; } if (fees[1] > 0n) { this.debit(this.signer, P.y, fees[1]); this.credit(this.relayer, P.y, fees[1]); ly -= fees[1]; }
    if (lx > 0n) { this.debit(this.signer, P.x, lx); this.vaultS(P.x, lx); this.receipt(this.tokens[P.x].asset, lx, BigInt(core.receiptOwner[0]), BigInt(core.receiptBlinding[0])); }
    if (ly > 0n) { this.debit(this.signer, P.y, ly); this.vaultS(P.y, ly); this.receipt(this.tokens[P.y].asset, ly, BigInt(core.receiptOwner[1]), BigInt(core.receiptBlinding[1])); }
    const id = this.tx('shield_order_withdraw', [{ name: 'ShieldOrderWithdrawn', amountX: lx, amountY: ly }], { pub: [['Instruction', 'shield_order_withdraw, submitted by the relayer'], ['Paid out', fmtA(this, P.x, lx) + ' + ' + fmtA(this, P.y, ly) + ' as receipt notes to one-time keys']], hidden: [['Whose order it was', 'the spent order notes are unlinkable'], ['Your wallet', 'never signs']] }, L.v);
    return { txHash: id }; }
  /// shield_lp (veyl_entry): legs, the position proof against the window's fee growth H, zap, harvest, charge / pay, burns
  /// and exact mints on the shielded aggregate, the pot, leftovers as receipts, the new position note.
  async shieldLp(core, legs, position) {
    const P = this.pool(core.binPool); const c = core; need(c.deltas.length === K && legs.length <= 2, 'Bad request.'); const action = Z.lpAction(c); const extHash = Z.lpExtHash(c);
    const entry = { x: 0n, y: 0n }; const proofs = [];
    for (const l of legs) { const L = await this.leg(l, action); need(L.sym === P.x || L.sym === P.y, 'The leg is not one of the pool\'s tokens.'); if (L.sym === P.x) entry.x += L.amount; else entry.y += L.amount; proofs.push(L.v); }
    const vp = await this.verified('position', position); proofs.push(vp); const pubs = position.pubs.map(BigInt);
    need(fieldEq(pubs[3], Z.posAssetOf(P.address, c.lo)) && fieldEq(pubs[7], extHash), 'The position proof is for another window or request.');
    const win = []; for (let b = 0; b < K; b++) win.push(c.lo + b); const H = [win.map((id) => this.lpAcc(P, chunkOf(id)).hx[slotOf(id)]), win.map((id) => this.lpAcc(P, chunkOf(id)).hy[slotOf(id)])];
    const assets = [this.tokens[P.x].asset, this.tokens[P.y].asset]; const fee = c.claimFee.map(BigInt);
    need(fieldEq(Z.bundleOf({ growth: H, delta: c.deltas.map(BigInt), assets, fee }), pubs[4]), 'The position proof was made against a different fee growth or request.');
    if (c.zap) { const z = c.zap; need(BigInt(z.amount) > 0n && BigInt(z.minOut) > 0n, 'Bad zap.'); const inS = z.xIn ? 'x' : 'y', outS = z.xIn ? 'y' : 'x'; need(entry[inS] >= BigInt(z.amount), 'The zap swaps more than the legs paid.');
      entry[inS] -= BigInt(z.amount); const r = this.swapInner(P, !!z.xIn, BigInt(z.amount)); need(r.out >= BigInt(z.minOut), 'The price moved: less than the minimum out.'); entry[outS] += r.out; }
    // harvest
    const supply = win.map((id) => { const sa = this.shareAcc(P, this.shieldOwner, this.signer, chunkOf(id), false); return sa ? sa.slots[slotOf(id)].shares : 0n; });
    const hv = win.filter((_, b) => supply[b] > 0n); const dh = [Array(K).fill(0n), Array(K).fill(0n)], got = [Array(K).fill(0n), Array(K).fill(0n)];
    if (hv.length) { const h = this.harvest(P, this.shieldOwner, this.signer, hv); this.vaultS(P.x, h.total.x); this.vaultS(P.y, h.total.y);
      hv.forEach((id, k) => { const b = id - c.lo; got[0][b] = h.got[k][0]; got[1][b] = h.got[k][1]; dh[0][b] = (got[0][b] << 64n) / supply[b]; dh[1][b] = (got[1][b] << 64n) / supply[b]; const a = this.lpAcc(P, chunkOf(id)); a.hx[slotOf(id)] += dh[0][b]; a.hy[slotOf(id)] += dh[1][b]; }); }
    // adjust
    const charge = [0n, 0n], pay = [0n, 0n]; for (let t = 0; t < 2; t++) { let pos = 0n, neg = 0n; for (let b = 0; b < K; b++) { const d = BigInt(c.deltas[b]); const h = dh[t][b]; if (d === 0n || h === 0n) continue; const pr = (d < 0n ? -d : d) * h; if (d > 0n) pos += pr; else neg += pr; } charge[t] = (pos + (1n << 64n) - 1n) >> 64n; pay[t] = neg >> 64n; }
    // burns then exact mints
    const burn = win.map((id, b) => [id, BigInt(c.deltas[b])]).filter((x) => x[1] < 0n);
    if (burn.length) { const o = this.burnInner(P, this.shieldOwner, this.signer, burn.map((x) => x[0]), burn.map((x) => -x[1])); P.vault.x -= o.x; P.vault.y -= o.y; entry.x += o.x; entry.y += o.y; }
    const mintIx = win.map((_, b) => b).filter((b) => BigInt(c.deltas[b]) > 0n);
    if (mintIx.length) { const m = this.mintExact(P, this.shieldOwner, this.signer, mintIx.map((b) => c.lo + b), mintIx.map((b) => BigInt(c.deltas[b])), mintIx.map((b) => BigInt(c.hintX[b])), mintIx.map((b) => BigInt(c.hintY[b])), entry.x, entry.y); entry.x -= m.x; entry.y -= m.y; }
    // dilution: a charge in a token this action does not hold is not taken; the new shares share that harvest instead
    const key = ['x', 'y']; const lf = c.leftoverFee.map(BigInt); const diluted = [false, false];
    for (let t = 0; t < 2; t++) { if (charge[t] <= pay[t]) continue; const needT = charge[t] - pay[t] + lf[t]; if (entry[key[t]] >= needT) continue;
      for (let b = 0; b < K; b++) { const d = BigInt(c.deltas[b]); const g = got[t][b]; if (d <= 0n || g === 0n) continue; const id = c.lo + b; const nd = (g << 64n) / (supply[b] + d); const a = this.lpAcc(P, chunkOf(id)); if (t === 0) a.hx[slotOf(id)] = a.hx[slotOf(id)] - dh[0][b] + nd; else a.hy[slotOf(id)] = a.hy[slotOf(id)] - dh[1][b] + nd; }
      charge[t] = 0n; diluted[t] = true; }
    for (let t = 0; t < 2; t++) need(charge[t] <= BigInt(c.maxCharge[t]), 'Slippage: the fee catch-up is above the cap.');
    // the pot, relayer fees
    for (let t = 0; t < 2; t++) { const s = key[t], sym = t ? P.y : P.x;
      if (charge[t] > pay[t]) { need(entry[s] >= charge[t] - pay[t], 'Short for the fee catch-up.'); entry[s] -= charge[t] - pay[t]; this.vaultS(sym, charge[t] - pay[t]); } else if (pay[t] > charge[t]) { this.vaultS(sym, -(pay[t] - charge[t])); entry[s] += pay[t] - charge[t]; }
      if (fee[t] > 0n) { this.vaultS(sym, -fee[t]); this.credit(this.relayer, sym, fee[t]); }
      if (lf[t] > 0n) { need(entry[s] >= lf[t], 'Short for the relayer fee.'); entry[s] -= lf[t]; this.credit(this.relayer, sym, lf[t]); } }
    // leftovers back into the pool as receipt notes
    const left = [entry.x, entry.y]; if (entry.x > 0n) { this.vaultS(P.x, entry.x); this.receipt(assets[0], entry.x, BigInt(c.receiptOwner[0]), BigInt(c.receiptBlinding[0])); } if (entry.y > 0n) { this.vaultS(P.y, entry.y); this.receipt(assets[1], entry.y, BigInt(c.receiptOwner[1]), BigInt(c.receiptBlinding[1])); }
    // consume the position proof
    need(this.knownRoot(pubs[0]), 'Unknown root: try again.'); this.useNullifier(pubs[1]); for (const cc of [pubs[2], pubs[5], pubs[6]]) if (cc !== 0n) this.insertLeaf(cc); this.ct(pubs[2], c.ciphertext);
    const adds = c.deltas.filter((d) => BigInt(d) > 0n).length, rems = c.deltas.filter((d) => BigInt(d) < 0n).length;
    const id = this.tx('shield_lp', [{ name: 'ShieldLpExecuted', deltas: c.deltas, receipts: left, charge, pay, diluted }], { pub: [['Instruction', 'shield_lp, submitted by the relayer (' + proofs.length + ' proof' + (proofs.length > 1 ? 's' : '') + ')'], ['Change per bin', (adds ? adds + ' bins up' : '') + (adds && rems ? ', ' : '') + (rems ? rems + ' bins down' : '') + (adds + rems === 0 ? 'none (a fee claim)' : '') + ' in bins ' + c.lo + '…' + (c.lo + K - 1) + ' of ' + P.x + '–' + P.y], ['Owner on the pool', 'the shielded aggregate'], ['Paid back as receipts', fmtA(this, P.x, left[0]) + ' + ' + fmtA(this, P.y, left[1])], ['Fees claimed', 'two new commitments, no amounts']], hidden: [['Your position\'s total size', 'a note only you can read'], ['How much you earned', 'claims are proven, not shown'], ['Your wallet', 'never signs']] }, proofs);
    return { txHash: id }; }

  // ---------------------------------------------------------------------------------------------- sealed batches (veyl_entry sealed.rs)
  initCommittee() { this.committee = J.dkgLocal(2, 3); }
  initSealed(P, { epochSlots = 50, minIn = [10_000_000n, 1_000_000n], kMin = 3, maxRollovers = 4, settleSlots = 150, maxDrift = 40 } = {}) {
    const s = { pool: P.address, seq: 0, epochSlots, minIn, kMin, maxRollovers, settleSlots, maxDrift, batches: new Map() }; this.sealed.set(P.address, s); this.openBatch(s, 0); return s; }
  openBatch(s, seq) { const now = this.slot(); const b = { seq, key: SE.batchKey(new PublicKey(s.pool), BigInt(seq)), state: 'open', startSlot: now, endSlot: now + s.epochSlots, closedSlot: 0, count: [0, 0], rollovers: 0, agg: [J.ZERO_CT, J.ZERO_CT], totals: [0n, 0n], num: [0n, 0n], den: [0n, 0n], netIn: 0n, netOut: 0n, xForY: false, verified: 0, shares: [], bots: [], claims: [0, 0], activeAtClose: 0 };
    s.batches.set(seq, b); s.seq = seq; return b; }
  batch(pool, seq) { const s = this.sealed.get(b58(pool)); return s ? s.batches.get(Number(seq)) || null : null; }
  /// submit_swap
  async submitSwap(r) { const s = this.sealed.get(b58(r.binPool)); need(s, 'Sealed swaps are not enabled here.'); const b = s.batches.get(Number(r.seq)); need(b && b.state === 'open' && b.seq === s.seq, 'That batch is closed. Seal into the next one.');
    const d = Number(r.direction); const P = this.pool(r.binPool); const sym = d === 0 ? P.x : P.y; const T = this.tokens[sym];
    const v = await this.verified('swap', r.p); const pubs = r.p.pubs.map(BigInt); need(fieldEq(pubs[5], b.key), 'The proof is for another batch.');
    const c1 = J.dec(Buffer.from(r.c1, 'base64')), c2 = J.dec(Buffer.from(r.c2, 'base64')); need(J.isOnCurve(c1) && J.isOnCurve(c2), 'Bad ciphertext.');
    const ext = { relayer: new PublicKey(r.ext.relayer), fee: BigInt(r.ext.fee || 0), encChange: Buffer.from(r.ext.encChange, 'base64'), encSwap: Buffer.from(r.ext.encSwap, 'base64') };
    need(fieldEq(SE.swapBundle({ direction: d, asset: T.asset, fee: ext.fee, minIn: s.minIn[d], c1, c2, pk: this.committee.PK }), pubs[6]), 'The proof\'s ciphertext or committee key does not match.');
    need(fieldEq(SE.swapExtHash(ext), pubs[7]), 'The proof is for different external data.'); need(this.knownRoot(pubs[0]), 'Unknown root: try again.');
    this.useNullifier(pubs[1]); this.useNullifier(pubs[2]); if (ext.fee > 0n) { this.vaultS(sym, -ext.fee); this.credit(this.relayer, sym, ext.fee); }
    this.insertLeaf(pubs[3]); this.insertLeaf(pubs[4]); this.ct(pubs[3], ext.encChange); this.ct(pubs[4], ext.encSwap);
    b.agg[d] = J.addCt(b.agg[d], { c1, c2 }); b.count[d] += 1; this.holds.delete(s.pool + ':' + b.seq);
    const id = this.tx('submit_swap', [{ name: 'SealedSwapSubmitted', seq: b.seq, direction: d, count: [...b.count] }], { pub: [['Instruction', 'post_proof + submit_swap, submitted by the relayer'], ['Batch', P.x + '–' + P.y + ' #' + b.seq + ', selling ' + sym], ['Ciphertext', '(C1, C2) on Baby Jubjub, added to the batch\'s ' + sym + ' total'], ['Relayer fee', fmtA(this, sym, ext.fee)]], hidden: [['How much you sold', 'encrypted to the 2-of-3 committee; only the batch total is ever decrypted'], ['Who sealed it', 'two nullifiers, no owner'], ['Your balance', 'change note']] }, v);
    this.emit({ type: 'sealed', pool: s.pool }); return { txHash: id }; }
  /// Bots seal swaps too: a real ciphertext into the aggregate, tokens into the shielded vault. They make no proofs.
  botSeal(P, d, amount) { const s = this.sealed.get(P.address); const b = s.batches.get(s.seq); if (!b || b.state !== 'open') return; const sym = d === 0 ? P.x : P.y; const bot = keyFrom('bot:sealer:' + (b.bots.length % 5));
    if (this.bal(bot, sym) < amount) this.credit(bot, sym, amount * 10n); this.debit(bot, sym, amount); this.vaultS(sym, amount);
    const ct = J.encrypt(this.committee.PK, amount); b.agg[d] = J.addCt(b.agg[d], ct); b.count[d] += 1; b.bots.push({ bot: bot.toBase58(), d, amount: String(amount) }); this.emit({ type: 'sealed', pool: P.address }); }
  hold(pool, seq) { this.holds.set(b58(pool) + ':' + seq, Date.now()); }
  /// close_batch + the committee: shares with DLEQ proofs, verified; totals by baby-step giant-step (`dlog`, async, a
  /// worker); settle_batch nets the two sides at the active bin and makes one swap through the pool.
  async tickSealed(dlog) { for (const s of this.sealed.values()) { const b = s.batches.get(s.seq); if (!b || b.state !== 'open') continue; const now = this.slot(); if (now < b.endSlot) continue;
      const held = this.holds.get(s.pool + ':' + b.seq); if (held && Date.now() - held < 10 * 60_000) { b.endSlot = now + 5; continue; }
      const under = [0, 1].some((d) => b.count[d] > 0 && b.count[d] < s.kMin);
      if (b.count[0] + b.count[1] === 0) { b.endSlot = now + s.epochSlots; continue; }
      if (under && b.rollovers < s.maxRollovers) { b.rollovers += 1; b.endSlot = now + s.epochSlots; this.tx('close_batch', [], { pub: [['Batch', '#' + b.seq + ' rolled over: a side has fewer than ' + s.kMin + ' sellers'], ['Sellers', b.count.join(' + ')]], hidden: [['Amounts', 'still encrypted']] }); continue; }
      b.closedSlot = now; const P = this.pool(s.pool);
      if (under) { b.state = 'failed'; this.refundBots(P, b); this.openBatch(s, b.seq + 1); this.tx('close_batch', [], { pub: [['Batch', '#' + b.seq + ' failed: too few sellers on a side; everything refunds']], hidden: [] }); continue; }
      b.state = 'closed'; b.activeAtClose = P.p.activeId; this.openBatch(s, b.seq + 1); this.emit({ type: 'sealed', pool: s.pool });
      this.tx('close_batch', [], { pub: [['Batch', '#' + b.seq + ' sealed'], ['Sellers', P.x + ' ' + b.count[0] + ', ' + P.y + ' ' + b.count[1]], ['Aggregates', 'two ciphertexts per side, published']], hidden: [['Each swap\'s size', 'never decrypted']] });
      this.settleBatch(s, b, P, dlog).catch((e) => { b.error = e.message; }); } }
  async settleBatch(s, b, P, dlog) {
    const t0 = Date.now(); const C1a = b.agg[0].c1, C1b = b.agg[1].c1; const members = this.committee.members.slice(0, 2); // members 1 and 2 answer (t = 2 of n = 3)
    const shares = members.map((m) => J.partialDecrypt({ batchKey: b.key, index: m.index, sk: m.sk, PKi: m.PK, C1a, C1b }));
    for (const sh of shares) { need(J.verifyPartial({ batchKey: b.key, PKi: this.committee.members[sh.index - 1].PK, C1a, C1b, share: sh }), 'A committee share failed its Chaum-Pedersen check.'); b.verified |= 1 << (sh.index - 1); }
    b.shares = shares.map((x) => x.index);
    const totals = []; for (const [d, which] of [[0, 'a'], [1, 'b']]) { if (b.count[d] === 0) { totals.push(0n); continue; } const M = J.combine(b.agg[d].c2, shares, which); const m = await dlog(M); need(m !== null, 'The batch total is out of range.'); need(J.eq(J.mulB(m), M), 'Bad total.'); totals.push(m); }
    b.totals = totals; b.decryptMs = Date.now() - t0;
    const price = priceOf(P.p.basePrice, P.p.binStep, P.p.activeId);
    need(Math.abs(P.p.activeId - b.activeAtClose) <= s.maxDrift, 'The price drifted too far since the batch closed.');
    const sym = [P.x, P.y]; const cl = await SE.clearing({ totals, price, quote: async (xForY, amt) => { const r = this.swapInner(P, xForY, amt); return r.out; } });
    // the net swap: the excess side's tokens leave the shielded vault into the pool, the output comes back
    if (cl.netIn > 0n) { const inS = cl.xForY ? 0 : 1; this.vaultS(sym[inS], -cl.netIn); this.vaultS(sym[1 - inS], cl.netOut); }
    Object.assign(b, { state: 'settled', num: cl.num, den: cl.den, netIn: cl.netIn, netOut: cl.netOut, xForY: cl.xForY, settledAt: Date.now() });
    // bots' outputs at the clearing ratio (their notes are not simulated)
    for (const x of b.bots) { const out = SE.claimOut(BigInt(x.amount), b.num[x.d], b.den[x.d]); if (out > 0n) { this.vaultS(sym[1 - x.d], -out); this.credit(x.bot, sym[1 - x.d], out); } }
    this.tx('settle_batch', [{ name: 'BatchSettled', seq: b.seq, totals, num: cl.num, den: cl.den }], { pub: [['Committee', '2 of 3 shares, each with a Chaum–Pedersen proof, verified'], ['Totals', fmtA(this, P.x, totals[0]) + ' and ' + fmtA(this, P.y, totals[1]) + ' sold'], ['Net swap', cl.netIn > 0n ? fmtA(this, sym[cl.xForY ? 0 : 1], cl.netIn) + ' → ' + fmtA(this, sym[cl.xForY ? 1 : 0], cl.netOut) + ' through the pool' : 'none: the sides matched'], ['Clearing price', 'the active bin\'s, for every seller']], hidden: [['Each seller\'s amount', 'only the totals were decrypted']] });
    this.emit({ type: 'sealed', pool: s.pool }); }
  refundBots(P, b) { for (const x of b.bots) { const sym = x.d === 0 ? P.x : P.y; this.vaultS(sym, -BigInt(x.amount)); this.credit(x.bot, sym, BigInt(x.amount)); } }
  claimTerms(pool, seq, direction) { const s = this.sealed.get(b58(pool)); const b = s && s.batches.get(Number(seq)); if (!b) return null; const P = this.pool(pool); const d = Number(direction);
    const mintIn = new PublicKey(this.tokens[d === 0 ? P.x : P.y].mint), mintOther = new PublicKey(this.tokens[d === 0 ? P.y : P.x].mint);
    if (b.state === 'settled') return b.den[d] > 0n ? { refund: false, mintOut: mintOther, num: b.num[d], den: b.den[d], batch: b } : null;
    if (b.state === 'failed') return { refund: true, mintOut: mintIn, num: 1n, den: 1n, batch: b }; return null; }
  /// claim_swap
  async claimSwap(r) { const s = this.sealed.get(b58(r.binPool)); const b = s && s.batches.get(Number(r.seq)); need(b, 'Unknown batch.'); const d = Number(r.direction);
    const terms = this.claimTerms(r.binPool, r.seq, d); need(terms, 'This batch has not settled yet.'); const T = this.sym(terms.mintOut);
    const v = await this.verified('claim', r.p); const pubs = r.p.pubs.map(BigInt); need(fieldEq(pubs[3], b.key), 'The proof is for another batch.');
    const ext = { relayer: new PublicKey(r.ext.relayer), fee: BigInt(r.ext.fee || 0), encOut: Buffer.from(r.ext.encOut, 'base64') };
    need(fieldEq(SE.claimBundle({ direction: d, assetOut: T.asset, num: terms.num, den: terms.den, fee: ext.fee }), pubs[4]), 'The proof does not claim at this batch\'s ratio.');
    need(fieldEq(SE.claimExtHash(ext), pubs[5]), 'The proof is for different external data.'); need(this.knownRoot(pubs[0]), 'Unknown root: try again.');
    this.useNullifier(pubs[1]); if (ext.fee > 0n) { this.vaultS(T.sym, -ext.fee); this.credit(this.relayer, T.sym, ext.fee); } this.insertLeaf(pubs[2]); this.ct(pubs[2], ext.encOut); b.claims[d] += 1;
    const id = this.tx('claim_swap', [{ name: 'SealedClaimed', seq: b.seq, direction: d, refund: terms.refund }], { pub: [['Instruction', 'post_proof + claim_swap, submitted by the relayer'], ['Batch', '#' + b.seq + (terms.refund ? ' (refund)' : ', at its clearing ratio')], ['New note', 'one commitment, no amount'], ['Relayer fee', fmtA(this, T.sym, ext.fee)]], hidden: [['How much you received', 'the proof computed it from your hidden amount'], ['Which sealed swap was yours', 'one nullifier, unlinkable']] }, v);
    return { txHash: id }; }

  // ---------------------------------------------------------------------------------------------- the play world
  /// Fresh state: pools with a market maker's curve of liquidity around the starting price, a farm on SOL–USDC, the
  /// committee's key, sealed batches on two pools, and a short history of bot trades.
  /// Fresh state. `usd` = { SYM: dollars } (the live market when it answered, else the config's fallback prices); `hist` =
  /// { SYM: [{ t, close }] } real 5-minute closes for the last 24 hours when available. Pools open at the price of 24 hours
  /// ago and bots trade them along the real path to now (the sandbox's history); without history, a random walk.
  seed(usd = {}, hist = {}) {
    this.usd = { ...Object.fromEntries(Object.values(this.tokens).map((t) => [t.sym, t.price])), ...usd };
    const now = nowS(); this.hist = hist;
    for (const c of this.poolCfg) { const px0 = this.histPrice(c, now - 86400) || this.usd[c.x] / this.usd[c.y]; const P = this.createPool(c, px0);
      P.createdAt = now - 26 * 3600 - Math.floor(Math.random() * 3600); this.mmCurve(P, 0, c.span || 40, c.liqUsd, now);
      P.target = 0; if (c.reward) this.initReward(P, 0, c.reward.sym, BigInt(Math.round(c.reward.amount * 10 ** this.tokens[c.reward.sym].decimals)), c.reward.days * 86400);
      if (c.sealed) { if (!this.committee) this.initCommittee(); this.initSealed(P, c.sealed); } }
    for (let i = 0, N = 800; i < N; i++) { const at = now - 86400 + Math.floor((i / N) * 86400); this.botTrade(true, at); if (i % 100 === 99) for (const P of this.pools.values()) this.mmTick(P, at); }
    for (const P of this.pools.values()) P.target = P.p.activeId;
    this.anchored = Object.keys(hist).length ? 'history' : Object.keys(usd).length ? 'market' : 'fallback';
    this.tx('genesis', [], { pub: [['Pools', this.poolCfg.map((c) => c.x + '–' + c.y).join(', ')], ['Prices', this.anchored === 'history' ? 'the last 24 hours of real market prices (5-minute closes)' : this.anchored === 'market' ? 'today\'s market price' : 'fallback prices: market price unavailable'], ['Committee', '2-of-3 key made by a joint DKG in this page']], hidden: [] });
  }
  /// A market maker's curve of liquidity, `span` bins either side of `center`, worth about `liqUsd` per side.
  mmCurve(P, center, span, liqUsd, now = nowS()) { const c = P.cfg; const mm = keyFrom('mm:' + c.id); const ids = []; for (let i = center - span; i <= center + span; i++) ids.push(i);
    const a = P.p.activeId; const w = S.shapeWeights(ids, a, 'curve'); for (const k of ['weightsX', 'weightsY']) w[k] = w[k].map((v, i) => (ids[i] === a ? v : v * 2));
    const X = this.tokens[c.x], Y = this.tokens[c.y]; const ux = this.usd[c.x] || 1, uy = this.usd[c.y] || 1;
    const ax = BigInt(Math.round((liqUsd / ux) * 10 ** X.decimals)), ay = BigInt(Math.round((liqUsd / uy) * 10 ** Y.decimals)); this.credit(mm, c.x, ax); this.credit(mm, c.y, ay);
    const xs = distribute(ax, w.weightsX), ys = distribute(ay, w.weightsY); const keep = ids.map((_, i) => xs[i] > 0n || ys[i] > 0n);
    try { this.mint(P, mm, keyFrom('mm-owner:' + c.id), mm, ids.filter((_, i) => keep[i]), xs.filter((_, i) => keep[i]), ys.filter((_, i) => keep[i])); } catch { /* a bin too small: skip */ } }
  /// The market maker keeps liquidity where the price is heading: when the target bin is near or past the edge of the
  /// liquidity, a single-sided curve goes in ahead of the price (X above it, Y below it), so bots can trade the price there.
  mmTick(P, now = nowS()) { const c = P.cfg; const t = this.targetOf(P, now); if (t === null) return; const a = P.p.activeId; const gap = t - a; if (Math.abs(gap) < 4) return;
    const ahead = (from, to) => { let v = 0; for (let id = from; from <= to ? id <= to : id >= to; id += from <= to ? 1 : -1) { const b = P.bins.get(id); if (b && (gap > 0 ? b.x > 0n : b.y > 0n)) v++; } return v; };
    const edge = gap > 0 ? a + Math.abs(gap) + 4 : a - Math.abs(gap) - 4; if (ahead(a + Math.sign(gap), edge) >= Math.abs(gap)) return;
    const mm = keyFrom('mm:' + c.id); const span = Math.abs(gap) + 12; const ids = []; for (let k = 1; k <= span; k++) ids.push(a + Math.sign(gap) * k); ids.sort((x, y) => x - y);
    const sym = gap > 0 ? c.x : c.y; const T = this.tokens[sym]; const amt = BigInt(Math.round(((c.liqUsd * span) / (4 * (c.span || 40)) / (this.usd[sym] || 1)) * 10 ** T.decimals)); this.credit(mm, sym, amt);
    const w = ids.map(() => 1); const xs = gap > 0 ? distribute(amt, w) : ids.map(() => 0n), ys = gap > 0 ? ids.map(() => 0n) : distribute(amt, w);
    try { this.mint(P, mm, keyFrom('mm-owner:' + c.id), mm, ids, xs, ys); } catch { /* skip */ } }
  /// Live market prices: { SYM: dollars }. Bots trade each pool toward its market price from now on.
  setMarket(usd) { this.market = { ...(this.market || {}), ...usd }; this.marketAt = Date.now(); for (const [k, v] of Object.entries(usd)) if (v > 0) this.usd[k] = v; }
  histPrice(c, t) { const h = this.hist || {}; const at = (sym) => { if (sym === 'USDC') return 1; const a = h[sym]; if (!a || !a.length) return null; let v = null; for (const p of a) { if (p.t <= t) v = p.close; else break; } return v === null ? a[0].close : v; };
    if (!(h[c.x] && h[c.x].length) && !(h[c.y] && h[c.y].length)) return null; const x = at(c.x), y = at(c.y); return x && y ? x / y : null; }
  /// The bin a pool should trade toward at time `t`: its real price then (history), or now (live market), else a walk.
  targetOf(P, t = nowS()) { const c = P.cfg; let px = null;
    if (t < nowS() - 120) px = this.histPrice(c, t); else if (this.market && this.market[c.x] && this.market[c.y]) px = this.market[c.x] / this.market[c.y];
    if (!px) return null; const p0 = this.humanPrice(P, 0); return Math.round(Math.log(px / p0) / Math.log(1 + c.binStep / 10_000)); }
  /// The bin of the reference price (the last known market price, else the config's dated fallback): a pool with no live
  /// market wanders around it rather than drifting away from it.
  refBin(P) { const c = P.cfg; const ux = this.usd[c.x], uy = this.usd[c.y]; if (!(ux > 0 && uy > 0)) return null; const p0 = this.humanPrice(P, 0);
    return Math.round(Math.log((ux / uy) / p0) / Math.log(1 + c.binStep / 10_000)); }
  /// A public swap along a route (the wallet signs: everything about it is public).
  swapRoute(from, symIn, symOut, hops, amountIn, minOut, now = nowS()) { need(amountIn > 0n, 'Enter an amount.'); this.debit(from, symIn, amountIn); let amt = amountIn; const names = [];
    try { for (const h of hops) { const P = this.pool(h.pool); const r = this.swapInner(P, !!h.xForY, amt, now); amt = r.out; names.push(P.x + '–' + P.y); } }
    catch (e) { this.credit(from, symIn, amountIn); throw e; }
    if (amt < minOut) throw new ChainError('The price moved: less than the minimum out.');
    this.credit(from, symOut, amt); return { out: amt, route: names }; }
  /// Play tokens: public balances in the practice wallet, and a little straight into the shielded balance (a receipt note to
  /// one of the account's one-time keys, so a private swap needs only its own proof).
  static FAUCET = { SOL: 25, USDC: 4000, USDT: 4000, JUP: 5000, BONK: 200_000_000 };
  /// What the faucet also puts straight into the shielded pool as notes (one one-time key per token, in this order).
  static FAUCET_SHIELDED = [['SOL', 5], ['USDC', 800], ['USDT', 800], ['JUP', 1000], ['BONK', 40_000_000]];
  faucet(owner, oneTime) { const g = SandboxChain.FAUCET; for (const [k, v] of Object.entries(g)) if (this.tokens[k]) this.credit(owner, k, BigInt(Math.round(v * 10 ** this.tokens[k].decimals)));
    const sh = [];
    if (oneTime) { SandboxChain.FAUCET_SHIELDED.forEach(([k, v], i) => { const t = this.tokens[k], o = oneTime[i]; if (!t || !o) return; const a = BigInt(Math.round(v * 10 ** t.decimals)); this.vaultS(k, a); this.receipt(t.asset, a, BigInt(o.pk), BigInt(o.blinding)); sh.push(fmtA(this, k, a)); }); }
    return this.tx('faucet', [], { pub: [['Faucet', 'demo funds to your wallet ' + short(b58(owner))], ['Shielded receipts', sh.join(' and ') + ' as notes to one-time keys']], hidden: [['Which receipts are yours', 'one-time keys are not linked to your wallet']] }); }
  /// Bots: public swaps. Each pool trades toward its real market price (history, then live) with some noise, sized by
  /// what lies between the active bin and the target; without a market price, toward a slowly wandering target.
  botTrade(quiet = false, at = nowS(), pick = null, noisy = true) { const pools = [...this.pools.values()]; const P = pick || pools[Math.floor(Math.random() * pools.length)]; const c = P.cfg;
    let target = this.targetOf(P, at); const real = target !== null;
    if (!real) { if (Math.random() < 0.3) P.target += Math.round((Math.random() - 0.5) * (c.wander || 6)); const ref = this.refBin(P); const band = Math.min(c.wander || 6, Math.max(2, Math.round(100 / c.binStep))); // about 1% either side at most
      P.target = Math.max(P.p.activeId - 12, Math.min(P.p.activeId + 12, P.target)); if (ref !== null) P.target = Math.max(ref - band, Math.min(ref + band, P.target)); target = P.target; }
    else if (noisy) target += Math.round((Math.random() - 0.5) * 2.4);
    const a = P.p.activeId; const gap = target - a; const xForY = gap === 0 ? Math.random() < 0.5 : gap < 0; const sym = xForY ? P.x : P.y; const T = this.tokens[sym];
    // what crossing to the target takes: the other token in the bins between (in this token's units)
    let need = 0; if (gap !== 0) for (let id = a; xForY ? id > target : id < target; id += xForY ? -1 : 1) { const b = P.bins.get(id); if (!b) continue; const px = this.humanPrice(P, id);
      need += xForY ? this.fmtN(P.y, b.y + b.bidY) / px : this.fmtN(P.x, b.x + b.askX) * px; }
    const noise = (c.botUsd || 500) / (this.usd[sym] || 1) * (0.2 + Math.random() * 0.8); const human = Math.min(noisy ? need * (0.5 + Math.random() * 0.6) + noise : need * 0.98 + noise * 0.05, (c.liqUsd / (this.usd[sym] || 1)) * 0.25);
    const amt = BigInt(Math.max(1, Math.round(human * 10 ** T.decimals))); const bot = keyFrom('bot:' + Math.floor(Math.random() * 7)); if (this.bal(bot, sym) < amt) this.credit(bot, sym, amt * 20n);
    try { const r = this.swapRoute(bot, sym, xForY ? P.y : P.x, [{ pool: P.address, xForY }], amt, 0n, at); if (!quiet) this.tx('swap', [], { pub: [['Swap by a bot', fmtA(this, sym, amt) + ' → ' + fmtA(this, xForY ? P.y : P.x, r.out)], ['Toward', real ? 'the market price' : 'a random walk (market price unavailable)'], ['Signer', short(b58(bot))]], hidden: [] }); } catch { /* not enough liquidity that way: skip */ } }
  /// Trade each pool to its market price now (after seeding or a long absence): a few sized swaps and the market maker.
  catchUp() { for (const P of this.pools.values()) for (let i = 0; i < 40; i++) { const t = this.targetOf(P); if (t === null || Math.abs(t - P.p.activeId) <= 1) break; this.mmTick(P); this.botTrade(true, nowS(), P, false); } }
  fmtN(sym, v) { return Number(BigInt(v)) / 10 ** this.tokens[sym].decimals; }
  /// Bots seal small swaps into each open batch so it reaches the k floor on both sides and settles.
  botSealTick() { for (const s of this.sealed.values()) { const b = s.batches.get(s.seq); if (!b || b.state !== 'open') continue; const P = this.pool(s.pool); const left = b.endSlot - this.slot();
      for (const d of [0, 1]) { if (b.count[d] >= s.kMin + 1 || b.count[d] >= 8) continue; if (b.count[d] >= s.kMin && Math.random() < 0.7) continue; if (left > s.epochSlots * 0.4 && Math.random() < 0.5) continue;
        const sym = d === 0 ? P.x : P.y; const T = this.tokens[sym]; const human = ((P.cfg.sealBotUsd || 10) / (this.usd[sym] || 1)) * (0.4 + Math.random() * 1.6);
        let amt = BigInt(Math.round(human * 10 ** T.decimals)); if (amt < s.minIn[d]) amt = s.minIn[d]; this.botSeal(P, d, amt); } } }
  humanPrice(P, id = P.p.activeId) { const q = Number(priceOf(P.p.basePrice, P.p.binStep, id)) / 2 ** 128; return q * 10 ** (this.tokens[P.x].decimals - this.tokens[P.y].decimals); }
  // ---------------------------------------------------------------------------------------------- persistence
  toJSON() { const pools = [...this.pools.values()].map((P) => ({ id: P.id, p: P.p, bins: [...P.bins.values()], shares: [...P.shares.entries()], vault: P.vault, rewardVault: P.rewardVault, buckets: P.buckets, createdAt: P.createdAt, target: P.target || 0 }));
    const sealed = [...this.sealed.values()].map((s) => ({ ...s, batches: [...s.batches.values()].filter((b) => b.seq >= s.seq - 12) }));
    return { v: 6, usd: this.usd, anchored: this.anchored, seq: this.seq, t0: this.t0, balances: [...this.balances.entries()], pools, lpacc: [...this.lpacc.entries()], shield: { leaves: this.shield.tree.leaves, roots: this.shield.roots, ciphertexts: [...this.shield.ciphertexts.entries()], receipts: this.shield.receipts, nullified: [...this.shield.nullified], vault: this.shield.vault, pending: this.shield.pending },
      sealed, committee: this.committee, log: this.log.slice(0, 120) }; }
  load(o) { need(o && o.v === 6, 'Old sandbox state.'); this.usd = o.usd || {}; this.anchored = o.anchored; this.seq = o.seq; this.t0 = o.t0; this.balances = new Map(o.balances);
    for (const x of o.pools) { const c = this.poolCfg.find((q) => q.id === x.id); if (!c) continue; const P = this.createPool(c, 1); P.p = x.p; P.bins = new Map(x.bins.map((b) => [b.id, b])); P.shares = new Map(x.shares); P.vault = x.vault; P.rewardVault = x.rewardVault; P.buckets = x.buckets || []; P.createdAt = x.createdAt || nowS(); P.target = x.target || 0; }
    this.lpacc = new Map(o.lpacc); this.shield.tree = new Z.Tree(o.shield.leaves.map(BigInt)); this.shield.roots = o.shield.roots; this.shield.ciphertexts = new Map(o.shield.ciphertexts); this.shield.receipts = o.shield.receipts;
    this.shield.nullified = new Set(o.shield.nullified); this.shield.vault = o.shield.vault; this.shield.pending = o.shield.pending; this.committee = o.committee;
    for (const s of o.sealed) this.sealed.set(s.pool, { ...s, batches: new Map(s.batches.map((b) => [b.seq, b])) }); this.log = o.log || []; }
}
// ---------------------------------------------------------------------------------------------- serialisation (BigInt, PublicKey, Uint8Array)
export const ser = (o) => JSON.stringify(o, function (k, v) { const raw = this[k];
  if (typeof raw === 'bigint') return { $b: raw.toString() }; if (raw instanceof PublicKey) return { $k: raw.toBase58() }; if (raw instanceof Uint8Array) return { $u: Buffer.from(raw).toString('base64') }; return v; });
export const deser = (s) => JSON.parse(s, (k, v) => { if (v && typeof v === 'object' && !Array.isArray(v)) { if ('$b' in v) return BigInt(v.$b); if ('$k' in v) return new PublicKey(v.$k); if ('$u' in v) return Buffer.from(v.$u, 'base64'); } return v; });
const short = (s) => { s = String(s); return s.length > 14 ? s.slice(0, 6) + '…' + s.slice(-4) : s; };
const fmtA = (ch, sym, v) => { const t = ch.tokens[sym]; const n = Number(BigInt(v)) / 10 ** t.decimals; return (n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(+n.toPrecision(6))) + ' ' + sym; };
export { ChainError, fmtA, short };
