#!/usr/bin/env node
// The one-off devnet migration (veyl_bin --features devnet-migrate + scripts/migrate-devnet.js), rehearsed on its own local
// validator (RPC 8993 by default, MIGRATE_RPC_PORT to change; away from the shared 8933): deploy the veyl_bin that devnet
// runs today (git 5d526ad: 137-byte factory, curated create_pool, 10% protocol share), make a factory and pools with it
// (raw old create_pool encoding) and add liquidity / swap, then extend + upgrade the program in place to the current
// devnet-migrate build, run the script (dry run, real run, rerun) and check: the factory reads with the new decoder (old
// fields kept, treasury / bond / fee / tiers), pools read 0.2% and the right tier / fees with every other byte unchanged,
// a swap pays exactly 0.2%, the old mock-SOL pool is delisted with no bond and still lets its LP exit, a pool with no
// matching tier is left alone, and a new permissionless pool can be listed at a tier.
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFileSync } = require('child_process');
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const S = require('../sdk/veyl.js'); const { Veyl } = S;
const { startValidator, programIds, createMint, fund, units, priceQ, tool, ROOT } = require('../scripts/lib.js');
const { counts, check, refused, funded, loadEngine } = require('./harness.js');

const PORT = Number(process.env.MIGRATE_RPC_PORT || 8993);
const OLD_COMMIT = process.env.OLD_BIN_COMMIT || '5d526ad';
const NEW_SO = process.env.MIGRATE_SO || path.join(ROOT, 'target/deploy/veyl_bin.so');

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-migrate-')); const payer = Keypair.generate(); const payerFile = path.join(TMP, 'payer.json'); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  const { val, rpc, conn } = await startValidator(TMP, payer, PORT);
  const done = (code) => { val.once('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(code); }); val.kill(); setTimeout(() => process.exit(code), 8000).unref(); };
  try {
    const programs = programIds(); const binId = new PublicKey(programs.bin);
    const sol = (args) => execFileSync(tool('solana'), [...args, '-u', rpc, '-k', payerFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const oldSo = path.join(TMP, 'veyl_bin.old.so'); fs.writeFileSync(oldSo, execFileSync('git', ['show', OLD_COMMIT + ':target/deploy/veyl_bin.so'], { cwd: ROOT, maxBuffer: 1 << 26 }));
    console.log('old veyl_bin', require('crypto').createHash('sha256').update(fs.readFileSync(oldSo)).digest('hex').slice(0, 16) + '…', fs.statSync(oldSo).size, 'bytes; new', fs.statSync(NEW_SO).size, 'bytes');
    sol(['program', 'deploy', '--program-id', path.join(ROOT, 'target/deploy/veyl_bin-keypair.json'), oldSo]);
    const [alice, bob, mallory] = await funded(conn, 3, 50);
    const V = new Veyl({ connection: conn, programs, payer }); const as = (kp) => new Veyl({ connection: conn, programs, payer: kp });
    const nowS = () => Math.floor(Date.now() / 1000);
    const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };
    const W = (k, s = false) => ({ pubkey: new PublicKey(k), isSigner: s, isWritable: true }); const R = (k, s = false) => ({ pubkey: new PublicKey(k), isSigner: s, isWritable: false });

    // ---------------------------------------------------------------- the old program: factory, pools, liquidity, a swap
    await V.send([V.initFactoryIx(payer.publicKey)]);
    const fpda = V.factoryPda(); const fOld = await conn.getAccountInfo(fpda, 'confirmed');
    check('old program: the factory is the 137-byte layout', fOld && fOld.data.length === 137);
    const ms = []; for (let i = 0; i < 4; i++) ms.push(await createMint(conn, payer, 6)); ms.sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer())); const [A, B, C, M] = ms;
    for (const k of [payer, alice, bob, mallory]) for (const m of ms) await fund(conn, payer, m, k.publicKey, units(1_000_000, 6));
    const TP = spl.TOKEN_PROGRAM_ID;
    /// old create_pool(bin_step u16, base_fee u32, variable_fee_control u64, base_price [u8;32], active_id i32), factory authority only
    const oldCreate = (x, y, binStep, baseFee, vfc) => { const pool = V.binPoolPda(x, y, binStep);
      return new TransactionInstruction({ programId: binId, data: Buffer.concat([S.disc('create_pool'), S.u16(binStep), S.u32(baseFee), S.u64(vfc), S.be32(priceQ(1, 6, 6)), S.i32(0)]),
        keys: [W(payer.publicKey, true), R(fpda), R(x), R(y), W(pool), W(V.ata(x, pool, TP)), W(V.ata(y, pool, TP)), R(TP), R(TP), R(spl.ASSOCIATED_TOKEN_PROGRAM_ID), R(SystemProgram.programId)] }); };
    const P20 = V.binPoolPda(A, B, 20), P10 = V.binPoolPda(A, C, 10), PM = V.binPoolPda(B, M, 50), P7 = V.binPoolPda(B, C, 7);
    await V.send([oldCreate(A, B, 20, 2_000, 10_000)]); await V.send([oldCreate(A, C, 10, 500, 10_000)]); await V.send([oldCreate(B, M, 50, 5_000, 1_600)]); await V.send([oldCreate(B, C, 7, 700, 10_000)]);
    { const p = await V.binPool(P20); check('old pools: protocol_share 1000 (reads as 1000 in the new protocol_fee_bps slot), base fee 0.2% at bin step 20', p.protocolFeeBps === 1000 && p.baseFee === 2_000 && p.binStep === 20 && !p.delisted && p.feeTier === 0); }
    const ids = range(-3, 3);
    for (const P of [P20, PM]) { await as(alice).send(await V.ensureBinAccountsIxs(alice.publicKey, P, ids, alice.publicKey, alice.publicKey), [], 400_000);
      await as(alice).send([await V.mintIx(alice.publicKey, P, { ids, amountsX: ids.map((i) => (i >= 0 ? units(1_000, 6) : 0n)), amountsY: ids.map((i) => (i <= 0 ? units(1_000, 6) : 0n)) })], [], 1_400_000); }
    await as(bob).send([await V.swapIx(bob.publicKey, P20, true, units(10, 6))], [], 1_400_000);
    const before = {}; for (const P of [P20, P10, PM, P7]) before[P.toBase58()] = (await conn.getAccountInfo(P, 'confirmed')).data;
    const p20old = await V.binPool(P20);
    check('old program: a swap accrued protocol fees from the 10% share', p20old.protocolFeeX > 0n, String(p20old.protocolFeeX));

    // ---------------------------------------------------------------- upgrade in place (extend first, as on devnet)
    const pdAddr = PublicKey.findProgramAddressSync([binId.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
    const room = (await conn.getAccountInfo(pdAddr, 'confirmed')).data.length - 45; const need = fs.statSync(NEW_SO).size - room;
    if (need > 0) sol(['program', 'extend', binId.toBase58(), String(need)]);
    sol(['program', 'deploy', '--program-id', path.join(ROOT, 'target/deploy/veyl_bin-keypair.json'), NEW_SO]);
    check(`upgraded in place (programdata had ${room} bytes, extended by ${Math.max(0, need)})`, (await conn.getAccountInfo(pdAddr, 'confirmed')).data.length - 45 >= fs.statSync(NEW_SO).size);
    await new Promise((r) => setTimeout(r, 1500));
    check('before migrate_factory: the factory does not load as the new layout (migrate_pool refused)', await refused(V.send([V.migratePoolIx(payer.publicKey, P20)]), /AccountDidNotDeserialize|Failed to deserialize|3003/));
    check('only the factory authority migrates the factory', await refused(as(mallory).send([V.migrateFactoryIx(mallory.publicKey)]), /NotAuthority/));

    // ---------------------------------------------------------------- the script: dry run, real run, rerun
    const deployFile = path.join(TMP, 'deploy.json');
    fs.writeFileSync(deployFile, JSON.stringify({ programs, binPools: [{ id: 'a-b', address: P20.toBase58() }, { id: 'a-c', address: P10.toBase58() }, { id: 'b-msol', address: PM.toBase58() }, { id: 'gone', address: Keypair.generate().publicKey.toBase58() }] }));
    const run = (extra = []) => execFileSync(process.execPath, [path.join(ROOT, 'scripts/migrate-devnet.js'), '--network', 'local', '--deploy', deployFile, '--old-mint', M.toBase58(), ...extra],
      { encoding: 'utf8', env: { ...process.env, RPC_URL: rpc, DEPLOYER_KEYPAIR: payerFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = run(['--dry-run']); console.log(out.split('\n').map((l) => '    | ' + l).join('\n'));
    check('dry run: plans migrate_factory (simulated ok), 8 tiers, 3 pools, 1 delist; changes nothing', /simulated: ok/.test(out) && /would be migrated: 3/.test(out) && /would be delisted .*: 1/.test(out) && (await conn.getAccountInfo(fpda, 'confirmed')).data.length === 137 && (await V.binPool(P20)).protocolFeeBps === 1000);
    const authBefore = await conn.getBalance(payer.publicKey, 'confirmed');
    out = run(); console.log(out.split('\n').map((l) => '    | ' + l).join('\n'));
    check('script: factory migrated, 8 tiers added, 3 pools migrated, 1 delisted, the no-tier pool and the missing deploy pool reported', /factory: migrated/.test(out) && /added: 1, 5, 10, 20, 30, 50, 80, 100/.test(out) && /migrated: 3/.test(out) && /delisted .*: 1/.test(out) && /no enabled tier for .*bin step 7/.test(out) && /not on chain: gone/.test(out));

    // ---------------------------------------------------------------- factory
    const fa = await conn.getAccountInfo(fpda, 'confirmed'); const f = S.decodeFactory(fa.data);
    const rent = await conn.getMinimumBalanceForRentExemption(S.SIZES.factory);
    check('factory: 428 bytes, rent-exempt for its new size (the authority paid the difference)', fa.data.length === S.SIZES.factory && fa.lamports >= rent && authBefore > await conn.getBalance(payer.publicKey, 'confirmed'));
    check('factory: the old 137 bytes unchanged (discriminator, authority, pending authority, bump, fee authority)', fa.data.subarray(0, 137).equals(fOld.data) && f.authority.equals(payer.publicKey) && f.feeAuthority.equals(payer.publicKey) && f.pendingAuthority.equals(PublicKey.default));
    check('factory: treasury = authority, bond 1 SOL / 30 days, protocol fee 20 bps', f.treasury.equals(payer.publicKey) && f.bondLamports === BigInt(LAMPORTS_PER_SOL) && f.bondLock === 30n * 86_400n && f.protocolFeeBps === 20);
    const cfgTiers = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/local.json'), 'utf8')).feeTiers;
    check('factory: the 8 configured tiers in order (bin step 20 at 0.25%)', f.tiers.length === 8 && f.tiers.every((t, i) => t.enabled && t.binStep === cfgTiers[i].binStep && t.baseFee === cfgTiers[i].baseFee && t.vfc === BigInt(cfgTiers[i].vfc)) && f.tiers[3].binStep === 20 && f.tiers[3].baseFee === 2_500);
    check('migrate_factory twice is refused', await refused(V.send([V.migrateFactoryIx(payer.publicKey)]), /BadParams/));

    // ---------------------------------------------------------------- pools
    const changed = (a, b) => { const out = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i); return out; };
    const allowed = (i) => (i >= 296 && i < 304) || (i >= 344 && i < 348) || (i >= 352 && i < 360);
    const want = { [P20.toBase58()]: [3, 2_500, 10_000n], [P10.toBase58()]: [2, 500, 10_000n], [PM.toBase58()]: [5, 5_000, 1_600n] };
    for (const [addr, [tier, base, vfc]] of Object.entries(want)) {
      const a = (await conn.getAccountInfo(new PublicKey(addr), 'confirmed')).data; const p = S.decodeBinPool(new PublicKey(addr), a); const diff = changed(before[addr], a);
      check(`pool bin step ${p.binStep}: 20 bps, tier ${tier}, base fee ${base}, vfc ${vfc}; only the fee bytes changed`, p.protocolFeeBps === 20 && p.feeTier === tier && p.baseFee === base && p.variableFeeControl === vfc && diff.every(allowed), diff.filter((i) => !allowed(i)).slice(0, 8).join(','));
    }
    check('protocol fees accrued before the upgrade are kept', (await V.binPool(P20)).protocolFeeX === p20old.protocolFeeX);
    { const a = (await conn.getAccountInfo(P7, 'confirmed')).data; check('a pool whose bin step has no tier is left alone; migrate_pool refuses it (BadTier)', a.equals(before[P7.toBase58()]) && await refused(V.send([V.migratePoolIx(payer.publicKey, P7)]), /BadTier/)); }
    check('only the factory authority migrates a pool', await refused(as(mallory).send([V.migratePoolIx(mallory.publicKey, P20)]), /NotAuthority|ConstraintHasOne/));

    // ---------------------------------------------------------------- the old mock-SOL pool: delisted, exits work
    { const p = await V.binPool(PM); check('mock-SOL pool delisted (no bond PDA ever existed: bond() is null)', p.delisted && (await V.bond(PM)) === null); }
    { const a0 = (await conn.getAccountInfo(PM, 'confirmed')).data; await V.send([V.migratePoolIx(payer.publicKey, PM)]); const p = await V.binPool(PM);
      check('migrate_pool is idempotent and never un-delists', p.delisted && (await conn.getAccountInfo(PM, 'confirmed')).data.equals(a0)); }
    check('the delisted pool refuses new liquidity', await refused(as(alice).send([await V.mintIx(alice.publicKey, PM, { ids: [1], amountsX: [units(1, 6)], amountsY: [0n] })], [], 1_400_000), /Delisted/));
    { const sa = { '-1': await V.shareAccount(PM, alice.publicKey, alice.publicKey, -1), 0: await V.shareAccount(PM, alice.publicKey, alice.publicKey, 0) };
      const shOf = (i) => sa[S.chunkOf(i)].slots[S.slotOf(i)].shares; const held = ids.filter((i) => shOf(i) > 0n);
      const bx = await V.tokenBalance(B, alice.publicKey); const sig = await as(alice).send([await V.burnIx(alice.publicKey, PM, { ids: held, shares: held.map(shOf) })], [], 1_400_000); const ev = (await V.events(sig)).find((e) => e.name === 'Burned');
      check('the LP of the delisted pool burns its whole position', ev && ev.amountX > 0n && ev.amountY > 0n && (await V.tokenBalance(B, alice.publicKey)) > bx); }

    // ---------------------------------------------------------------- a swap after migration pays exactly 0.2%
    { const p = await V.binPool(P20); const amount = units(10, 6); const bins = await V.bins(P20, S.chunksForSwap(p, true)); const sim = S.simulateSwap(p, bins, true, amount, nowS());
      const sig = await as(bob).send([await V.swapIx(bob.publicKey, P20, true, amount)], [], 1_400_000); const ev = (await V.events(sig)).find((e) => e.name === 'Swapped'); const q = await V.binPool(P20);
      const proto = S.protocolFeeOf(amount, 20); const lp = S.mulDivCeil(amount - proto, 2_500n, S.PIPS);
      check('swap on a migrated pool: protocol += ceil(0.2%) exactly, LP fee at the new 0.25%, chain == JS twin', q.protocolFeeX - p.protocolFeeX === proto && proto === 20_000n && ev.protocolFee === proto && sim.lpFee === lp && ev.fee === lp + proto && ev.amountOut === sim.out, `+${q.protocolFeeX - p.protocolFeeX} lp ${sim.lpFee}`); }

    // ---------------------------------------------------------------- new rules work: permissionless listing at a tier
    { const [x, y] = S.canonicalPair(B, C); const pool = V.binPoolPda(x, y, 20); const b0 = BigInt(await conn.getBalance(alice.publicKey, 'confirmed'));
      await as(alice).send([await V.createPoolIx(alice.publicKey, x, y, 3, priceQ(1, 6, 6), 0)]); const p = await V.binPool(pool); const bond = await V.bond(pool);
      check('a non-authority lists a new pool at tier 3 and pays the 1 SOL bond', p && p.feeTier === 3 && p.baseFee === 2_500 && p.protocolFeeBps === 20 && bond && bond.amount === BigInt(LAMPORTS_PER_SOL) && b0 - BigInt(await conn.getBalance(alice.publicKey, 'confirmed')) > BigInt(LAMPORTS_PER_SOL)); }

    // ---------------------------------------------------------------- engine: an old pool with no bond is "verified"
    { const { installPools } = loadEngine('pools-engine.js'); class E {} installPools(E); const st = E.prototype._statusOf; const bp = await V.binPool(P20); const [bond] = await V.bonds([P20]);
      check('engine: an old pool (no bond PDA) reads verified, from config or discovered on chain; the delisted one delisted', bond === null && st({ address: P20.toBase58() }, bp, bond, nowS()) === 'verified' && st(null, bp, bond, nowS()) === 'verified' && st(null, await V.binPool(PM), null, nowS()) === 'delisted'); }

    out = run(); check('rerun: nothing left to do', /factory: already migrated/.test(out) && /added: none/.test(out) && /migrated: 0; already on the new rules: 4/.test(out) && /delisted .*: 0; already delisted: 1/.test(out), out.split('\n').filter((l) => /migrated|delisted/.test(l)).join(' / '));
  } catch (e) { console.error('\nTEST RUN CRASHED:', e, e.stderr ? String(e.stderr) : ''); counts.fail++; }
  console.log(`\n${counts.pass} passed, ${counts.fail} failed`);
  done(counts.fail ? 1 : 0);
})();
