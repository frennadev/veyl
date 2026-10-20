// Phase 3 for the browser engine: sealed batch swaps. Installed onto the Engine class by sol-entry.js.
//
// A sealed swap spends shielded notes into the pool's current batch: the amount is encrypted on this device to the batch
// committee's threshold key (inside the swap proof, made in the Web Worker) and only the batch's total is ever decrypted.
// The relayer submits it and never learns the amount. When the batch has settled, the same device proves its claim against
// the batch's public clearing ratio and receives a hidden note; a batch that fails refunds through the same claim.
// What this device keeps: nothing new. Each sealed swap's opening is encrypted to this account's viewing key on chain, so
// a restored backup finds it by scanning (ShieldWallet.sealedSwaps()).
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
const SE = require('../sdk/sealed.js');
const { protocolFeeOf } = require('../sdk/veyl.js');
const J = require('../sdk/bjj.js');
const B64 = (u) => Buffer.from(u).toString('base64');

export function installSealed(Engine) {
  const P = Engine.prototype;
  /// The pool's sealed-swap state: settings, the current batch (counts per direction, timing, state; never an amount),
  /// the last finished batch's public outcome. From the relayer; read from the chain when the relayer cannot answer.
  P.sealedState = async function (pool) {
    try { const r = await fetch(this.cfg.relayer + '/sealed?pool=' + encodeURIComponent(pool.address || pool)).then((x) => x.json()); if (!r.error) return r; } catch { /* chain below */ }
    const st = await this.V.sealedState(new PublicKey(pool.address || pool)); if (!st) return { enabled: false, reason: 'not-enabled', why: 'Sealed swaps are turned on pool by pool by the batch committee; this pool does not have them (yet). Instant private swaps work.' };
    const { sealed: s, batch: b, slot } = st; const pub = (x) => x && { seq: String(x.seq), state: x.state, count: x.count, rollovers: x.rollovers, endSlot: String(x.endSlot), closedSlot: String(x.closedSlot), verified: x.verified, totals: x.totals.map(String), num: x.num.map(String), den: x.den.map(String), xForY: x.xForY };
    const last = s.seq > 0n ? await this.V.batch(new PublicKey(pool.address || pool), s.seq - 1n) : null; const c = await this.V.committee();
    return { enabled: true, slot, slotMs: 400, paused: s.paused, mintX: s.mintX.toBase58(), mintY: s.mintY.toBase58(), seq: String(s.seq), epochSlots: String(s.epochSlots), settleTimeout: String(s.settleTimeout), minIn: s.minIn.map(String), kMin: s.kMin, maxRollovers: s.maxRollovers, batch: pub(b), last: pub(last), committee: c ? { t: c.t, n: c.n, epoch: c.epoch, kind: c.kind, pk: J.enc(c.pk).toString('hex') } : null };
  };
  /// Seal a swap into the pool's current batch: `xIn` sells the pool's X token (else Y), `amount` in display units.
  P.sealedSwap = async function (pool, { xIn, amount }) {
    await this.shieldSync(); const st = await this.sealedState(pool); if (!st.enabled) throw new Error(st.why || 'Sealed swaps are not enabled for this pool.');
    if (st.paused) throw new Error('Sealed swaps are paused for this pool.'); if (!st.committee) throw new Error('No batch committee is registered on this network.');
    const sym = xIn ? pool.x : pool.y; const mint = new PublicKey(this.tok(sym).mint); const v = this.unit(sym, amount); const dir = xIn ? 0 : 1;
    const minIn = BigInt(st.minIn[dir]); if (v < minIn) throw new Error('The smallest sealed swap in this pool is ' + this.fmt(sym, minIn) + ' ' + sym + '.');
    if (v >= SE.AMOUNT_LIMIT) throw new Error('A sealed swap is at most ' + this.fmt(sym, SE.AMOUNT_LIMIT - 1n) + ' ' + sym + ': split it.');
    const fee = await this.shieldFee('sealedSwap', sym); await this.ensureSpendable(sym, v + fee);
    const me = await this._relayerAddr(); const tp = await this.V.tokenProgram(mint);
    const PK = J.dec(Buffer.from(st.committee.pk, 'hex')); const seq = BigInt(st.seq);
    const req = SE.sealedSwapRequest(this.zw, { binPool: new PublicKey(pool.address), seq, direction: dir, mintIn: mint, amount: v, fee, minIn, PK, relayerToken: this.V.ata(mint, me, tp) });
    const p = await this.proveIn('swap', req.input);
    const r = await this.submit({ kind: 'sealedSwap', binPool: pool.address, seq: String(seq), direction: dir, c1: B64(J.enc(req.c1)), c2: B64(J.enc(req.c2)), ext: { relayer: req.ext.relayer.toBase58(), fee: String(fee), encChange: B64(req.ext.encChange), encSwap: B64(req.ext.encSwap) }, p });
    const sh = this.store.data.shield; (sh.sealed = sh.sealed || []).push({ pool: pool.address, seq: String(seq), dir, amount: String(v), sym, fee: String(fee), tx: r.txHash, at: Date.now() }); this.store.save();
    await this.shieldSync(); return { tx: r.txHash, seq, fee, protocolFee: protocolFeeOf(v) };
  };
  /// This account's sealed swaps (found on chain by scanning; claimed ones from this device's history), with what each can
  /// do now: wait (open / sealed), claim (settled: the expected output at the batch's ratio), refund (failed). protocolFee:
  /// the fixed 0.2% of what was sold, in its atoms (the matched part pays it at settlement, the net part in its swap; the
  /// batch's ratio already has it out); lpFee: null (only the net part pays LPs, and no seller's share of it is known).
  P.mySealedSwaps = async function () {
    const zw = this.zw || this.shieldInit(); const out = []; const seen = new Set(); const terms = new Map(); const now = Date.now();
    for (const n of zw.notes.filter((x) => x.kind === 4)) { const key = String(n.commitment); if (seen.has(key)) continue; seen.add(key);
      const pool = (this.cfg.binPools || []).find((b) => b.address === n.binPool); if (!pool) continue; const sym = n.direction === 0 ? pool.x : pool.y, other = n.direction === 0 ? pool.y : pool.x;
      const k = n.binPool + ':' + n.seq; let b = terms.get(k); if (!b) { b = { batch: await this.V.batch(new PublicKey(n.binPool), BigInt(n.seq)), t: await this.V.claimTerms(new PublicKey(n.binPool), BigInt(n.seq), n.direction) }; terms.set(k, b); }
      const hist = (this.store.data.shield.sealed || []).find((h) => h.pool === n.binPool && String(h.seq) === String(n.seq) && String(h.amount) === String(n.amount)) || {};
      const state = n.spent ? (hist.claimed && hist.claimed.refund ? 'refunded' : 'claimed') : !b.batch ? 'unknown' : b.t ? (b.t.refund ? 'refund' : 'claim') : b.batch.state === 'open' ? 'waiting' : b.batch.state === 'closed' ? 'sealed' : b.batch.state;
      const outAmt = b.t && !b.t.refund ? (n.amount * b.t.num) / b.t.den : null;
      out.push({ id: key, pool: n.binPool, pair: pool.x + '–' + pool.y, x: pool.x, y: pool.y, seq: String(n.seq), dir: n.direction, sym, other, amount: n.amount, state, batchState: b.batch ? b.batch.state : null, count: b.batch ? b.batch.count : [0, 0], endSlot: b.batch ? String(b.batch.endSlot) : null,
        protocolFee: protocolFeeOf(n.amount), lpFee: null, expect: outAmt, ratio: b.t && !b.t.refund ? [b.t.num, b.t.den] : null, tx: hist.tx || null, claimTx: hist.claimed ? hist.claimed.tx : null, at: hist.at || now, note: n }); }
    return out.sort((a, b) => b.at - a.at);
  };
  /// Claim a settled sealed swap's output (or a failed one's refund) into a new hidden note.
  P.sealedClaim = async function (s) {
    await this.shieldSync(); const n = (this.zw.sealedSwaps() || []).find((x) => String(x.commitment) === String(s.id)); if (!n) throw new Error('This sealed swap is already claimed.');
    const pool = new PublicKey(n.binPool); const terms = await this.V.claimTerms(pool, BigInt(n.seq), n.direction); if (!terms) throw new Error('This batch has not settled yet.');
    const symOut = Object.keys(this.tokens).find((k) => this.tokens[k].mint === new PublicKey(terms.mintOut).toBase58()); const fee = await this.shieldFee('sealedClaim', symOut);
    const me = await this._relayerAddr(); const mint = new PublicKey(terms.mintOut); const tp = await this.V.tokenProgram(mint);
    const req = SE.sealedClaimRequest(this.zw, { swap: n, terms, fee, relayerToken: this.V.ata(mint, me, tp) });
    if (req.value <= 0n) throw new Error('This claim is smaller than the relayer\'s fee.');
    const p = await this.proveIn('claim', req.input);
    const r = await this.submit({ kind: 'sealedClaim', binPool: n.binPool, seq: String(n.seq), direction: n.direction, ext: { relayer: req.ext.relayer.toBase58(), fee: String(fee), encOut: B64(req.ext.encOut) }, p });
    const h = (this.store.data.shield.sealed || []).find((x) => x.pool === n.binPool && String(x.seq) === String(n.seq) && String(x.amount) === String(n.amount)); if (h) { h.claimed = { tx: r.txHash, refund: terms.refund, value: String(req.value), sym: symOut }; this.store.save(); }
    await this.shieldSync(); return { tx: r.txHash, value: req.value, sym: symOut, refund: terms.refund };
  };
}
