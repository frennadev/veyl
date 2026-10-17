// Phase 3 (sealed batch swaps): GET /sealed, and the permissionless crank that closes and fails batches.
// Part of the Relayer class (relayer/relayer.js composes these mixins in one place).
'use strict';
const { PublicKey } = require('@solana/web3.js');
module.exports = (Base) => class Sealed extends Base {
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
};
