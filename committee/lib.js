// Veyl batch committee: what a member node does on chain, and the permissionless cranks (close, verify totals, settle,
// fail) any node or the relayer runs. A member never decrypts an individual swap: it only ever multiplies its key share
// into a batch's two aggregate C1 points (D = sk_i·C1) and proves it did so correctly (Chaum–Pedersen, sdk/bjj.js).
'use strict';
const { PublicKey, ComputeBudgetProgram } = require('@solana/web3.js');
const J = require('../sdk/bjj.js'); const SE = require('../sdk/sealed.js'); require('../sdk/shield.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Post this member's partial decryption of a closed batch and drive its on-chain check to the end (post_share, then
/// share_step until the job account is gone). Returns { txs, cu: [per transaction] }.
async function postShare(V, node, { member, sk, binPool, seq, share = null, log = () => {} }) {
  const b = await V.batch(binPool, seq); if (!b || b.state !== 'closed') throw new Error('batch not closed');
  if (b.verified & (1 << (member - 1))) return { txs: [], cu: [], skipped: true };
  const c = await V.committee();
  const sh = share || J.partialDecrypt({ batchKey: b.key, index: member, sk: BigInt(sk), PKi: c.members[member - 1], C1a: b.aggregates[0], C1b: b.aggregates[2] });
  const job = V.shareJobPda(b.address, member); const txs = []; const cu = [];
  if (!(await V.conn.getAccountInfo(job))) { const sig = await V.send([V.postShareIx(node.publicKey, b.address, sh)], [node], 1_400_000); txs.push(sig); cu.push(await cuOf(V, sig)); log('post_share', member, cu[cu.length - 1]); }
  for (let i = 0; i < 20 && (await V.conn.getAccountInfo(job)); i++) { const sig = await V.send([V.shareStepIx(node.publicKey, b.address, member, node.publicKey)], [node], 1_400_000); txs.push(sig); cu.push(await cuOf(V, sig)); log('share_step', member, cu[cu.length - 1]); }
  return { txs, cu, share: sh };
}
async function cuOf(V, sig) { const t = await V.conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); const m = (t.meta.logMessages || []).map((l) => l.match(/consumed (\d+) of \d+ compute units/)).filter(Boolean); return m.length ? Math.max(...m.map((x) => Number(x[1]))) : null; }

/// Recover a closed batch's totals from its verified shares (any t of them) by baby-step giant-step.
async function recoverTotals(V, binPool, seq, bits = J.TOTAL_BITS) {
  const b = await V.batch(binPool, seq); const c = await V.committee();
  const S = []; for (let i = 1; i <= c.n && S.length < c.t; i++) if (b.verified & (1 << (i - 1))) S.push(i);
  if (S.length < c.t) return null;
  const shares = S.map((i) => ({ index: i, Da: b.shares[i - 1][0], Db: b.shares[i - 1][1] }));
  const out = []; for (const d of [0, 1]) { if (b.count[d] === 0) { out.push(0n); continue; } const m = J.bsgsAuto(J.combine(b.aggregates[2 * d + 1], shares, d === 0 ? 'a' : 'b'), bits); if (m === null) throw new Error('total out of range'); out.push(m); }
  return out;
}
/// Settle a closed batch (anyone): verify both totals, then the net swap. Returns the signatures.
async function settle(V, payer, binPool, seq, { totals = null, log = () => {} } = {}) {
  const t = totals || (await recoverTotals(V, binPool, seq)); if (!t) throw new Error('not enough verified shares'); const b = await V.batch(binPool, seq); const txs = [];
  for (const d of [0, 1]) if (!(b.totalsOk & (1 << d))) { txs.push(await V.send([V.settleVerifyIx(b.address, d, t[d])], [payer], 1_400_000)); log('settle_verify', d, String(t[d])); }
  txs.push(await V.sendV0([await V.settleBatchIx(payer.publicKey, binPool, seq)], [payer], 1_400_000)); log('settle_batch', String(seq));
  return { txs, totals: t };
}
/// One crank pass over a pool: close the batch when its epoch is over, fail a closed one past its window. Returns what it did.
async function crank(V, payer, binPool) {
  const st = await V.sealedState(binPool); if (!st || !st.batch) return null; const { sealed: s, batch: b, slot } = st;
  if (b.state === 'open' && BigInt(slot) >= b.endSlot) { await V.send([V.closeBatchIx(payer.publicKey, binPool, b.seq)], [payer], 1_400_000); return 'closed ' + b.seq; }
  return null;
}
/// Closed batches of a pool still waiting for something (shares, settlement): the last `depth` sequence numbers.
async function pendingBatches(V, binPool, depth = 8) { const s = await V.sealed(binPool); if (!s) return []; const out = [];
  for (let q = s.seq - 1n; q >= 0n && q >= s.seq - BigInt(depth); q--) { const b = await V.batch(binPool, q); if (b && b.state === 'closed') out.push(b); } return out; }

module.exports = { postShare, recoverTotals, settle, crank, pendingBatches, cuOf, sleep };
