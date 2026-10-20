// The fee floor (REVIEW.md M-1): what a request costs this relayer, the fee that covers it, POST /fee.
// Part of the Relayer class (relayer/relayer.js composes these mixins in one place).
'use strict';
const { PublicKey } = require('@solana/web3.js');
const S = require('../sdk/veyl.js'); const { SIZES, rentOf } = S;
const Z = require('../sdk/shield.js');
const { TX_FEE, WORST, SHIELD_KINDS, PROOF_LEGS, deepBig } = require('./costs.js');
module.exports = (Base) => class Fees extends Base {
  // ---- the fee floor: the fee must at least pay back what the request costs the relayer (rent it never recovers + fees)
  /// Lamports -> atoms of `sym` at the configured prices (x feeCover, rounded up); 0n when a price is missing (no floor).
  atomsFor(lamports, sym) { const sol = this.prices.SOL, px = this.prices[sym] || (this.derivedPrices && this.derivedPrices[sym]), t = this.dep.tokens[sym] || (this.extraTokens && this.extraTokens[sym]); if (!sol || !px || !t) return 0n;
    return BigInt(Math.ceil((lamports / 1e9) * (sol / px) * 10 ** t.decimals * this.feeCover)); }
  /// Per kind and token: the smallest fee in atoms that covers the worst case (what the app uses to pick feeBps).
  minFeeTable() { const out = {}; for (const [kind, lam] of Object.entries(WORST)) { out[kind] = {}; for (const sym of Object.keys(this.dep.tokens)) out[kind][sym] = this.atomsFor(lam, sym).toString(); } return out; }
  /// parts: [{ sym, atoms }] fees paid in each token; refuses unless together they cover `lamports`.
  _coverOrRefuse(lamports, parts) {
    const all = parts; parts = parts.filter((x) => !this._unvalued(x.sym)); /* a discovered token without a price pays nothing toward the floor */
    if (all.length && !parts.length) throw new Error('this relayer cannot value ' + [...new Set(all.map((x) => x.sym))].join(', ') + ' for its fee yet: no pool of it against a priced token is deep enough');
    if (parts.some((x) => this.atomsFor(1e9, x.sym) === 0n)) return; // no price for one of the deployment's tokens: no floor
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
  async shieldFeeQuote(req) { const sym = this._symOfMint(req.mint); if (this._unvalued(sym)) this._coverOrRefuse(0, [{ sym, atoms: 0n }]);
    let lam = await this.shieldCost(req.kind, req); if (this.extraTokens && this.extraTokens[sym] && (await this._missing([this._feeAta(req.mint)]))) lam += rentOf(SIZES.tokenAccount); /* its fee account, made at submit */
    const atoms = this.atomsFor(lam, sym);
    return { fee: (atoms > 0n ? atoms : 0n).toString(), costLamports: lam, sym }; }
};
