#!/usr/bin/env node
// The engine's open-pool API (engine/pools-engine.js) and the relayer's pool discovery. Part 1, no network: the Sandbox
// (the in-browser demo chain) offers the same calls: tiers, bond terms, token checks, poolFor, createPool, listPools,
// bond / releaseBond, mint keys everywhere, the quote's LP / protocol fee breakdown, persistence. Part 2, against its own
// local validator (RPC 8933; run alone, like the other suites): the real engine bundled for Node with a keypair as the
// wallet: tokenInfo (listed, Token-2022 metadata, plain mint), checkToken (the program's Token-2022 allowlist), every
// createPool error code, a pool created by a wallet (canonical order, inverted price, vaults for private actions), its
// listing (unverified while the bond is locked, then verified; delisted), bond / releaseBond, quote breakdown vs the chain,
// a public swap keyed by mints, and the relayer finding the new pools (tier, status, fees in a new token).
'use strict';
globalThis.window = new EventTarget();
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const S = require('../sdk/veyl.js');
const { check, refused, lap, freshValidator, funded, finish, loadEngine } = require('./harness.js');
const E = loadEngine('sol-entry.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code = async (p, c) => { try { await p; return 'no error'; } catch (e) { return e.code === c ? true : (e.code || '') + ' ' + e.message; } };

async function sandbox() {
  console.log('\n-- Sandbox');
  const sb = new E.Sandbox({ persist: false, market: false, bots: false, history: false }); await sb.init();
  check('Engine.PROTOCOL_FEE_BPS = 20 (static), Sandbox too', E.Engine.PROTOCOL_FEE_BPS === 20 && E.Sandbox.PROTOCOL_FEE_BPS === 20);
  const tiers = await sb.listTiers(); const want = { 1: 100, 5: 500, 10: 500, 20: 2500, 30: 3000, 50: 5000, 80: 10000, 100: 20000 };
  check('listTiers: the owner\'s 8 tiers { id, label, category, feePips, binStep }', tiers.length === 8 && tiers.every((t, i) => t.id === i && want[t.binStep] === t.feePips && t.label && ['stable', 'major', 'volatile'].includes(t.category)), JSON.stringify(tiers[5]));
  const terms = await sb.bondTerms(); check('bondTerms: 1 SOL, 30 days', terms.amount === 1_000_000_000n && terms.lockDays === 30);
  const rows = await sb.listPools(); check('listPools: the 5 demo pools, verified, with mints and tiers', rows.length === 5 && rows.every((r) => r.status === 'verified' && r.mintX && r.tier && typeof r.tier.feePips === 'number'), JSON.stringify(rows[0]).slice(0, 160));
  const T = sb.tokens; const ck = await sb.checkToken(T.JUP.mint); const bad = await sb.checkToken(Keypair.generate().publicKey.toBase58());
  check('checkToken: a demo token ok (info.symbol), an empty address NOT_A_TOKEN', ck.ok && ck.info.symbol === 'JUP' && ck.info.listed && !bad.ok && bad.reasons[0].code === 'NOT_A_TOKEN');
  const t20 = tiers.find((t) => t.binStep === 20).id; const jupSol = rows.find((r) => r.id === 'jup-sol');
  check('poolFor: an existing pair at its tier, either order; null at another tier', (await sb.poolFor(T.SOL.mint, T.JUP.mint, t20)) === jupSol.address && (await sb.poolFor(T.JUP.mint, T.SOL.mint, t20)) === jupSol.address && (await sb.poolFor(T.JUP.mint, T.SOL.mint, 0)) === null);
  check('createPool: BAD_TIER, BAD_PRICE, POOL_EXISTS', (await code(sb.createPool({ mintA: T.JUP.mint, mintB: T.USDC.mint, tierId: 42, price: 1 }), 'BAD_TIER')) === true && (await code(sb.createPool({ mintA: T.JUP.mint, mintB: T.USDC.mint, tierId: t20, price: 0 }), 'BAD_PRICE')) === true
    && (await code(sb.createPool({ mintA: T.JUP.mint, mintB: T.SOL.mint, tierId: t20, price: 0.003 }), 'POOL_EXISTS')) === true);
  check('createPool without SOL for the bond: BOND_LOW', (await code(sb.createPool({ mintA: T.JUP.mint, mintB: T.USDC.mint, tierId: t20, price: 0.3 }), 'BOND_LOW')) === true);
  await sb.faucet(); const sol0 = await sb.solBalance();
  const made = await sb.createPool({ mintA: T.JUP.mint, mintB: T.USDC.mint, tierId: t20, price: 0.3 });
  const row = (await sb.listPools({ fresh: true })).find((r) => r.address === made.address);
  check('createPool (mints, price B per A) -> { tx, address }; bond paid; listed unverified with tier, creator, createdAt', made.tx && row && row.status === 'unverified' && row.tier.binStep === 20 && row.tier.feePips === 2500 && row.creator === sb.account && row.createdAt > 0 && sol0 - (await sb.solBalance()) === 1_000_000_000n, JSON.stringify(row).slice(0, 200));
  const st = await sb.poolState(made.address, 1); const px = sb.humanPrice(st, st.active); const jupIsX = st.x === 'JUP';
  check('canonical order and the price inverted when the mints swap: 0.3 USDC per JUP at bin 0', Math.abs((jupIsX ? px : 1 / px) - 0.3) < 1e-9 && st.tier.id === t20 && st.status === 'unverified' && st.protocolFeeBps === 20 && st.protocolShare === 0, st.x + ' ' + px);
  const b = await sb.bond(made.address); check('bond: amount, creator, lockedUntil (unix s), releasable false', b.amount === 1_000_000_000n && b.creator === sb.account && b.lockedUntil > Date.now() / 1000 + 29 * 86400 && !b.releasable);
  check('releaseBond during the lock: BOND_LOCKED', (await code(sb.releaseBond(made.address), 'BOND_LOCKED')) === true);
  sb.chain.bonds.get(made.address).unlockAt = BigInt(Math.floor(Date.now() / 1000) - 1);
  const rel = await sb.releaseBond(made.address); check('after the lock: releaseBond -> { tx }; bond back; bond() null; status verified', rel.tx && (await sb.solBalance()) === sol0 && (await sb.bond(made.address)) === null && (await sb.listPools({ fresh: true })).find((r) => r.address === made.address).status === 'verified');
  await sb.addLiquidity(row, { priv: false, lo: st.active - 5, hi: st.active + 5, shape: 'spot', amountX: jupIsX ? 1000 : 300, amountY: jupIsX ? 300 : 1000 });
  const q = await sb.quoteRoute(T.JUP.mint, 'USDC', sb.unit('JUP', '10')); const amt = sb.unit('JUP', '10');
  check('quoteRoute with a mint and a symbol: lpFee + protocolFee (0.2% of each hop\'s input, a second hop\'s converted) in input atoms, path feePips / volatilityPips', q && (q.path.length === 1 ? q.protocolFee === S.protocolFeeOf(amt) : q.protocolFee > S.protocolFeeOf(amt) && q.protocolFee <= 2n * S.protocolFeeOf(amt) + 2n) && q.lpFee > 0n && q.path.some((h) => h.feePips >= 500 && h.volatilityPips >= 0), q && JSON.stringify({ lp: String(q.lpFee), pr: String(q.protocolFee), path: q.path.map((h) => h.name + ' ' + h.feePips + '/' + h.volatilityPips) }));
  const pub = await sb.swapPublic(T.JUP.mint, T.USDC.mint, '5'); check('swapPublic keyed by mints', pub.out > 0n);
  check('publicBalance / privateBalance / fmt take a mint', (await sb.publicBalance(T.USDC.mint)) === (await sb.publicBalance('USDC')) && sb.privateBalance(T.SOL.mint) === sb.privateBalance('SOL') && sb.fmt(T.SOL.mint, 10n ** 9n) === 1);
  const zp = await sb.planZapPreview(row, { xIn: true, amount: 10, lo: st.active - 3, hi: st.active + 3 }); check('planZapPreview: lpFee + protocolFee of its swapped part', zp.protocolFee > 0n && zp.lpFee > 0n, String(zp.protocolFee));
  const json = sb.chain.toJSON(); const ch2 = new sb.chain.constructor({ tokens: Object.values(sb.chain.tokens), pools: sb.chain.poolCfg, verify: async () => ({ ok: true }) }); ch2.load(JSON.parse(JSON.stringify(json, (k, v) => (typeof v === 'bigint' ? v.toString() : v)), (k, v) => v));
  check('persistence: a listed pool survives a reload of the chain state', ch2.pools.has(made.address) && ch2.pools.get(made.address).cfg.user);
  sb.stop();
}

async function onChain() {
  console.log('\n-- local validator');
  const { rpc, conn, payer, payerFile, done } = await freshValidator('veyl-poolsapi-');
  try {
    const [alice, bob, relayerKp] = await funded(conn, 3, 50);
    const poor = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(poor.publicKey, LAMPORTS_PER_SOL / 2), 'confirmed');
    const { deployAll, fund, units } = require('../scripts/lib.js');
    const { V, dep, T } = await deployAll({ rpc, payerFile, relayer: relayerKp.publicKey, bond: { lamports: LAMPORTS_PER_SOL, lockSeconds: 30 } });
    console.log('deployed in', lap());
    // three new mints: a plain SPL token, a Token-2022 one with metadata (allowed), a Token-2022 one with a transfer fee (refused)
    const NEWT = await spl.createMint(conn, payer, payer.publicKey, null, 6, undefined, { commitment: 'confirmed' });
    const T22 = spl.TOKEN_2022_PROGRAM_ID; const meta = Keypair.generate(); const len = spl.getMintLen([spl.ExtensionType.MetadataPointer]);
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: meta.publicKey, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len), programId: T22 }),
      spl.createInitializeMetadataPointerInstruction(meta.publicKey, payer.publicKey, meta.publicKey, T22), spl.createInitializeMintInstruction(meta.publicKey, 9, payer.publicKey, null, T22)), [payer, meta], { commitment: 'confirmed' });
    await spl.tokenMetadataInitializeWithRentTransfer(conn, payer, meta.publicKey, payer.publicKey, payer, 'Meta Coin', 'META', 'https://example.invalid/meta.json', undefined, { commitment: 'confirmed' }, T22);
    const fee = Keypair.generate(); const flen = spl.getMintLen([spl.ExtensionType.TransferFeeConfig]);
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: fee.publicKey, space: flen, lamports: await conn.getMinimumBalanceForRentExemption(flen), programId: T22 }),
      spl.createInitializeTransferFeeConfigInstruction(fee.publicKey, payer.publicKey, payer.publicKey, 50, 1_000_000n, T22), spl.createInitializeMintInstruction(fee.publicKey, 6, payer.publicKey, null, T22)), [payer, fee], { commitment: 'confirmed' });
    const cfg = { chainName: 'Local', rpc, programs: dep.programs, lookupTable: dep.lookupTable, lookupTables: dep.lookupTables, relayer: 'http://127.0.0.1:1', tokens: dep.tokens, feeTiers: dep.feeTiers,
      binPools: dep.binPools.map((b) => ({ id: b.id, x: b.x, y: b.y, bs: b.binStep, base: b.baseFee / 1e4, address: b.address })) };
    const engineFor = async (kp) => { const e = new E.Engine(JSON.parse(JSON.stringify(cfg))); const sign = (tx) => { if (tx.version !== undefined) tx.sign([kp]); else tx.partialSign(kp); return tx; };
      await e.connect({ name: 'test', publicKey: kp.publicKey, connect: async () => ({ publicKey: kp.publicKey }), signTransaction: async (tx) => sign(tx), signAllTransactions: async (txs) => txs.map(sign) }); return e; };
    const e = await engineFor(alice); const logs = []; e.onLog = (m) => logs.push(m);
    const USDC = T.USDC.mint.toBase58(), SOL = T.SOL.mint.toBase58(), N = NEWT.toBase58(), M = meta.publicKey.toBase58(), F = fee.publicKey.toBase58();

    const tiers = await e.listTiers(); const want = { 1: 100, 5: 500, 10: 500, 20: 2500, 30: 3000, 50: 5000, 80: 10000, 100: 20000 };
    check('listTiers from the factory: 8 tiers, the owner\'s fees, labels and categories', tiers.length === 8 && tiers.every((t) => want[t.binStep] === t.feePips && t.label && t.category), tiers.map((t) => t.label).join(', '));
    const terms = await e.bondTerms(); check('bondTerms from the factory: { amount: 1 SOL (bigint), lockDays }', terms.amount === BigInt(LAMPORTS_PER_SOL) && Math.abs(terms.lockDays - 30 / 86400) < 1e-9);
    const iu = await e.tokenInfo(USDC), im = await e.tokenInfo(M), inn = await e.tokenInfo(N);
    check('tokenInfo: a listed token (its symbol, spl, listed)', iu.symbol === 'USDC' && iu.decimals === 6 && iu.program === 'spl' && iu.listed, JSON.stringify(iu));
    check('tokenInfo: Token-2022 metadata (symbol, name, token2022, not listed)', im.symbol === 'META' && im.name === 'Meta Coin' && im.decimals === 9 && im.program === 'token2022' && !im.listed, JSON.stringify(im));
    check('tokenInfo: a plain mint (short mint as symbol); registered: tok / fmt by mint', inn.symbol === N.slice(0, 4) + '…' + N.slice(-4) && e.tok(N).decimals === 6 && e.fmt(N, 2_000_000n) === 2);
    check('tokenInfo of nothing: NOT_FOUND', (await code(e.tokenInfo(Keypair.generate().publicKey), 'NOT_FOUND')) === true);
    const cN = await e.checkToken(N), cM = await e.checkToken(M), cF = await e.checkToken(F), cX = await e.checkToken(Keypair.generate().publicKey.toBase58()), cB = await e.checkToken('nope');
    check('checkToken: plain SPL ok; Token-2022 with metadata ok', cN.ok && cM.ok && cM.info.symbol === 'META');
    check('checkToken: Token-2022 with a transfer fee refused, in plain words (EXT_TRANSFER_FEE_CONFIG)', !cF.ok && cF.reasons.some((r) => r.code === 'EXT_TRANSFER_FEE_CONFIG' && /fee on every transfer/.test(r.text)), JSON.stringify(cF.reasons));
    check('checkToken: no mint there (NOT_A_TOKEN), not an address (BAD_ADDRESS)', !cX.ok && cX.reasons[0].code === 'NOT_A_TOKEN' && !cB.ok && cB.reasons[0].code === 'BAD_ADDRESS');
    const t10 = tiers.find((t) => t.binStep === 10).id, t20 = tiers.find((t) => t.binStep === 20).id, t50 = tiers.find((t) => t.binStep === 50).id;
    const solUsdc = dep.binPools.find((b) => b.id === 'sol-usdc').address;
    check('poolFor: the deployment\'s SOL-USDC at its tier, either order; null for a new pair', (await e.poolFor(USDC, SOL, t10)) === solUsdc && (await e.poolFor(SOL, USDC, t10)) === solUsdc && (await e.poolFor(N, USDC, t20)) === null);

    check('createPool: BAD_TIER (no such tier)', (await code(e.createPool({ mintA: N, mintB: USDC, tierId: 77, price: 2.5 }), 'BAD_TIER')) === true);
    check('createPool: BAD_PRICE (zero, NaN)', (await code(e.createPool({ mintA: N, mintB: USDC, tierId: t20, price: 0 }), 'BAD_PRICE')) === true && (await code(e.createPool({ mintA: N, mintB: USDC, tierId: t20, price: 'x' }), 'BAD_PRICE')) === true);
    check('createPool: TOKEN_REFUSED (transfer-fee token; same mint twice)', (await code(e.createPool({ mintA: F, mintB: USDC, tierId: t20, price: 1 }), 'TOKEN_REFUSED')) === true && (await code(e.createPool({ mintA: N, mintB: N, tierId: t20, price: 1 }), 'TOKEN_REFUSED')) === true);
    check('createPool: POOL_EXISTS (the deployment\'s pair at its tier)', (await code(e.createPool({ mintA: SOL, mintB: USDC, tierId: t10, price: 150 }), 'POOL_EXISTS')) === true);
    const ep = await engineFor(poor); check('createPool: BOND_LOW (a wallet with 0.5 SOL)', (await code(ep.createPool({ mintA: N, mintB: USDC, tierId: t20, price: 2.5 }), 'BOND_LOW')) === true);

    const sol0 = BigInt(await conn.getBalance(alice.publicKey)); logs.length = 0;
    const made = await e.createPool({ mintA: N, mintB: USDC, tierId: t20, price: 2.5 }); const addr = new PublicKey(made.address);
    const [cx, cy, flipped] = S.canonicalPair(N, USDC); const bp = await V.binPool(addr); const spent = sol0 - BigInt(await conn.getBalance(alice.publicKey));
    check('createPool -> { tx, address }: the canonical pair at the tier\'s bin step, created by the wallet', made.tx && addr.equals(V.binPoolPda(cx, cy, 20)) && bp && bp.mintX.equals(cx) && bp.binStep === 20 && bp.baseFee === 2500 && bp.protocolFeeBps === 20, flipped ? 'flipped' : 'in order');
    check('the creator paid the 1 SOL bond and the rent; the action runner steps were logged', spent > BigInt(LAMPORTS_PER_SOL) && spent < BigInt(LAMPORTS_PER_SOL) + 50_000_000n && logs.includes('Confirm in your wallet') && logs.some((l) => /^Sending/.test(l)), logs.join(' | '));
    const st = await e.poolState(made.address, 1); const px = e.humanPrice(st, 0); const want25 = flipped ? 1 / 2.5 : 2.5;
    check('opening price: 2.5 USDC per NEWT at bin 0, inverted when NEWT sorts second; decimals applied', Math.abs(px / want25 - 1) < 1e-9, st.x === 'USDC' ? 'x = USDC' : 'x = NEWT', px);
    check('poolState: tier, status unverified, protocolFeeBps 20, protocolShare 0', st.tier.id === t20 && st.tier.feePips === 2500 && st.status === 'unverified' && st.protocolFeeBps === 20 && st.protocolShare === 0);
    const tpN = spl.TOKEN_PROGRAM_ID; const vaults = await conn.getMultipleAccountsInfo([V.ata(NEWT, V.signerPda(), tpN), V.shieldVault(NEWT, tpN)]);
    check('the new token\'s entry vault and shielded vault exist (made in the same flow)', vaults.every(Boolean));
    check('createPool again: POOL_EXISTS', (await code(e.createPool({ mintA: USDC, mintB: N, tierId: t20, price: 0.4 }), 'POOL_EXISTS')) === true);
    check('poolFor finds it (either order)', (await e.poolFor(USDC, N, t20)) === made.address);

    let rows = await e.listPools(); let row = rows.find((r) => r.address === made.address);
    check('listPools: the deployment\'s 5 verified + the new one unverified (tier, creator, createdAt ms, mints canonical)', rows.length === 6 && rows.filter((r) => r.status === 'verified').length === 5 && row && row.status === 'unverified' && row.tier.id === t20 && row.creator === alice.publicKey.toBase58() && row.createdAt > Date.now() - 600_000 && row.mintX === cx.toBase58() && row.mintY === cy.toBase58(), JSON.stringify(row).slice(0, 240));
    check('listPools rows: x / y keys work with tok / fmt / humanPrice; stable id', e.tok(row.x).mint === row.mintX && e.fmt(row.y, 10n ** BigInt(e.tok(row.y).decimals)) === 1 && /-20$/.test(row.id), row.id);
    check('poolCount: 6 pools on chain', (await e.poolCount()) === 6);
    const b = await e.bond(made.address); check('bond: { amount 1 SOL, creator, lockedUntil, releasable false }', b && b.amount === BigInt(LAMPORTS_PER_SOL) && b.creator === alice.publicKey.toBase58() && b.lockedUntil > Date.now() / 1000 - 5 && !b.releasable && b.mine);
    const eb = await engineFor(bob); check('releaseBond: BOND_LOCKED during the lock; NOT_CREATOR for another wallet', (await code(e.releaseBond(made.address), 'BOND_LOCKED')) === true && (await code(eb.releaseBond(made.address), 'NOT_CREATOR')) === true);

    // liquidity in the new pool (the SDK, alice), then the quote breakdown against the chain's own quote
    await fund(conn, payer, NEWT, alice.publicKey, units(10_000, 6)); await fund(conn, payer, T.USDC.mint, alice.publicKey, units(10_000, 6));
    const as = new S.Veyl({ connection: conn, programs: V.programs, payer: alice }); const a = bp.activeId; const ids = []; for (let i = a - 5; i <= a + 5; i++) ids.push(i);
    const xIsN = bp.mintX.equals(NEWT); const ax = units(xIsN ? 4000 : 4000 * 2.5, 6), ay = units(xIsN ? 4000 * 2.5 : 4000, 6); const w = S.shapeWeights(ids, a, 'spot');
    const owner = Keypair.generate().publicKey; await as.send(await as.ensureBinAccountsIxs(alice.publicKey, addr, ids, owner, alice.publicKey));
    await as.send([await as.mintIx(alice.publicKey, addr, { owner, authority: alice.publicKey, ids, amountsX: S.distribute(ax, w.weightsX), amountsY: S.distribute(ay, w.weightsY) })], [], 1_400_000);
    const amt = units(10, 6); const q = await e.quoteRoute(N, 'USDC', amt); const onchain = await V.quote(addr, xIsN, amt);
    check('quoteRoute (mint in, symbol out): out == the program\'s quote; protocolFee = 0.2% of the input; lpFee = fee - protocolFee', q && q.out === onchain.out && q.protocolFee === S.protocolFeeOf(amt) && q.lpFee + q.protocolFee === onchain.fee, q && JSON.stringify({ out: String(q.out), chain: String(onchain.out), lp: String(q.lpFee), pr: String(q.protocolFee), fee: String(onchain.fee) }));
    check('quoteRoute path entry: name, feePips (2500), volatilityPips', q.path.length === 1 && q.path[0].feePips === 2500 && q.path[0].volatilityPips >= 0 && /USDC/.test(q.path[0].name), JSON.stringify(q.path[0]));
    const usdc0 = await V.tokenBalance(T.USDC.mint, alice.publicKey); const sw = await e.swapPublic(N, USDC, '10');
    check('swapPublic keyed by mints through the new pool', sw.tx && (await V.tokenBalance(T.USDC.mint, alice.publicKey)) - usdc0 >= (q.out * 98n) / 100n);
    check('publicBalance by mint', (await e.publicBalance(N)) === (await V.tokenBalance(NEWT, alice.publicKey)));

    // a Token-2022 pool, then delisted by the factory authority
    const madeM = await e.createPool({ mintA: M, mintB: SOL, tierId: t50, price: 0.01 });
    const tpM = await V.tokenProgram(meta.publicKey); const vM = await conn.getMultipleAccountsInfo([V.ata(meta.publicKey, V.signerPda(), tpM), V.shieldVault(meta.publicKey, tpM)]);
    check('createPool with a Token-2022 token: its vaults use the Token-2022 program', tpM.equals(T22) && vM.every(Boolean) && !!(await V.binPool(new PublicKey(madeM.address))));
    await V.send([await V.delistPoolIx(payer.publicKey, new PublicKey(madeM.address))]);
    rows = await e.listPools({ fresh: true }); const all = await e.listPools({ includeDelisted: true });
    check('delisted: left out of listPools, listed with includeDelisted as delisted; its bond is gone', !rows.some((r) => r.address === madeM.address) && all.find((r) => r.address === madeM.address).status === 'delisted' && (await e.bond(madeM.address)) === null);

    // the relayer finds the new pools
    const { Relayer } = require('../relayer/relayer.js');
    const r = new Relayer({ connection: conn, wallet: relayerKp, deploy: { ...dep, tokens: Object.fromEntries(Object.entries(dep.tokens).map(([k, t]) => [k, { ...t, price: k === 'SOL' ? 150 : k === 'USDC' || k === 'USDT' ? 1 : t.price || 0.5 }])) } });
    const pools = await r.binPools(); const rp = pools.find((p) => p.address === made.address);
    check('relayer /pools: the new pools too, with tier, status and protocolFeeBps (no protocolShare)', pools.length === 7 && rp && rp.discovered && rp.tier.binStep === 20 && rp.status === 'unverified' && rp.protocolFeeBps === 20 && rp.protocolShare === 0 && pools.find((p) => p.address === madeM.address).status === 'delisted', JSON.stringify(rp && { s: rp.status, t: rp.tier }));
    const fq = await r.feeQuote({ kind: 'transact', mint: N });
    check('relayer fee in a new token: valued through its deep pool against USDC (fee > 0, includes its fee account\'s rent)', BigInt(fq.fee) > 0n && fq.sym === N, JSON.stringify(fq));
    check('relayer fee in a new token without a deep priced pool: refused', await refused(r.feeQuote({ kind: 'transact', mint: M }), /cannot value/));

    // the lock ends: verified, bond released to the creator
    { const ub = await e.bond(made.address); await sleep(Math.max(0, ub.lockedUntil * 1000 - Date.now()) + 3000); } const solB = BigInt(await conn.getBalance(alice.publicKey)); const rel = await e.releaseBond(made.address);
    check('after the lock: releaseBond -> { tx }; 1 SOL (+ rent) back; bond() null', rel.tx && BigInt(await conn.getBalance(alice.publicKey)) - solB > BigInt(LAMPORTS_PER_SOL) - 10_000n && (await e.bond(made.address)) === null);
    check('status verified once the bond is released', (await e.listPools({ fresh: true })).find((x) => x.address === made.address).status === 'verified' && (await e.poolState(made.address, 1)).status === 'verified');
  } catch (err) { console.error(err); check('no unexpected error', false, err.message); }
  finish(done, { cu: false });
}

(async () => { try { await sandbox(); } catch (err) { console.error(err); check('sandbox: no unexpected error', false, err.message); }
  if (process.env.SANDBOX_ONLY) return finish(null, { cu: false }); await onChain(); })();
