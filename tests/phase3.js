// Phase 3: sealed batch swaps (individual trade sizes hidden), against the same local validator and deployment as
// tests/run.js (called after Phase 2), or alone with `npm run test:phase3`. Real swap and claim proofs
// (zk/circuits/swap.circom, claim.circom) made in Node, submitted through the relayer service; a 2-of-3 committee from a
// joint (dealerless) Feldman DKG posts partial decryptions whose Chaum–Pedersen proofs are checked on chain.
//
// Covered: homomorphic aggregation (the batch's aggregates == the sum of the submitted ciphertexts, and decrypt to the sum
// of the amounts); a forged DLEQ proof and a wrong share refused; a non-member refused; t-1 shares cannot decrypt (on chain:
// refused; off chain: the combination is not the total); a wrong total refused; the net swap and clearing ratios equal the
// JS twin's; claims pay exactly floor(amount·num/den) - fee; claim inflation (a higher ratio, the other direction's ratio)
// refused; double claim refused; per-batch conservation (sum of claims + rounding dust == net swap output + the opposite
// side's inputs, per direction); the k-floor rolls a batch over; a batch whose committee withholds its shares refunds after
// its window (and can no longer settle); a batch out of rollovers fails and refunds; paused pools refuse swaps.
'use strict';
const crypto = require('crypto');
const { Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const S = require('../sdk/veyl.js'); const Z = require('../sdk/shield.js'); const SE = require('../sdk/sealed.js'); const J = require('../sdk/bjj.js');
const { proveTransact, proveSwap, proveClaim, TIMES, verifyCircuit } = require('../sdk/prover.js');
const { Relayer } = require('../relayer/relayer.js');
const CM = require('../committee/lib.js');
const { logsOf } = require('./harness.js');

module.exports = async function phase3(C) {
  const { conn, payer, V, as, alice, bob, carol, mallory, relayer, postman, dep, T, check, refused, cuOf, CU, units, sleep, lap } = C;
  const SOL = T.SOL.mint, USDC = T.USDC.mint; const me = relayer.publicKey; const R = as(relayer);
  const BPX = dep.binPools.find((b) => b.id === 'sol-usdc'); const POOL = new PublicKey(BPX.address);
  const svc = new Relayer({ connection: conn, wallet: relayer, deploy: dep, postman, minFeeBps: 5 });
  const Jo = (o) => JSON.parse(S.j(o)); const pt = (pr) => ({ proof: pr.proof.toString('base64'), pubs: pr.pubs.map(String) });
  const mints = Object.fromEntries(Object.values(T).map((t) => [t.mint.toBase58(), { sym: t.sym, decimals: t.decimals }]));
  const pools = dep.binPools.map((b) => ({ address: b.address, mintX: T[b.x].mint.toBase58(), mintY: T[b.y].mint.toBase58(), x: b.x, y: b.y }));
  const wallet = () => new Z.ShieldWallet(crypto.randomBytes(32), { mints, pools });
  const sync = async (...ws) => { const st = await V.readShield(); st.tree = new Z.Tree(st.leaves); for (const w of ws) w.scan(st); return st; };
  const amt = async (a) => BigInt((await conn.getTokenAccountBalance(a)).value.amount); const vault = (m) => amt(V.shieldVault(m));
  const slot = () => conn.getSlot('confirmed'); const waitSlot = async (s) => { while ((await slot()) < Number(s)) await sleep(400); };
  const evOf = async (sig, name) => (await V.events(sig)).find((e) => e.name === name);
  const fee = async (kind, mint) => BigInt((await svc.shieldFeeQuote({ kind, mint: new PublicKey(mint) })).fee);
  const mintOfDir = (d) => (d === 0 ? SOL : USDC);
  const timeline = []; const mark = (s) => timeline.push(`${lap()} ${s}`);
  console.log('  -- phase 3: sealed batch swaps (swap + claim circuits, 2-of-3 committee, on-chain Chaum–Pedersen)');

  // liquidity around the active bin of sol-usdc (the batch's net swap goes through it)
  { const p = await V.binPool(POOL); const ids = []; for (let i = -10; i <= 10; i++) ids.push(p.activeId + i);
    for (let k = 0; k < ids.length; k += 11) { const part = ids.slice(k, k + 11); const pre = await V.ensureBinAccountsIxs(alice.publicKey, POOL, part, alice.publicKey, alice.publicKey); if (pre.length) await as(alice).send(pre, [], 400_000);
      await as(alice).send([await V.mintIx(alice.publicKey, POOL, { ids: part, amountsX: part.map((id) => (id >= p.activeId ? units(3, 9) : 0n)), amountsY: part.map((id) => (id <= p.activeId ? units(450, 6) : 0n)) })], [], 1_400_000); } }

  // ================================================================================== A. the committee (joint DKG, 2 of 3)
  const dk = J.dkgLocal(2, 3); const nodes = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const k of nodes) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
  check('P3 DKG (joint Feldman VSS, no dealer): every member\'s share verifies against the public commitments, any 2 interpolate to the joint key, 1 does not', dk.members.every((m) => J.verifyShare(dk.commitments, m.index, m.sk))
    && J.eq(J.mulB(J.md(J.lagrange([1, 3])[0] * dk.members[0].sk + J.lagrange([1, 3])[1] * dk.members[2].sk, J.l)), dk.PK) && !J.eq(J.mulB(dk.members[0].sk), dk.PK));
  const transcript = crypto.createHash('sha256').update(JSON.stringify(dk.dealerCommitments.map((F) => F.map((p) => J.enc(p).toString('hex'))))).digest();
  const reg = { t: 2, n: 3, kind: 1, pk: dk.PK, members: dk.members.map((m) => m.PK), nodes: nodes.map((k) => k.publicKey), transcript };
  check('P3 only the entry program\'s upgrade authority creates the committee account', await refused(as(mallory).send([V.initCommitteeIx(mallory.publicKey)]), /NotAuthority|ConstraintRaw|2003/));
  await V.send([V.initCommitteeIx(payer.publicKey)]);
  check('P3 a committee whose key shares do not interpolate to its key is refused (BadCommittee)', await refused(V.send([V.setCommitteeIx(payer.publicKey, { ...reg, members: [dk.members[1].PK, dk.members[0].PK, dk.members[2].PK] })], [], 1_400_000), /BadCommittee/));
  check('P3 only the committee authority registers keys', await refused(as(mallory).send([V.setCommitteeIx(mallory.publicKey, reg)], [], 1_400_000), /NotAuthority/));
  let sig = await V.send([V.setCommitteeIx(payer.publicKey, reg)], [], 1_400_000); await cuOf(conn, sig, 'set_committee (2 of 3)');
  const cm = await V.committee();
  check('P3 committee registered: t = 2, n = 3, joint key, the member keys, their node keys, the DKG transcript hash', cm.t === 2 && cm.n === 3 && cm.epoch === 1 && J.eq(cm.pk, dk.PK) && cm.members.every((m, i) => J.eq(m, dk.members[i].PK)) && cm.nodes[2].equals(nodes[2].publicKey) && Buffer.from(cm.transcript).equals(transcript));

  // ================================================================================== B. shielded balances for six sellers
  const As = [wallet(), wallet(), wallet()], Bs = [wallet(), wallet(), wallet()]; const all = [...As, ...Bs];
  for (const [w, kp, mint, a] of [...As.map((w) => [w, alice, SOL, units(10, 9)]), ...Bs.map((w) => [w, bob, USDC, units(2000, 6)])]) {
    await sync(w); const d = w.deposit(mint, a); const pr = await proveTransact(d.input); await as(kp).send([V.postProofIx(kp.publicKey, 1, pr.proof, pr.pubs)], [], 1_400_000);
    const s2 = await as(kp).send([await V.shieldDepositIx(kp.publicKey, d.ext, pr.pubs)], [], 600_000); const e = await evOf(s2, 'DepositPending'); await as(postman).send([V.approveDepositIx(postman.publicKey, e.pending, kp.publicKey)]); }
  await sync(...all);
  check('P3 six sellers hold shielded balances (3 x 10 SOL, 3 x 2,000 USDC), amounts hidden from here on', As.every((w) => w.balance(SOL) === units(10, 9)) && Bs.every((w) => w.balance(USDC) === units(2000, 6)));
  mark('deposits done');

  // ================================================================================== C. batch 0: six sealed swaps
  const params = { epochSlots: 75, settleTimeout: 900, minIn: [units(0.01, 9), units(1, 6)], kMin: 3, maxRollovers: 2, maxDrift: 60 };
  const PK = cm.pk; const fSol = await fee('sealedSwap', SOL), fUsdc = await fee('sealedSwap', USDC);
  const sizes = [[units(1, 9), units(2.5, 9), units(0.75, 9)], [units(150, 6), units(333.333333, 6), units(90, 6)]];
  // prove first (the batch key of batch 0 is known before the pool exists), then open the pool and submit within its epoch
  const reqs = []; for (const d of [0, 1]) for (let i = 0; i < 3; i++) { const w = d === 0 ? As[i] : Bs[i]; const m = mintOfDir(d);
    const r = SE.sealedSwapRequest(w, { binPool: POOL, seq: 0n, direction: d, mintIn: m, amount: sizes[d][i], fee: d === 0 ? fSol : fUsdc, minIn: params.minIn[d], PK, relayerToken: V.ata(m, me) });
    reqs.push({ w, d, i, r, pr: await proveSwap(r.input) }); }
  check('P3 a real swap proof verifies locally (snarkjs, dev key): [root, 2 nullifiers, change, swap commitment, batch key, bundle, ext hash]', await verifyCircuit('swap', reqs[0].pr.raw) && reqs[0].pr.pubs[5] === SE.batchKey(POOL, 0n), `${TIMES.swap[0]} ms`);
  // a proof made for another committee key (its bundle cannot match the registered key)
  const otherKey = J.dkgLocal(2, 3).PK; const wrongPk = SE.sealedSwapRequest(As[0], { binPool: POOL, seq: 0n, direction: 0, mintIn: SOL, amount: units(0.2, 9), fee: fSol, minIn: params.minIn[0], PK: otherKey, relayerToken: V.ata(SOL, me) }); const wrongPkPr = await proveSwap(wrongPk.input);
  mark('swap proofs made');
  check('P3 only the committee authority enables sealed swaps on a pool', await refused(as(mallory).send([V.initSealedPoolIx(mallory.publicKey, POOL, params)]), /NotAuthority/));
  sig = await V.send([V.initSealedPoolIx(payer.publicKey, POOL, params)]); await cuOf(conn, sig, 'init_sealed_pool');
  let st = await V.sealedState(POOL);
  check('P3 sealed pool: batch 0 open now, ends after its epoch, nothing in it', st.batch.state === 'open' && st.batch.seq === 0n && st.batch.count.every((c) => c === 0) && st.batch.endSlot > BigInt(st.slot));
  const vSol0 = await vault(SOL), vUsdc0 = await vault(USDC);
  // refusals on a posted proof before the honest submission
  { const x = reqs[0]; await R.send([V.postProofIx(me, SE.KIND.SWAP, x.pr.proof, x.pr.pubs)], [], 1_400_000);
    check('P3 a swap proof is bound to its direction: submitted as the other direction it is refused', await refused(R.sendV0([await V.submitSwapIx(me, { binPool: POOL, seq: 0n, direction: 1, mintIn: USDC, c1: x.r.c1, c2: x.r.c2, ext: { ...x.r.ext, relayer: V.ata(USDC, me) }, pubs: x.pr.pubs, poster: me })], [], 600_000), /BadContext|WrongRecipient/));
    check('P3 ...and to its ciphertext: another (C1, C2) under the same proof is refused', await refused(R.sendV0([await V.submitSwapIx(me, { binPool: POOL, seq: 0n, direction: 0, mintIn: SOL, c1: reqs[1].r.c1, c2: reqs[1].r.c2, ext: x.r.ext, pubs: x.pr.pubs, poster: me })], [], 600_000), /BadContext/));
    await R.send([V.cancelProofIx(me, SE.KIND.SWAP, x.pr.pubs, me)]); }
  { await R.send([V.postProofIx(me, SE.KIND.SWAP, wrongPkPr.proof, wrongPkPr.pubs)], [], 1_400_000);
    check('P3 a swap encrypted to a key that is not the committee\'s is refused (the bundle names the registered key)', await refused(R.sendV0([await V.submitSwapIx(me, { binPool: POOL, seq: 0n, direction: 0, mintIn: SOL, c1: wrongPk.c1, c2: wrongPk.c2, ext: wrongPk.ext, pubs: wrongPkPr.pubs, poster: me })], [], 600_000), /BadContext/));
    await R.send([V.cancelProofIx(me, SE.KIND.SWAP, wrongPkPr.pubs, me)]); }
  const submitted = [];
  for (const x of reqs) { const r = await svc.submit(Jo({ kind: 'sealedSwap', binPool: POOL, seq: 0n, direction: x.d, c1: J.enc(x.r.c1), c2: J.enc(x.r.c2), ext: x.r.ext, p: pt(x.pr) }));
    for (const s2 of r.txs) await cuOf(conn, s2, 'post_proof / submit_swap'); const e = await evOf(r.txHash, 'SealedSwapSubmitted'); submitted.push({ ...x, sig: r.txHash, ev: e }); await logsOf(conn, r.txHash, 'submit_swap'); }
  CU.submit_swap = (await (async () => { const t = await conn.getTransaction(submitted[0].sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); return Math.max(...t.meta.logMessages.map((l) => (l.match(/consumed (\d+) of/) || [0, 0])[1]).map(Number)); })());
  { const t = await conn.getTransaction(submitted[0].sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); const logs = t.meta.logMessages.join('\n');
    check('P3 six sealed swaps through the relayer: each event names only the batch, the direction and the running count; no amount appears anywhere in the transaction',
      submitted.every((x, k) => x.ev && x.ev.seq === 0n && x.ev.direction === x.d) && submitted[5].ev.count[0] === 3 && submitted[5].ev.count[1] === 3 && !logs.includes(String(sizes[0][0])) && !t.transaction.message.serialize().toString('hex').includes(S.u64(sizes[0][0]).toString('hex')), 'CU ' + CU.submit_swap); }
  check('P3 the relayer\'s flat fees are the only tokens that moved: the shielded vaults changed by exactly the fees (the swapped amounts stay inside, hidden)', (await vault(SOL)) === vSol0 - 3n * fSol && (await vault(USDC)) === vUsdc0 - 3n * fUsdc, `fees ${fSol} lamports, ${fUsdc} USDC atoms`);
  await sync(...all);
  check('P3 each seller keeps hidden change and finds its sealed swap by scanning (the opening is encrypted to its viewing key): recoverable on a new device', As.every((w, i) => w.balance(SOL) === units(10, 9) - sizes[0][i] - fSol && w.sealedSwaps().length === 1 && w.sealedSwaps()[0].amount === sizes[0][i]) && Bs.every((w, i) => w.sealedSwaps()[0].amount === sizes[1][i]));
  { const x = submitted[0]; await R.send([V.postProofIx(me, SE.KIND.SWAP, x.pr.proof, x.pr.pubs)], [], 1_400_000);
    check('P3 a replayed swap proof is refused (its notes are spent)', await refused(R.sendV0([await V.submitSwapIx(me, { binPool: POOL, seq: 0n, direction: 0, mintIn: SOL, c1: x.r.c1, c2: x.r.c2, ext: x.r.ext, pubs: x.pr.pubs, poster: me })], [], 600_000), /AlreadySpent|already in use|0x0/));
    await R.send([V.cancelProofIx(me, SE.KIND.SWAP, x.pr.pubs, me)]); }
  check('P3 a batch cannot be closed before its epoch ends (EpochNotOver)', await refused(as(mallory).send([V.closeBatchIx(mallory.publicKey, POOL, 0n)], [], 1_400_000), /EpochNotOver/));
  mark('batch 0 submitted');
  // the next batches: shorter epochs; the settlement window stays long until batch 0 is settled
  await V.send([V.setSealedParamsIx(payer.publicKey, POOL, { ...params, epochSlots: 100 })]);
  st = await V.sealedState(POOL); await waitSlot(st.batch.endSlot);
  sig = await as(mallory).send([V.closeBatchIx(mallory.publicKey, POOL, 0n)], [], 1_400_000); await cuOf(conn, sig, 'close_batch (seal: 4 points to affine)');
  let b0 = await V.batch(POOL, 0n); const ev0 = await evOf(sig, 'BatchClosed');
  const sum = (d) => submitted.filter((x) => x.d === d).reduce((acc, x) => J.addCt(acc, { c1: x.r.c1, c2: x.r.c2 }), J.ZERO_CT);
  const jointSk = J.md(J.lagrange([1, 2])[0] * dk.members[0].sk + J.lagrange([1, 2])[1] * dk.members[1].sk, J.l);
  check('P3 close (anyone, once the epoch is over): batch 0 sealed, batch 1 opened; the published aggregates equal the homomorphic sum of the six ciphertexts per direction',
    b0.state === 'closed' && (await V.batch(POOL, 1n)).state === 'open' && J.eq(b0.aggregates[0], sum(0).c1) && J.eq(b0.aggregates[1], sum(0).c2) && J.eq(b0.aggregates[2], sum(1).c1) && J.eq(b0.aggregates[3], sum(1).c2) && ev0 && ev0.count[0] === 3, 'CU ' + CU['close_batch (seal: 4 points to affine)']);
  check('P3 aggregation is additive: the aggregate decrypts (under the joint key, test only) to the sum of the hidden amounts in each direction', J.eq(J.decryptPoint({ c1: b0.aggregates[0], c2: b0.aggregates[1] }, jointSk), J.mulB(sizes[0][0] + sizes[0][1] + sizes[0][2])) && J.eq(J.decryptPoint({ c1: b0.aggregates[2], c2: b0.aggregates[3] }, jointSk), J.mulB(sizes[1].reduce((a, b) => a + b, 0n))));
  check('P3 a swap into a closed batch is refused', await refused((async () => { const x = reqs[1]; await R.send([V.postProofIx(me, SE.KIND.SWAP, x.pr.proof, x.pr.pubs)], [], 1_400_000).catch(() => {}); return R.sendV0([await V.submitSwapIx(me, { binPool: POOL, seq: 0n, direction: 0, mintIn: SOL, c1: x.r.c1, c2: x.r.c2, ext: x.r.ext, pubs: x.pr.pubs, poster: me })], [], 600_000); })(), /ConstraintSeeds|BatchNotOpen|2006|AlreadySpent/));
  mark('batch 0 closed');

  // ================================================================================== D. partial decryptions (Chaum–Pedersen on chain)
  const nv = nodes.map((k) => as(k)); const key0 = b0.key;
  check('P3 a share from a key that is not a member\'s node is refused (NotMember)', await refused(as(mallory).send([V.postShareIx(mallory.publicKey, b0.address, J.partialDecrypt({ batchKey: key0, index: 1, sk: dk.members[0].sk, PKi: dk.members[0].PK, C1a: b0.aggregates[0], C1b: b0.aggregates[2] }))], [], 1_400_000), /NotMember/));
  check('P3 a share with a point off the curve is refused (BadPoint)', await refused(nv[0].send([V.postShareIx(nodes[0].publicKey, b0.address, { ...J.partialDecrypt({ batchKey: key0, index: 1, sk: dk.members[0].sk, PKi: dk.members[0].PK, C1a: b0.aggregates[0], C1b: b0.aggregates[2] }), Da: [1n, 2n] })], [], 1_400_000), /BadPoint/));
  // member 2 forges: a wrong partial decryption (another key) with a proof that is internally consistent for it
  { const forged = J.partialDecrypt({ batchKey: key0, index: 2, sk: J.md(dk.members[1].sk + 1n, J.l), PKi: dk.members[1].PK, C1a: b0.aggregates[0], C1b: b0.aggregates[2] });
    const r = await refused(CM.postShare(nv[1], nodes[1], { member: 2, sk: 0n, binPool: POOL, seq: 0n, share: forged }), /BadShare/);
    b0 = await V.batch(POOL, 0n);
    check('P3 DLEQ forgery refused: a partial decryption under another key fails the on-chain Chaum–Pedersen check (BadShare); nothing recorded', r && !(b0.verified & 2));
    await nv[1].send([V.cancelShareIx(nodes[1].publicKey, b0.address, 2)]);
    const tampered = { ...J.partialDecrypt({ batchKey: key0, index: 2, sk: dk.members[1].sk, PKi: dk.members[1].PK, C1a: b0.aggregates[0], C1b: b0.aggregates[2] }) }; tampered.Db = J.add(tampered.Db, J.B);
    check('P3 wrong share refused: the right D_a with a wrong D_b (and the proof made for the right ones) fails the check', await refused(CM.postShare(nv[1], nodes[1], { member: 2, sk: 0n, binPool: POOL, seq: 0n, share: tampered }), /BadShare/) && !((await V.batch(POOL, 0n)).verified & 2));
    await nv[1].send([V.cancelShareIx(nodes[1].publicKey, b0.address, 2)]); }
  const s1 = await CM.postShare(nv[0], nodes[0], { member: 1, sk: dk.members[0].sk, binPool: POOL, seq: 0n });
  b0 = await V.batch(POOL, 0n);
  CU.post_share = s1.cu[0]; CU.share_step = Math.max(...s1.cu.slice(1)); CU['share check: transactions'] = s1.cu.length; CU['share check: total CU'] = s1.cu.reduce((a, b) => a + b, 0);
  check('P3 member 1\'s partial decryption passes the on-chain Chaum–Pedersen check (resumable: post_share + share_step until done), recorded, job closed', !!(b0.verified & 1) && J.eq(b0.shares[0][0], J.mul(b0.aggregates[0], dk.members[0].sk)) && !(await conn.getAccountInfo(V.shareJobPda(b0.address, 1))), `${s1.cu.length} transactions, ${s1.cu.join(' / ')} CU`);
  check('P3 t-1 shares cannot decrypt: with one share settle_verify is refused (NotEnoughShares), and off chain one share interpolates to a point that is not m·B', await refused(V.send([V.settleVerifyIx(b0.address, 0, sizes[0][0] + sizes[0][1] + sizes[0][2])], [], 1_400_000), /NotEnoughShares/)
    && J.bsgs(J.combine(b0.aggregates[1], [{ index: 1, Da: b0.shares[0][0], Db: b0.shares[0][1] }], 'a'), 34) === null);
  const s3 = await CM.postShare(nv[2], nodes[2], { member: 3, sk: dk.members[2].sk, binPool: POOL, seq: 0n });
  b0 = await V.batch(POOL, 0n);
  check('P3 member 3 too (any 2 of 3); member 2 stays silent', (b0.verified & 5) === 5 && !(b0.verified & 2), s3.cu.length + ' transactions');
  mark('shares verified');

  // ================================================================================== E. totals and settlement
  const totals = await CM.recoverTotals(V, POOL, 0n, 34); const want = [sizes[0].reduce((a, b) => a + b, 0n), sizes[1].reduce((a, b) => a + b, 0n)];
  check('P3 the two verified shares recover each direction\'s total by baby-step giant-step (and only the totals: no individual amount is ever decrypted)', totals[0] === want[0] && totals[1] === want[1], `${totals[0]} lamports, ${totals[1]} USDC atoms`);
  check('P3 a wrong total is refused (BadTotal): 8·(Δ·C2 - Σ Δλ_i·D_i) must equal (8·Δ·total)·B', await refused(V.send([V.settleVerifyIx(b0.address, 0, totals[0] + 1n)], [], 1_400_000), /BadTotal/));
  sig = await V.send([V.settleVerifyIx(b0.address, 0, totals[0])], [], 1_400_000); await cuOf(conn, sig, 'settle_verify (one direction)');
  sig = await V.send([V.settleVerifyIx(b0.address, 1, totals[1])], [], 1_400_000);
  check('P3 settlement before both totals are verified would be refused; both now verified', (await V.batch(POOL, 0n)).totalsOk === 3);
  const p0 = await V.binPool(POOL); const price = S.priceOf(p0.basePrice, p0.binStep, p0.activeId);
  const twin = await SE.clearing({ totals, price, quote: async (xForY, a) => (await V.quoteLocal(POOL, xForY, a)).out });
  const vs = [await vault(SOL), await vault(USDC)]; const pf0 = await V.protocolFees(POOL);
  sig = await V.sendV0([await V.settleBatchIx(payer.publicKey, POOL, 0n)], [], 1_400_000); await cuOf(conn, sig, 'settle_batch (net swap)'); await logsOf(conn, sig, 'settle_batch (net swap)');
  const set = await evOf(sig, 'BatchSettled'); b0 = await V.batch(POOL, 0n);
  check('P3 settle (anyone): the directions net at the active bin\'s price, ONE swap of the excess through the bins; ratios == the JS twin\'s', b0.state === 'settled' && set.xForY === twin.xForY && set.netIn === twin.netIn && set.netOut === twin.netOut && set.num.every((x, k) => x === twin.num[k]) && set.den.every((x, k) => x === twin.den[k]),
    `net ${set.xForY ? 'X->Y' : 'Y->X'} ${set.netIn} -> ${set.netOut}, CU ${CU['settle_batch (net swap)']}`);
  const dv = set.xForY ? [-set.netIn, set.netOut] : [set.netOut, -set.netIn]; const pfm = twin.protocolFee; const pf1 = await V.protocolFees(POOL);
  check('P3 the vaults moved by exactly the net swap and the matched part\'s 0.2% protocol fee: the excess token out, the other one in, the fee to the bin pool (the matched tokens never leave the shielded pool)', (await vault(SOL)) === vs[0] + dv[0] - pfm[0] && (await vault(USDC)) === vs[1] + dv[1] - pfm[1], `protocol fee on the matched part ${pfm[0]} lamports + ${pfm[1]} USDC atoms`);
  { const netFee = S.protocolFeeOf(set.netIn, pf0.bps);
    check('P3 every sealed seller pays the 0.2% protocol fee: the net swap pays it on its input, the matched part on each side\'s matched value (rounded up), all accounted to the bin pool; the clearing ratios shrink by exactly that',
      pf1.x - pf0.x - pfm[0] >= (set.xForY ? netFee : 0n) && pf1.y - pf0.y - pfm[1] >= (set.xForY ? 0n : netFee) && (set.xForY ? pf1.y - pf0.y === pfm[1] : pf1.x - pf0.x === pfm[0]) && pfm.every((f, k) => f === S.protocolFeeOf(twin.matched[k], pf0.bps) && (twin.matched[k] === 0n || f > 0n))); }
  check('P3 public per batch: totals, net swap, clearing ratios, participant counts; settle_batch twice is refused', set.totals[0] === totals[0] && set.count[0] === 3 && set.count[1] === 3 && await refused(V.sendV0([await V.settleBatchIx(payer.publicKey, POOL, 0n)], [], 1_400_000), /BatchNotClosed/));
  mark('batch 0 settled');

  // ================================================================================== F. claims
  await sync(...all);
  const claimed = [[], []]; const fClaim = [await fee('sealedClaim', USDC), await fee('sealedClaim', SOL)]; // dir 0 receives USDC, dir 1 SOL
  for (const x of submitted) { const w = x.w; const sw = w.sealedSwaps()[0]; const terms = await V.claimTerms(POOL, 0n, x.d); const mOut = terms.mintOut; const f = fClaim[x.d];
    const before = w.balance(mOut);
    if (x === submitted[0]) {
      const infl = SE.sealedClaimRequest(w, { swap: sw, terms: { ...terms, num: terms.num + terms.den / 100n }, fee: f, relayerToken: V.ata(mOut, me) }); const ip = await proveClaim(infl.input);
      check('P3 claim inflation refused: a claim proven against a higher ratio than the batch\'s (out > input x ratio) does not match the bundle (BadContext)', await refused(svc.submit(Jo({ kind: 'sealedClaim', binPool: POOL, seq: 0n, direction: x.d, ext: infl.ext, p: pt(ip) })), /BadContext/));
      const other = SE.sealedClaimRequest(w, { swap: sw, terms: { ...terms, num: b0.num[1], den: b0.den[1] }, fee: f, relayerToken: V.ata(mOut, me) }); const op = await proveClaim(other.input);
      check('P3 ...nor can a claim use the other direction\'s ratio', await refused(svc.submit(Jo({ kind: 'sealedClaim', binPool: POOL, seq: 0n, direction: x.d, ext: other.ext, p: pt(op) })), /BadContext/));
      check('P3 a real claim proof verifies locally (snarkjs): [root, nullifier, out note, batch key, bundle, ext hash]', await verifyCircuit('claim', op.raw), `${TIMES.claim[0]} ms`); }
    const req = SE.sealedClaimRequest(w, { swap: sw, terms, fee: f, relayerToken: V.ata(mOut, me) }); const pr = await proveClaim(req.input);
    const r = await svc.submit(Jo({ kind: 'sealedClaim', binPool: POOL, seq: 0n, direction: x.d, ext: req.ext, p: pt(pr) })); await cuOf(conn, r.txHash, 'claim_swap'); await logsOf(conn, r.txHash, 'claim_swap');
    await sync(w); const gross = (sw.amount * terms.num) / terms.den; claimed[x.d].push(gross);
    x.claimOk = w.balance(mOut) === before + gross - f && w.sealedSwaps().length === 0; x.claimPr = pr; x.claimReq = req; }
  check('P3 six claims through the relayer: each seller receives exactly floor(amount x num / den) - fee as a new hidden note (the chain sees a nullifier, a commitment, the fee)', submitted.every((x) => x.claimOk), 'CU ' + CU.claim_swap);
  { const x = submitted[0]; await R.send([V.postProofIx(me, SE.KIND.CLAIM, x.claimPr.proof, x.claimPr.pubs)], [], 1_400_000);
    check('P3 double claim refused: the same claim again (its swap commitment\'s nullifier is published)', await refused(R.sendV0([await V.claimSwapIx(me, { binPool: POOL, seq: 0n, direction: 0, mintOut: USDC, ext: x.claimReq.ext, pubs: x.claimPr.pubs, poster: me })], [], 600_000), /AlreadySpent|already in use|0x0/));
    await R.send([V.cancelProofIx(me, SE.KIND.CLAIM, x.claimPr.pubs, me)]); }
  { const dust = [0, 1].map((d) => b0.num[d] - claimed[d].reduce((a, c) => a + c, 0n));
    const pfm = twin.protocolFee; const avail = set.xForY ? [totals[1] + set.netOut - pfm[1], totals[0] - set.netIn - pfm[0]] : [totals[1] - set.netIn - pfm[1], totals[0] + set.netOut - pfm[0]];
    check('P3 conservation per batch, per direction: sum of claims + rounding dust == net swap output + the opposite side\'s inputs - the matched part\'s protocol fee (dust < 1 atom per claim, kept by the shielded pool)',
      dust.every((x, d) => x >= 0n && x < 3n) && claimed[0].reduce((a, c) => a + c, 0n) + dust[0] === avail[0] && claimed[1].reduce((a, c) => a + c, 0n) + dust[1] === avail[1], `dust ${dust[0]} / ${dust[1]} atoms`); }
  mark('batch 0 claimed');

  // ================================================================================== G. the k-floor rolls a batch over; withheld shares -> refund
  await V.send([V.setSealedParamsIx(payer.publicKey, POOL, { ...params, epochSlots: 100, settleTimeout: 40 })]);
  const runSwap = async (w, d, amount, seq) => { await sync(w); const m = mintOfDir(d); const f = d === 0 ? fSol : fUsdc;
    const r = SE.sealedSwapRequest(w, { binPool: POOL, seq, direction: d, mintIn: m, amount, fee: f, minIn: params.minIn[d], PK, relayerToken: V.ata(m, me) }); const pr = await proveSwap(r.input);
    const res = await svc.submit(Jo({ kind: 'sealedSwap', binPool: POOL, seq, direction: d, c1: J.enc(r.c1), c2: J.enc(r.c2), ext: r.ext, p: pt(pr) })); return { r, pr, res, amount, fee: f }; };
  /// Wait for the current (empty) batch's epoch to end and close it: an empty batch is only extended, so this starts a full
  /// fresh epoch (the proofs below take seconds each; a swap after its batch's end is refused, BatchNotOpen).
  const freshEpoch = async () => { let s2 = await V.sealedState(POOL); if (s2.batch.count[0] + s2.batch.count[1] !== 0) throw new Error('fresh epoch on a non-empty batch');
    await waitSlot(s2.batch.endSlot); try { await as(mallory).send([V.closeBatchIx(mallory.publicKey, POOL, s2.batch.seq)], [], 1_400_000); } catch { /* someone closed it first */ } return V.sealedState(POOL); };
  st = await freshEpoch();
  check('P3 an empty batch at the end of its epoch is extended, not closed', st.batch.seq === 1n && st.batch.state === 'open' && st.batch.rollovers === 0 && st.batch.endSlot - BigInt(st.slot) > 80n);
  const g1 = [await runSwap(As[0], 0, units(0.5, 9), 1n), await runSwap(As[1], 0, units(0.6, 9), 1n)];
  st = await V.sealedState(POOL); await waitSlot(st.batch.endSlot);
  sig = await as(mallory).send([V.closeBatchIx(mallory.publicKey, POOL, 1n)], [], 1_400_000); let b1 = await V.batch(POOL, 1n); const rolled = await evOf(sig, 'BatchRolled');
  check('P3 k-floor: 2 sellers in a direction (k = 3) at the end of the epoch: the batch rolls over to the next epoch instead of settling (their total would be two people\'s)', b1.state === 'open' && b1.rollovers === 1 && rolled && rolled.count[0] === 2 && b1.endSlot > BigInt(await slot()));
  g1.push(await runSwap(As[2], 0, units(0.7, 9), 1n));
  st = await V.sealedState(POOL); await waitSlot(st.batch.endSlot);
  sig = await as(mallory).send([V.closeBatchIx(mallory.publicKey, POOL, 1n)], [], 1_400_000); b1 = await V.batch(POOL, 1n);
  check('P3 ...a third seller joins: at the next epoch end the batch is sealed (count [3, 0])', b1.state === 'closed' && b1.count[0] === 3 && b1.count[1] === 0);
  check('P3 the committee withholds its shares: nothing can be settled (NotEnoughShares) and nothing claimed yet (NotClaimable)', await refused(V.send([V.settleVerifyIx(b1.address, 0, units(1.8, 9))], [], 1_400_000), /NotEnoughShares/) && !(await V.claimTerms(POOL, 1n, 0)));
  await waitSlot(b1.closedSlot + 41n);
  await sync(...As);
  { const w = As[0]; const sw = w.sealedSwaps().find((n) => n.seq === 1n); const terms = await V.claimTerms(POOL, 1n, 0); const f = await fee('sealedClaim', SOL);
    const before = w.balance(SOL); const req = SE.sealedClaimRequest(w, { swap: sw, terms, fee: f, relayerToken: V.ata(SOL, me) }); const pr = await proveClaim(req.input);
    const r = await svc.submit(Jo({ kind: 'sealedClaim', binPool: POOL, seq: 1n, direction: 0, ext: req.ext, p: pt(pr) })); await sync(w); const e = await evOf(r.txHash, 'SealedClaimed');
    check('P3 refund after the settlement window: the claim circuit with num = den = 1 returns the sold token (amount - fee) as a hidden note; the batch is marked failed', terms.refund && e && e.refund && w.balance(SOL) === before + sw.amount - f && (await V.batch(POOL, 1n)).state === 'failed'); }
  check('P3 a failed batch can no longer settle, even with shares (BatchNotClosed)', await refused(CM.postShare(nv[0], nodes[0], { member: 1, sk: dk.members[0].sk, binPool: POOL, seq: 1n }), /not closed|BatchNotClosed/));
  for (const w of [As[1], As[2]]) { const sw = w.sealedSwaps().find((n) => n.seq === 1n); const terms = await V.claimTerms(POOL, 1n, 0); const f = await fee('sealedClaim', SOL); const req = SE.sealedClaimRequest(w, { swap: sw, terms, fee: f, relayerToken: V.ata(SOL, me) }); const pr = await proveClaim(req.input);
    await svc.submit(Jo({ kind: 'sealedClaim', binPool: POOL, seq: 1n, direction: 0, ext: req.ext, p: pt(pr) })); }
  await sync(...As);
  check('P3 every seller of the failed batch is refunded (the input notes come back, minus the two flat fees)', As.every((w, i) => w.sealedSwaps().length === 0) && As[1].balance(SOL) === units(10, 9) - sizes[0][1] - fSol - units(0.6, 9) - fSol + units(0.6, 9) - (await fee('sealedClaim', SOL)));
  mark('batch 1 refunded');

  // ================================================================================== H. out of rollovers -> fails at close; paused pools
  await V.send([V.setSealedParamsIx(payer.publicKey, POOL, { ...params, epochSlots: 100, settleTimeout: 40, maxRollovers: 0 })]);
  st = await freshEpoch(); const seq2 = st.batch.seq; const g2 = await runSwap(Bs[0], 1, units(10, 6), seq2);
  st = await V.sealedState(POOL); await waitSlot(st.batch.endSlot);
  sig = await as(mallory).send([V.closeBatchIx(mallory.publicKey, POOL, seq2)], [], 1_400_000); const failEv = await evOf(sig, 'BatchFailed');
  check('P3 out of rollovers: a batch still under the k-floor fails at close (a lone seller is never settled) and the next batch opens', failEv && (await V.batch(POOL, seq2)).state === 'failed' && (await V.batch(POOL, seq2 + 1n)).state === 'open');
  await sync(Bs[0]); { const w = Bs[0]; const sw = w.sealedSwaps()[0]; const terms = await V.claimTerms(POOL, seq2, 1); const f = await fee('sealedClaim', USDC); const before = w.balance(USDC);
    const req = SE.sealedClaimRequest(w, { swap: sw, terms, fee: f, relayerToken: V.ata(USDC, me) }); const pr = await proveClaim(req.input); await svc.submit(Jo({ kind: 'sealedClaim', binPool: POOL, seq: seq2, direction: 1, ext: req.ext, p: pt(pr) })); await sync(w);
    check('P3 ...and refunds', w.balance(USDC) === before + sw.amount - f); }
  await V.send([V.setSealedParamsIx(payer.publicKey, POOL, { ...params, epochSlots: 150 }, true)]); await freshEpoch();
  check('P3 a paused pool refuses sealed swaps (SealedPaused)', await refused(runSwap(Bs[1], 1, units(5, 6), seq2 + 1n), /SealedPaused/));
  await V.send([V.setSealedParamsIx(payer.publicKey, POOL, { ...params, epochSlots: 150 }, false)]);
  // ================================================================================== I. the committee as node processes
  // three committee/node.js processes (127.0.0.1:8863-8865) run the dealerless key generation over HTTP, the authority
  // rotates the on-chain committee to their key, and from then on the nodes alone close the batch, post their partial
  // decryptions (each checked on chain), recover the totals and settle it.
  { const path = require('path'); const fs = require('fs'); const os = require('os'); const { startLocalCommittee } = require('../scripts/committee-local.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-committee-')); const t0 = Date.now();
    const cmt = await startLocalCommittee({ n: 3, t: 2, dir, deployFile: path.join(__dirname, '..', `deploy.${dep.network}.json`), rpc: conn.rpcEndpoint, env: { WATCH_MS: '1500', BSGS_BITS: '40' } });
    try {
      const dkgMs = Date.now() - t0; const h = await Promise.all(cmt.peers.map(async (p) => (await fetch(p.url + '/health')).json()));
      check('P3 three committee nodes (separate processes) ran the dealerless DKG over HTTP: same joint key, same transcript, the transcript re-verifies (signatures, commitments, keys); /health answers', h.every((x) => x.ok && x.dkg === 'done' && x.pk === h[0].pk) && require('../committee/dkg.js').verifyTranscript(cmt.transcript).ok, dkgMs + ' ms');
      for (const k of cmt.keys) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
      await V.send([V.setCommitteeIx(payer.publicKey, cmt.registration)], [], 1_400_000); const c2 = await V.committee();
      check('P3 the authority rotates the committee to the nodes\' key (epoch 2); the nodes see themselves registered', c2.epoch === 2 && J.eq(c2.pk, cmt.registration.pk) && (await (async () => { for (let i = 0; i < 20; i++) { const x = await (await fetch(cmt.peers[0].url + '/health')).json(); if (x.registered) return true; await sleep(500); } return false; })()));
      // the current batch is empty (the paused attempt above failed): it takes the new key with its first swap
      await V.send([V.setSealedParamsIx(payer.publicKey, POOL, { ...params, epochSlots: 120, settleTimeout: 600 })]);
      let s0 = await freshEpoch();
      check('P3 an empty batch opened under the old key adopts the rotated one (nothing was encrypted to the old key)', s0.batch.count[0] + s0.batch.count[1] === 0);
      const pkNow = c2.pk; const seqN = s0.batch.seq; const swaps = [];
      for (const [w, a] of [[As[0], units(0.3, 9)], [As[1], units(0.4, 9)], [As[2], units(0.5, 9)]]) { await sync(w); const r = SE.sealedSwapRequest(w, { binPool: POOL, seq: seqN, direction: 0, mintIn: SOL, amount: a, fee: fSol, minIn: params.minIn[0], PK: pkNow, relayerToken: V.ata(SOL, me) });
        const pr = await proveSwap(r.input); swaps.push(await svc.submit(Jo({ kind: 'sealedSwap', binPool: POOL, seq: seqN, direction: 0, c1: J.enc(r.c1), c2: J.enc(r.c2), ext: r.ext, p: pt(pr) }))); }
      let bn = await V.batch(POOL, seqN); const tStart = Date.now();
      for (let i = 0; i < 240 && bn.state !== 'settled'; i++) { await sleep(1000); bn = await V.batch(POOL, seqN); }
      const hs = await Promise.all(cmt.peers.map(async (p) => (await fetch(p.url + '/health')).json()));
      check('P3 ...then the nodes alone: close the batch at its epoch end, post and prove their partial decryptions, recover the total, settle (no other party involved)', bn.state === 'settled' && bn.totals[0] === units(1.2, 9) && bn.committeeEpoch === 2 && hs.filter((x) => x.lastShare).length >= 2 && hs.some((x) => x.lastSettle),
        `${((Date.now() - tStart) / 1000).toFixed(0)} s from the last swap to settled, verified members ${bn.verified.toString(2)}`);
      await sync(As[0]); const sw = As[0].sealedSwaps().find((n) => n.seq === seqN); const terms = await V.claimTerms(POOL, seqN, 0); const f = await fee('sealedClaim', USDC); const before = As[0].balance(USDC);
      const req = SE.sealedClaimRequest(As[0], { swap: sw, terms, fee: f, relayerToken: V.ata(USDC, me) }); await svc.submit(Jo({ kind: 'sealedClaim', binPool: POOL, seq: seqN, direction: 0, ext: req.ext, p: pt(await proveClaim(req.input)) })); await sync(As[0]);
      check('P3 ...and a seller claims its output from the nodes\' settlement', As[0].balance(USDC) === before + (sw.amount * terms.num) / terms.den - f);
    } finally { cmt.stop(); fs.rmSync(dir, { recursive: true, force: true }); } }
  mark('phase 3 done');
  CU['prove swap (node, ms)'] = Math.round(TIMES.swap.reduce((a, b) => a + b, 0) / TIMES.swap.length); CU['prove claim (node, ms)'] = Math.round(TIMES.claim.reduce((a, b) => a + b, 0) / TIMES.claim.length);
  console.log('  timeline:\n    ' + timeline.join('\n    '));
};
