// Phase 3 (sealed batch swaps): GET /sealed, and the permissionless crank that closes and fails batches.
// Part of the Relayer class (relayer/relayer.js composes these mixins in one place).
'use strict';
const { PublicKey } = require('@solana/web3.js');
/// Why a pool has no sealed swaps, for /sealed and the app.
function sealedOff(bp) { if (!bp) return { enabled: false, reason: 'unknown-pool', why: 'There is no such pool.' };
  return { enabled: false, reason: 'not-enabled', why: 'Sealed swaps are turned on pool by pool by the batch committee; this pool does not have them (yet). Instant private swaps work.' }; }
module.exports = (Base) => class Sealed extends Base {
  /// Phase 3: a pool's sealed-swap state for the app: settings, the current batch (no amounts: only counts per direction,
  /// timing and state), the last finished batch's public outcome, and the committee's key and threshold.
  /// Sealed swaps are turned on pool by pool by the committee's authority (init_sealed_pool); a pool without them (every
  /// pool listed by anyone since the deploy, until then) answers { enabled: false, reason, why }.
  async sealedState(pool) { const V = this.V; const st = await V.sealedState(new PublicKey(pool)); if (!st) return sealedOff(await V.binPool(new PublicKey(pool)));
    const c = await V.committee(); const { sealed: s, batch: b, slot } = st; const last = s.seq > 0n ? await V.batch(new PublicKey(pool), s.seq - 1n) : null;
    const pub = (x) => x && { seq: String(x.seq), state: x.state, count: x.count, rollovers: x.rollovers, endSlot: String(x.endSlot), closedSlot: String(x.closedSlot), verified: x.verified, totals: x.totals.map(String), num: x.num.map(String), den: x.den.map(String), xForY: x.xForY, netIn: String(x.netIn), netOut: String(x.netOut), settleId: x.settleId };
    return { enabled: true, slot, slotMs: 400, paused: s.paused, mintX: s.mintX.toBase58(), mintY: s.mintY.toBase58(), seq: String(s.seq), epochSlots: String(s.epochSlots), settleTimeout: String(s.settleTimeout), minIn: s.minIn.map(String), kMin: s.kMin, maxRollovers: s.maxRollovers,
      batch: pub(b), last: pub(last), committee: c ? { t: c.t, n: c.n, epoch: c.epoch, kind: c.kind, pk: Buffer.from(require('../sdk/bjj.js').enc(c.pk)).toString('hex') } : null }; }
  /// Permissionless upkeep of every sealed pool: close a batch whose epoch is over; fail a closed one past its window.
  /// Only pools with a sealed account are cranked: all of them in one getProgramAccounts read (pools listed since the deploy
  /// included, once the committee turns them on; the others are skipped), refreshed every 15 s (a deployment with no
  /// committee has none, and per-pool reads every few seconds would exhaust a public RPC's rate limit). If that read is
  /// refused, the deployment's pools are checked one batched read per 100 instead.
  crankSealed() {
    if (this._crankPromise) return this._crankPromise;
    this._crankPromise = this._crankSealedOnce().finally(() => { this._crankPromise = null; });
    return this._crankPromise;
  }
  async _crankSealedOnce() { const V = this.V; let n = 0;
    if (!this._sealedAt || Date.now() - this._sealedAt > 15_000) { let found = [];
      try { const name = new Map(this.dep.binPools.map((b) => [b.address, b.id])); found = (await V.sealedPools()).map((s) => ({ address: s.binPool.toBase58(), id: name.get(s.binPool.toBase58()) || s.binPool.toBase58().slice(0, 8) })); }
      catch { const all = this.dep.binPools; for (let i = 0; i < all.length; i += 100) { const part = all.slice(i, i + 100); const infos = await V.conn.getMultipleAccountsInfo(part.map((b) => V.sealedPda(new PublicKey(b.address))), 'confirmed'); part.forEach((b, j) => { if (infos[j]) found.push(b); }); } }
      /* delisted pools: their empty batches aren't rolled any more (a batch holding swaps still closes, settles or fails) */
      try { const infos = await V.conn.getMultipleAccountsInfo(found.map((b) => new PublicKey(b.address)), 'confirmed'); found.forEach((b, j) => { b.delisted = !!(infos[j] && require('../sdk/veyl.js').decodeBinPool(new PublicKey(b.address), infos[j].data).delisted); }); } catch { /* unknown: crank as before */ }
      this._sealed = found; this._sealedAt = Date.now(); }
    for (const b of this._sealed) { const pool = new PublicKey(b.address); try { const st = await V.sealedState(pool); if (!st || !st.batch) continue; const { sealed: s, batch: x, slot } = st;
      if (x.state === 'open' && BigInt(slot) >= x.endSlot + 2n && !(b.delisted && x.count[0] + x.count[1] === 0)) { /* 2 slots of grace: the committee's nodes usually close first */ await V.send([V.closeBatchIx(this.wallet.publicKey, pool, x.seq)], [], 1_400_000); n++; }
      for (let q = s.seq - 1n; q >= 0n && q >= s.seq - 4n; q--) { const y = await V.batch(pool, q); if (y && y.state === 'closed' && BigInt(slot) > y.closedSlot + s.settleTimeout) { await V.send([V.failBatchIx(pool, q)], [], 200_000); n++; } }
    } catch (e) { const m = (e && e.message) || (typeof e === 'object' ? JSON.stringify(e) : String(e)); if (!/"Custom":60(16|18|19)\b|0x17(80|82|83)\b/.test(m)) console.error('sealed crank', b.id, m.slice(0, 120)); } } // a node closed or settled it first: nothing to do
    return n; }
};
