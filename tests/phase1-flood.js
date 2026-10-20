#!/usr/bin/env node
// Phase 1 log flooding (REVIEW.md M-9), on its own local validator (RPC 9103 by default, FLOOD_RPC_PORT to change; away from
// the shared 8933). veyl_pool's deposit / withdraw log their Deposited / Withdrawn only, and Solana keeps ~10 KB of logs per
// transaction: memo instructions in front of a direct deposit (anyone's own) cut its event. Before the fix the pool's history
// had a gap and readTree threw, so the relayer's /state for that token stopped and its notes could not be spent by proof.
// Checks: flooded deposits (two in one transaction), a flooded withdraw, a flooded deposit then ragequit (its record closed)
// are rebuilt from the instructions and the accounts they wrote; the tree's root is on chain; /state works; a note deposited
// after the flood is withdrawn by proof; a forged account (wrong owner) or a root not on chain still fails closed.
'use strict';
globalThis.window = new EventTarget();
const fs = require('fs'); const path = require('path'); const os = require('os');
const { Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } = require('@solana/web3.js');
const S = require('../sdk/veyl.js'); const { H, newNote, merklePath, withdrawInput, contextOf, ASP_DEPTH, STATE_DEPTH } = S;
const { prove } = require('../sdk/prover.js');
const { startValidator, deployAll, fund, units } = require('../scripts/lib.js');
const { check, finish, logsOf, funded } = require('./harness.js');
const PORT = Number(process.env.FLOOD_RPC_PORT || 9103);

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-flood-')); const payer = Keypair.generate(); const payerFile = path.join(TMP, 'payer.json'); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  const { val, rpc, conn } = await startValidator(TMP, payer, PORT);
  const done = (code) => { val.once('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(code); }); val.kill(); setTimeout(() => process.exit(code), 8000).unref(); };
  try {
    const [postman, relayerKp, alice, mallory, processor] = await funded(conn, 5);
    // deployAll writes deploy.local.json at the repo root (other suites' file): the old one is put back right after
    const depFile = path.join(__dirname, '..', 'deploy.local.json'); const prevDep = fs.existsSync(depFile) ? fs.readFileSync(depFile) : null;
    let deployed; try { deployed = await deployAll({ rpc, payerFile, postman: postman.publicKey, relayer: relayerKp.publicKey }); } finally { if (prevDep) fs.writeFileSync(depFile, prevDep); else fs.rmSync(depFile, { force: true }); }
    const { V, T, dep } = deployed; const USDC = T.USDC.mint, POOL = T.USDC.pool;
    const as = (kp) => { const v = new S.Veyl({ connection: conn, programs: V.programs, payer: kp }); v.lookupTable = V.lookupTable; return v; };
    for (const k of [alice, mallory]) await fund(conn, payer, USDC, k.publicKey, units(10_000, 6));
    const procAta = await fund(conn, payer, USDC, processor.publicKey, 0n);
    // ---- the flood: as many memo instructions in front as still fit (size, compute, the instruction trace limit); each logs
    // ~200 bytes for ~4 bytes of transaction (the helper of tests/phase2.js)
    const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const memoIx = (i) => new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(String(i % 10)) });
    const flood = async (Vx, ixs, cu = 1_400_000) => {
      const sim = async (n) => { try { const tx = await Vx.buildV0([...Array.from({ length: n }, (_, i) => memoIx(i)), ...ixs], [], cu); tx.serialize(); const v = (await conn.simulateTransaction(tx, { sigVerify: false })).value; return v.err ? null : v; } catch { return null; } };
      if (!(await sim(0))) throw new Error('the action fails on its own'); let lo = 1, hi = 62, n = 0;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (await sim(m)) { n = m; lo = m + 1; } else hi = m - 1; }
      if (!n) throw new Error('no room for a memo');
      return { sig: await Vx.sendSigned(await Vx.buildV0([...Array.from({ length: n }, (_, i) => memoIx(i)), ...ixs], [], cu)), memos: n }; };
    const prog = V.programs.pool.toBase58();
    const logged = (logs) => S.logEvents(logs).filter((e) => (e.name === 'Deposited' || e.name === 'Withdrawn') && e.program === prog);
    /// a reader that cannot see instructions (how readTree read the pool before the fix: the logs alone)
    const logsOnly = new S.Veyl({ connection: new Proxy(conn, { get: (o, k) => (k === 'getTransaction' ? async (sg, opt) => { const t = await o.getTransaction(sg, opt); return t && { ...t, transaction: null }; } : typeof o[k] === 'function' ? o[k].bind(o) : o[k]) }), programs: V.programs });
    const gapOf = async (Vx) => { try { await Vx.readTree(POOL); return null; } catch (e) { return e.message; } };
    const fresh = () => new S.Veyl({ connection: conn, programs: V.programs });
    const treeOk = async (Vx = fresh()) => { const st = await Vx.readTree(POOL); const p = await V.pool(POOL); return { st, ok: BigInt(st.leaves.length) === p.nextIndex && merklePath(st.leaves, 0, STATE_DEPTH).root === p.currentRoot, n: st.leaves.length }; };
    const deposit = async (kp, amount, note, nonce) => { const v = as(kp); return v.depositIx(kp.publicKey, USDC, amount, note.precommitment, kp.publicKey, kp.publicKey, nonce); };

    // ---- alice deposits two notes the ordinary way
    const a1 = newNote(), a2 = newNote();
    await as(alice).send([await deposit(alice, units(100, 6), a1)]); await as(alice).send([await deposit(alice, units(50, 6), a2)]);
    // ---- mallory: two direct deposits in one transaction, memos in front: both events are cut
    const m1 = newNote(), m2 = newNote(); const p0 = await V.pool(POOL);
    const fl = await flood(as(mallory), [await deposit(mallory, units(10, 6), m1, p0.depositNonce + 1n), await deposit(mallory, units(20, 6), m2, p0.depositNonce + 2n)]);
    let lg = await logsOf(conn, fl.sig);
    check('the attack is real: memos in front of two direct deposits cut the logs before either Deposited', lg.truncated && logged(lg.logs).length === 0 && (await V.pool(POOL)).nextIndex === p0.nextIndex + 2n, `${fl.memos} memos, ${lg.bytes} log bytes kept`);
    // ---- alice deposits a third note after the flood (the one withdrawn by proof below)
    const a3 = newNote(); await as(alice).send([await deposit(alice, units(70, 6), a3)]);
    const old = await gapOf(logsOnly);
    check('a reader of the logs alone (readTree before the fix) finds a gap and throws: /state for the token would stop', /gap in the tree history at 2/.test(old || ''), old || 'no error');
    let r = await treeOk();
    const md = r.st.deposits.filter((d) => d.payer.equals(mallory.publicKey));
    const rec1 = await V.depositRecord(V.depositPda(POOL, S.labelOf(POOL, p0.depositNonce + 1n)));
    check('readTree rebuilds both cut deposits from their DepositRecords, in instruction order: full tree, root == the pool\'s current root', r.ok && r.n === 5 && md.length === 2 && md[0].index === 2 && md[1].index === 3 && md[0].commitment === rec1.commitment && md[0].label === rec1.label && md[0].value === units(10, 6) && md[1].value === units(20, 6) && md[0].precommitment === BigInt(m1.precommitment), `${r.n} leaves`);
    const hist = await fresh().poolHistory(POOL);
    check('poolHistory: the rebuilt events are marked recovered, with the cut transaction\'s signature; every other one is logged', hist.filter((e) => e.recovered).length === 2 && hist.filter((e) => e.recovered).every((e) => e.sig === fl.sig) && hist.length === 5);
    // ---- fail closed: a look-alike account (not owned by veyl_pool), or a rebuilt tree whose root is not on chain
    { const forged = new Proxy(conn, { get: (o, k) => (k === 'getMultipleAccountsInfo' ? async (keys, c) => (await o.getMultipleAccountsInfo(keys, c)).map((a) => a && { ...a, owner: Keypair.generate().publicKey }) : typeof o[k] === 'function' ? o[k].bind(o) : o[k]) });
      const e1 = await gapOf(new S.Veyl({ connection: forged, programs: V.programs }));
      const rootless = new Proxy(conn, { get: (o, k) => (k === 'getAccountInfo' ? async (key, c) => { const a = await o.getAccountInfo(key, c); if (!a || !new PublicKey(key).equals(POOL)) return a; const d = Buffer.from(a.data); d.fill(7, d.length - 8 - 32 * S.ROOT_HISTORY, d.length - 8); return { ...a, data: d }; } : typeof o[k] === 'function' ? o[k].bind(o) : o[k]) });
      const e2 = await gapOf(new S.Veyl({ connection: rootless, programs: V.programs }));
      check('fail closed: a record not owned by veyl_pool is not used (the gap error stays)', /gap in the tree history at 2/.test(e1 || ''), e1 || 'no error');
      check('fail closed: rebuilt leaves whose tree root is not in the pool\'s root history are dropped (the gap error stays)', /gap in the tree history at 2/.test(e2 || ''), e2 || 'no error'); }

    // ---- the relayer's /state for the token works
    const { Relayer } = require('../relayer/relayer.js'); process.env.SEALED_CRANK = '0';
    const rel = new Relayer({ connection: conn, wallet: relayerKp, deploy: dep }); const st = await rel.state(POOL);
    check('relayer /state (Relayer.state) serves the full tree, the cut deposits included', st.leaves.length === 5 && st.deposits.length === 5 && st.deposits.some((d) => d.index === 3 && d.value === units(20, 6)));

    // ---- a note deposited after the flood is withdrawn by proof, the withdraw itself flooded too (its Withdrawn is cut)
    const labels = r.st.deposits.map((d) => d.label); const aspRoot = merklePath(labels, 0, ASP_DEPTH).root;
    await as(postman).send([V.updateAspRootIx(postman.publicKey, POOL, aspRoot)]);
    const n3 = { ...a3, value: String(units(70, 6)), label: String(r.st.deposits.find((d) => d.index === 4).label), index: 4 };
    const data = Buffer.from('flooded withdraw'); const ctx = contextOf(processor.publicKey, data, POOL);
    const w = withdrawInput({ note: n3, withdrawnValue: units(30, 6), context: ctx, leaves: r.st.leaves, labels }); const pr = await prove(w.input);
    await as(relayerKp).send([V.postWithdrawalIx(relayerKp.publicKey, POOL, pr.proof, pr.pubs, processor.publicKey)], [], 1_400_000);
    const fw = await flood(as(processor), [await V.withdrawIx(processor.publicKey, POOL, pr.pubs[1], procAta, data)], 400_000);
    lg = await logsOf(conn, fw.sig);
    check('withdraw by proof of a note after the flooded deposits (state root from the rebuilt tree): 30 USDC out, nullifier spent', (await V.tokenBalance(USDC, processor.publicKey)) === units(30, 6) && (await V.isSpent(POOL, pr.pubs[1])));
    r = await treeOk();
    check('the withdraw\'s own Withdrawn was cut too, and its change leaf is rebuilt from its Spend account (new_commitment): root on chain', lg.truncated && logged(lg.logs).length === 0 && r.ok && r.n === 6 && r.st.leaves[5] === BigInt(w.changeNote.commitment), `${fw.memos} memos, ${lg.bytes} log bytes`);

    // ---- a flooded deposit taken back by ragequit: its DepositRecord is closed, the ragequit's arguments rebuild the leaf
    const m3 = newNote(); const p1 = await V.pool(POOL); const fd = await flood(as(mallory), [await deposit(mallory, units(15, 6), m3)]);
    const label3 = S.labelOf(POOL, p1.depositNonce + 1n);
    await as(mallory).send([await V.ragequitIx(mallory.publicKey, USDC, { ...m3, value: units(15, 6), label: label3 })]);
    const a4 = newNote(); await as(alice).send([await deposit(alice, units(5, 6), a4)]);
    r = await treeOk(); const q = r.st.deposits.find((d) => d.index === 6);
    check('a flooded deposit then ragequit (record closed): rebuilt from the ragequit\'s label, value and nullifier + secret; root on chain', (await V.depositRecord(V.depositPda(POOL, label3))) === null && (await logsOf(conn, fd.sig)).truncated && r.ok && r.n === 8 && q && q.label === label3 && q.value === units(15, 6) && q.payer.equals(mallory.publicKey));
    check('a second read reuses the verified leaves (no root check needed) and agrees', (await treeOk(fresh())).ok && (await (async () => { const v = fresh(); await v.readTree(POOL); return v._cutOk.size === 4; })()));
  } catch (e) { console.error(e); check('no exception', false, e.message); }
  finish(done, { cu: false });
})();
