#!/usr/bin/env node
// Devnet proof: an ordinary wallet lists a pool (permissionless, 1 SOL bond), it trades with the 0.2% protocol fee, the
// authority delists it (bond to the treasury). RPC_URL=<dedicated devnet RPC> node e2e/devnet-pools.js
// (deployer key: DEPLOYER_KEYPAIR or ~/keys/veyl/devnet-deployer.json; costs ~0.2 devnet SOL, the bond comes back on delist)
'use strict';
const path = require('path'); const os = require('os'); const ROOT = path.join(__dirname, '..'); const fs = require('fs');
const { Keypair, PublicKey, Connection, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require(ROOT + '/node_modules/@solana/web3.js');
const S = require(ROOT + '/sdk/veyl.js'); const { Veyl } = S; const { createMint, fund, units, priceQ, readKey } = require(ROOT + '/scripts/lib.js');
let pass = 0, fail = 0; const check = (name, ok, note = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? '  ' + note : ''}`); };
const refused = async (p, re) => { try { await p; return false; } catch (e) { return re.test(String(e.message || e) + JSON.stringify(e.logs || e.transactionLogs || '')); } };
(async () => {
  if (!process.env.RPC_URL) { console.error('Set RPC_URL to a dedicated devnet RPC.'); process.exit(2); } const conn = new Connection(process.env.RPC_URL, 'confirmed'); if ((await conn.getGenesisHash()) !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') { console.error('Not devnet.'); process.exit(2); } const dep = JSON.parse(fs.readFileSync(ROOT + '/deploy.devnet.json', 'utf8'));
  const programs = Object.fromEntries(Object.entries(dep.programs).map(([k, v]) => [k, new PublicKey(v)]));
  const deployer = readKey(process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), 'keys/veyl/devnet-deployer.json')); const user = Keypair.generate(); fs.writeFileSync(path.join(os.tmpdir(), 'veyl-devnet-pools-user.json'), JSON.stringify(Array.from(user.secretKey)), { mode: 0o600 });
  const V = new Veyl({ connection: conn, programs, payer: deployer }); const U = new Veyl({ connection: conn, programs, payer: user });
  const sol = async (k) => BigInt(await conn.getBalance(k)); const d0 = await sol(deployer.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: user.publicKey, lamports: 1.3 * LAMPORTS_PER_SOL })), [deployer]);
  const f = await V.factory(); const tier = await V.tierIndex(30); const BOND = f.bondLamports;
  check('devnet factory: permissionless listing with a 1 SOL bond, 30-day lock, 0.2% protocol fee, tier for bin step 30', BOND === 1_000_000_000n && Number(f.bondLock) === 30 * 86400 && f.protocolFeeBps === 20 && tier >= 0, `tier ${tier}`);
  const a = await createMint(conn, deployer, 6), b = await createMint(conn, deployer, 6); const [x, y] = S.canonicalPair(a, b); const pool = V.binPoolPda(x, y, 30);
  const u0 = await sol(user.publicKey);
  await U.send([await U.createPoolIx(user.publicKey, x, y, tier, priceQ(1, 6, 6), 0)]);
  const p = await V.binPool(pool); const bond = await V.bond(pool); const u1 = await sol(user.publicKey);
  check('an ordinary wallet lists a new pair on devnet: pool at the chosen tier, 0.2% protocol fee, not delisted', !!p && p.binStep === 30 && p.feeTier === tier && p.protocolFeeBps === 20 && !p.delisted, pool.toBase58());
  check('the creator paid the 1 SOL bond into the pool\'s bond account, locked for 30 days', bond && bond.creator.equals(user.publicKey) && bond.amount === BOND && Number(bond.unlockAt - bond.createdAt) === 30 * 86400, `paid ${(Number(u0 - u1) / 1e9).toFixed(4)} SOL incl. rent`);
  check('the same pair at the same tier cannot be listed twice', await refused(V.send([await V.createPoolIx(deployer.publicKey, x, y, tier, priceQ(1, 6, 6), 0)]), /already in use|0x0/));
  check('the reversed pair is refused (canonical mint order)', await refused(V.send([await V.createPoolIx(deployer.publicKey, y, x, tier, priceQ(1, 6, 6), 0)]), /MintOrder/));
  check('the bond cannot be released before its lock', await refused(U.send([U.releaseBondIx(user.publicKey, pool)]), /BondLocked/));
  check('nobody but the creator can release the bond', await refused(V.send([V.releaseBondIx(deployer.publicKey, pool)]), /NotAuthority|ConstraintHasOne|ConstraintSeeds|BondLocked/));
  // liquidity from the creator, a swap from someone else: the protocol fee is 0.2% of the input on top of the LP fee
  await fund(conn, deployer, x, user.publicKey, units(10_000, 6)); await fund(conn, deployer, y, user.publicKey, units(10_000, 6));
  const ids = [-2, -1, 0, 1, 2]; await U.send(await U.ensureBinAccountsIxs(user.publicKey, pool, ids, user.publicKey, user.publicKey), [], 400_000); await U.send([await U.mintIx(user.publicKey, pool, { ids, amountsX: ids.map((i) => (i >= 0 ? units(1_000, 6) : 0n)), amountsY: ids.map((i) => (i <= 0 ? units(1_000, 6) : 0n)) })], [], 1_400_000);
  await fund(conn, deployer, x, deployer.publicKey, units(1_000, 6)); await fund(conn, deployer, y, deployer.publicKey, units(1_000, 6));
  const b0 = await V.binPool(pool); const amt = units(100, 6); await V.send([await V.swapIx(deployer.publicKey, pool, true, amt)], [], 1_400_000); const b1 = await V.binPool(pool);
  const want = (amt * 20n + 9_999n) / 10_000n;
  check('a swap through the new pool pays exactly 0.2% protocol fee (ceil) on top of the LP fee', b1.protocolFeeX - b0.protocolFeeX === want && b1.totalFeeX - b0.totalFeeX > want, `${b1.protocolFeeX - b0.protocolFeeX} atoms of ${amt}`);
  check('only the factory authority can delist', await refused(U.send([await U.delistPoolIx(user.publicKey, pool)]), /NotAuthority|ConstraintHasOne/));
  const t0 = await sol(f.treasury); await V.send([await V.delistPoolIx(deployer.publicKey, pool)]); const t1 = await sol(f.treasury); const p2 = await V.binPool(pool);
  check('delist: the pool is flagged and the bond goes to the treasury (the deployer on devnet)', p2.delisted && !(await V.bond(pool)) && t1 - t0 >= BOND - 10_000n, `treasury +${(Number(t1 - t0) / 1e9).toFixed(4)} SOL`);
  check('a delisted pool refuses new liquidity', await refused(U.send([await U.mintIx(user.publicKey, pool, { ids: [0], amountsX: [units(10, 6)], amountsY: [units(10, 6)] })], [], 1_400_000), /Delisted|PoolDelisted|0x17/));
  const left = await sol(user.publicKey); if (left > 10_000n) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: deployer.publicKey, lamports: Number(left - 5_000n) })), [user]);
  console.log(`\n${pass} passed, ${fail} failed · deployer net ${(Number((await sol(deployer.publicKey)) - d0) / 1e9).toFixed(4)} SOL`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED', e.message, e.logs || ''); process.exit(1); });
