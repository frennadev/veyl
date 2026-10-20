#!/usr/bin/env node
// veyl_bin permissionless listing + fixed protocol fee, against its own local validator (RPC 8933; run alone, like the
// other suites): fee tiers (factory authority), anyone lists a canonical pair at an approved tier and pays the bond,
// duplicates / reversed pairs / unknown or disabled tiers refused, Token-2022 extension rules, every swap pays the LP fee
// plus exactly 0.2% of its input to the protocol (vault and accumulator deltas == the JS twin), release_bond before and
// after the lock, delisting (bond to the treasury, new liquidity refused, exits and swaps still work), pay_protocol_fee.
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const S = require('../sdk/veyl.js'); const { Veyl } = S;
const { startValidator, deployPrograms, programIds, createMint, fund, units, sleep, priceQ, RPC_PORT } = require('../scripts/lib.js');
let pass = 0, fail = 0; const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '  ok  ' : '  FAIL') + ' ' + n + (extra !== '' ? '  ' + String(extra).slice(0, 200) : '')); };
const refused = async (p, re) => { try { await p; return false; } catch (e) { const t = String(e.message) + JSON.stringify(e.logs || e.transactionLogs || ''); if (!re.test(t)) console.log('    unexpected error:', t.slice(0, 600)); return re.test(t); } };

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-binperm-')); const payer = Keypair.generate(); const payerFile = path.join(TMP, 'payer.json'); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  const { val, rpc, conn } = await startValidator(TMP, payer, RPC_PORT);
  const done = (code) => { val.once('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(code); }); val.kill(); setTimeout(() => process.exit(code), 8000).unref(); };
  try {
    const [alice, bob, carol, mallory, treasury] = Array.from({ length: 5 }, () => Keypair.generate());
    for (const k of [alice, bob, carol, mallory]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 50 * LAMPORTS_PER_SOL), 'confirmed');
    await deployPrograms(rpc, payerFile);
    const V = new Veyl({ connection: conn, programs: programIds(), payer });
    const as = (kp) => new Veyl({ connection: conn, programs: V.programs, payer: kp });
    const evOf = async (sig, name) => (await V.events(sig)).find((e) => e.name === name);
    const lamports = async (k) => BigInt(await conn.getBalance(k, 'confirmed'));
    const amt = async (addr) => BigInt((await conn.getTokenAccountBalance(addr)).value.amount);
    const nowS = () => Math.floor(Date.now() / 1000); const dl = () => nowS() + 900;
    const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };
    const rentBond = BigInt(await conn.getMinimumBalanceForRentExemption(S.SIZES.bond));

    // ---------------------------------------------------------------- factory + tiers
    await V.send([V.initFactoryIx(payer.publicKey)]);
    let f = await V.factory();
    check('factory: protocol fee 0.2% (20 bps), treasury = deployer, default bond 1 SOL / 30 days, no tier yet', f.protocolFeeBps === 20 && f.treasury.equals(payer.publicKey) && f.bondLamports === BigInt(LAMPORTS_PER_SOL) && f.bondLock === 30n * 86_400n && f.tiers.length === 0);
    for (const t of S.DEFAULT_FEE_TIERS) await V.send([V.addFeeTierIx(payer.publicKey, t.binStep, t.baseFee, t.vfc)]);
    f = await V.factory();
    check('the 8 default tiers seeded, distinct bin steps, fees as listed (stable 0.01/0.05, majors 0.05/0.25/0.30, volatile 0.5/1/2 %)', f.tiers.length === 8 && f.tiers.length === S.DEFAULT_FEE_TIERS.length && f.tiers.every((t, i) => t.binStep === S.DEFAULT_FEE_TIERS[i].binStep && t.baseFee === S.DEFAULT_FEE_TIERS[i].baseFee && t.enabled), f.tiers.map((t) => t.binStep + '/' + t.baseFee).join(' '));
    check('a tier with an existing bin step is refused', await refused(V.send([V.addFeeTierIx(payer.publicKey, 20, 1_000, 10_000)]), /BadParams/));
    check('only the factory authority adds tiers / sets the bond', await refused(as(mallory).send([V.addFeeTierIx(mallory.publicKey, 40, 1_000, 10_000)]), /NotAuthority|ConstraintHasOne/) && await refused(as(mallory).send([V.setBondIx(mallory.publicKey, 0n, 0n)]), /NotAuthority|ConstraintHasOne/));
    check('only the fee authority sets the treasury', await refused(as(mallory).send([V.setTreasuryIx(mallory.publicKey, mallory.publicKey)]), /NotAuthority|ConstraintHasOne/));
    const BOND = BigInt(LAMPORTS_PER_SOL) / 2n, LOCK = 6n;
    await V.send([V.setBondIx(payer.publicKey, BOND, LOCK), V.setTreasuryIx(payer.publicKey, treasury.publicKey)]);
    f = await V.factory(); check('bond 0.5 SOL / 6 s and a new treasury set', f.bondLamports === BOND && f.bondLock === LOCK && f.treasury.equals(treasury.publicKey));

    // mints: three classic SPL mints, sorted so that A < B < C (canonical order)
    const ms = []; for (let i = 0; i < 3; i++) ms.push(await createMint(conn, payer, 6)); ms.sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer())); const [A, B, C] = ms;
    for (const k of [alice, bob, carol, mallory]) for (const m of ms) await fund(conn, payer, m, k.publicKey, units(1_000_000, 6));
    const P1 = V.binPoolPda(A, B, 20); const TIER20 = 3;

    // ---------------------------------------------------------------- permissionless create + bond
    const a0 = await lamports(alice.publicKey);
    let sig = await as(alice).send([await V.createPoolIx(alice.publicKey, A, B, TIER20, priceQ(1, 6, 6), 0)]);
    let ev = await evOf(sig, 'PoolCreated'); let p = await V.binPool(P1); let bond = await V.bond(P1);
    check('a non-authority creates a pool at a tier: bin step 20, base fee 0.25%, vfc and protocol fee fixed from the tier / factory', p && p.binStep === 20 && p.baseFee === 2_500 && p.variableFeeControl === 10_000n && p.protocolFeeBps === 20 && p.feeTier === TIER20 && !p.delisted && ev && ev.creator.equals(alice.publicKey) && ev.tier === TIER20);
    check('the creator paid the bond into the pool\'s bond PDA (creator, amount, created_at, unlock = created + lock)', bond && bond.creator.equals(alice.publicKey) && bond.amount === BOND && bond.unlockAt === bond.createdAt + LOCK && (await lamports(V.bondPda(P1))) === BOND + rentBond && a0 - (await lamports(alice.publicKey)) > BOND);
    check('the same pair at the same tier cannot be listed twice', await refused(as(carol).send([await V.createPoolIx(carol.publicKey, A, B, TIER20, priceQ(1, 6, 6), 0)]), /already in use/));
    check('the reversed pair (B/A) is refused: mints must be canonical', await refused(as(carol).send([await V.createPoolIx(carol.publicKey, B, A, TIER20, priceQ(1, 6, 6), 0)]), /MintOrder/));
    check('a tier that does not exist is refused', await refused(as(carol).send([await V.createPoolIx(carol.publicKey, A, B, S.DEFAULT_FEE_TIERS.length, priceQ(1, 6, 6), 0, 0)]), /BadTier/));
    await V.send([V.setFeeTierEnabledIx(payer.publicKey, 6, false)]);
    check('a disabled tier is refused (until re-enabled)', await refused(as(carol).send([await V.createPoolIx(carol.publicKey, A, B, 6, priceQ(1, 6, 6), 0)]), /BadTier/));
    await V.send([V.setFeeTierEnabledIx(payer.publicKey, 6, true)]);
    check('release_bond before the lock is refused', await refused(as(alice).send([V.releaseBondIx(alice.publicKey, P1)]), /BondLocked/));
    check('nobody but the creator releases the bond', await refused(as(mallory).send([V.releaseBondIx(mallory.publicKey, P1)]), /NotAuthority|ConstraintHasOne/));

    // ---------------------------------------------------------------- Token-2022 rules
    const T22 = spl.TOKEN_2022_PROGRAM_ID;
    const feeMint = Keypair.generate(); { const len = spl.getMintLen([spl.ExtensionType.TransferFeeConfig]);
      await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: feeMint.publicKey, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len), programId: T22 }),
        spl.createInitializeTransferFeeConfigInstruction(feeMint.publicKey, payer.publicKey, payer.publicKey, 50, 1_000_000n, T22), spl.createInitializeMintInstruction(feeMint.publicKey, 6, payer.publicKey, null, T22)), [payer, feeMint], { commitment: 'confirmed' }); }
    { const [x, y] = S.canonicalPair(feeMint.publicKey, A);
      check('a Token-2022 mint with a transfer fee is refused', await refused(as(carol).send([await V.createPoolIx(carol.publicKey, x, y, 0, priceQ(1, 6, 6), 0)]), /BadMint/)); }
    const plain22 = await createMint(conn, payer, 6, T22);
    { const [x, y] = S.canonicalPair(plain22, A); await as(carol).send([await V.createPoolIx(carol.publicKey, x, y, 0, priceQ(1, 6, 6), 0)]); const q = await V.binPool(V.binPoolPda(x, y, 1));
      check('a plain Token-2022 mint is accepted (its vault under Token-2022)', q && (x.equals(plain22) ? q.tokenProgramX : q.tokenProgramY).equals(T22)); }

    // ---------------------------------------------------------------- swap: LP fee + exactly 0.2% to the protocol
    const ids = range(-3, 3);
    { const pre = await V.ensureBinAccountsIxs(alice.publicKey, P1, ids, alice.publicKey, alice.publicKey); await as(alice).send(pre, [], 400_000);
      await as(alice).send([await V.mintIx(alice.publicKey, P1, { ids, amountsX: ids.map((i) => (i >= 0 ? units(1_000, 6) : 0n)), amountsY: ids.map((i) => (i <= 0 ? units(1_000, 6) : 0n)) })], [], 1_400_000); }
    const swapCase = async (kp, xForY, amount) => {
      p = await V.binPool(P1); const bins = await V.bins(P1, S.chunksForSwap(p, xForY)); const sim = S.simulateSwap(p, bins, xForY, amount, nowS()); const qc = await V.quote(P1, xForY, amount);
      const vx = await amt(p.vaultX), vy = await amt(p.vaultY);
      sig = await as(kp).send([await V.swapIx(kp.publicKey, P1, xForY, amount, qc.out)], [], 1_400_000); ev = await evOf(sig, 'Swapped');
      const q = await V.binPool(P1); const dvx = (await amt(q.vaultX)) - vx, dvy = (await amt(q.vaultY)) - vy;
      const dpx = q.protocolFeeX - p.protocolFeeX, dpy = q.protocolFeeY - p.protocolFeeY; const proto = S.protocolFeeOf(amount, 20);
      return { sim, qc, ev, dvx, dvy, dpx, dpy, proto, q };
    };
    let r = await swapCase(bob, true, units(10, 6));
    check('swap X->Y: on-chain quote == JS twin == executed (out, fee incl. protocol, end bin)', r.qc.out === r.sim.out && r.qc.fee === r.sim.fee && r.ev.amountOut === r.sim.out && r.ev.fee === r.sim.fee && r.ev.protocolFee === r.sim.protocolFee && r.sim.touched.length === 1);
    check('protocol accumulator X grows by exactly ceil(0.2% x amount in) == twin; Y untouched', r.dpx === r.proto && r.proto === 20_000n && r.sim.protocolFee === r.proto && r.dpy === 0n, `+${r.dpx}`);
    check('vault deltas: +amount in (X), -out (Y)', r.dvx === units(10, 6) && r.dvy === -r.sim.out);
    { const lp = S.mulDivCeil(units(10, 6) - r.proto, 2_500n, S.PIPS);
      check('the LP fee is the pool\'s 0.25% of what is left after the protocol fee, on top of it (fee = LP + protocol)', r.sim.lpFee === lp && r.sim.fee === lp + r.proto, `lp ${r.sim.lpFee}`); }
    { const pos = await V.position(P1, alice.publicKey, alice.publicKey, ids);
      check('the LP keeps 100% of the LP fee: claimable == LP fee (minus < 1 atom of per-share rounding)', pos.fees.x <= r.sim.lpFee && pos.fees.x >= r.sim.lpFee - 1n, `${pos.fees.x} of ${r.sim.lpFee}`); }
    r = await swapCase(carol, false, units(2_500, 6));
    check('a larger Y->X swap across bins: twin == chain, protocol Y += ceil(0.2%) exactly', r.qc.out === r.sim.out && r.ev.amountOut === r.sim.out && r.sim.touched.length > 1 && r.dpy === r.proto && r.proto === 5_000_000n && r.dpx === 0n && r.dvy === units(2_500, 6), `${r.sim.touched.length} bins`);
    r = await swapCase(bob, true, 333n);
    check('rounding: a 333-atom swap pays a 1-atom protocol fee (rounded up), twin == chain', r.dpx === 1n && r.sim.protocolFee === 1n && r.ev.amountOut === r.sim.out);
    { const p0 = await V.binPool(P1); sig = await as(bob).send([await V.payProtocolFeeIx(bob.publicKey, P1, 1_000n, 0n)]); const q = await V.binPool(P1);
      check('pay_protocol_fee: anyone pays protocol fees in; they are accounted like a swap\'s', q.protocolFeeX - p0.protocolFeeX === 1_000n && (await evOf(sig, 'ProtocolFeePaid')).amountX === 1_000n); }
    { const q = await V.binPool(P1); const bx = await V.tokenBalance(A, payer.publicKey), by = await V.tokenBalance(B, payer.publicKey); await fund(conn, payer, A, payer.publicKey, 0n); await fund(conn, payer, B, payer.publicKey, 0n);
      check('only the fee authority withdraws protocol fees', await refused(as(mallory).send([await V.withdrawProtocolFeeIx(mallory.publicKey, P1, 1n, 0n, V.ata(A, mallory.publicKey), V.ata(B, mallory.publicKey))]), /NotAuthority|ConstraintHasOne/));
      await V.send([await V.withdrawProtocolFeeIx(payer.publicKey, P1, q.protocolFeeX, q.protocolFeeY)]); const q2 = await V.binPool(P1);
      check('the fee authority withdraws exactly the accrued protocol fees', (await V.tokenBalance(A, payer.publicKey)) - bx === q.protocolFeeX && (await V.tokenBalance(B, payer.publicKey)) - by === q.protocolFeeY && q2.protocolFeeX === 0n && q2.protocolFeeY === 0n); }

    // ---------------------------------------------------------------- release after the lock
    { const b = await V.bond(P1); while (nowS() <= Number(b.unlockAt) + 2) await sleep(1000); await sleep(1500);
      let before; for (let i = 0; ; i++) { before = await lamports(alice.publicKey); try { sig = await as(alice).send([V.releaseBondIx(alice.publicKey, P1)]); break; } catch (e) { if (i > 10 || !/BondLocked/.test(String(e.message) + JSON.stringify(e.logs || ''))) throw e; await sleep(1000); } }
      ev = await evOf(sig, 'BondReleased');
      check('after the lock the creator releases the bond: bond + rent back, bond account closed', ev && ev.amount === BOND && (await lamports(alice.publicKey)) - before === BOND + rentBond - 5_000n && !(await V.bond(P1)), String((await lamports(alice.publicKey)) - before)); }

    // ---------------------------------------------------------------- authority listing: zero bond
    { await V.send([await V.createPoolIx(payer.publicKey, A, C, 2, priceQ(1, 6, 6), 0)]); const b = await V.bond(V.binPoolPda(A, C, 10));
      check('the factory authority lists curated pools with a zero bond (record kept, rent only)', b && b.amount === 0n && b.creator.equals(payer.publicKey) && (await lamports(V.bondPda(V.binPoolPda(A, C, 10)))) === rentBond); }

    // ---------------------------------------------------------------- delist
    const P2 = V.binPoolPda(B, C, 30);
    await as(carol).send([await V.createPoolIx(carol.publicKey, B, C, 4, priceQ(1, 6, 6), 0)]);
    { const pre = await V.ensureBinAccountsIxs(alice.publicKey, P2, ids, alice.publicKey, alice.publicKey); await as(alice).send(pre, [], 400_000);
      await as(alice).send([await V.mintIx(alice.publicKey, P2, { ids, amountsX: ids.map((i) => (i >= 0 ? units(1_000, 6) : 0n)), amountsY: ids.map((i) => (i <= 0 ? units(1_000, 6) : 0n)) })], [], 1_400_000);
      await as(bob).send([await V.swapIx(bob.publicKey, P2, true, units(50, 6))], [], 1_400_000); }
    check('only the factory authority delists', await refused(as(mallory).send([await V.delistPoolIx(mallory.publicKey, P2)]), /NotAuthority|ConstraintHasOne/));
    { const t0 = await lamports(treasury.publicKey); sig = await V.send([await V.delistPoolIx(payer.publicKey, P2)]); ev = await evOf(sig, 'PoolDelisted');
      check('delist: the pool is flagged, the bond (+ its rent) goes to the treasury, the bond account is gone', (await V.binPool(P2)).delisted && ev.forfeited === BOND && (await lamports(treasury.publicKey)) - t0 === BOND + rentBond && !(await V.bond(P2))); }
    check('a delisted pool refuses new liquidity: mint', await refused(as(alice).send([await V.mintIx(alice.publicKey, P2, { ids: [1], amountsX: [units(1, 6)], amountsY: [0n] })], [], 1_400_000), /Delisted/));
    check('... limit orders', await refused(as(alice).send([await V.placeOrderIx(alice.publicKey, P2, { id: 2, isAsk: true, amount: units(1, 6) })], [], 1_400_000), /Delisted/));
    check('... and zaps (swap_and_add)', await refused(as(alice).send([await V.swapAndAddIx(alice.publicKey, P2, { xIn: true, amountIn: units(2, 6), swapAmount: units(1, 6), ids: [-1, 0, 1], weightsX: [0, 1, 1], weightsY: [1, 1, 0] })], [], 1_400_000), /Delisted/));
    check('the creator cannot release a forfeited bond', await refused(as(carol).send([V.releaseBondIx(carol.publicKey, P2)]), /AccountNotInitialized|not initialized|Delisted/i));
    check('delisting twice is refused', await refused(V.send([await V.delistPoolIx(payer.publicKey, P2)]), /Delisted/));
    { const before = await V.binPool(P2); sig = await as(bob).send([await V.swapIx(bob.publicKey, P2, false, units(20, 6))], [], 1_400_000); ev = await evOf(sig, 'Swapped'); const q = await V.binPool(P2);
      check('swaps continue on a delisted pool (and still pay the 0.2%)', ev && ev.amountOut > 0n && q.protocolFeeY - before.protocolFeeY === S.protocolFeeOf(units(20, 6))); }
    { const pos = await V.position(P2, alice.publicKey, alice.publicKey, ids); const sa = { '-1': await V.shareAccount(P2, alice.publicKey, alice.publicKey, -1), 0: await V.shareAccount(P2, alice.publicKey, alice.publicKey, 0) };
      const shOf = (i) => sa[S.chunkOf(i)].slots[S.slotOf(i)].shares; const held = ids.filter((i) => shOf(i) > 0n);
      const ax = await V.tokenBalance(B, alice.publicKey); sig = await as(alice).send([await V.burnIx(alice.publicKey, P2, { ids: held, shares: held.map(shOf) })], [], 1_400_000); ev = await evOf(sig, 'Burned');
      sig = await as(alice).send([await V.claimFeesIx(alice.publicKey, P2, { ids })], [], 600_000); const fc = await evOf(sig, 'FeesClaimed');
      check('LPs exit a delisted pool: burn and claim_fees work', ev && ev.amountX + ev.amountY > 0n && fc && fc.amountX === pos.fees.x && fc.amountY === pos.fees.y && (await V.tokenBalance(B, alice.publicKey)) > ax); }
  } catch (e) { console.error('\nTEST RUN CRASHED:', e); fail++; }
  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})();
