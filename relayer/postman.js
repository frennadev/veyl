// The approved-set publisher ("postman"): publishes each pool's approved-label root and admits pending shielded deposits.
// Part of the Relayer class (relayer/relayer.js composes these mixins in one place).
'use strict';
const { Veyl, merklePath, ASP_DEPTH } = require('../sdk/veyl.js');
const { isAllowed } = require('./screening.js');
module.exports = (Base) => class Postman extends Base {
  /// The postman's other job: admit pending shielded deposits whose depositor passes screening.
  async approveDeposits() { if (!this.postman) return 0; const pv = new Veyl({ connection: this.conn, programs: this.dep.programs, payer: this.postman }); const st = await pv.readShield(); let n = 0;
    for (const d of st.pending) { if (!isAllowed({ payer: d.depositor.toBase58(), beneficiary: d.depositor.toBase58() })) continue;
      try { await pv.send([pv.approveDepositIx(this.postman.publicKey, d.pending, d.depositor)], [], 200_000); n++; } catch (e) { console.error('approve', e.message); } }
    if (n) this.shieldCache = null; return n; }
  /// The postman: rebuild the approved-label tree of every pool and publish its root when it changed.
  async publish() {
    if (!this.postman) return;
    for (const { pool } of this.pools) {
      try { this.cache.delete(pool.toBase58()); const st = await this.state(pool); const root = merklePath(st.labels.length ? st.labels : [0n], 0, ASP_DEPTH).root; const p = await this.V.pool(pool);
        if (p.aspRoot !== root) { const pv = new Veyl({ connection: this.conn, programs: this.dep.programs, payer: this.postman }); await pv.send([pv.updateAspRootIx(this.postman.publicKey, pool, root, 'labels:' + st.labels.length)], [], 50_000); console.log(new Date().toISOString(), 'asp', pool.toBase58().slice(0, 8), 'approved', st.labels.length); }
      } catch (e) { console.error('asp', pool.toBase58().slice(0, 8), e.message); }
    }
  }
};
