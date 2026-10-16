#!/usr/bin/env node
// Veyl on Solana, program tests against a local validator (RPC 8933):
// deploy -> Poseidon cross-check (JS vs syscall) -> deposits -> a REAL Groth16 proof verified on-chain -> withdraw ->
// double spend / stale root / wrong context refused -> ragequit -> bin pool maths vs the JS twin -> entry: relay,
// private swap, private add, signed private remove, public router.
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const nacl = require('tweetnacl');
const { Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const S = require('../sdk/veyl.js'); const { Veyl, H, be32, labelOf, contextOf, encodeAction, removeDigest, zeros, merklePath, withdrawInput, newNote, simulateSwap, priceOf, chunkOf, STATE_DEPTH, ASP_DEPTH, Q } = S;
const { prove, verifyLocal } = require('../sdk/prover.js');
const { startValidator, deployAll, deployPrograms, programIds, createMint, fund, units, sleep, priceQ } = require('../scripts/lib.js');
const { Relayer } = require('../relayer/relayer.js');
const PORT = require('../scripts/lib.js').RPC_PORT;
let pass = 0, fail = 0; const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '  ok  ' : '  FAIL') + ' ' + n + (extra !== '' ? '  ' + String(extra).slice(0, 200) : '')); };
const refused = async (p, re) => { try { await p; return false; } catch (e) { const t = String(e.message) + JSON.stringify(e.logs || e.transactionLogs || ''); if (!re.test(t)) console.log('    unexpected error:', t.slice(0, 600)); return re.test(t); } };
const CU = {}; const cuOf = async (conn, sig, label) => { const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); const m = (t.meta.logMessages || []).map((l) => l.match(/consumed (\d+) of \d+ compute units/)).filter(Boolean); if (m.length) CU[label] = Math.max(...m.map((x) => Number(x[1]))); };
const t0 = Date.now(); const lap = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-sol-')); const payer = Keypair.generate(); const payerFile = path.join(TMP, 'payer.json'); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  const { val, rpc, conn } = await startValidator(TMP, payer, PORT);
  // stop the validator and delete its ledger (each run would otherwise leave ~150 MB in the temp dir)
  const done = (code) => { val.once('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(code); }); val.kill(); setTimeout(() => process.exit(code), 8000).unref(); };
  try {
    const [postman, relayer, alice, bob, carol, mallory, fresh] = Array.from({ length: 7 }, () => Keypair.generate());
    for (const k of [postman, relayer, alice, bob, carol, mallory, fresh]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 50 * LAMPORTS_PER_SOL), 'confirmed');
    // REVIEW.md H-1: right after the programs are deployed, before the deployer initialises anything, a stranger tries to take
    // the bin factory (it is a fixed address: whoever creates it owns pool listing)
    await deployPrograms(rpc, payerFile);
    const factorySquat = await refused(new Veyl({ connection: conn, programs: programIds(), payer: mallory }).send([new Veyl({ connection: conn, programs: programIds() }).initFactoryIx(mallory.publicKey)]), /NotAuthority/);
    const { V, dep, T, BP } = await deployAll({ rpc, payerFile, postman: postman.publicKey, relayer: relayer.publicKey, deploy: false });
    console.log('deployed in', lap());
    const as = (kp) => { const v = new Veyl({ connection: conn, programs: V.programs, payer: kp }); v.lookupTable = V.lookupTable; return v; };
    const USDC = T.USDC.mint, SOL = T.SOL.mint, USDT = T.USDT.mint; const POOL = T.USDC.pool;
    for (const k of [alice, bob, carol, mallory]) { await fund(conn, payer, USDC, k.publicKey, units(100_000, 6)); await fund(conn, payer, SOL, k.publicKey, units(1_000, 9)); await fund(conn, payer, USDT, k.publicKey, units(100_000, 6)); }
    const bal = (mint, owner) => V.tokenBalance(mint, owner);

    // ---------------------------------------------------------------- pool: Poseidon + tree
    let p = await V.pool(POOL);
    check('three programs deployed; 5 private pools, factory, 5 bin pools, entry + vaults, lookup table', p && dep.binPools.length === 5 && Object.keys(dep.tokens).length === 5 && dep.lookupTable);
    const z = zeros(STATE_DEPTH);
    check('empty-tree root on chain == JS Poseidon (circomlib) zeros[32]: the sol_poseidon syscall matches poseidon-lite', p.currentRoot === z[STATE_DEPTH], p.currentRoot.toString().slice(0, 20));
    check('pool config: mint, min deposit 1 USDC, postman, authority', p.mint.equals(USDC) && p.minDeposit === units(1, 6) && p.postman.equals(postman.publicKey) && p.authority.equals(payer.publicKey));
    check('only the postman may publish an approved set', await refused(as(mallory).send([V.updateAspRootIx(mallory.publicKey, POOL, 123n)]), /OnlyPostman/));
    check('a zero / out-of-field root is refused', await refused(as(postman).send([V.updateAspRootIx(postman.publicKey, POOL, S.F)]), /BadField/));
    check('root history: 192 entries, one per slot (decoded from the account)', p.roots.length === 192 && S.ROOT_HISTORY === 192);
    // REVIEW.md H-1 + M-3: listing a pool is the upgrade authority's; a pre-created vault token account cannot block it
    { const m2 = await createMint(conn, payer, 6); const pool2 = V.poolPda(m2);
      await spl.createAssociatedTokenAccount(conn, mallory, m2, pool2, { commitment: 'confirmed' }, spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID, true);
      check('H-1: a stranger cannot create (squat) the private pool of a mint', await refused(as(mallory).send([await V.initPoolIx(mallory.publicKey, m2, 1n, mallory.publicKey)]), /NotAuthority/));
      check('H-1: a stranger could not create the bin factory right after the deploy (upgrade authority only); the deployer did', factorySquat && (await V.factory()).authority.equals(payer.publicKey));
      await V.send([await V.initPoolIx(payer.publicKey, m2, 1n, postman.publicKey)]);
      const q2 = await V.pool(pool2);
      check('M-3: the upgrade authority lists the pool even though a stranger created its vault token account first', q2 && q2.vault.equals(V.ata(m2, pool2)) && q2.authority.equals(payer.publicKey)); }

    // ---------------------------------------------------------------- deposits
    const aliceNote = newNote();
    check('below the minimum deposit is refused', await refused(as(alice).send([await V.depositIx(alice.publicKey, USDC, units(0.5, 6), aliceNote.precommitment)]), /BadAmount/));
    check('a zero precommitment is refused', await refused(as(alice).send([await V.depositIx(alice.publicKey, USDC, units(10, 6), 0n)]), /BadField/));
    let sig = await as(alice).send([await V.depositIx(alice.publicKey, USDC, units(1000, 6), aliceNote.precommitment)]); await cuOf(conn, sig, 'deposit');
    let ev = (await V.events(sig)).find((e) => e.name === 'Deposited');
    p = await V.pool(POOL);
    const expectLabel = labelOf(POOL, 1n);
    check('Deposited event: label = hash(pool, nonce) as computed in JS', ev && ev.label === expectLabel && ev.index === 0n && ev.value === units(1000, 6) && ev.beneficiary.equals(alice.publicKey));
    check('commitment on chain == Poseidon(value, label, precommitment) in JS', ev.commitment === H(units(1000, 6), ev.label, BigInt(aliceNote.precommitment)));
    Object.assign(aliceNote, { value: ev.value.toString(), label: ev.label.toString(), index: 0, commitment: ev.commitment });
    check('root after one leaf == JS merkle root over [commitment] (32 on-chain Poseidon hashes match)', p.currentRoot === merklePath([ev.commitment], 0, STATE_DEPTH).root && p.nextIndex === 1n);
    check('deposit record: beneficiary + commitment; vault holds the funds', (await V.depositRecord(V.depositPda(POOL, ev.label))).commitment === ev.commitment && (await conn.getTokenAccountBalance(p.vault)).value.amount === String(units(1000, 6)));
    // bob deposits twice, carol once (carol's will NOT be approved)
    const bobNote = newNote(), bobNote2 = newNote(), carolNote = newNote();
    for (const [kp, n, amt] of [[bob, bobNote, 500], [bob, bobNote2, 250], [carol, carolNote, 100]]) { const s = await as(kp).send([await V.depositIx(kp.publicKey, USDC, units(amt, 6), n.precommitment)]); const e = (await V.events(s)).find((x) => x.name === 'Deposited'); Object.assign(n, { value: e.value.toString(), label: e.label.toString(), index: Number(e.index), commitment: e.commitment }); }
    const tree = await V.readTree(POOL);
    check('readTree from signatures + logs: 4 leaves in order, 4 deposits', tree.leaves.length === 4 && tree.leaves[2] === bobNote2.commitment && tree.deposits.length === 4);
    p = await V.pool(POOL);
    check('tree root matches the 4 leaves', p.currentRoot === merklePath(tree.leaves, 0, STATE_DEPTH).root);
    // REVIEW.md M-4: a burst of inserts in one slot takes ONE root-history entry, so it cannot flush the roots proofs use
    { const m3 = await createMint(conn, payer, 6); await V.send([await V.initPoolIx(payer.publicKey, m3, 1n, postman.publicKey)]); await fund(conn, payer, m3, mallory.publicKey, units(100, 6));
      const pool3 = V.poolPda(m3); const before = await V.pool(pool3); const ixs = []; for (let i = 0; i < 5; i++) ixs.push(await V.depositIx(mallory.publicKey, m3, units(1, 6), newNote().precommitment, mallory.publicKey, mallory.publicKey, before.depositNonce + 1n + BigInt(i)));
      await as(mallory).send(ixs, [], 1_400_000); const after = await V.pool(pool3); const leaves3 = (await V.readTree(pool3)).leaves;
      check('M-4: five deposits in one slot: 5 leaves, 1 new root-history entry (the end-of-slot root)', after.nextIndex === before.nextIndex + 5n && after.currentRootIndex === before.currentRootIndex + 1n && after.currentRoot === merklePath(leaves3, 0, STATE_DEPTH).root && after.rootSlot > 0n); }

    // ---------------------------------------------------------------- approved set
    const labels = [aliceNote.label, bobNote.label, bobNote2.label].map(BigInt); // carol left out
    const aspRoot = merklePath(labels, 0, ASP_DEPTH).root;
    sig = await as(postman).send([V.updateAspRootIx(postman.publicKey, POOL, aspRoot, 'bafy-demo-cid')]);
    ev = (await V.events(sig)).find((e) => e.name === 'AspRootUpdated'); p = await V.pool(POOL);
    check('postman publishes the approved set (event with cid; ring holds it)', ev && ev.root === aspRoot && ev.ipfsCid === 'bafy-demo-cid' && p.aspRoot === aspRoot && p.isKnownAspRoot(aspRoot));

    // ---------------------------------------------------------------- a real proof, verified on chain
    const processor = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(processor.publicKey, 5 * LAMPORTS_PER_SOL), 'confirmed');
    const procAta = await fund(conn, payer, USDC, processor.publicKey, 0n);
    const data = Buffer.from('any action bytes the processor commits to'); const ctx = contextOf(processor.publicKey, data, POOL);
    console.log('  proving (snarkjs, this takes a while)...');
    let w = withdrawInput({ note: aliceNote, withdrawnValue: units(300, 6), context: ctx, leaves: tree.leaves, labels });
    let pr = await prove(w.input); console.log('  proof ready at', lap());
    check('snarkjs verifies the proof locally with the unchanged vkey', await verifyLocal(pr.raw));
    check('public signals: [newCommitment, nullifierHash, value, stateRoot, aspRoot, context] as the circuit emits them', pr.pubs[0] === BigInt(w.changeNote.commitment) && pr.pubs[1] === H(BigInt(aliceNote.nullifier)) && pr.pubs[2] === units(300, 6) && pr.pubs[3] === p.currentRoot && pr.pubs[4] === aspRoot && pr.pubs[5] === ctx);
    const nh = pr.pubs[1];
    // tampered proof / public inputs
    const bad = Buffer.from(pr.proof); bad[40] ^= 1;
    check('a tampered proof is refused on chain (BadProof)', await refused(as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, bad, pr.pubs, processor.publicKey)], [], 1_400_000), /BadProof/));
    const pubsMore = [...pr.pubs]; pubsMore[2] = units(301, 6);
    check('changing the withdrawn value under a valid proof is refused', await refused(as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pubsMore, processor.publicKey)], [], 1_400_000), /BadProof/));
    const pubsRoot = [...pr.pubs]; pubsRoot[3] = 12345n;
    check('an unknown state root is refused', await refused(as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pubsRoot, processor.publicKey)], [], 1_400_000), /UnknownStateRoot/));
    const pubsAsp = [...pr.pubs]; pubsAsp[4] = 777n;
    check('an unknown approved-set root is refused', await refused(as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pubsAsp, processor.publicKey)], [], 1_400_000), /StaleAspRoot/));
    sig = await as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, processor.publicKey)], [], 1_400_000);
    const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const cu = (tx.meta.logMessages.find((l) => /consumed \d+ of/.test(l) && l.includes(V.programs.pool.toBase58())) || '').match(/consumed (\d+)/);
    CU['post_withdrawal (proof check)'] = cu ? Number(cu[1]) : 0;
    check('the REAL proof verifies on chain (groth16-solana / alt_bn128 syscalls) and is posted', (await V.spend(V.spendPda(POOL, nh))).status === 1, 'compute units: ' + (cu ? cu[1] : '?'));
    // REVIEW.md M-2: a posted spend is not a lock. Anyone holding the proof can post it again, but only by replacing (and
    // refunding) the earlier post, and a newer post replaces theirs: parking a proof with a useless processor freezes nothing.
    { const spendKey = V.spendPda(POOL, nh); const rent = await conn.getBalance(spendKey); const relBefore = await conn.getBalance(relayer.publicKey);
      check('M-2: replacing a post must name its poster (refund goes to them)', await refused(as(mallory).send([V.postWithdrawalIx(mallory.publicKey, POOL, pr.proof, pr.pubs, mallory.publicKey, 100, mallory.publicKey)], [], 1_400_000), /NotProcessor/));
      await as(mallory).send([V.postWithdrawalIx(mallory.publicKey, POOL, pr.proof, pr.pubs, mallory.publicKey, 9000, relayer.publicKey)], [], 1_400_000);
      let sp = await V.spend(spendKey);
      check('M-2: a squatter can re-post a public proof with its own processor, but pays the earlier poster back', sp.poster.equals(mallory.publicKey) && sp.processor.equals(mallory.publicKey) && (await conn.getBalance(relayer.publicKey)) === relBefore + rent);
      await as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, processor.publicKey, S.DEFAULT_TTL_SLOTS, mallory.publicKey)], [], 1_400_000);
      sp = await V.spend(spendKey);
      check('M-2: ...and the next valid post replaces the squatter at once (no waiting for its TTL)', sp.poster.equals(relayer.publicKey) && sp.processor.equals(processor.publicKey) && sp.status === 1); }
    // execution
    check('another signer cannot execute the posted spend', await refused(as(mallory).send([await V.withdrawIx(mallory.publicKey, POOL, nh, await fund(conn, payer, USDC, mallory.publicKey, 0n), data)], [], 400_000), /NotProcessor/));
    check('the processor cannot execute with different action data (context mismatch)', await refused(as(processor).send([await V.withdrawIx(processor.publicKey, POOL, nh, procAta, Buffer.from('other'))], [], 400_000), /BadContext/));
    sig = await as(processor).send([await V.withdrawIx(processor.publicKey, POOL, nh, procAta, data)], [], 400_000); await cuOf(conn, sig, 'withdraw');
    ev = (await V.events(sig)).find((e) => e.name === 'Withdrawn'); p = await V.pool(POOL);
    check('withdraw: 300 USDC to the processor, change note inserted at index 4, nullifier spent', ev && ev.value === units(300, 6) && ev.index === 4n && ev.newCommitment === BigInt(w.changeNote.commitment) && (await bal(USDC, processor.publicKey)) === units(300, 6) && (await V.isSpent(POOL, nh)));
    check('root history keeps the old root and knows the new one', p.isKnownRoot(pr.pubs[3]) && p.currentRoot === merklePath([...tree.leaves, BigInt(w.changeNote.commitment)], 0, STATE_DEPTH).root);
    check('executing twice is refused (AlreadySpent)', await refused(as(processor).send([await V.withdrawIx(processor.publicKey, POOL, nh, procAta, data)], [], 400_000), /AlreadySpent/));
    check('posting a spent nullifier again is refused (AlreadySpent)', await refused(as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, processor.publicKey)], [], 1_400_000), /AlreadySpent/));
    // spend the change note (700 USDC) in full
    const changeNote = { ...w.changeNote, index: 4 };
    let leaves = (await V.readTree(POOL)).leaves; check('history now has 5 leaves (deposits + change)', leaves.length === 5);
    w = withdrawInput({ note: changeNote, withdrawnValue: units(700, 6), context: ctx, leaves, labels }); pr = await prove(w.input); console.log('  proof 2 at', lap());
    await as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, processor.publicKey)], [], 1_400_000);
    await as(processor).send([await V.withdrawIx(processor.publicKey, POOL, pr.pubs[1], procAta, data)], [], 400_000);
    check('the change note is spent in full (label follows the money); zero-value change note still inserted', (await bal(USDC, processor.publicKey)) === units(1000, 6) && (await V.pool(POOL)).nextIndex === 6n);
    check('a zero-value withdrawal is refused at post time', await refused((async () => { const q = [...pr.pubs]; q[2] = 0n; q[1] = 99n; await as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, q, processor.publicKey)], [], 1_400_000); })(), /BadAmount/));
    // cancel a posted spend
    leaves = (await V.readTree(POOL)).leaves;
    w = withdrawInput({ note: bobNote2, withdrawnValue: units(50, 6), context: ctx, leaves, labels }); pr = await prove(w.input); console.log('  proof 3 at', lap());
    await as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, processor.publicKey, 100)], [], 1_400_000);
    check('a stranger cannot cancel a fresh posted spend', await refused(as(mallory).send([await V.cancelPostIx(mallory.publicKey, POOL, pr.pubs[1])]), /NotExpired/));
    const lamBefore = await conn.getBalance(relayer.publicKey);
    await as(relayer).send([await V.cancelPostIx(relayer.publicKey, POOL, pr.pubs[1])]);
    check('the poster cancels: the nullifier PDA is closed, rent back, note still unspent', !(await V.spend(V.spendPda(POOL, pr.pubs[1]))) && (await conn.getBalance(relayer.publicKey)) > lamBefore);
    await as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, processor.publicKey, 1)], [], 1_400_000);
    { const exp = (await V.spend(V.spendPda(POOL, pr.pubs[1]))).expiresAt; for (let i = 0; i < 60 && BigInt(await conn.getSlot('confirmed')) <= exp; i++) await sleep(500); }
    await as(mallory).send([await V.cancelPostIx(mallory.publicKey, POOL, pr.pubs[1])]);
    check('after expiry anyone can cancel a posted spend (rent to the poster)', !(await V.spend(V.spendPda(POOL, pr.pubs[1]))));
    // stale asp root between post and execute
    await as(relayer).send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, processor.publicKey)], [], 1_400_000);
    const aspRoot2 = merklePath([aliceNote.label, bobNote.label].map(BigInt), 0, ASP_DEPTH).root; // bob's second deposit flagged
    await as(postman).send([V.resetAspRootsIx(postman.publicKey, POOL, aspRoot2, 'bafy-reset')]);
    check('an emergency approved-set reset stops a posted-but-unexecuted spend (StaleAspRoot)', await refused(as(processor).send([await V.withdrawIx(processor.publicKey, POOL, pr.pubs[1], procAta, data)], [], 400_000), /StaleAspRoot/));
    await as(relayer).send([await V.cancelPostIx(relayer.publicKey, POOL, pr.pubs[1])]);
    await as(postman).send([V.updateAspRootIx(postman.publicKey, POOL, aspRoot, 'bafy-demo-cid')]);
    check('history ring: the earlier set is known again after re-publishing', (await V.pool(POOL)).isKnownAspRoot(aspRoot));
    // REVIEW.md M-2: the public exit cannot be blocked by parking that (now public) proof with a useless processor
    await as(mallory).send([V.postWithdrawalIx(mallory.publicKey, POOL, pr.proof, pr.pubs, mallory.publicKey, 9000)], [], 1_400_000);
    { const b0 = await bal(USDC, bob.publicKey); await as(bob).send([await V.ragequitIx(bob.publicKey, USDC, bobNote2)]);
      check('M-2: bob ragequits his deposit although a squatter posted its proof (the post is overridden, nullifier now spent)', (await bal(USDC, bob.publicKey)) - b0 === units(250, 6) && (await V.isSpent(POOL, pr.pubs[1]))); }
    // unapproved deposit: no private exit
    leaves = (await V.readTree(POOL)).leaves;
    check('an unapproved deposit cannot be proven against the approved set', (() => { try { withdrawInput({ note: carolNote, withdrawnValue: 1n, context: ctx, leaves, labels }); return false; } catch (e) { return /not approved/.test(e.message); } })());

    // ---------------------------------------------------------------- ragequit
    check('ragequit by someone else is refused', await refused(as(mallory).send([await V.ragequitIx(mallory.publicKey, USDC, carolNote)]), /NotDepositor|ConstraintHasOne|has one|seeds/i));
    check('ragequit with a wrong secret is refused', await refused(as(carol).send([await V.ragequitIx(carol.publicKey, USDC, { ...carolNote, secret: '7' })]), /BadNote/));
    const c0 = await bal(USDC, carol.publicKey); const lamC = await conn.getBalance(carol.publicKey);
    sig = await as(carol).send([await V.ragequitIx(carol.publicKey, USDC, carolNote)]);
    check('carol takes her unapproved 100 USDC back publicly; deposit record closed (rent back); nullifier spent', (await bal(USDC, carol.publicKey)) - c0 === units(100, 6) && !(await V.depositRecord(V.depositPda(POOL, carolNote.label))) && (await V.isSpent(POOL, H(BigInt(carolNote.nullifier)))) && (await conn.getBalance(carol.publicKey)) > lamC - 10_000_000);
    check('ragequit twice is refused', await refused(as(carol).send([await V.ragequitIx(carol.publicKey, USDC, carolNote)]), /AccountNotInitialized|already in use|0x0|BadNote|NotDepositor/i));
    // two-step authority
    await V.send([V.proposeAuthorityIx(payer.publicKey, POOL, fresh.publicKey)]);
    check('a non-pending key cannot accept the pool authority', await refused(as(mallory).send([V.acceptAuthorityIx(mallory.publicKey, POOL)]), /NotAuthority/));
    await as(fresh).send([V.acceptAuthorityIx(fresh.publicKey, POOL)]);
    check('two-step authority transfer; the new authority sets the postman', (await V.pool(POOL)).authority.equals(fresh.publicKey) && !(await refused(as(fresh).send([V.setPostmanIx(fresh.publicKey, POOL, postman.publicKey)]), /./)));

    // ---------------------------------------------------------------- bin pool
    const BPX = BP.find((b) => b.id === 'sol-usdc'); const bp0 = await V.binPool(BPX.address);
    check('bin pool SOL/USDC: step 10 bps, base fee 500 pips, price(0) = 150 USDC/SOL in raw 128.128', bp0.binStep === 10 && bp0.baseFee === 500 && bp0.basePrice === priceQ(150, 9, 6) && bp0.activeId === 0 && !bp0.seeded);
    check('priceOf(id) JS: P(100) ≈ P(0) * 1.001^100', (() => { const r = Number(priceOf(bp0.basePrice, 10, 100)) / Number(bp0.basePrice); return Math.abs(r - 1.001 ** 100) < 1e-9; })());
    check('only the factory authority may create pools', await refused(as(mallory).send([await V.createPoolIx(mallory.publicKey, SOL, USDT, 20, 500, 10_000, Q, 0)]), /NotAuthority|ConstraintHasOne|has one/i));
    check('bad pool params are refused (binStep 0)', await refused(V.send([await V.createPoolIx(payer.publicKey, SOL, USDT, 0, 500, 10_000, Q, 0)]), /BadParams|seeds|ConstraintSeeds/i));
    // alice mints: bins -5..5, 1 SOL per bin above and at active (x), 150 USDC per bin at/below (y)
    const ids = []; const ax = []; const ay = [];
    for (let i = -5; i <= 5; i++) { ids.push(i); ax.push(i >= 0 ? units(1, 9) : 0n); ay.push(i <= 0 ? units(150, 6) : 0n); }
    check('swapping on an unseeded pool is refused', await refused(as(bob).send([await V.swapIx(bob.publicKey, BPX.address, true, units(1, 9))], [], 1_400_000), /InsufficientLiquidity/));
    let pre = await V.ensureBinAccountsIxs(alice.publicKey, BPX.address, ids, alice.publicKey, alice.publicKey);
    check('bin arrays and share accounts are created on demand (chunks -1 and 0)', pre.length === 4);
    await as(alice).send(pre);
    check('a wrong-side add is refused (Y above the active bin)', await refused(as(alice).send([await V.mintIx(alice.publicKey, BPX.address, { ids: [3], amountsX: [0n], amountsY: [units(1, 6)] })], [], 400_000), /WrongSide/));
    check('an expired add is refused', await refused(as(alice).send([await V.mintIx(alice.publicKey, BPX.address, { ids: [3], amountsX: [units(1, 9)], amountsY: [0n], deadline: 1 })], [], 400_000), /Expired/));
    sig = await as(alice).send([await V.mintIx(alice.publicKey, BPX.address, { ids, amountsX: ax, amountsY: ay })], [], 1_400_000);
    ev = (await V.events(sig)).find((e) => e.name === 'Minted'); let bp = await V.binPool(BPX.address);
    check('mint: 11 bins, Minted event with shares; pool seeded with range -5..5', ev && ev.shares.length === 11 && bp.seeded && bp.lowestId === -5 && bp.highestId === 5);
    let bins = await V.bins(BPX.address, [-1, 0]);
    check('first mint into a bin locks MIN_LIQUIDITY: shares(bin 3) = x*P/Q - 1000, supply = x*P/Q', bins.get(3).shares === S.mulDiv(units(1, 9), priceOf(bp.basePrice, 10, 3), Q) && ev.shares[8] === bins.get(3).shares - S.MIN_LIQUIDITY);
    check('vaults received 6 SOL and 6*150 USDC', (await conn.getTokenAccountBalance(bp.vaultX)).value.amount === String(units(6, 9)) && (await conn.getTokenAccountBalance(bp.vaultY)).value.amount === String(units(900, 6)));
    // quote: on-chain simulate == JS twin, then the real swap matches both
    const amountIn = units(2.5, 9);
    const qc = await V.quote(BPX.address, true, amountIn); const ql = await V.quoteLocal(BPX.address, true, amountIn, Math.floor(Date.now() / 1000));
    check('quote (on-chain simulate) == quote (JS twin) for 2.5 SOL -> USDC', qc.out === ql.out && qc.fee === ql.fee && qc.endId === ql.endId, `out ${qc.out} fee ${qc.fee} endId ${qc.endId}`);
    check('quote crosses bins: 2.5 SOL eats bin 0 (150 USDC) and walks down; fee between the 0.05% base and 0.2%', qc.endId < 0 && qc.fee >= amountIn / 2_000n && qc.fee < amountIn / 500n);
    check('slippage protection: minOut above the quote is refused', await refused(as(bob).send([await V.swapIx(bob.publicKey, BPX.address, true, amountIn, qc.out + 1n)], [], 1_400_000), /Slippage/));
    const b0 = await bal(USDC, bob.publicKey);
    sig = await as(bob).send([await V.swapIx(bob.publicKey, BPX.address, true, amountIn, qc.out)], [], 1_400_000); await cuOf(conn, sig, 'swap (3 bins)');
    ev = (await V.events(sig)).find((e) => e.name === 'Swapped'); bp = await V.binPool(BPX.address);
    check('swap: bob receives exactly the quoted USDC; event; active bin moved', (await bal(USDC, bob.publicKey)) - b0 === qc.out && ev.amountOut === qc.out && ev.fee === qc.fee && bp.activeId === qc.endId);
    check('volatility accumulator recorded (idRef/volRef/lastSwapAt)', bp.lastSwapAt > 0n && bp.idRef === 0);
    const feeNow = await V.currentFee(BPX.address);
    check('right after a bin-crossing swap the fee is above the base fee', feeNow > 500n, String(feeNow));
    // the other direction, multiple bins up
    const qc2 = await V.quote(BPX.address, false, units(700, 6));
    sig = await as(bob).send([await V.swapIx(bob.publicKey, BPX.address, false, units(700, 6), qc2.out)], [], 1_400_000);
    ev = (await V.events(sig)).find((e) => e.name === 'Swapped');
    check('swap USDC -> SOL walks bins up; matches the quote', ev.amountOut === qc2.out && ev.activeId === qc2.endId && qc2.endId > 0);
    // fees are accounted per share (claimable), not folded into the reserves: alice's position shows them, burn returns the reserves
    bins = await V.bins(BPX.address, [-1, 0]); let worth = { x: 0n, y: 0n }; const sh = await V.shares(BPX.address, alice.publicKey, alice.publicKey, 0); const shm = await V.shares(BPX.address, alice.publicKey, alice.publicKey, -1);
    for (const id of ids) { const s = id < 0 ? shm[S.slotOf(id)] : sh[S.slotOf(id)]; const v = V.valueOf(bins.get(id), s); worth.x += v.x; worth.y += v.y; }
    const posA = await V.position(BPX.address, alice.publicKey, alice.publicKey, ids); bp = await V.binPool(BPX.address);
    check('swap fees are claimable per position in both tokens (the LP share, after the 10% protocol share)', posA.fees.x > 0n && posA.fees.y > 0n && bp.protocolFeeX > 0n && bp.protocolFeeY > 0n && bp.protocolFeeX + posA.fees.x <= bp.totalFeeX, `${posA.fees.x} lamports + ${posA.fees.y} USDC atoms`);
    check('burn more shares than owned is refused', await refused(as(alice).send([await V.burnIx(alice.publicKey, BPX.address, { ids: [0], shares: [sh[0] + 1n] })], [], 400_000), /NotEnoughShares/));
    check('a stranger cannot burn alice\'s shares', await refused(as(mallory).send([await V.burnIx(mallory.publicKey, BPX.address, { owner: alice.publicKey, ids: [0], shares: [1n] })], [], 400_000), /MissingShareAccount|WrongShareAccount|NotEnoughShares/));
    const ax0 = await bal(SOL, alice.publicKey), ay0 = await bal(USDC, alice.publicKey);
    sig = await as(alice).send([await V.burnIx(alice.publicKey, BPX.address, { ids, shares: ids.map((id) => (id < 0 ? shm[S.slotOf(id)] : sh[S.slotOf(id)])) })], [], 1_400_000);
    ev = (await V.events(sig)).find((e) => e.name === 'Burned');
    check('burn all: alice gets her share of every bin\'s reserves, matching valueOf; the fees stay claimable', ev && (await bal(SOL, alice.publicKey)) - ax0 === worth.x && (await bal(USDC, alice.publicKey)) - ay0 === worth.y && ev.amountX === worth.x);
    { const pos2 = await V.position(BPX.address, alice.publicKey, alice.publicKey, ids); const s2 = await as(alice).send([await V.claimFeesIx(alice.publicKey, BPX.address, { ids })], [], 600_000); const ec = (await V.events(s2)).find((e) => e.name === 'FeesClaimed');
      check('claim_fees after the full burn pays exactly the fees earned (== what position() showed before the burn)', ec && ec.amountX === posA.fees.x && ec.amountY === posA.fees.y && pos2.fees.x === posA.fees.x); }
    bins = await V.bins(BPX.address, [-1, 0]);
    check('MIN_LIQUIDITY stays locked in each bin after a full burn (supply == 1000, dust reserves)', ids.every((id) => bins.get(id).shares === S.MIN_LIQUIDITY));
    // re-seed liquidity for the entry tests (alice, wider range, both pools)
    const ids2 = []; const ax2 = []; const ay2 = []; bp = await V.binPool(BPX.address);
    for (let i = bp.activeId - 8; i <= bp.activeId + 8; i++) { ids2.push(i); ax2.push(i >= bp.activeId ? units(2, 9) : 0n); ay2.push(i <= bp.activeId ? units(300, 6) : 0n); }
    await as(alice).send([...(await V.ensureBinAccountsIxs(alice.publicKey, BPX.address, ids2, alice.publicKey, alice.publicKey)), await V.mintIx(alice.publicKey, BPX.address, { ids: ids2, amountsX: ax2, amountsY: ay2 })], [], 1_400_000);
    const BPU = BP.find((b) => b.id === 'usdt-usdc'); const ids3 = [], ax3 = [], ay3 = [];
    for (let i = -3; i <= 3; i++) { ids3.push(i); ax3.push(i >= 0 ? units(1000, 6) : 0n); ay3.push(i <= 0 ? units(1000, 6) : 0n); }
    await as(alice).send([...(await V.ensureBinAccountsIxs(alice.publicKey, BPU.address, ids3, alice.publicKey, alice.publicKey)), await V.mintIx(alice.publicKey, BPU.address, { ids: ids3, amountsX: ax3, amountsY: ay3 })], [], 1_400_000);
    check('liquidity re-seeded in SOL/USDC and USDT/USDC', (await V.binPool(BPU.address)).seeded);

    // ---------------------------------------------------------------- public router (VeylRouter)
    const routes = await V.prepareRoutes([{ amountIn: units(100, 6), hops: [{ pool: BPU.address, xForY: true }, { pool: BPX.address, xForY: false }] }]);
    const q1 = await V.quote(BPU.address, true, units(100, 6)); const q2 = await V.quote(BPX.address, false, q1.out);
    const cs0 = await bal(SOL, carol.publicKey);
    check('router refuses a route whose minOut is not met', await refused(as(carol).send([await V.swapRouteIx(carol.publicKey, USDT, SOL, routes, q2.out + 1n)], [], 1_400_000), /Slippage/));
    sig = await as(carol).send([await V.swapRouteIx(carol.publicKey, USDT, SOL, routes, q2.out)], [], 1_400_000);
    ev = (await V.events(sig)).find((e) => e.name === 'Routed');
    check('swap_route: 100 USDT -> USDC -> SOL in one transaction, output = chained quotes', ev && ev.amountOut === q2.out && (await bal(SOL, carol.publicKey)) - cs0 === q2.out, String(q2.out));
    check('router refuses a route that ends in the wrong token', await refused(as(carol).send([await V.swapRouteIx(carol.publicKey, USDT, USDC, await V.prepareRoutes([{ amountIn: units(10, 6), hops: [{ pool: BPU.address, xForY: true }, { pool: BPX.address, xForY: false }] }]), 0n)], [], 1_400_000), /BadRoute|ConstraintTokenMint|UnknownToken|Constraint/));

    // ---------------------------------------------------------------- entry: relay
    const R = as(relayer); const EP = V.signerPda(); const FEE_BPS = 5;
    const relayerFeeAta = V.ata(USDC, relayer.publicKey);
    leaves = (await V.readTree(POOL)).leaves;
    const freshAta = await fund(conn, payer, USDC, fresh.publicKey, 0n);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    let d = { recipient: fresh.publicKey, feeRecipient: relayer.publicKey, feeBps: FEE_BPS, deadline };
    let act = encodeAction('relay', d); let ctxR = contextOf(EP, act, POOL);
    w = withdrawInput({ note: bobNote, withdrawnValue: units(200, 6), context: ctxR, leaves, labels }); pr = await prove(w.input); console.log('  proof 4 (relay) at', lap());
    await R.send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, EP)], [], 1_400_000);
    check('relayer cannot redirect: a different recipient breaks the context', await refused(R.send([await V.relayIx(relayer.publicKey, USDC, pr.pubs[1], { ...d, recipient: mallory.publicKey })], [], 400_000), /BadContext|AccountNotInitialized|WrongRecipient/));
    check('relayer cannot raise its fee', await refused(R.send([await V.relayIx(relayer.publicKey, USDC, pr.pubs[1], { ...d, feeBps: 50 })], [], 400_000), /BadContext/));
    check('relayer cannot sit on it past the deadline (data with an old deadline fails the context; an expired one is refused)', await refused(R.send([await V.relayIx(relayer.publicKey, USDC, pr.pubs[1], { ...d, deadline: 1 })], [], 400_000), /Expired|BadContext/));
    sig = await R.send([await V.relayIx(relayer.publicKey, USDC, pr.pubs[1], d)], [], 600_000); await cuOf(conn, sig, 'relay');
    ev = (await V.events(sig)).find((e) => e.name === 'Relayed');
    check('relay: 200 USDC from bob\'s note -> fresh wallet minus 0.05% fee; relayer paid; entry holds nothing', ev && ev.value === units(200, 6) && ev.fee === units(0.1, 6) && (await bal(USDC, fresh.publicKey)) === units(199.9, 6) && (await bal(USDC, relayer.publicKey)) === units(0.1, 6) && (await bal(USDC, EP)) === 0n);
    check('a posted proof can only be executed once through the entry', await refused(R.send([await V.relayIx(relayer.publicKey, USDC, pr.pubs[1], d)], [], 400_000), /AlreadySpent/));
    const bobChange = { ...w.changeNote, index: Number((await V.pool(POOL)).nextIndex - 1n) };

    // ---------------------------------------------------------------- entry: private swap (USDC note -> SOL note)
    leaves = (await V.readTree(POOL)).leaves; const POOL_SOL = T.SOL.pool;
    const outNote = newNote(); const refundKey = Keypair.generate();
    const swapRoutes = await V.prepareRoutes([{ amountIn: units(150, 6) - units(0.075, 6), hops: [{ pool: BPX.address, xForY: false }] }]);
    const qs = await V.quote(BPX.address, false, swapRoutes[0].amountIn);
    d = { tokenOut: SOL, routes: swapRoutes, minOut: qs.out - qs.out / 100n, recipient: null, outPrecommitment: BigInt(outNote.precommitment), refundTo: refundKey.publicKey, feeRecipient: relayer.publicKey, feeBps: FEE_BPS, deadline };
    act = encodeAction('swap', d); let ctxS = contextOf(EP, act, POOL);
    w = withdrawInput({ note: bobChange, withdrawnValue: units(150, 6), context: ctxS, leaves, labels }); pr = await prove(w.input); console.log('  proof 5 (swap) at', lap());
    await R.send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, EP)], [], 1_400_000);
    check('a relay cannot execute a proof made for a swap (action tag is in the context)', await refused(R.send([await V.relayIx(relayer.publicKey, USDC, pr.pubs[1], { recipient: fresh.publicKey, feeRecipient: relayer.publicKey, feeBps: FEE_BPS, deadline })], [], 400_000), /BadContext/));
    sig = await R.sendV0([await V.privateSwapIx(relayer.publicKey, USDC, pr.pubs[1], d)], [], 1_400_000); await cuOf(conn, sig, 'private_swap (1 hop)');
    check('private_swap goes through as a v0 transaction with the relayer\'s lookup table', (await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).version === 0);
    const evs = await V.events(sig); ev = evs.find((e) => e.name === 'PrivateSwapped'); const dep2 = evs.find((e) => e.name === 'Deposited');
    check('private swap: 150 USDC note -> fee -> SOL via the bin pool -> new SOL note deposited for the refund key', ev && ev.amountIn === units(149.925, 6) && ev.amountOut === qs.out && dep2 && dep2.pool.equals(POOL_SOL) && dep2.value === qs.out && dep2.precommitment === BigInt(outNote.precommitment) && dep2.beneficiary.equals(refundKey.publicKey), `out ${qs.out} lamports`);
    check('nothing is left in the entry\'s vaults', (await bal(USDC, EP)) === 0n && (await bal(SOL, EP)) === 0n);
    Object.assign(outNote, { value: dep2.value.toString(), label: dep2.label.toString(), index: Number(dep2.index), commitment: dep2.commitment });
    const bobChange2 = { ...w.changeNote, index: Number(evs.find((e) => e.name === 'Withdrawn').index) }; // 150 USDC left
    // the SOL note is spendable once approved: approve it and relay it to a fresh wallet
    const solLabels = [BigInt(outNote.label)]; const solAsp = merklePath(solLabels, 0, ASP_DEPTH).root;
    await as(postman).send([V.updateAspRootIx(postman.publicKey, POOL_SOL, solAsp, 'bafy-sol')]);
    const freshSolAta = await fund(conn, payer, SOL, fresh.publicKey, 0n); await fund(conn, payer, SOL, relayer.publicKey, 0n);
    const solLeaves = (await V.readTree(POOL_SOL)).leaves;
    d = { recipient: fresh.publicKey, feeRecipient: relayer.publicKey, feeBps: FEE_BPS, deadline };
    w = withdrawInput({ note: outNote, withdrawnValue: BigInt(outNote.value), context: contextOf(EP, encodeAction('relay', d), POOL_SOL), leaves: solLeaves, labels: solLabels }); pr = await prove(w.input); console.log('  proof 6 (relay SOL) at', lap());
    await R.send([V.postWithdrawalIx(relayer.publicKey, POOL_SOL, pr.proof, pr.pubs, EP)], [], 1_400_000);
    await R.send([await V.relayIx(relayer.publicKey, SOL, pr.pubs[1], d)], [], 600_000);
    check('the swap output note is spent privately in turn (SOL to a fresh wallet)', (await bal(SOL, fresh.publicKey)) === BigInt(outNote.value) - BigInt(outNote.value) * 5n / 10_000n);

    // ---------------------------------------------------------------- the relayer service (relayer/relayer.js) on this deployment
    const svc = new Relayer({ connection: conn, wallet: relayer, deploy: dep }); const J = (o) => JSON.parse(S.j(o));
    { const { clientKey } = require('../relayer/relayer.js'); const viaProxy = { headers: { 'x-forwarded-for': 'spoofed-by-client, 203.0.113.7' }, socket: { remoteAddress: '10.0.0.1' } };
      check('L-2: behind a proxy (TRUST_PROXY=1) the rate limit keys on the address the proxy appended, not the proxy or a spoofed entry', clientKey(viaProxy, 1) === '203.0.113.7' && clientKey(viaProxy, 0) === '10.0.0.1'); }
    const fresh3 = Keypair.generate().publicKey;
    let rq = { kind: 'relay', mint: USDC, value: units(100, 6), d: { recipient: fresh3, feeRecipient: relayer.publicKey, feeBps: FEE_BPS, deadline } };
    check('M-1: /fee refuses an amount whose fee could not pay the relayer back within the 1% cap', await refused(svc.feeQuote(J({ ...rq, value: 10_000n })), /too small/));
    const fq = await svc.feeQuote(J(rq));
    check('M-1: /fee prices the request\'s real cost (spent marker + recipient token account + 2 fees): 100 USDC needs more than the 5 bps floor', fq.feeBps > FEE_BPS && fq.costLamports === S.rentOf(250) + S.rentOf(165) + 10_000, `${fq.feeBps} bps, ${fq.costLamports} lamports`);
    { const fakeProof = { proof: Buffer.alloc(256).toString('base64'), pubs: ['1', '2', String(units(100, 6)), '3', '4', '5'] };
      check('M-1: /submit refuses a fee that does not cover the relayer\'s cost before sending anything', await refused(svc.submit(J({ kind: 'relay', mint: USDC, d: rq.d, p: fakeProof })), /fee too low/)); }
    leaves = (await V.readTree(POOL)).leaves; rq.d.feeBps = fq.feeBps;
    w = withdrawInput({ note: bobChange2, withdrawnValue: units(100, 6), context: contextOf(EP, encodeAction('relay', rq.d), POOL), leaves, labels }); pr = await prove(w.input); console.log('  proof 8 (relay via the service) at', lap());
    { const r = await svc.submit(J({ kind: 'relay', mint: USDC, d: rq.d, p: { proof: pr.proof.toString('base64'), pubs: pr.pubs.map(String) } })); const evx = await V.events(r.txs[0]);
      const fee = units(100, 6) * BigInt(fq.feeBps) / 10_000n;
      check('M-2: the service posts and executes a relay in ONE transaction (the proof is never parked on chain)', r.txs.length === 1 && evx.some((e) => e.name === 'Posted') && evx.some((e) => e.name === 'Relayed') && (await bal(USDC, fresh3)) === units(100, 6) - fee, r.txs.length + ' tx');
      var bobChange3 = { ...w.changeNote, index: Number(evx.find((e) => e.name === 'Withdrawn').index) }; } // 50 USDC left
    // REVIEW.md M-6: proceeds below a pool's minimum deposit still land as a note (the entry's signer is exempt)
    leaves = (await V.readTree(POOL)).leaves; const dustNote = newNote(); const dustIn = units(0.06, 6) - units(0.06, 6) * 5n / 10_000n;
    d = { tokenOut: SOL, routes: await V.prepareRoutes([{ amountIn: dustIn, hops: [{ pool: BPX.address, xForY: false }] }]), minOut: 1n, recipient: null, outPrecommitment: BigInt(dustNote.precommitment), refundTo: refundKey.publicKey, feeRecipient: relayer.publicKey, feeBps: FEE_BPS, deadline };
    w = withdrawInput({ note: bobChange3, withdrawnValue: units(0.06, 6), context: contextOf(EP, encodeAction('swap', d), POOL), leaves, labels }); pr = await prove(w.input); console.log('  proof 9 (dust swap) at', lap());
    await R.send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, EP)], [], 1_400_000);
    { const evd = await V.events(await R.sendV0([await V.privateSwapIx(relayer.publicKey, USDC, pr.pubs[1], d)], [], 1_400_000)); const dd = evd.find((e) => e.name === 'Deposited');
      check('M-6: a private swap whose output (' + (dd ? dd.value : '?') + ' lamports) is below the SOL pool\'s 0.0005 minimum still becomes a note', dd && dd.pool.equals(POOL_SOL) && dd.value > 0n && dd.value < units(0.0005, 9)); }
    check('M-6: a wallet\'s own deposit below the minimum is still refused', await refused(as(alice).send([await V.depositIx(alice.publicKey, SOL, units(0.0001, 9), newNote().precommitment)]), /BadAmount/));

    // ---------------------------------------------------------------- entry: private add + signed private remove
    // alice's fresh deposit funds a one-sided USDC position below the active bin in SOL/USDC
    const aliceNote2 = newNote(); sig = await as(alice).send([await V.depositIx(alice.publicKey, USDC, units(600, 6), aliceNote2.precommitment)]);
    ev = (await V.events(sig)).find((e) => e.name === 'Deposited'); Object.assign(aliceNote2, { value: ev.value.toString(), label: ev.label.toString(), index: Number(ev.index), commitment: ev.commitment });
    const labels2 = [...labels, BigInt(aliceNote2.label)]; const asp3 = merklePath(labels2, 0, ASP_DEPTH).root; await as(postman).send([V.updateAspRootIx(postman.publicKey, POOL, asp3, 'bafy-3')]);
    leaves = (await V.readTree(POOL)).leaves; bp = await V.binPool(BPX.address);
    const owner = Keypair.generate(); // one-time key: never sends a transaction
    const addIds = [bp.activeId - 2, bp.activeId - 1, bp.activeId]; const net = units(600, 6) - units(0.3, 6); const per = net / 3n;
    // REVIEW.md M-5: minimum shares per bin are required; the bin program refuses a mint that gives fewer
    const binsNow = await V.bins(BPX.address, [...new Set(addIds.map(S.chunkOf))]); const feeNow2 = await V.currentFee(BPX.address);
    const amountsY = [per, per, net - 2n * per]; const expect = addIds.map((id, i) => S.sharesForMint(bp, binsNow.get(id), id, bp.activeId, 0n, amountsY[i], feeNow2));
    { const id = bp.activeId - 3; const b = (await V.bins(BPX.address, [S.chunkOf(id)])).get(id); const e1 = S.sharesForMint(bp, b, id, bp.activeId, 0n, units(1, 6), feeNow2);
      check('M-5: a mint that would give fewer shares than its min_shares is refused (TooFewShares)', await refused(as(alice).send([await V.mintIx(alice.publicKey, BPX.address, { ids: [id], amountsX: [0n], amountsY: [units(1, 6)], minShares: [e1 + 1n] })], [], 400_000), /TooFewShares/)); }
    d = { binPool: BPX.address, ids: addIds, amountsX: [0n, 0n, 0n], amountsY, minShares: expect.map((x) => x - x / 100n), owner: owner.publicKey, feeRecipient: relayer.publicKey, feeBps: FEE_BPS, deadline };
    act = encodeAction('add', d); const ctxA = contextOf(EP, act, POOL);
    w = withdrawInput({ note: aliceNote2, withdrawnValue: units(600, 6), context: ctxA, leaves, labels: labels2 }); pr = await prove(w.input); console.log('  proof 7 (add) at', lap());
    await R.send([V.postWithdrawalIx(relayer.publicKey, POOL, pr.proof, pr.pubs, EP)], [], 1_400_000);
    pre = await V.ensureBinAccountsIxs(relayer.publicKey, BPX.address, addIds, owner.publicKey, EP);
    check('share accounts for (one-time owner, entry signer) are created by the relayer', pre.length >= 1);
    await R.send(pre);
    check('M-5: a private add without min_shares is refused (MinSharesRequired)', await refused(R.sendV0([await V.privateAddIx(relayer.publicKey, [{ mint: USDC, nullifierHash: pr.pubs[1] }], { ...d, minShares: [] })], [], 1_400_000), /MinSharesRequired/));
    check('private_add with mismatched amounts is refused', await refused(R.sendV0([await V.privateAddIx(relayer.publicKey, [{ mint: USDC, nullifierHash: pr.pubs[1] }], { ...d, amountsY: [per, per, per + 1n] })], [], 1_400_000), /BadContext|AmountMismatch/));
    sig = await R.sendV0([await V.privateAddIx(relayer.publicKey, [{ mint: USDC, nullifierHash: pr.pubs[1] }], d)], [], 1_400_000); await cuOf(conn, sig, 'private_add (1 leg, 3 bins)');
    ev = (await V.events(sig)).find((e) => e.name === 'PrivateAdded');
    const posShares = await Promise.all(addIds.map((id) => V.sharesOf(BPX.address, owner.publicKey, EP, id)));
    check('private add: 600 USDC note -> 3 bins owned by the one-time key (authority = entry signer), at least min_shares each', ev && ev.shares.length === 3 && posShares.every((s, i) => s === ev.shares[i] && s > 0n && s >= d.minShares[i]) && (await bal(USDC, EP)) === 0n);
    // some trading so the position earns fees
    for (let i = 0; i < 2; i++) { const qq = await V.quote(BPX.address, true, units(1, 9)); await as(bob).send([await V.swapIx(bob.publicKey, BPX.address, true, units(1, 9), qq.out)], [], 1_400_000); }
    // remove: signed by the one-time key, submitted by the relayer, proceeds back into the private balance (USDC + SOL notes)
    const nX = newNote(), nY = newNote();
    let rd = { owner: owner.publicKey, binPool: BPX.address, ids: addIds, shares: posShares.map((x) => x / 2n), precommitX: BigInt(nX.precommitment), precommitY: BigInt(nY.precommitment), recipient: null, feeRecipient: relayer.publicKey, feeBps: FEE_BPS, nonce: 0n, deadline };
    const sign = (dd) => nacl.sign.detached(removeDigest(V.programs.entry, dd), owner.secretKey);
    const sigOk = sign(rd);
    check('a remove without the ed25519 instruction is refused', await refused(R.sendV0([await V.privateRemoveIx(relayer.publicKey, rd)], [], 1_400_000), /BadSignature/));
    check('a remove signed by another key is refused', await refused(R.sendV0([V.removeSigIx(mallory.publicKey, nacl.sign.detached(removeDigest(V.programs.entry, rd), mallory.secretKey), rd), await V.privateRemoveIx(relayer.publicKey, rd)], [], 1_400_000), /BadSignature/));
    check('a signature over different data is refused', await refused(R.sendV0([V.removeSigIx(owner.publicKey, sign({ ...rd, feeBps: 1 }), rd), await V.privateRemoveIx(relayer.publicKey, rd)], [], 1_400_000), /BadSignature|precompile|InvalidAccountData|0x/i));
    check('a wrong nonce is refused', await refused(R.sendV0([V.removeSigIx(owner.publicKey, sign({ ...rd, nonce: 3n }), { ...rd, nonce: 3n }), await V.privateRemoveIx(relayer.publicKey, { ...rd, nonce: 3n })], [], 1_400_000), /BadNonce/));
    const poolSolBefore = (await V.pool(POOL_SOL)).nextIndex, poolUsdcBefore = (await V.pool(POOL)).nextIndex;
    sig = await R.sendV0([V.removeSigIx(owner.publicKey, sigOk, rd), await V.privateRemoveIx(relayer.publicKey, rd)], [], 1_400_000); await cuOf(conn, sig, 'private_remove (3 bins)');
    const evr = await V.events(sig); ev = evr.find((e) => e.name === 'PrivateRemoved'); const deps = evr.filter((e) => e.name === 'Deposited');
    check('private remove (half): shares burned (fees included: some SOL now too), proceeds re-deposited as two new notes', ev && ev.amountY > 0n && ev.amountX > 0n && deps.length === 2 && deps.some((e) => e.pool.equals(POOL_SOL) && e.precommitment === BigInt(nX.precommitment) && e.beneficiary.equals(owner.publicKey)) && deps.some((e) => e.pool.equals(POOL) && e.precommitment === BigInt(nY.precommitment)), `x ${ev.amountX} y ${ev.amountY}`);
    check('USDC proceeds ≈ half of 600 USDC less what was traded away into SOL', ev.amountY < units(300, 6) && ev.amountY > units(150, 6));
    check('entry nonce incremented; replaying the same signed remove is refused', (await V.nonce(owner.publicKey)) === 1n && (await refused(R.sendV0([V.removeSigIx(owner.publicKey, sigOk, rd), await V.privateRemoveIx(relayer.publicKey, rd)], [], 1_400_000), /BadNonce|NotEnoughShares/)));
    check('both pools gained one leaf each', (await V.pool(POOL_SOL)).nextIndex === poolSolBefore + 1n && (await V.pool(POOL)).nextIndex === poolUsdcBefore + 1n);
    // REVIEW.md L-1: the rest through the relayer service, paid out publicly: its token-account instructions go BEFORE the
    // ed25519 instruction (which must sit right before private_remove)
    { const left = await Promise.all(addIds.map((id) => V.sharesOf(BPX.address, owner.publicKey, EP, id))); const to = Keypair.generate().publicKey;
      const rd2 = { ...rd, shares: left, recipient: to, nonce: 1n, precommitX: BigInt(newNote().precommitment), precommitY: BigInt(newNote().precommitment) };
      rd2.feeBps = (await svc.feeQuote(J({ kind: 'remove', d: rd2 }))).feeBps;
      const r = await svc.submit(J({ kind: 'remove', d: rd2, sig: Buffer.from(sign(rd2)).toString('base64') })); const evq = (await V.events(r.txHash)).find((e) => e.name === 'PrivateRemoved');
      check('L-1: a removal to a public wallet goes through the relayer service (fee ' + rd2.feeBps + ' bps covers its cost)', evq && (await bal(USDC, to)) === evq.amountY - evq.amountY * BigInt(rd2.feeBps) / 10_000n && (await bal(SOL, to)) === evq.amountX - evq.amountX * BigInt(rd2.feeBps) / 10_000n && evq.amountX > 0n);
      check('position shares are now zero', (await Promise.all(addIds.map((id) => V.sharesOf(BPX.address, owner.publicKey, EP, id)))).every((x) => x === 0n)); }
    // ---------------------------------------------------------------- Phase 1 (tests/phase1.js)
    const C = { conn, payer, V, as, alice, bob, carol, mallory, relayer, postman, dep, T, BP, check, refused, cuOf, CU, prove, fund, units, priceQ, sleep, lap, usdcLabels: labels2 };
    await require('./phase1.js')(C);
    // ---------------------------------------------------------------- Phase 2 (tests/phase2.js): hidden balances, transfers, positions
    await require('./phase2.js')(C);
    // fee cap and wrong mint on the entry
    check('entry refuses a fee above 1%', await refused(R.send([await V.relayIx(relayer.publicKey, USDC, pr.pubs[1], { ...d, recipient: fresh.publicKey, feeBps: 101 })], [], 400_000), /FeeTooHigh|BadContext|AlreadySpent/));
    const fake = await createMint(conn, payer, 6); await fund(conn, payer, fake, alice.publicKey, units(10, 6));
    check('depositing a mint without a pool is refused', await refused((async () => { await as(alice).send([await V.depositIx(alice.publicKey, fake, units(5, 6), 1n)]); })(), /pool not found/));
    check('paying a pool with another mint\'s token account is refused', await refused((async () => { const ix = await V.depositIx(alice.publicKey, USDC, units(5, 6), 1n); ix.keys[5].pubkey = V.ata(fake, alice.publicKey); await as(alice).send([ix]); })(), /ConstraintTokenMint|WrongMint|Constraint/));
    check('the wrong token program is refused', await refused((async () => { const ix = await V.depositIx(alice.publicKey, USDC, units(5, 6), 1n); ix.keys[7].pubkey = S.TOKEN_2022; await as(alice).send([ix]); })(), /WrongTokenProgram|InvalidProgramId|Constraint/));
    // ---------------------------------------------------------------- Phase 3 (tests/phase3.js): sealed batch swaps
    // (after the checks above: they reuse an earlier relay request whose deadline the long Phase 3 run would pass)
    await require('./phase3.js')(C);

    // ---------------------------------------------------------------- authority handover (npm run handover) + the roles preflight reads
    { const { handover } = require('../scripts/handover.js'); const { readRoles, roleFindings } = require('../scripts/roles.js');
      await fund(conn, payer, USDC, payer.publicKey, 0n); // the deployer's token accounts exist: the refusals below must come from the authority checks
      const msig = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(msig.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed'); const newPostman = Keypair.generate().publicKey;
      const me = payer.publicKey.toBase58(); const who = { deployer: me, relayer: relayer.publicKey.toBase58() };
      const before = await readRoles(V, dep); const f0 = roleFindings(before, who);
      check('roles: after deploy the deployer holds the 3 upgrade authorities, the pool and factory authorities and the postman role is not the relayer (preflight lists them)', f0.red.filter((m) => /upgrade authority/.test(m)).length === 3 && f0.red.some((m) => /factory/.test(m)) && f0.red.some((m) => /pool authority \(SOL\)/.test(m)) && !f0.red.some((m) => /relayer's hot wallet/.test(m)));
      const dry = await handover({ rpc, dep, deployer: payer, deployerFile: payerFile, to: msig.publicKey, postman: newPostman, dryRun: true, log: () => {} });
      check('handover --dry-run plans every role and sends nothing', dry.plan.some((x) => /set-upgrade-authority/.test(x.action)) && JSON.stringify(await readRoles(V, dep)) === JSON.stringify(before));
      const r = await handover({ rpc, dep, deployer: payer, deployerFile: payerFile, to: msig.publicKey, postman: newPostman, acceptKeypair: msig, log: () => {} });
      const held = (kind) => r.roles.filter((x) => x.kind === kind);
      check('handover: 3 upgrade authorities, 4 pool authorities (accepted), the factory, protocol fee and batch committee authorities (accepted), the reward funder and 4 postmen moved; nothing red left on the deployer', r.findings.red.length === 0 && held('committee').length === 1 && held('committee')[0].holder === msig.publicKey.toBase58() && held('upgrade').every((x) => x.holder === msig.publicKey.toBase58()) && held('pool').filter((x) => x.holder === msig.publicKey.toBase58()).length === 4 && held('factory')[0].holder === msig.publicKey.toBase58() && held('fee')[0].holder === msig.publicKey.toBase58() && held('reward').length >= 1 && held('reward').every((x) => x.holder === msig.publicKey.toBase58()) && held('postman').filter((x) => x.holder === newPostman.toBase58()).length === 4, r.findings.red.join('; '));
      check('handover leaves a role it does not hold alone (the USDC pool was handed over earlier in this run)', r.plan.some((x) => x.role === 'pool authority (USDC)' && /skip/.test(x.action)));
      check('the old deployer key can no longer set a postman, list a bin pool, set a protocol share, withdraw protocol fees or fund a reward', await refused(V.send([V.setPostmanIx(payer.publicKey, T.SOL.pool, payer.publicKey)]), /NotAuthority/) && await refused(V.send([await V.createPoolIx(payer.publicKey, SOL, USDT, 30, 500, 10_000, Q, 0)]), /NotAuthority/)
        && await refused(V.send([V.setProtocolShareIx(payer.publicKey, BPX.address, 0)]), /NotAuthority|ConstraintHasOne/) && await refused(V.send([await V.withdrawProtocolFeeIx(payer.publicKey, BPX.address, 1n, 0n)]), /NotAuthority|ConstraintHasOne/) && await refused(V.send([await V.fundRewardIx(payer.publicKey, BPX.address, 0, 1n)]), /NotAuthority/));
      const again = await handover({ rpc, dep, deployer: payer, deployerFile: payerFile, to: msig.publicKey, postman: newPostman, dryRun: true, log: () => {} });
      check('re-running the handover has nothing left to do', again.plan.every((x) => /^done|^skip|kept by the deployer/.test(x.action))); }
  } catch (e) { console.error('\nTEST RUN CRASHED:', e); fail++; }
  console.log('\ncompute units:', JSON.stringify(CU));
  console.log(`\n${pass} passed, ${fail} failed  (${lap()})`); done(fail ? 1 : 0);
})();
