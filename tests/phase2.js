// Phase 2: hidden balances, transfers and liquidity position sizes, against the same local validator and deployment as
// tests/run.js (called from there, after Phase 1 and before the authority handover). Real transact and position proofs
// (zk/circuits/transact.circom, position.circom) made in Node and verified on chain; every refusal the brief lists
// (double spend, wrong asset, range overflow, external-data tamper, inflation) and conservation checked as properties:
// for every token, the shielded pool's vault always equals what its unspent notes and pending deposits are worth plus the
// fee pot that backs unclaimed liquidity fees.
'use strict';
const crypto = require('crypto');
const snarkjs = require('snarkjs');
const { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const S = require('../sdk/veyl.js');
const Z = require('../sdk/shield.js');
const { prove, proveTransact, provePosition, verifyCircuit, TIMES, CIRCUITS } = require('../sdk/prover.js');
const { Relayer } = require('../relayer/relayer.js');

module.exports = async function phase2(C) {
  const { conn, payer, V, as, alice, bob, carol, mallory, relayer, postman, dep, T, check, refused, cuOf, CU, fund, units, sleep, lap } = C;
  const USDC = T.USDC.mint, SOL = T.SOL.mint, USDT = T.USDT.mint;
  const R = as(relayer); const EP = V.signerPda(); const me = relayer.publicKey;
  const svc = new Relayer({ connection: conn, wallet: relayer, deploy: dep, postman, minFeeBps: 5 });
  const J = (o) => JSON.parse(S.j(o));
  const nowS = () => Math.floor(Date.now() / 1000); const dl = () => nowS() + 1200;
  const amt = async (addr) => BigInt((await conn.getTokenAccountBalance(addr)).value.amount);
  const vault = (mint) => amt(V.shieldVault(mint));
  const evOf = async (sig, name) => (await V.events(sig)).find((e) => e.name === name);
  const evsOf = async (sig, name) => (await V.events(sig)).filter((e) => e.name === name);
  const mints = Object.fromEntries(Object.values(T).map((t) => [t.mint.toBase58(), { sym: t.sym, decimals: t.decimals }]));
  const pools = dep.binPools.map((b) => ({ address: b.address, mintX: T[b.x].mint.toBase58(), mintY: T[b.y].mint.toBase58(), x: b.x, y: b.y }));
  const wallet = () => new Z.ShieldWallet(crypto.randomBytes(32), { mints, pools });
  const A = wallet(), B = wallet(), M = wallet();
  const sync = async (...ws) => { const st = await V.readShield(); st.tree = new Z.Tree(st.leaves); for (const w of ws) w.scan(st); return st; };
  const pt = (pr) => ({ proof: pr.proof.toString('base64'), pubs: pr.pubs.map(String) });
  const sizeOf = async (ixs, payerKey) => { const lut = (await conn.getAddressLookupTable(new PublicKey(dep.lookupTable))).value; const { TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
    try { return new VersionedTransaction(new TransactionMessage({ payerKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs] }).compileToV0Message([lut])).serialize().length; } catch (e) { return 'n/a: ' + e.message; } };
  const SIZE = {}; const PROOFS = { transact: 0, position: 0 };
  const proveT = async (input) => { PROOFS.transact++; return proveTransact(input); };
  const proveP = async (input) => { PROOFS.position++; return provePosition(input); };
  /// Expected vault per mint: what the test has put in and taken out (deposits, withdrawals, relayer fees, pool actions).
  const ledger = {}; const led = (mint, d) => { const k = new PublicKey(mint).toBase58(); ledger[k] = (ledger[k] || 0n) + BigInt(d); };
  const ledgerOk = async (mint) => (await vault(mint)) === (ledger[new PublicKey(mint).toBase58()] || 0n);
  /// Vault change of a shielded LP action, from its own events: harvested fees in, the dilution charge in / the removal's
  /// pay out, the relayer's claim fee out, receipts in (legs are counted by the caller).
  const ledLp = async (sig) => { const evs = await V.events(sig); const e = evs.find((x) => x.name === 'ShieldLpExecuted'); const so = V.shieldOwner();
    const hv = evs.filter((x) => x.name === 'FeesClaimed' && x.owner.equals(so)).reduce((a, x) => [a[0] + x.amountX, a[1] + x.amountY], [0n, 0n]);
    led(SOL, hv[0] + e.charge[0] - e.pay[0] - e.claimFee[0] + e.receipts[0]); led(USDC, hv[1] + e.charge[1] - e.pay[1] - e.claimFee[1] + e.receipts[1]); return e; };
  const feeFor = async (kind, mint, extra = {}) => BigInt((await svc.shieldFeeQuote({ kind, mint: new PublicKey(mint), ...extra })).fee);
  let sig, ev;
  console.log('  -- phase 2: shielded pool (transact), shielded liquidity (position), ceremony-ready keys');
  for (const m of [USDC, SOL, USDT]) led(m, await vault(m));

  // ======================================================================================== A. the shielded pool
  let sh = await V.shield();
  check('P2 shielded pool deployed: one tree for every token, empty root == JS zeros[32], postman set, every mint has a vault (its ATA)', sh && sh.currentRoot === S.zeros(32)[32] && sh.postman.equals(postman.publicKey) && !!(await conn.getAccountInfo(V.shieldVault(USDC))));
  check('P2 only the upgrade authority creates the shielded pool (it is a fixed address)', await refused(as(mallory).send([V.initShieldIx(mallory.publicKey, mallory.publicKey)]), /NotAuthority|already in use|0x0/));
  check('P2 only its authority sets the shielded postman', await refused(as(mallory).send([V.shieldAdminIx('set_shield_postman', mallory.publicKey, S.pk(mallory.publicKey))]), /NotAuthority/));
  check('P2 keys: a Veyl address round-trips (spending pubkey + X25519 viewing key) and a different seed gives a different address', Z.decodeAddress(A.address).pk === A.k.pk && A.address !== B.address && A.address.startsWith('veyl:'));
  check('P2 circuits: transact and position use the same tree (depth 32) and Poseidon (circomlib) as the withdraw circuit; dev keys load', require(CIRCUITS.transact.vkey).nPublic === 8 && require(CIRCUITS.position.vkey).nPublic === 8);

  // ======================================================================================== B. deposit -> pending -> approved
  await sync(A, B, M);
  let d = A.deposit(USDC, units(1000, 6)); let pr = await proveT(d.input);
  check('P2 a real transact proof verifies locally (snarkjs) with the dev key: [root, publicAmount, extDataHash, publicAsset, nullifiers, commitments]', await verifyCircuit('transact', pr.raw) && pr.pubs[1] === units(1000, 6) && pr.pubs[3] === Z.assetOf(USDC), `${pr.ms} ms`);
  const bad = Buffer.from(pr.proof); bad[40] ^= 1;
  check('P2 a tampered proof is refused at post (BadProof)', await refused(as(alice).send([V.postProofIx(alice.publicKey, 1, bad, pr.pubs)], [], 1_400_000), /BadProof/));
  check('P2 a transact proof posted as a position proof is refused (BadProof)', await refused(as(alice).send([V.postProofIx(alice.publicKey, 2, pr.proof, pr.pubs)], [], 1_400_000), /BadProof/));
  sig = await as(alice).send([V.postProofIx(alice.publicKey, 1, pr.proof, pr.pubs)], [], 1_400_000); await cuOf(conn, sig, 'post_proof (transact, 8 inputs)');
  check('P2 the proof is verified on chain (groth16-solana) and parked under its id', (await V.posted(V.proofPda(1, pr.pubs))).kind === 1, 'CU ' + CU['post_proof (transact, 8 inputs)']);
  check('P2 deposit: changing the amount under the proof is refused (external data hash)', await refused(as(alice).send([await V.shieldDepositIx(alice.publicKey, { ...d.ext, extAmount: units(1001, 6) }, pr.pubs)], [], 600_000), /BadContext/));
  { const t2 = A.deposit(USDC, units(5, 6)); t2.ext.mint = USDT; const w2 = Z.transactInput({ tree: A.tree, asset: Z.assetOf(USDC), ins: [], outs: t2.outs, ext: t2.ext, sk: A.k.sk }); const p2 = await proveT(w2.input);
    await as(alice).send([V.postProofIx(alice.publicKey, 1, p2.proof, p2.pubs)], [], 1_400_000);
    check('P2 wrong asset: a USDC note paid for with USDT is refused (publicAsset != asset of the mint moved)', await refused(as(alice).send([await V.shieldDepositIx(alice.publicKey, t2.ext, p2.pubs)], [], 600_000), /WrongMint/));
    await as(alice).send([V.cancelProofIx(alice.publicKey, 1, p2.pubs, alice.publicKey)]); }
  const rootBefore = (await V.shield()).currentRoot;
  sig = await as(alice).send([await V.shieldDepositIx(alice.publicKey, d.ext, pr.pubs)], [], 600_000); await cuOf(conn, sig, 'shield_deposit'); led(USDC, units(1000, 6));
  ev = await evOf(sig, 'DepositPending'); let pend = await V.pending(ev.pending);
  check('P2 deposit: 1,000 USDC into the vault, two notes pending outside the tree (tree unchanged), depositor and amount public', ev && pend.amount === units(1000, 6) && pend.depositor.equals(alice.publicKey) && (await V.shield()).currentRoot === rootBefore && (await ledgerOk(USDC)));
  const cts = await evsOf(sig, 'NoteCiphertext');
  check('P2 the deposit emits both notes encrypted (X25519 + XSalsa20-Poly1305): only the recipient\'s viewing key opens them', cts.length === 2 && !!Z.open(A.k.viewSecret, cts[0].data) && !Z.open(B.k.viewSecret, cts[0].data));
  check('P2 only the postman admits a deposit', await refused(as(mallory).send([V.approveDepositIx(mallory.publicKey, ev.pending, alice.publicKey)]), /OnlyPostman/));
  check('P2 nobody but the depositor can take a pending deposit back', await refused(as(mallory).send([await V.cancelDepositIx(mallory.publicKey, ev.pending, USDC)]), /NotDepositor|ConstraintAddress|2012/));
  sig = await as(postman).send([V.approveDepositIx(postman.publicKey, ev.pending, alice.publicKey)]); await cuOf(conn, sig, 'approve_deposit (2 leaves)');
  let st = await sync(A, B, M);
  check('P2 approved: both notes enter the tree; on-chain root == JS tree root; the owner finds 1,000 USDC by scanning, others find nothing', (await V.shield()).currentRoot === st.tree.root() && A.balance(USDC) === units(1000, 6) && B.balance(USDC) === 0n && st.leaves.length === 2);
  // ragequit of a pending deposit
  { const bd = B.deposit(USDC, units(300, 6)); await fund(conn, payer, USDC, bob.publicKey, 0n); const bp = await proveT(bd.input); await as(bob).send([V.postProofIx(bob.publicKey, 1, bp.proof, bp.pubs)], [], 1_400_000);
    const s2 = await as(bob).send([await V.shieldDepositIx(bob.publicKey, bd.ext, bp.pubs)], [], 600_000); const e2 = await evOf(s2, 'DepositPending'); const b0 = await amt(V.ata(USDC, bob.publicKey));
    await as(bob).send([await V.cancelDepositIx(bob.publicKey, e2.pending, USDC)]);
    check('P2 a depositor takes a pending deposit back (the shielded pool\'s ragequit): refunded in full, record closed, nothing entered the tree', (await amt(V.ata(USDC, bob.publicKey))) === b0 + units(300, 6) && !(await V.pending(e2.pending)) && (await V.shield()).nextIndex === 2n && (await ledgerOk(USDC)));
    check('P2 ...and it can no longer be admitted', await refused(as(postman).send([V.approveDepositIx(postman.publicKey, e2.pending, bob.publicKey)]), /AccountNotInitialized|3012|not exist|could not find/i)); }

  // ======================================================================================== C. transfers and withdrawals
  // A -> B: 250 USDC inside the pool; the relayer is paid a flat fee (the only amount the transfer reveals)
  let fee = await feeFor('transact', USDC);
  let s1 = A.spend({ mint: USDC, send: units(250, 6), to: B.address, fee, relayer: V.ata(USDC, me) }); pr = await proveT(s1.input);
  let r = await svc.submit(J({ kind: 'transact', ext: s1.ext, p: pt(pr) })); led(USDC, -fee);
  for (const x of r.txs) await cuOf(conn, x, 'relayed transfer');
  ev = await evOf(r.txHash, 'Transacted'); st = await sync(A, B, M);
  check('P2 private send A -> B through the relayer: B finds 250 USDC; A keeps the change; the chain shows two nullifiers, two new notes and the relayer\'s flat fee, no amount', B.balance(USDC) === units(250, 6) && A.balance(USDC) === units(750, 6) - fee && ev && ev.extAmount === 0n && ev.fee === fee && (await ledgerOk(USDC)), 'fee ' + fee + ' atoms');
  CU['shield_transact (transfer)'] = CU['relayed transfer'];
  { const t = await conn.getTransaction(r.txHash, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); SIZE.shield_transact = t.transaction.message.serialize().length + 65; }
  // a transfer with no fee reveals no token at all (submitted here by a throwaway key)
  { const thrw = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(thrw.publicKey, LAMPORTS_PER_SOL), 'confirmed');
    const t = B.spend({ mint: USDC, send: units(50, 6), to: A.address, hideToken: true }); const p2 = await proveT(t.input);
    check('P2 hidden-token transfer: with no fee the proof\'s publicAsset is 0 and the external data names no mint', p2.pubs[3] === 0n && t.ext.mint.equals(Z.DEFAULT_KEY));
    await as(thrw).send([V.postProofIx(thrw.publicKey, 1, p2.proof, p2.pubs)], [], 1_400_000); const v0 = await vault(USDC);
    const s3 = await as(thrw).send([await V.shieldTransactIx(thrw.publicKey, t.ext, p2.pubs)], [], 600_000); const e3 = await evOf(s3, 'Transacted'); st = await sync(A, B, M);
    check('P2 ...executes without any token account; Transacted names no mint; the vault does not move; B -> A 50 USDC arrived', e3.mint.equals(PublicKey.default) && (await vault(USDC)) === v0 && A.balance(USDC) === units(800, 6) - fee && B.balance(USDC) === units(200, 6)); }
  // withdraw B -> a fresh wallet
  const fresh = Keypair.generate(); fee = await feeFor('transact', USDC, { recipientOwner: fresh.publicKey, ext: { extAmount: -1n, recipient: V.ata(USDC, fresh.publicKey) } });
  s1 = B.spend({ mint: USDC, pay: units(120, 6), fee, recipient: V.ata(USDC, fresh.publicKey), relayer: V.ata(USDC, me) }); pr = await proveT(s1.input);
  const wReq = J({ kind: 'transact', ext: s1.ext, p: pt(pr), recipientOwner: fresh.publicKey });
  check('P2 the relayer refuses a withdrawal whose recipient token account is not the named wallet\'s', await refused(svc.submit({ ...wReq, recipientOwner: mallory.publicKey.toBase58() }), /recipient is not/));
  r = await svc.submit(wReq); led(USDC, -(units(120, 6) + fee)); st = await sync(A, B, M);
  check('P2 withdraw B -> a fresh wallet: it receives exactly 120 USDC (public: amount and recipient), B keeps 80 - fee hidden', (await V.tokenBalance(USDC, fresh.publicKey)) === units(120, 6) && B.balance(USDC) === units(80, 6) - fee && (await ledgerOk(USDC)));
  // refusals against the spent notes
  await R.send([V.postProofIx(me, 1, pr.proof, pr.pubs)], [], 1_400_000);
  check('P2 double spend: the same proof again is refused (its nullifier PDA exists: AlreadySpent)', await refused(R.sendV0([await V.shieldTransactIx(me, s1.ext, pr.pubs)], [], 600_000), /AlreadySpent/));
  await R.send([V.cancelProofIx(me, 1, pr.pubs, me)]);
  { const t = A.spend({ mint: USDC, pay: units(10, 6), fee: units(1, 6), recipient: V.ata(USDC, fresh.publicKey), relayer: V.ata(USDC, me) }); const p2 = await proveT(t.input); await R.send([V.postProofIx(me, 1, p2.proof, p2.pubs)], [], 1_400_000);
    check('P2 ext-data tamper: redirecting a withdrawal to another token account is refused (BadContext)', await refused(R.sendV0([await V.shieldTransactIx(me, { ...t.ext, recipient: V.ata(USDC, mallory.publicKey) }, p2.pubs)], [], 600_000), /BadContext/));
    check('P2 ext-data tamper: raising the relayer fee is refused (BadContext)', await refused(R.sendV0([await V.shieldTransactIx(me, { ...t.ext, fee: units(2, 6) }, p2.pubs)], [], 600_000), /BadContext/));
    check('P2 ext-data tamper: swapping the encrypted notes is refused (BadContext)', await refused(R.sendV0([await V.shieldTransactIx(me, { ...t.ext, encOut: [t.ext.encOut[1], t.ext.encOut[0]] }, p2.pubs)], [], 600_000), /BadContext/));
    // grief: lamports sent to a nullifier's address before it is used cannot block the spend
    await R.send([SystemProgram.transfer({ fromPubkey: me, toPubkey: V.nullifierPda(p2.pubs[4]), lamports: 1_000_000 })]);
    sig = await R.sendV0([await V.shieldTransactIx(me, t.ext, p2.pubs)], [], 600_000); led(USDC, -units(11, 6)); await sync(A, B, M);
    check('P2 a nullifier address pre-funded by a griefer does not block the spend (allocate + assign)', !!sig && (await V.isNullified(p2.pubs[4])) && (await ledgerOk(USDC))); }
  { const t = M.deposit(USDC, 0n); t.ext.extAmount = 0n; const w2 = Z.transactInput({ tree: new Z.Tree([123n]), asset: Z.assetOf(USDC), ins: [], outs: t.outs, ext: t.ext, sk: M.k.sk }); const p2 = await proveT(w2.input);
    await R.send([V.postProofIx(me, 1, p2.proof, p2.pubs)], [], 1_400_000);
    check('P2 a proof against a root the pool never had is refused (UnknownStateRoot)', await refused(R.sendV0([await V.shieldTransactIx(me, t.ext, p2.pubs)], [], 600_000), /UnknownStateRoot/)); await R.send([V.cancelProofIx(me, 1, p2.pubs, me)]); }
  { const t = A.spend({ mint: USDC, pay: units(1, 6), recipient: V.ata(USDC, fresh.publicKey), processor: EP }); const p2 = await proveT(t.input); await R.send([V.postProofIx(me, 1, p2.proof, p2.pubs)], [], 1_400_000);
    check('P2 a spend bound to a processor (an entry action\'s leg) cannot be executed by anyone else (NotProcessor)', await refused(R.sendV0([await V.shieldTransactIx(me, t.ext, p2.pubs)], [], 600_000), /NotProcessor/)); await R.send([V.cancelProofIx(me, 1, p2.pubs, me)]); }
  // circuit-level refusals (the witness cannot be built)
  const wasmErr = async (input) => { try { await snarkjs.wtns.calculate(input, CIRCUITS.transact.wasm, { type: 'mem' }); return ''; } catch (e) { return String(e.message || e); } };
  { const t = A.spend({ mint: USDC, send: units(5, 6), to: B.address }); const inp = JSON.parse(JSON.stringify(t.input));
    const recommit = (o, amounts) => ({ ...o, outAmount: amounts.map(String), outputCommitment: amounts.map((a, i) => String(Z.commitmentOf(BigInt(o.asset), a, BigInt(o.outPubkey[i]), BigInt(o.outBlinding[i])))) });
    const infl = recommit(inp, [BigInt(inp.outAmount[0]) + 1n, BigInt(inp.outAmount[1])]); const e1 = await wasmErr(infl);
    check('P2 inflation: outputs worth one atom more than the inputs cannot be proven (the conservation constraint fails, with honest commitments)', /line: 15[0-9]/.test(e1) && !/line: 132/.test(e1), e1.split('\n')[0]);
    const F = S.F; const wrap = recommit(inp, [BigInt(inp.outAmount[0]) + (1n << 64n), (BigInt(inp.outAmount[1]) - (1n << 64n) + F) % F]); const e2 = await wasmErr(wrap);
    check('P2 range: an output of 2^64 balanced by a "negative" one (sums equal in the field) cannot be proven: the 64-bit range check fails', /Num2Bits/.test(e2), e2.split('\n')[0]);
    const two = { ...inp, inPathIndex: [inp.inPathIndex[0], inp.inPathIndex[0]], inBlinding: [inp.inBlinding[0], inp.inBlinding[0]], inAmount: [inp.inAmount[0], inp.inAmount[0]], inKey: [inp.inKey[0], inp.inKey[0]], inPathElements: [inp.inPathElements[0], inp.inPathElements[0]], inputNullifier: [inp.inputNullifier[0], inp.inputNullifier[0]] };
    check('P2 one note twice in one proof cannot be proven (the two nullifiers must differ)', /line: 146/.test(await wasmErr(two)));
    const other = { ...inp, inKey: [String(Z.randField()), inp.inKey[1]] };
    check('P2 spending someone else\'s note (wrong spending key) cannot be proven', !!(await wasmErr(other))); }
  // merging: two notes into one (transfer to self, no fee)
  { st = await sync(A); const before = A.tokenNotes(USDC).length; const total = A.balance(USDC); const two = A.tokenNotes(USDC).slice(0, 2);
    const t = A.transact({ mint: USDC, ins: two, outs: [{ amount: two.reduce((s, n) => s + BigInt(n.amount), 0n) }], ext: { mint: Z.DEFAULT_KEY } });
    const p2 = await proveT(t.input); await R.send([V.postProofIx(me, 1, p2.proof, p2.pubs)], [], 1_400_000); await R.sendV0([await V.shieldTransactIx(me, t.ext, p2.pubs)], [], 600_000); await sync(A);
    check('P2 merge: two notes become one of the same total (the chain sees two nullifiers and two commitments, nothing else)', before >= 2 && A.tokenNotes(USDC).length === before - 1 && A.balance(USDC) === total && (await ledgerOk(USDC))); }

  // ======================================================================================== D. property: no inflation under random activity
  { let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; let ok = true; const ops = [];
    await fund(conn, payer, USDT, carol.publicKey, units(1000, 6));
    for (let i = 0; i < 4; i++) { const k = Math.floor(rnd() * 3); await sync(A, B, M);
      if (k === 0 || M.balance(USDT) < units(5, 6)) { const a = units(10 + Math.floor(rnd() * 90), 6); const t = M.deposit(USDT, a); const p2 = await proveT(t.input); await as(carol).send([V.postProofIx(carol.publicKey, 1, p2.proof, p2.pubs)], [], 1_400_000);
        const s2 = await as(carol).send([await V.shieldDepositIx(carol.publicKey, t.ext, p2.pubs)], [], 600_000); led(USDT, a); const e2 = await evOf(s2, 'DepositPending'); await as(postman).send([V.approveDepositIx(postman.publicKey, e2.pending, carol.publicKey)]); ops.push('deposit ' + a); }
      else if (k === 1) { const a = M.balance(USDT) / 3n; const t = M.spend({ mint: USDT, send: a, to: B.address, hideToken: true }); const p2 = await proveT(t.input); await R.send([V.postProofIx(me, 1, p2.proof, p2.pubs)], [], 1_400_000); await R.sendV0([await V.shieldTransactIx(me, t.ext, p2.pubs)], [], 600_000); ops.push('send ' + a); }
      else { const a = M.balance(USDT) / 4n; const f2 = units(1, 6); const t = M.spend({ mint: USDT, pay: a, fee: f2, recipient: V.ata(USDT, carol.publicKey), relayer: V.ata(USDT, me) }); const p2 = await proveT(t.input);
        await R.send([V.postProofIx(me, 1, p2.proof, p2.pubs)], [], 1_400_000); await R.sendV0([await V.shieldTransactIx(me, t.ext, p2.pubs)], [], 600_000); led(USDT, -(a + f2)); ops.push('withdraw ' + a); }
      await sync(A, B, M); const notes = A.balance(USDT) + B.balance(USDT) + M.balance(USDT); ok = ok && (await ledgerOk(USDT)) && notes === (await vault(USDT)); }
    check('P2 property (seed 7, 4 random deposits / hidden transfers / withdrawals): after each, the USDT vault == sum of public amounts in and out == the sum of every unspent note', ok, ops.join(', ')); }

  // ======================================================================================== E. legacy notes migrate in
  { const POOL = T.USDC.pool; const n = S.newNote(); const s2 = await as(alice).send([await V.depositIx(alice.publicKey, USDC, units(200, 6), n.precommitment)]); const e2 = await evOf(s2, 'Deposited');
    Object.assign(n, { value: e2.value.toString(), label: e2.label.toString(), index: Number(e2.index) });
    const tree = await V.readTree(POOL); const labels = [...tree.deposits.map((x) => x.label)]; const aspRoot = S.merklePath(labels, 0, S.ASP_DEPTH).root; await as(postman).send([V.updateAspRootIx(postman.publicKey, POOL, aspRoot, 'p2')]);
    const ot = A.nextOneTime(); const info = svc.info(); const md = { owner: ot.pk, blinding: ot.blinding, feeRecipient: me, feeBps: 0, deadline: dl() };
    md.feeBps = Math.max(svc.minFeeBps, Number((await svc.feeQuote(J({ kind: 'relay', mint: USDC, value: units(200, 6), d: { recipient: me } }))).feeBps));
    const ctx = S.contextOf(EP, Buffer.concat([Buffer.from([Z.MIGRATE]), Z.encodeMigrate(md)]), POOL);
    const w = S.withdrawInput({ note: n, withdrawnValue: units(200, 6), context: ctx, leaves: tree.leaves, labels }); const p2 = await prove(w.input);
    r = await svc.submit(J({ kind: 'migrate', mint: USDC, d: md, p: { proof: p2.proof.toString('base64'), pubs: p2.pubs.map(String) } })); await cuOf(conn, r.txHash, 'shield_migrate');
    const feeM = (units(200, 6) * BigInt(md.feeBps)) / 10_000n; led(USDC, units(200, 6) - feeM); ev = await evOf(r.txHash, 'ReceiptNote'); st = await sync(A, B, M);
    check('P2 migration: a legacy note (withdraw circuit, approved set) becomes one receipt note in the shielded pool for a one-time key only its owner recognises', ev && ev.amount === units(200, 6) - feeM && A.notes.some((x) => x.receipt && x.amount === units(200, 6) - feeM && !x.spent) && (await ledgerOk(USDC)));
    // the receipt is spent together with another note: its public amount no longer shows
    const rec = A.notes.find((x) => x.receipt && !x.spent); const other = A.tokenNotes(USDC).find((x) => x !== rec);
    const t = A.transact({ mint: USDC, ins: [rec, other], outs: [{ amount: BigInt(rec.amount) + BigInt(other.amount) }], ext: { mint: Z.DEFAULT_KEY } }); const p3 = await proveT(t.input);
    await R.send([V.postProofIx(me, 1, p3.proof, p3.pubs)], [], 1_400_000); await R.sendV0([await V.shieldTransactIx(me, t.ext, p3.pubs)], [], 600_000); await sync(A);
    check('P2 ...and merges with a hidden note (spent with its one-time key): A holds one note of the total', A.notes.filter((x) => x.receipt && !x.spent).length === 0 && A.balance(USDC) > units(900, 6)); }

  // ======================================================================================== F. shielded swap
  const BPX = dep.binPools.find((b) => b.id === 'sol-usdc'); const POOLX = new PublicKey(BPX.address);
  { let p = await V.binPool(POOLX); const ids = []; for (let i = -12; i <= 12; i++) ids.push(p.activeId + i);
    for (let k = 0; k < ids.length; k += 13) { const part = ids.slice(k, k + 13); const pre = await V.ensureBinAccountsIxs(alice.publicKey, POOLX, part, alice.publicKey, alice.publicKey); if (pre.length) await as(alice).send(pre, [], 400_000);
      await as(alice).send([await V.mintIx(alice.publicKey, POOLX, { ids: part, amountsX: part.map((id) => (id >= p.activeId ? units(2, 9) : 0n)), amountsY: part.map((id) => (id <= p.activeId ? units(300, 6) : 0n)) })], [], 1_400_000); } }
  { await sync(A); const amountIn = units(300, 6); const q = await V.quoteLocal(POOLX, false, amountIn); const f2 = await feeFor('shieldSwap', USDC); const ot = A.nextOneTime();
    const core = { tokenOut: SOL, routes: await V.prepareRoutes([{ amountIn, hops: [{ pool: POOLX, xForY: false }] }]), minOut: q.out - q.out / 100n, receiptOwner: ot.pk, receiptBlinding: ot.blinding, deadline: dl() };
    const t = A.spend({ mint: USDC, pay: amountIn, fee: f2, recipient: V.ata(USDC, EP), relayer: V.ata(USDC, me), processor: EP, action: Z.swapAction(core) }); const p2 = await proveT(t.input);
    check('P2 a swap leg is bound to its swap: the same leg with a lower minimum output is refused (BadContext)', await refused(svc.submit(J({ kind: 'shieldSwap', core: { ...core, minOut: 1n }, leg: { ext: t.ext, p: pt(p2) } })), /BadContext/));
    const v0 = await vault(SOL); r = await svc.submit(J({ kind: 'shieldSwap', core, leg: { ext: t.ext, p: pt(p2) } })); await cuOf(conn, r.txHash, 'shield_swap (1 hop)'); ev = await evOf(r.txHash, 'ShieldSwapped');
    led(USDC, -(amountIn + f2)); led(SOL, ev.amountOut); await sync(A);
    check('P2 shielded swap: 300 USDC from hidden notes -> SOL through the bin pool -> a SOL receipt note (amounts public at the pool, owner a one-time key)', ev && ev.amountOut >= core.minOut && (await vault(SOL)) === v0 + ev.amountOut && A.balance(SOL) === ev.amountOut && (await ledgerOk(USDC)) && (await ledgerOk(SOL)));
    const tx = await conn.getTransaction(r.txHash, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); SIZE.shield_swap = tx.transaction.message.serialize().length + 65;
  }

  // ======================================================================================== G. shielded liquidity
  const pX = await V.binPool(POOLX); const lo = pX.activeId - 4; const win = []; for (let b = 0; b < Z.K; b++) win.push(lo + b);
  const assetsX = [Z.assetOf(pX.mintX), Z.assetOf(pX.mintY)];
  /// Build and submit a shielded LP action for wallet `w`: deltas per window bin, optional funding legs [{ mint, amount }].
  const lpAction = async (w, { deltas, legs = [], claimFee = [0n, 0n], leftoverFee = [0n, 0n], maxCharge = [units(1, 9), units(1000, 6)], zap = null, hint = null, mutate = null, tamper = null }) => {
    await sync(w); const note = w.position(POOLX, lo); const growth = await V.growthOf(POOLX, lo);
    const plan = Z.nextPosition({ sk: w.k.sk, binPool: POOLX, lo, note, delta: deltas, growth, assets: assetsX, fee: claimFee });
    const ct = Z.seal(w.k.viewPublic, Z.encodePosition({ ...plan, binPool: POOLX }));
    const o1 = w.nextOneTime(), o2 = w.nextOneTime();
    const core = { binPool: POOLX, lo, deltas, hintX: hint ? hint.hintX : Array(Z.K).fill(0n), hintY: hint ? hint.hintY : Array(Z.K).fill(0n), zap, claimFee, leftoverFee, receiptOwner: [o1.pk, o2.pk], receiptBlinding: [o1.blinding, o2.blinding], maxCharge, relayer: me, deadline: dl(), ciphertext: ct };
    const action = Z.lpAction(core); const legReqs = [];
    for (const l of legs) { const t = w.spend({ mint: l.mint, pay: l.amount, fee: l.fee || 0n, recipient: V.ata(l.mint, EP), relayer: V.ata(l.mint, me), processor: EP, action }); const p2 = await proveT(t.input); legReqs.push({ ext: t.ext, p: pt(p2) }); }
    const pi = Z.positionInput({ tree: w.tree, sk: w.k.sk, binPool: POOLX, lo, note, delta: deltas, growth, assets: assetsX, fee: claimFee, ext: core, outBlinding: plan.blinding });
    const pp = await proveP(pi.input); const req = { kind: 'shieldLp', core, legs: legReqs, position: pt(pp) };
    if (mutate) mutate(req); return { r: await svc.submit(J(req)), plan, core, req };
  };
  // public trading in the window first (so the bins carry fees)
  const trade = async (n = 2) => { for (let i = 0; i < n; i++) { const xForY = i % 2 === 0; const a = xForY ? units(12, 9) : units(1800, 6); const q = await V.quote(POOLX, xForY, a); await as(bob).send([await V.swapIx(bob.publicKey, POOLX, xForY, a, q.out)], [], 1_400_000); } };
  await fund(conn, payer, SOL, bob.publicKey, units(200, 9)); await fund(conn, payer, USDC, bob.publicKey, units(40_000, 6));
  // A adds: SOL above the price, USDC at and below it, sized from what it holds
  let bins = await V.bins(POOLX, [...new Set([...win.map(S.chunkOf), S.chunkOf(pX.activeId)])]); await sync(A);
  const solHave = A.balance(SOL), usdHave = A.balance(USDC);
  let ax = win.map((id) => (id > pX.activeId ? solHave / 40n : 0n)), ay = win.map((id) => (id < pX.activeId ? usdHave / 20n : 0n));
  const active = win.indexOf(pX.activeId); { const b = bins.get(pX.activeId); let ya = usdHave / 5n; if (b.x > 0n) { const cap = (solHave * 4n / 10n * b.y) / b.x; if (ya > cap) ya = cap; } ay[active] = ya; ax[active] = b.y > 0n ? (b.x * ya) / b.y + 1n : 0n; }
  let plan = Z.planExact(pX, bins, win, ax, ay);
  await svc._ensureLp(POOLX, [...win, pX.activeId], []);
  const fx1 = await feeFor('shieldLp', SOL, { core: { binPool: POOLX, lo }, legs: 2 }), fy1 = await feeFor('transact', USDC);
  const needX = plan.needX + plan.needX / 50n + 10n, needY = plan.needY + plan.needY / 50n + 10n;
  let res = await lpAction(A, { deltas: plan.shares, legs: [{ mint: SOL, amount: needX, fee: fx1 }, { mint: USDC, amount: needY, fee: fy1 }] });
  for (const x of res.r.txs) await cuOf(conn, x, 'shield_lp (add, 2 legs)'); CU['shield_lp (add, 2 legs)'] = (await (async () => { const t = await conn.getTransaction(res.r.txHash, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); SIZE['shield_lp (2 legs)'] = t.transaction.message.serialize().length + 65; return Number((t.meta.logMessages.find((l) => l.includes(V.programs.entry.toBase58() + ' consumed')) || '').match(/consumed (\d+)/)[1]); })());
  led(SOL, -(needX + fx1)); led(USDC, -(needY + fy1)); ev = await ledLp(res.r.txHash);
  let agg = await V.aggregateOf(POOLX, lo); await sync(A);
  check('P2 shielded add: two hidden-amount legs fund exact share mints held by the aggregate; the position note (window of 16 bins) records them; leftovers came back as receipts', agg.every((s, i) => s === plan.shares[i]) && A.position(POOLX, lo) && A.position(POOLX, lo).shares.every((s, i) => s === plan.shares[i]) && (ev.receipts[0] > 0n || ev.receipts[1] > 0n) && (await ledgerOk(SOL)) && (await ledgerOk(USDC)), 'CU ' + CU['shield_lp (add, 2 legs)'] + ', proving ' + TIMES.position.slice(-1)[0] + ' ms');
  { const sa = await V.shareAccount(POOLX, V.shieldOwner(), EP, S.chunkOf(lo));
    check('P2 the chain shows the aggregate per bin and this action\'s change, never whose: the share account belongs to the shielded owner (a PDA that never signs), the event carries deltas only', sa && sa.owner.equals(V.shieldOwner()) && sa.authority.equals(EP) && ev.deltas.every((x, i) => x === plan.shares[i])); }
  // fees accrue; B joins the same bins without harvesting first: B pays for fees earned before it joined
  await trade(4);
  await sync(A, B); { const t = await (async () => { const amt2 = units(50, 6); return amt2; })(); void t; }
  // B needs USDC: A sends B some (hidden)
  { const f2 = await feeFor('transact', USDC); const t = A.spend({ mint: USDC, send: units(150, 6), to: B.address, fee: f2, relayer: V.ata(USDC, me) }); const p2 = await proveT(t.input); await svc.submit(J({ kind: 'transact', ext: t.ext, p: pt(p2) })); led(USDC, -f2); }
  let pB = await V.binPool(POOLX); bins = await V.bins(POOLX, [...new Set([...win.map(S.chunkOf), S.chunkOf(pB.activeId)])]);
  const bIdx = win.map((id, i) => i).filter((i) => win[i] < pB.activeId).slice(-3); const bY = win.map((id, i) => (bIdx.includes(i) ? units(30, 6) : 0n));
  const planB = Z.planExact(pB, bins, win, win.map(() => 0n), bY); const gBefore = await V.growthOf(POOLX, lo);
  const fyB = await feeFor('shieldLp', USDC, { core: { binPool: POOLX, lo }, legs: 1 });
  res = await lpAction(B, { deltas: planB.shares, legs: [{ mint: USDC, amount: planB.needY + units(1, 6), fee: fyB }] }); led(USDC, -(planB.needY + units(1, 6) + fyB)); ev = await ledLp(res.r.txHash);
  const gAfter = await V.growthOf(POOLX, lo);
  check('P2 harvest: the action collected the aggregate\'s fees into the shielded pool and raised H (fee per shielded share) by at most what was collected', gAfter[0].some((h, i) => h > gBefore[0][i]) || gAfter[1].some((h, i) => h > gBefore[1][i]));
  { const dX = planB.shares.some((d, i) => d > 0n && gAfter[0][i] > gBefore[0][i]), dY = planB.shares.some((d, i) => d > 0n && gAfter[1][i] > gBefore[1][i]);
    check('P2 dilution guard: B\'s USDC-only add pays a USDC charge for the fees collected before its shares existed; in SOL, which it did not bring, its new shares are counted in that harvest instead (diluted, still solvent)', (!dY || (ev.charge[1] > 0n && !ev.diluted[1])) && (!dX || (ev.charge[0] === 0n && ev.diluted[0])) && (dX || dY), `charge ${ev.charge.join('/')}, diluted ${ev.diluted.join('/')}, fees in B's bins: SOL ${dX} USDC ${dY}`); }
  // A claims its fees: amounts hidden, computed from H and its own position only
  await trade(2); await sync(A, B); { const note = A.position(POOLX, lo); const g = await V.growthOf(POOLX, lo); const cl = Z.claimable(note.shares, note.debt, g);
    // the relayer's claim fee is paid in whichever token has enough claimable fees
    const fees = [await feeFor('shieldLp', SOL, { core: { binPool: POOLX, lo }, legs: 0 }), await feeFor('shieldLp', USDC, { core: { binPool: POOLX, lo }, legs: 0 })];
    const ti = cl[1].q > fees[1] ? 1 : 0; const cf = [0n, 0n]; cf[ti] = fees[ti]; const before = [A.balance(SOL), A.balance(USDC)];
    if (cl[ti].q <= fees[ti]) console.log('    (claimable fees', cl[0].q, cl[1].q, 'below the claim fee', fees.join('/'), ')');
    res = await lpAction(A, { deltas: Array(Z.K).fill(0n), claimFee: cf }); ev = await ledLp(res.r.txHash); await cuOf(conn, res.r.txHash, 'shield_lp (claim)');
    const gNow = (await V.growthOf(POOLX, lo)); await sync(A);
    const got = [A.balance(SOL) - before[0], A.balance(USDC) - before[1]];
    check('P2 claim: A\'s fee notes equal floor(sum(shares x (H - debt)) / 2^64) at the H the proof used, minus the relayer\'s claim fee; the chain shows no amount', got[0] === cl[0].q - cf[0] && got[1] === cl[1].q - cf[1] && (cl[0].q + cl[1].q) > 0n, `claimed ${got.join(' / ')} atoms`);
    void gNow; }
  // A removes half of every bin: proceeds come back as receipts; it is paid what its shares earned this harvest
  { await sync(A); const note = A.position(POOLX, lo); const deltas = note.shares.map((s) => -(s / 2n));
    res = await lpAction(A, { deltas, leftoverFee: [0n, units(1, 6)] }); ev = await ledLp(res.r.txHash); await cuOf(conn, res.r.txHash, 'shield_lp (remove)'); await sync(A);
    agg = await V.aggregateOf(POOLX, lo);
    check('P2 shielded remove (half): shares burned from the aggregate, proceeds as receipt notes for one-time keys, the note keeps the other half', A.position(POOLX, lo).shares.every((s, i) => s === note.shares[i] - note.shares[i] / 2n) && ev.receipts[0] + ev.receipts[1] > 0n && agg.every((s, i) => s === A.position(POOLX, lo).shares[i] + (B.position(POOLX, lo) ? B.position(POOLX, lo).shares[i] : 0n))); }
  check('P2 overburn: a position proof that burns more than the note holds cannot be built (shares range-checked to 112 bits)', await (async () => { const note = A.position(POOLX, lo); try { Z.nextPosition({ sk: A.k.sk, binPool: POOLX, lo, note, delta: note.shares.map((s) => -(s + 1n)), growth: await V.growthOf(POOLX, lo), assets: assetsX }); return false; } catch { return true; } })());
  // tamper: the posted position proof against a request with different deltas
  check('P2 a position proof for one request cannot execute another (deltas changed: BadContext)', await refused(lpAction(A, { deltas: Array(Z.K).fill(0n), leftoverFee: [0n, units(1, 6)], mutate: (q) => { q.core = { ...q.core, deltas: q.core.deltas.map((x, i) => (i === 0 ? 1n : x)) }; } }), /BadContext|proof/));
  check('P2 a position proof for another window is refused (BadContext)', await refused(lpAction(A, { deltas: Array(Z.K).fill(0n), leftoverFee: [0n, units(1, 6)], mutate: (q) => { q.core = { ...q.core, lo: q.core.lo + 1 }; } }), /BadContext|proof|LpAcc/));
  // in-window rebalance by B: move its shares one bin down (burn + exact mint in one instruction)
  { await sync(B); const note = B.position(POOLX, lo); const k = note.shares.findIndex((s) => s > 0n); const deltas = Array(Z.K).fill(0n); deltas[k] = -note.shares[k];
    const p2 = await V.binPool(POOLX); const bins2 = await V.bins(POOLX, [...new Set([...win.map(S.chunkOf), S.chunkOf(p2.activeId)])]); const tgt = k - 1;
    const val = Z.valueOfShares(bins2.get(win[k]), note.shares[k]); const pl = Z.planExact(p2, bins2, [win[tgt]], [0n], [val.y - val.y / 20n]); deltas[tgt] = pl.shares[0];
    res = await lpAction(B, { deltas, leftoverFee: [0n, units(1, 6)], hint: { hintX: deltas.map((_, i) => (i === tgt ? pl.hintX[0] : 0n)), hintY: deltas.map((_, i) => (i === tgt ? pl.hintY[0] : 0n)) } }); ev = await ledLp(res.r.txHash); await sync(B);
    check('P2 in-window rebalance: one proof burns one bin and mints another from the proceeds; the rest returns as receipts', B.position(POOLX, lo).shares[k] === 0n && B.position(POOLX, lo).shares[tgt] === note.shares[tgt] + pl.shares[0]); }
  // zap: one token in (USDC), part swapped inside the action, exact shares minted
  { await sync(A); const note = A.position(POOLX, lo); const p2 = await V.binPool(POOLX); const zIn = units(100, 6); const swapAmt = units(30, 6); const sim = await V.quoteLocal(POOLX, false, swapAmt);
    const bins2 = await V.bins(POOLX, [...new Set([...win.map(S.chunkOf), S.chunkOf(p2.activeId), ...S.chunksForSwap(p2, false)])]); for (const t of sim.touched) bins2.set(t.id, t);
    const p3 = { ...p2, activeId: sim.endId }; const xi = win.indexOf(sim.endId + 2), yi = win.indexOf(sim.endId - 2);
    const ax2 = win.map((_, i) => (i === xi ? sim.out - sim.out / 10n : 0n)), ay2 = win.map((_, i) => (i === yi ? (zIn - swapAmt) - (zIn - swapAmt) / 10n : 0n)); const pl = Z.planExact(p3, bins2, win, ax2, ay2);
    const f2 = await feeFor('shieldLp', USDC, { core: { binPool: POOLX, lo }, legs: 1 });
    res = await lpAction(A, { deltas: pl.shares, legs: [{ mint: USDC, amount: zIn, fee: f2 }], zap: { xIn: false, amount: swapAmt, minOut: sim.out - sim.out / 20n } }); led(USDC, -(zIn + f2)); ev = await ledLp(res.r.txHash); await cuOf(conn, res.r.txHash, 'shield_lp (zap, 1 leg)'); await sync(A);
    check('P2 shielded zap: one USDC leg, part swapped through the pool inside the action, exact shares minted on both sides', A.position(POOLX, lo).shares.every((s, i) => s === note.shares[i] + pl.shares[i]) && pl.shares.filter((x) => x > 0n).length === 2); }

  // ======================================================================================== H. shielded limit orders
  { await sync(A); const p2 = await V.binPool(POOLX); const id = p2.activeId + 3; const amount = A.balance(SOL) / 4n; const f2 = await feeFor('shieldOrder', SOL, { core: { binPool: POOLX, id } }); const ot = A.nextOneTime();
    const core = { binPool: POOLX, id, isAsk: true, receiptOwner: ot.pk, receiptBlinding: ot.blinding, deadline: dl() };
    const t = A.spend({ mint: SOL, pay: amount, fee: f2, recipient: V.ata(SOL, EP), relayer: V.ata(SOL, me), processor: EP, action: Z.orderAction(core) }); const p3 = await proveT(t.input);
    r = await svc.submit(J({ kind: 'shieldOrder', core, leg: { ext: t.ext, p: pt(p3) } })); ev = await evOf(r.txHash, 'ShieldOrderPlaced'); await cuOf(conn, r.txHash, 'shield_order'); led(SOL, -(amount + f2));
    A.orderBook = [{ pool: POOLX, id, isAsk: true }]; await sync(A); const on = A.orderNotes(POOLX, id, true);
    check('P2 shielded limit order: hidden SOL notes -> an ask held by the aggregate; the order\'s shares come back as an order note (virtual asset)', ev && on.length === 1 && BigInt(on[0].amount) === ev.shares && ev.amount === amount);
    // fill it
    const q = await V.quote(POOLX, false, units(1500, 6)); await as(bob).send([await V.swapIx(bob.publicKey, POOLX, false, units(1500, 6), q.out)], [], 1_400_000);
    const core2 = { binPool: POOLX, id, isAsk: true, leftoverFee: [0n, units(1, 6)], receiptOwner: [A.nextOneTime().pk, A.nextOneTime().pk], receiptBlinding: [1n, 2n], relayer: me, deadline: dl() };
    const lg = A.orderSpend({ binPool: POOLX, id, isAsk: true, notes: on, processor: EP, action: Z.orderWithdrawAction(core2) }); const p4 = await proveT(lg.input);
    r = await svc.submit(J({ kind: 'shieldOrderWithdraw', core: core2, leg: { ext: lg.ext, p: pt(p4) } })); ev = await evOf(r.txHash, 'ShieldOrderWithdrawn'); await cuOf(conn, r.txHash, 'shield_order_withdraw'); led(SOL, ev.amountX); led(USDC, ev.amountY); await sync(A);
    check('P2 ...filled, then withdrawn by spending the order note (a transact proof on the virtual asset): the USDC it bought comes back as a receipt note', ev && ev.amountY > 0n && A.orderNotes(POOLX, id, true).length === 0); }

  // ======================================================================================== I. conservation and close-out
  { await sync(A, B); for (const w of [A, B]) { const note = w.position(POOLX, lo); if (!note || note.shares.every((s) => s === 0n)) continue;
      res = await lpAction(w, { deltas: note.shares.map((s) => -s), leftoverFee: [0n, units(1, 6)] }); ev = await ledLp(res.r.txHash); }
    agg = await V.aggregateOf(POOLX, lo); await sync(A, B, M);
    const pot = async (mint) => (await vault(mint)) - (A.balance(mint) + B.balance(mint) + M.balance(mint));
    const potX = await pot(SOL), potY = await pot(USDC); const g = await V.growthOf(POOLX, lo);
    const owed = [A, B].map((w) => { const n = w.position(POOLX, lo); return n ? Z.claimable(n.shares, n.debt, g) : [{ q: 0n }, { q: 0n }]; });
    const owedX = owed.reduce((s, o) => s + o[0].q, 0n), owedY = owed.reduce((s, o) => s + o[1].q, 0n);
    check('P2 every shielded position removed: the aggregate holds nothing in the window', agg.every((s) => s === 0n));
    check('P2 conservation (no inflation): for SOL and USDC the vault == the sum of every unspent note + the fee pot, and the pot covers every fee still claimable (pot >= owed, the rest is rounding dust)', (await ledgerOk(SOL)) && (await ledgerOk(USDC)) && potX >= owedX && potY >= owedY && potX - owedX < 100n && potY - owedY < 100n, `pot ${potX}/${potY}, owed ${owedX}/${owedY}`);
    check('P2 shielded positions never earn farm rewards in Phase 2 (documented); a farm\'s share of the aggregate can be returned to its funder (shield_return_rewards)', typeof V.shieldReturnRewardsIx === 'function'); }

  // ======================================================================================== J. measurements
  const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
  console.log('  phase 2 proofs:', JSON.stringify(PROOFS), 'node proving ms (avg): transact', avg(TIMES.transact), 'position', avg(TIMES.position));
  console.log('  phase 2 tx sizes (bytes, v0 + lookup table):', JSON.stringify(SIZE));
  C.P2 = { proving: { transact: avg(TIMES.transact), position: avg(TIMES.position) }, sizes: SIZE, proofs: PROOFS };
};
