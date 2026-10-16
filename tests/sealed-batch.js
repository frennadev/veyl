// One complete sealed batch, end to end, with whatever proving keys it is given: six shielded deposits, three sealed swaps
// per direction, close, two of three committee members' partial decryptions checked on chain, totals verified, the net
// swap, six claims, conservation. The ceremony rehearsal runs it with the rehearsal keys (and checks a dev-key swap proof
// is refused); tests/phase3.js covers the same ground in more depth with the dev keys.
'use strict';
const crypto = require('crypto');
const { Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const S = require('../sdk/veyl.js'); const Z = require('../sdk/shield.js'); const SE = require('../sdk/sealed.js'); const J = require('../sdk/bjj.js');
const CM = require('../committee/lib.js');

/// prove: { transact(input), swap(input), claim(input) } -> { proof, pubs }; devSwap: a prover with other keys whose proof
/// the program must refuse (the rehearsal passes the dev key). Returns { batch, totals, dust }.
async function runFullBatch({ V, conn, payer, postman, relayer, T, dep, prove, units, check = () => {}, log = () => {}, devSwap = null }) {
  const SOL = T.SOL.mint, USDC = T.USDC.mint; const BPX = dep.binPools.find((b) => b.id === 'sol-usdc'); const POOL = new PublicKey(BPX.address);
  const as = (kp) => { const v = new S.Veyl({ connection: conn, programs: V.programs, payer: kp }); v.lookupTable = V.lookupTable; return v; };
  const R = as(relayer); const me = relayer.publicKey; const evOf = async (sig, name) => (await V.events(sig)).find((e) => e.name === name);
  const mints = Object.fromEntries(Object.values(T).map((t) => [t.mint.toBase58(), { sym: t.sym, decimals: t.decimals }]));
  const wallet = () => new Z.ShieldWallet(crypto.randomBytes(32), { mints, pools: [] });
  const sync = async (...ws) => { const st = await V.readShield(); st.tree = new Z.Tree(st.leaves); for (const w of ws) w.scan(st); };
  const slot = () => conn.getSlot('confirmed'); const waitSlot = async (s) => { while ((await slot()) < Number(s)) await new Promise((r) => setTimeout(r, 400)); };
  // tokens, liquidity, committee
  for (const [m, a] of [[SOL, units(200, 9)], [USDC, units(200_000, 6)]]) { const { fund } = require('../scripts/lib.js'); await fund(conn, payer, m, payer.publicKey, a); }
  { const p = await V.binPool(POOL); const ids = []; for (let i = -10; i <= 10; i++) ids.push(p.activeId + i);
    for (let k = 0; k < ids.length; k += 11) { const part = ids.slice(k, k + 11); const pre = await V.ensureBinAccountsIxs(payer.publicKey, POOL, part, payer.publicKey, payer.publicKey); if (pre.length) await V.send(pre, [], 400_000);
      await V.send([await V.mintIx(payer.publicKey, POOL, { ids: part, amountsX: part.map((id) => (id >= p.activeId ? units(3, 9) : 0n)), amountsY: part.map((id) => (id <= p.activeId ? units(450, 6) : 0n)) })], [], 1_400_000); } }
  const dk = J.dkgLocal(2, 3); const nodes = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const k of nodes) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
  if (!(await V.committee())) await V.send([V.initCommitteeIx(payer.publicKey)]);
  await V.send([V.setCommitteeIx(payer.publicKey, { t: 2, n: 3, kind: 0, pk: dk.PK, members: dk.members.map((m) => m.PK), nodes: nodes.map((k) => k.publicKey), transcript: Buffer.alloc(32) })], [], 1_400_000);
  // six sellers with shielded balances
  const As = [wallet(), wallet(), wallet()], Bs = [wallet(), wallet(), wallet()];
  for (const [w, mint, a] of [...As.map((w) => [w, SOL, units(5, 9)]), ...Bs.map((w) => [w, USDC, units(1000, 6)])]) {
    await sync(w); const d = w.deposit(mint, a); const pr = await prove.transact(d.input); await V.send([V.postProofIx(payer.publicKey, 1, pr.proof, pr.pubs)], [], 1_400_000);
    const s2 = await V.send([await V.shieldDepositIx(payer.publicKey, d.ext, pr.pubs)], [], 600_000); const e = await evOf(s2, 'DepositPending'); await as(postman).send([V.approveDepositIx(postman.publicKey, e.pending, payer.publicKey)]); }
  log('deposits done');
  // swap proofs for batch 0, then the pool, then submission within the epoch
  const params = { epochSlots: 90, settleTimeout: 900, minIn: [units(0.01, 9), units(1, 6)], kMin: 3, maxRollovers: 1, maxDrift: 60 };
  const sizes = [[units(0.4, 9), units(1.1, 9), units(0.25, 9)], [units(60, 6), units(125.5, 6), units(33, 6)]]; const PK = dk.PK; const reqs = [];
  for (const d of [0, 1]) for (let i = 0; i < 3; i++) { const w = d === 0 ? As[i] : Bs[i]; const m = d === 0 ? SOL : USDC; await sync(w);
    const r = SE.sealedSwapRequest(w, { binPool: POOL, seq: 0n, direction: d, mintIn: m, amount: sizes[d][i], fee: 0n, minIn: params.minIn[d], PK }); reqs.push({ w, d, r, pr: await prove.swap(r.input) }); }
  log('swap proofs made');
  if (!(await V.sealed(POOL))) await V.send([V.initSealedPoolIx(payer.publicKey, POOL, params)]);
  if (devSwap) { const x = await devSwap(reqs[0].r.input); let refused = false; try { await R.send([V.postProofIx(me, SE.KIND.SWAP, x.proof, x.pubs)], [], 1_400_000); } catch (e) { refused = /BadProof/.test(String(e.message) + JSON.stringify(e.logs || '')); } check('on chain: a swap proof made with the DEV key is refused by the rehearsal program (BadProof)', refused); }
  for (const x of reqs) { await R.send([V.postProofIx(me, SE.KIND.SWAP, x.pr.proof, x.pr.pubs)], [], 1_400_000);
    await R.sendV0([await V.submitSwapIx(me, { binPool: POOL, seq: 0n, direction: x.d, mintIn: x.d === 0 ? SOL : USDC, c1: x.r.c1, c2: x.r.c2, ext: x.r.ext, pubs: x.pr.pubs, poster: me })], [], 600_000); }
  let st = await V.sealedState(POOL); check('on chain: six sealed swaps (3 per direction) proven with these keys enter batch 0', st.batch.count[0] === 3 && st.batch.count[1] === 3);
  await waitSlot(st.batch.endSlot); await V.send([V.closeBatchIx(payer.publicKey, POOL, 0n)], [], 1_400_000);
  for (const [i, k] of [[0, nodes[0]], [2, nodes[2]]]) await CM.postShare(as(k), k, { member: i + 1, sk: dk.members[i].sk, binPool: POOL, seq: 0n });
  const totals = await CM.recoverTotals(V, POOL, 0n, 34);
  check('on chain: two of three partial decryptions pass the Chaum–Pedersen check; the totals they reveal are the sums of the hidden amounts', totals[0] === sizes[0].reduce((a, b) => a + b, 0n) && totals[1] === sizes[1].reduce((a, b) => a + b, 0n));
  const p0 = await V.binPool(POOL); const twin = await SE.clearing({ totals, price: S.priceOf(p0.basePrice, p0.binStep, p0.activeId), quote: async (xf, a) => (await V.quoteLocal(POOL, xf, a)).out });
  await CM.settle(V, payer, POOL, 0n, { totals }); const b = await V.batch(POOL, 0n);
  check('on chain: the batch settles with ONE net swap; its clearing ratios equal the JS twin\'s', b.state === 'settled' && b.num.every((x, k) => x === twin.num[k]) && b.den.every((x, k) => x === twin.den[k]));
  const got = [[], []];
  for (const x of reqs) { await sync(x.w); const sw = x.w.sealedSwaps()[0]; const terms = await V.claimTerms(POOL, 0n, x.d); const before = x.w.balance(terms.mintOut);
    const req = SE.sealedClaimRequest(x.w, { swap: sw, terms }); const pr = await prove.claim(req.input); await R.send([V.postProofIx(me, SE.KIND.CLAIM, pr.proof, pr.pubs)], [], 1_400_000);
    await R.sendV0([await V.claimSwapIx(me, { binPool: POOL, seq: 0n, direction: x.d, mintOut: terms.mintOut, ext: req.ext, pubs: pr.pubs, poster: me })], [], 600_000); await sync(x.w);
    got[x.d].push(x.w.balance(terms.mintOut) - before); }
  const dust = [0, 1].map((d) => b.num[d] - got[d].reduce((a, c) => a + c, 0n));
  check('on chain: six claims proven with these keys pay floor(amount x num / den) each; claims + dust == what each side was owed (dust < 1 atom per claim)', reqs.every((x, k) => got[x.d][k % 3] === (sizes[x.d][k % 3] * b.num[x.d]) / b.den[x.d]) && dust.every((x) => x >= 0n && x < 3n));
  return { batch: b, totals, dust };
}
module.exports = { runFullBatch };
