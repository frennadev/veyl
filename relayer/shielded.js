// Phase 2 (the shielded pool) and Phase 3 submissions: POST /submit for the shielded and sealed kinds, GET /shield.
// Part of the Relayer class (relayer/relayer.js composes these mixins in one place).
'use strict';
const { PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const S = require('../sdk/veyl.js'); const { contextOf } = S;
const Z = require('../sdk/shield.js');
const SE = require('../sdk/sealed.js');
const { HEAP, WORST } = require('./costs.js');
module.exports = (Base) => class Shielded extends Base {
  _symOfMint(mint) { const t = this.symOf[new PublicKey(mint).toBase58()]; if (!t) throw new Error('unknown token'); return t.sym; }
  _feeAta(mint) { return this.V.ata(new PublicKey(mint), this.wallet.publicKey); }
  _checkDeadline(dl) { const now = Math.floor(Date.now() / 1000); if (Number(dl) < now) throw new Error('expired'); if (Number(dl) > now + 3600) throw new Error('deadline too far'); }
  _checkProof8(p) { const proof = Buffer.from(p.proof, 'base64'); if (proof.length !== 256) throw new Error('bad proof'); const pubs = p.pubs.map(BigInt); if (pubs.length !== 8) throw new Error('bad public signals'); return { proof, pubs }; }
  /// A leg / transact spend the relayer executes: its fee goes to this relayer's token account for the leg's token.
  _checkLeg(ext, processor) { if (!new PublicKey(ext.processor).equals(processor)) throw new Error('wrong processor in the external data');
    if (BigInt(ext.fee) > 0n && !new PublicKey(ext.relayer).equals(this._feeAta(ext.mint))) throw new Error('the fee must go to this relayer'); }
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
};
