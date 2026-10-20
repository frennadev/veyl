#!/usr/bin/env node
// Pools listed after the deploy (permissionless create_pool), on their own local validator (RPC 9043 by default,
// NEWPOOLS_RPC_PORT to change; away from the shared 8933): the gaps they opened and their fixes.
//   1. lookup tables: transaction sizes of private and public actions on a new pool with only the deployment's tables
//      (measured: what overflows 1,232 bytes), then the relayer's own table (relayer/luts.js): which pools and addresses it
//      takes (listed and seeded only, derived from the pool account, caps per pool / hour / tables), found again after a
//      restart, served in /info, loaded by the engine; the sizes after; the warm-up rule (sdk usableLut); a public add of
//      many bins on a new pool (the engine halves a mint that does not fit) and a v0 swap through the relayer's table.
//   2. fees in a token listed since the deploy (relayer _valueDiscovered, fees.js _derivedLimit): a creator's fake price
//      (liquidity far from the opening price) is not taken; a real one is valued from the band near the active bin, with
//      the haircut and the lowest price of the last 30 min; per-request cost cap and daily budgets.
//   3. sealed swaps: a new pool answers { enabled: false, reason }; once the committee's authority turns one on, the
//      relayer's crank finds it (sealedPools) although it is not in the deployment file.
'use strict';
globalThis.window = new EventTarget();
const fs = require('fs'); const path = require('path'); const os = require('os');
const { Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const S = require('../sdk/veyl.js'); require('../sdk/shield.js'); require('../sdk/sealed.js');
const { startValidator, deployAll, createMint, fund, units, priceQ } = require('../scripts/lib.js');
const { check, refused, finish, loadEngine } = require('./harness.js');
const E = loadEngine('sol-entry.js');
const PORT = Number(process.env.NEWPOOLS_RPC_PORT || 9043), HTTP_PORT = PORT + 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => BigInt('0x' + require('crypto').randomBytes(31).toString('hex'));
const ENV0 = { ...process.env };
const setEnv = (o) => { for (const k of Object.keys(process.env)) if (/^(POOL_LUT|DISCOVERED_)/.test(k)) delete process.env[k]; Object.assign(process.env, o); };
const throwsLike = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-newpools-')); const payer = Keypair.generate(); const payerFile = path.join(TMP, 'payer.json'); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  const { val, rpc, conn } = await startValidator(TMP, payer, PORT); let srv = null;
  const done = (code) => { if (srv) srv.close(); val.once('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(code); }); val.kill(); setTimeout(() => process.exit(code), 8000).unref(); };
  try {
    const kps = []; for (let i = 0; i < 4; i++) { const k = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 50 * LAMPORTS_PER_SOL), 'confirmed'); kps.push(k); }
    const [relayerKp, alice, relayer2, relayer3] = kps;
    // deployAll writes deploy.local.json at the repo root (other suites' file): the old one is put back right after
    const depFile = path.join(__dirname, '..', 'deploy.local.json'); const prevDep = fs.existsSync(depFile) ? fs.readFileSync(depFile) : null;
    let deployed; try { deployed = await deployAll({ rpc, payerFile, relayer: relayerKp.publicKey }); } finally { if (prevDep) fs.writeFileSync(depFile, prevDep); else fs.rmSync(depFile, { force: true }); }
    const { V, T } = deployed; const dep = { ...deployed.dep, tokens: Object.fromEntries(Object.entries(deployed.dep.tokens).map(([k, t]) => [k, { ...t, price: k === 'SOL' ? 150 : k === 'USDC' || k === 'USDT' ? 1 : t.price || 0.5 }])) };
    const USDC = T.USDC.mint, JUP = T.JUP.mint;
    const solUsdc = new PublicKey(dep.binPools.find((b) => b.id === 'sol-usdc').address);
    // ---- new pools: NEW-USDC (a new token, healthy), JUP-USDC at another tier (deployment tokens), MEH-USDC (a fake price:
    // opened at 1,000 USDC per MEH with its USDC parked 400 bins lower), DEL-USDC (delisted), EMP-USDC (never seeded)
    const decOf = (m) => (m.equals(USDC) ? T.USDC.decimals : m.equals(JUP) ? T.JUP.decimals : 6);
    const pool = async (mint, other, binStep, humanYperX) => { const [x, y] = S.canonicalPair(mint, other); const fl = !x.equals(mint);
      await V.send([await V.createPoolIx(payer.publicKey, x, y, await V.tierIndex(binStep), priceQ(fl ? 1 / humanYperX : humanYperX, decOf(x), decOf(y)), 0)]); return V.binPoolPda(x, y, binStep); };
    const vaults = async (m) => { await V.send([await V.initVaultIx(payer.publicKey, m)]); await V.send([spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, V.shieldVault(m), V.shieldPda(), m)]); await fund(conn, payer, m, relayerKp.publicKey, 0n); };
    const NEW = await createMint(conn, payer, 6), MEH = await createMint(conn, payer, 6), DEL = await createMint(conn, payer, 6), EMP = await createMint(conn, payer, 6);
    for (const m of [NEW, MEH, DEL, EMP]) await vaults(m);
    const PN = await pool(NEW, USDC, 20, 2), PJ = await pool(JUP, USDC, 10, 1), PM = await pool(MEH, USDC, 20, 1000), PD = await pool(DEL, USDC, 20, 1), PE = await pool(EMP, USDC, 20, 1);
    /// liquidity over `ids`: perBin.x at and above the active bin, perBin.y at and below
    const seed = async (P, ids, perBin) => { const bp = await V.binPool(P); for (const m of [bp.mintX, bp.mintY]) await fund(conn, payer, m, payer.publicKey, units(1e7, 9));
      await V.send(await V.ensureBinAccountsIxs(payer.publicKey, P, ids, payer.publicKey, payer.publicKey), [], 400_000);
      for (let k = 0; k < ids.length; k += 8) { const g = ids.slice(k, k + 8); await V.send([await V.mintIx(payer.publicKey, P, { ids: g, amountsX: g.map((i) => (i >= bp.activeId ? perBin.x : 0n)), amountsY: g.map((i) => (i <= bp.activeId ? perBin.y : 0n)) })], [], 1_400_000); } };
    const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };
    await seed(PN, range(-20, 20), { x: units(1000, 6), y: units(1000, 6) }); await seed(PJ, range(-20, 20), { x: units(100, 6), y: units(100, 6) }); await seed(PD, range(-2, 2), { x: units(10, 6), y: units(10, 6) });
    { const bp = await V.binPool(PM); const usdcIsY = bp.mintY.equals(USDC); const far = usdcIsY ? range(-405, -400) : range(400, 405); /* USDC far from the active bin, nothing near it */
      await seed(PM, far, usdcIsY ? { x: 0n, y: units(2000, 6) } : { x: units(2000, 6), y: 0n }); await seed(PM, [0], usdcIsY ? { x: units(1, 6), y: 0n } : { x: 0n, y: units(1, 6) }); }
    await V.send([await V.delistPoolIx(payer.publicKey, PD)]);
    check('setup: 5 new pools (NEW, JUP at bin step 10, fake-priced MEH, delisted DEL, unseeded EMP)', (await V.binPool(PD)).delisted && !(await V.binPool(PE)).seeded && (await V.binPool(PN)).seeded && (await V.binPool(PM)).seeded);

    // ---------------------------------------------------------------- 1. sizes with the deployment's tables only
    const tablesOf = async (keys) => { const out = []; for (const k of keys) { const t = await S.usableLut(conn, (await conn.getAddressLookupTable(new PublicKey(k))).value); if (t) out.push(t); } return out; };
    const depTables = await tablesOf([dep.lookupTable, ...(dep.lookupTables || [])]);
    const me = relayerKp.publicKey; const pubs = () => Array.from({ length: 8 }, rnd); const HEAP = ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 });
    const size = (ixs, tables, payerKey = me) => { try { return new VersionedTransaction(new TransactionMessage({ payerKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs] }).compileToV0Message(tables)).serialize().length; } catch { return Infinity; } };
    const pn = await V.binPool(PN), pj = await V.binPool(PJ); const usdcXn = pn.mintX.equals(USDC), usdcXj = pj.mintX.equals(USDC);
    const owner = Keypair.generate().publicKey; const dl = 1n << 40n; const ids15 = range(-7, 7);
    const cases = {
      'shield_lp 2 legs + zap (NEW)': async () => [HEAP, await V.shieldLpIx(me, 1n, { core: { binPool: PN, lo: 52, relayer: me, zap: { xIn: false, amount: 1n, minOut: 1n } }, legs: [] }, pubs(), me, [{ pubs: pubs(), poster: me }, { pubs: pubs(), poster: me }])],
      'shield_swap 2 routes NEW>USDC>JUP + NEW>USDC>SOL': async () => { const sbp = await V.binPool(solUsdc); const routes = await V.prepareRoutes([{ amountIn: 1n, hops: [{ pool: PN, xForY: !usdcXn }, { pool: PJ, xForY: usdcXj }] }, { amountIn: 1n, hops: [{ pool: PN, xForY: !usdcXn }, { pool: solUsdc, xForY: sbp.mintX.equals(USDC) }] }]);
        return [HEAP, await V.shieldSwapIx(me, 1n, { core: { routes, tokenOut: JUP }, leg: { mint: NEW, relayer: V.ata(NEW, me) }, legPubs: pubs() }, me)]; },
      'private_add 15 bins 2 legs (JUP-USDC, Phase 1)': async () => [await V.privateAddIx(me, [{ mint: pj.mintX, nullifierHash: rnd() }, { mint: pj.mintY, nullifierHash: rnd() }], { binPool: PJ, ids: ids15, amountsX: ids15.map(() => 1n), amountsY: ids15.map(() => 1n), minShares: ids15.map(() => 1n), owner, feeRecipient: me, feeBps: 5, deadline: dl })],
      'private_remove 15 bins (JUP-USDC, Phase 1)': async () => { const d = { owner, binPool: PJ, ids: ids15, shares: ids15.map(() => 1n), precommitX: 1n, precommitY: 1n, recipient: null, feeRecipient: me, feeBps: 5, nonce: 0n, deadline: dl }; return [V.signedSigIx('remove', owner, Buffer.alloc(64), d), await V.privateRemoveIx(me, d)]; },
      'public mint 16 bins (NEW, wallet)': async () => { const g = range(-8, 7); return [await V.mintIx(alice.publicKey, PN, { owner, authority: alice.publicKey, ids: g, amountsX: g.map(() => 1n), amountsY: g.map(() => 1n), minShares: g.map(() => 1n) })]; },
    };
    const sizes = async (tables) => { const o = {}; for (const [k, f] of Object.entries(cases)) o[k] = size(await f(), tables, k.includes('wallet') ? alice.publicKey : me); return o; };
    const before = await sizes(depTables); console.log('  sizes, deployment tables only:', JSON.stringify(before, (k, v) => (v === Infinity ? 'over (does not encode)' : v)));
    check('measured: a new pool\'s Phase 1 add and remove and a 16-bin public mint overflow 1,232 bytes with the deployment\'s tables only', before['private_add 15 bins 2 legs (JUP-USDC, Phase 1)'] > 1232 && before['private_remove 15 bins (JUP-USDC, Phase 1)'] > 1232 && before['public mint 16 bins (NEW, wallet)'] > 1232);
    check('measured: the shielded actions still fit, with little room (worst shield_lp / 2-route swap > 1,000 bytes)', before['shield_lp 2 legs + zap (NEW)'] <= 1232 && before['shield_swap 2 routes NEW>USDC>JUP + NEW>USDC>SOL'] <= 1232 && before['shield_lp 2 legs + zap (NEW)'] > 1000);

    // ---------------------------------------------------------------- 1. the relayer's table
    const { Relayer, serve } = require('../relayer/relayer.js');
    setEnv({});
    const r = new Relayer({ connection: conn, wallet: relayerKp, deploy: dep });
    await r.discover(true); const res = await r.syncPoolLuts(); /* discover started one in the background: this returns it */
    const lut = r.poolLuts && r.poolLuts[0] && (await conn.getAddressLookupTable(r.poolLuts[0])).value; const inLut = new Set(lut ? lut.state.addresses.map((a) => a.toBase58()) : []);
    check('relayer: one table of its own (its authority), served in /info poolLookupTables, used for its own transactions', r.poolLuts.length === 1 && lut.state.authority.equals(me) && JSON.stringify(r.info().poolLookupTables) === JSON.stringify([r.poolLuts[0].toBase58()]) && r.V.lookupExtra.some((k) => k.equals(r.poolLuts[0])), JSON.stringify({ res, n: inLut.size }));
    check('it holds NEW-USDC\'s accounts: pool, vaults, entry / shielded / fee token accounts of NEW, bin arrays of chunks -1 and 0', [pn.address, pn.vaultX, pn.vaultY, V.ata(NEW, V.signerPda()), V.shieldVault(NEW), V.ata(NEW, me), V.binArrayPda(PN, 0), V.binArrayPda(PN, -1)].every((a) => inLut.has(a.toBase58())));
    check('only accounts that exist (no LpAcc / shielded share account for NEW-USDC yet, no chunk-1 bin array)', !inLut.has(V.lpAccPda(PN, 0).toBase58()) && !inLut.has(V.binArrayPda(PN, 1).toBase58()));
    check('not the delisted pool nor the unseeded one; nothing already in the deployment\'s tables', !inLut.has(PD.toBase58()) && !inLut.has(PE.toBase58()) && !inLut.has(USDC.toBase58()) && !inLut.has(solUsdc.toBase58()));
    check('a second sync adds nothing (idempotent)', (await r.syncPoolLuts()).added === 0);
    // a relayer restarted with the same wallet finds its table on chain (and makes none); POOL_LOOKUP_TABLES works too
    const rr = new Relayer({ connection: conn, wallet: relayerKp, deploy: dep }); await rr.discover(true); await rr.syncPoolLuts();
    check('restart: the table is found again on chain, no second one made', rr.poolLuts.length === 1 && rr.poolLuts[0].equals(r.poolLuts[0]) && (await rr.syncPoolLuts()).added === 0);
    setEnv({ POOL_LOOKUP_TABLES: r.poolLuts[0].toBase58() }); const re = new Relayer({ connection: conn, wallet: relayerKp, deploy: dep });
    check('POOL_LOOKUP_TABLES names it instead of the chain scan', (await re._loadPoolLuts()).length === 1 && re.poolLuts[0].equals(r.poolLuts[0]));
    // caps, each on a fresh wallet
    setEnv({ POOL_LUT_PER_POOL: '3' }); const r2 = new Relayer({ connection: conn, wallet: relayer2, deploy: dep }); await r2.discover(true); await r2.syncPoolLuts();
    const t2 = (await conn.getAddressLookupTable(r2.poolLuts[0])).value; const pools2 = (await V.binPools()).filter((p) => !p.delisted && p.seeded).length;
    check('POOL_LUT_PER_POOL=3: at most 3 new addresses per pool', t2.state.addresses.length <= 3 * pools2 && t2.state.addresses.length > 0, t2.state.addresses.length + ' for ' + pools2 + ' pools');
    setEnv({ POOL_LUT_PER_HOUR: '5' }); const r3 = new Relayer({ connection: conn, wallet: relayer3, deploy: dep }); await r3.discover(true); await r3.syncPoolLuts(); const a3 = (await r3.syncPoolLuts()).added;
    check('POOL_LUT_PER_HOUR=5: 5 addresses, then nothing more this hour', (await conn.getAddressLookupTable(r3.poolLuts[0])).value.state.addresses.length === 5 && a3 === 0);
    const r4kp = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(r4kp.publicKey, LAMPORTS_PER_SOL), 'confirmed');
    setEnv({ POOL_LUT_MAX_TABLES: '0' }); const r4 = new Relayer({ connection: conn, wallet: r4kp, deploy: dep }); await r4.discover(true); const a4 = await r4.syncPoolLuts();
    check('POOL_LUT_MAX_TABLES=0: no table made, no rent spent', a4.added === 0 && r4.poolLuts.length === 0 && (await conn.getBalance(r4kp.publicKey)) === LAMPORTS_PER_SOL);
    setEnv({ POOL_LUTS: '0' }); const r5 = new Relayer({ connection: conn, wallet: r4kp, deploy: dep }); await r5.discover(true);
    check('POOL_LUTS=0 turns it off', (await r5.syncPoolLuts()).added === 0 && !r5.poolLuts);
    setEnv({});
    // warm-up: addresses extended in the current slot are left out until the next one
    { const slot = await conn.getSlot('confirmed'); const st = { ...lut.state, lastExtendedSlot: slot + 1000, lastExtendedSlotStartIndex: 2 };
      const fresh = await S.usableLut(conn, new AddressLookupTableAccount({ key: lut.key, state: st })), old = await S.usableLut(conn, lut);
      check('usableLut: entries added this slot are held back (2 of ' + lut.state.addresses.length + ' usable), older tables in full', fresh.state.addresses.length === 2 && old.state.addresses.length === lut.state.addresses.length); }

    // ---------------------------------------------------------------- 1. sizes after, the engine, real transactions
    await sleep(800); const after = await sizes(await tablesOf([dep.lookupTable, ...(dep.lookupTables || []), ...r.poolLuts]));
    console.log('  sizes, with the relayer\'s table:', JSON.stringify(after));
    check('with the relayer\'s table every one fits, each smaller than before', Object.keys(cases).every((k) => after[k] <= 1232 && after[k] < before[k]));
    process.env.SEALED_CRANK = '0'; srv = serve(r, HTTP_PORT); await sleep(300);
    const info = await fetch('http://127.0.0.1:' + HTTP_PORT + '/info').then((x) => x.json());
    check('GET /info: lookupTable, lookupTables (the deployment\'s) and poolLookupTables (this relayer\'s)', info.lookupTable === dep.lookupTable && Array.isArray(info.lookupTables) && info.poolLookupTables.length === 1 && info.poolLookupTables[0] === r.poolLuts[0].toBase58());
    const cfg = { chainName: 'Local', rpc, programs: dep.programs, lookupTable: dep.lookupTable, lookupTables: dep.lookupTables, tokens: dep.tokens, feeTiers: dep.feeTiers,
      binPools: dep.binPools.map((b) => ({ id: b.id, x: b.x, y: b.y, bs: b.binStep, base: b.baseFee / 1e4, address: b.address })) };
    const engineFor = async (kp, relayerUrl) => { const e = new E.Engine(JSON.parse(JSON.stringify({ ...cfg, relayer: relayerUrl }))); const sign = (tx) => { if (tx.version !== undefined) tx.sign([kp]); else tx.partialSign(kp); return tx; };
      await e.connect({ name: 'test', publicKey: kp.publicKey, connect: async () => ({ publicKey: kp.publicKey }), signTransaction: async (tx) => sign(tx), signAllTransactions: async (txs) => txs.map(sign) }); return e; };
    for (const m of [NEW, USDC]) await fund(conn, payer, m, alice.publicKey, units(100_000, 6));
    const eR = await engineFor(alice, 'http://127.0.0.1:' + HTTP_PORT), eX = await engineFor(alice, 'http://127.0.0.1:1');
    const lR = await eR._luts(), lX = await eX._luts();
    check('engine _luts: the deployment\'s tables plus the relayer\'s (from /info); without a relayer, the deployment\'s only', lR.length === depTables.length + 1 && lR.some((t) => t.key.equals(r.poolLuts[0])) && lX.length === depTables.length);
    const rowN = (await eR.listPools({ fresh: true })).find((x) => x.address === PN.toBase58()); await eX.listPools({ fresh: true });
    const g16 = range(-8, 7); const ix16 = await eX.V.mintIx(alice.publicKey, PN, { owner, authority: alice.publicKey, ids: g16, amountsX: g16.map(() => 1n), amountsY: g16.map(() => 1n), minShares: g16.map(() => 1n) });
    check('engine without the relayer\'s table: a 16-bin mint on the new pool is over the limit (with it: fits)', (await eX._bytes([ix16], alice.publicKey)) > 1232 && (await eR._bytes([ix16], alice.publicKey)) <= 1232);
    const nIsX = pn.mintX.equals(NEW); const amt = { amountX: nIsX ? 40 : 80, amountY: nIsX ? 80 : 40 };
    const pos1 = await eX.addLiquidity(rowN, { priv: false, lo: -12, hi: 12, shape: 'spot', ...amt });
    check('public add of 25 bins on the new pool without the relayer\'s table: mints halved until they fit, all confirmed', pos1 && pos1.ids.length === 25 && !!pos1.tx, pos1 && pos1.ids.length);
    const pos2 = await eR.addLiquidity(rowN, { priv: false, lo: -12, hi: 12, shape: 'spot', ...amt });
    check('the same through the relayer\'s table (v0 transactions resolving it on chain)', pos2 && pos2.ids.length === 25 && !!pos2.tx);
    { const tx = await conn.getTransaction(pos2.tx, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); const used = (tx.transaction.message.addressTableLookups || []).map((l) => l.accountKey.toBase58());
      check('…and its transaction did look addresses up in the relayer\'s table', used.includes(r.poolLuts[0].toBase58()), JSON.stringify(used)); }
    { await fund(conn, payer, NEW, me, units(100, 6)); const usdc0 = await V.tokenBalance(USDC, me);
      await r.V.sendV0([await r.V.swapIx(me, PN, nIsX, units(5, 6))], [], 400_000);
      check('a relayer-signed v0 swap through the new pool with its table executes', (await V.tokenBalance(USDC, me)) > usdc0); }

    // ---------------------------------------------------------------- 2. fees in a token listed since the deploy
    const N = NEW.toBase58(), M = MEH.toBase58();
    { const bp = await V.binPool(PM); const spot = Number(S.priceOf(bp.basePrice, bp.binStep, bp.activeId)) / 2 ** 128; const vault = await conn.getTokenAccountBalance(bp.mintY.equals(USDC) ? bp.vaultY : bp.vaultX);
      check('MEH (opened at 1,000 USDC, $12,000 of USDC parked 400 bins away): the old rule (spot x whole vault depth, 50% haircut) would have valued it at ~$500', Number(vault.value.uiAmount) >= 2000 && (bp.mintY.equals(USDC) ? spot : 1 / spot) > 900); }
    check('…now refused: no liquidity near its price', r._unvalued(M) && (await refused(r.feeQuote({ kind: 'transact', mint: M }), /cannot value/)));
    const pxN = r.derivedPrices[N]; { const spot = Number(S.priceOf(pn.basePrice, pn.binStep, pn.activeId)) / 2 ** 128; const spotUsd = nIsX ? spot : 1 / spot;
      check('NEW valued from the band near its price: under half of spot (haircut 0.5, band average), band depth counted', pxN > 0 && pxN <= spotUsd * 0.5 + 1e-9 && pxN > spotUsd * 0.4 && r.derivedDepth[N] >= 1000, JSON.stringify({ pxN, spotUsd, depth: r.derivedDepth[N] })); }
    const revalue = async () => r._valueDiscovered((await V.binPools()).filter((p) => p.address.equals(PN)));
    r._pxHist[N] = [{ at: Date.now() - 60_000, px: pxN / 10 }]; await revalue();
    check('the lowest price of the last 30 min is used (a pump inside it does not raise the fee value)', Math.abs(r.derivedPrices[N] - pxN / 10) < 1e-12);
    r._pxHist[N] = [{ at: Date.now() - 3_600_000, px: pxN / 10 }]; await revalue();
    check('…and an older low is forgotten', Math.abs(r.derivedPrices[N] / pxN - 1) < 0.05, r.derivedPrices[N] / pxN);
    const fq = await r.feeQuote({ kind: 'transact', mint: N }); check('a withdrawal quoted in NEW (cheap: no new accounts)', BigInt(fq.fee) > 0n && fq.costLamports < 0.03e9, JSON.stringify(fq));
    check('a request that would make the relayer pay more than 0.03 SOL (new bin arrays) is refused in NEW: pay in a listed token', await refused(r.feeQuote({ kind: 'shieldLp', mint: N, legs: 1, core: { binPool: PN.toBase58(), lo: 3000 } }), /listed token/));
    const q2 = await r.feeQuote({ kind: 'shieldLp', mint: USDC.toBase58(), legs: 1, core: { binPool: PN.toBase58(), lo: 3000 } }); check('…the same quoted in USDC is fine', BigInt(q2.fee) > 0n);
    setEnv({ DISCOVERED_BUDGET_SOL: '0.002' }); const lam = 1_000_000; const big = (sym) => [{ sym, atoms: r.atomsFor(lam, sym) * 2n }];
    let ok1 = true; try { r._coverOrRefuse(lam, big(N)); r._coverOrRefuse(lam, big(N)); } catch { ok1 = false; }
    check('budget DISCOVERED_BUDGET_SOL=0.002: two requests costing 0.001 SOL each covered by NEW fees pass, the third is refused', ok1 && throwsLike(() => r._coverOrRefuse(lam, big(N)), /taken all the fees/));
    let ok2 = true; try { r._coverOrRefuse(lam, [...big(N), ...big('USDC')]); } catch { ok2 = false; } check('…a request whose USDC part covers it alone still passes (and spends no NEW budget)', ok2);
    setEnv({ DISCOVERED_BUDGET_TOTAL_SOL: '0.0025', DISCOVERED_BUDGET_SOL: '1' }); check('total budget over every listed-since token (DISCOVERED_BUDGET_TOTAL_SOL)', throwsLike(() => r._coverOrRefuse(lam, big(N)), /taken all the fees/));
    setEnv({});

    // ---------------------------------------------------------------- 3. sealed swaps
    const ss = await r.sealedState(PN.toBase58()); check('/sealed for a new pool: { enabled: false, reason: not-enabled, why }', ss.enabled === false && ss.reason === 'not-enabled' && /committee/.test(ss.why));
    check('…an address that is no pool: reason unknown-pool', (await r.sealedState(Keypair.generate().publicKey.toBase58())).reason === 'unknown-pool');
    check('crank with no sealed pool anywhere: nothing to do, no error', (await r.crankSealed()) === 0);
    const es = await eR.sealedState({ address: PN.toBase58() }); check('engine sealedState passes the reason through', es.enabled === false && es.reason === 'not-enabled');
    await V.send([V.initCommitteeIx(payer.publicKey)]); await V.send([V.initSealedPoolIx(payer.publicKey, PN, { epochSlots: 2, settleTimeout: 20, minIn: [1n, 1n], kMin: 1, maxRollovers: 3, maxDrift: 100 })]);
    const sp = await V.sealedPools(); check('V.sealedPools finds the pool the committee authority turned on (not in the deployment file)', sp.length === 1 && sp[0].binPool.equals(PN));
    await sleep(2500); r._sealedAt = 0; const b0 = await V.batch(PN, 0n); const n = await r.crankSealed(); const b1 = await V.batch(PN, 0n);
    check('the relayer\'s crank serves it: the empty batch rolled over', n >= 1 && b1.endSlot > b0.endSlot, JSON.stringify({ n, before: String(b0.endSlot), after: String(b1.endSlot) }));
    const ss2 = await r.sealedState(PN.toBase58()); check('/sealed then reports it enabled', ss2.enabled === true && ss2.seq === '0');
  } catch (e) { console.error(e); check('no exception', false, e.message); }
  Object.assign(process.env, ENV0); finish(done, { cu: false });
})();
