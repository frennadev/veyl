// The approved-set publisher ("postman"): publishes each pool's approved-label root and admits pending shielded deposits.
// Part of the Relayer class (relayer/relayer.js composes these mixins in one place).
'use strict';
const { Veyl, merklePath, ASP_DEPTH } = require('../sdk/veyl.js');
const { isAllowed } = require('./screening.js');
module.exports = (Base) => class Postman extends Base {
  /// The postman's other job: admit pending shielded deposits whose depositor passes screening.
  async approveDeposits() { if (!this.postman || this.admitting) return 0; this.admitting = true; let n = 0; // one pass at a time
    try { const pv = new Veyl({ connection: this.conn, programs: this.dep.programs, payer: this.postman }); // incremental (newer signatures only), a full read every 10 minutes
      const full = !this.postMem || Date.now() - this.postMem.at > 600_000; const st = await pv.readShield({ prev: full ? null : this.postMem.st }); this.postMem = { st, at: full ? Date.now() : this.postMem.at };
      for (const d of st.pending) { if (!isAllowed({ payer: d.depositor.toBase58(), beneficiary: d.depositor.toBase58() })) continue;
        try { await pv.send([pv.approveDepositIx(this.postman.publicKey, d.pending, d.depositor)], [], 200_000); n++; } catch (e) { console.error('approve', e.message); } }
    } finally { this.admitting = false; }
    if (n) this.shieldCache = null; return n; }
  /// The postman: rebuild the approved-label tree of every pool and publish its root when it changed. A pool with no new
  /// deposit and the root it was left with is skipped (rebuilding walks its whole history, which a public RPC rate-limits);
  /// every pool is rebuilt at least every 10 minutes anyway, so a denylist change still reaches the root.
  async publish() {
    if (!this.postman || this.publishing) return; this.publishing = true; if (!this.aspSeen) this.aspSeen = new Map(); // a slow pass must not overlap the next tick
    try { for (const { pool } of this.pools) {
      try { const k = pool.toBase58(); const p = await this.V.pool(pool); const seen = this.aspSeen.get(k);
        if (seen && seen.mark === p.depositNonce + ':' + p.aspRoot && Date.now() - seen.at < 600_000) continue;
        this.cache.delete(k); const st = await this.state(pool); const root = merklePath(st.labels.length ? st.labels : [0n], 0, ASP_DEPTH).root;
        this.aspSeen.set(k, { mark: p.depositNonce + ':' + root, at: Date.now() });
        if (p.aspRoot !== root) { const pv = new Veyl({ connection: this.conn, programs: this.dep.programs, payer: this.postman }); await pv.send([pv.updateAspRootIx(this.postman.publicKey, pool, root, 'labels:' + st.labels.length)], [], 50_000); console.log(new Date().toISOString(), 'asp', pool.toBase58().slice(0, 8), 'approved', st.labels.length); }
      } catch (e) { console.error('asp', pool.toBase58().slice(0, 8), e.message); }
    } } finally { this.publishing = false; }
  }
};
