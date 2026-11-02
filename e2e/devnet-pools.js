#!/usr/bin/env node
// Devnet proof: an ordinary wallet lists a pool (permissionless, 1 SOL bond) of a brand-new token against devnet USDC, it
// trades with the 0.2% protocol fee, the new token works for the private flows (shielded deposit admitted by the publisher,
// a shielded swap into USDC through the new pool, private withdrawals), then the authority delists it (bond to the treasury).
//   RPC_URL=<dedicated devnet RPC> node e2e/devnet-pools.js
// (keys: DEPLOYER_KEYPAIR, RELAYER_KEY, POSTMAN_KEY, default ~/keys/veyl/devnet-*.json; a relayer with the approved-set
// publisher runs here on RELAYER_PORT (8857); costs ~0.12 devnet SOL (deployer) + ~0.01 (relayer), the bond comes back to the treasury on delist)
// Per-token setup a new mint needs for the shielded pool (no authority involved, anyone may pay): the shielded vault (the
// ATA of the shield PDA) before any deposit, the entry vault (veyl_entry init_vault: the ATA of the entry's signer PDA)
// before a swap / liquidity through it; the relayer makes its own fee account in the transaction that pays it.
'use strict';
const path = require('path'); const os = require('os'); const ROOT = path.join(__dirname, '..'); const fs = require('fs'); const { spawn } = require('child_process');
const { Keypair, PublicKey, Connection, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require(ROOT + '/node_modules/@solana/web3.js'); const spl = require(ROOT + '/node_modules/@solana/spl-token');
const S = require(ROOT + '/sdk/veyl.js'); const { Veyl } = S; const Z = require(ROOT + '/sdk/shield.js'); const { proveTransact } = require(ROOT + '/sdk/prover.js'); const { createMint, fund, units, priceQ, readKey } = require(ROOT + '/scripts/lib.js');
let pass = 0, fail = 0; const check = (name, ok, note = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? '  ' + note : ''}`); };
const refused = async (p, re) => { try { await p; return false; } catch (e) { return re.test(String(e.message || e) + JSON.stringify(e.logs || e.transactionLogs || '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const until = async (fn, ms, step = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; };
const KEYS = path.join(os.homedir(), 'keys/veyl'); const keyFile = (env, name) => process.env[env] || path.join(KEYS, 'devnet-' + name + '.json');
const REL = 'http://127.0.0.1:' + Number(process.env.RELAYER_PORT || 8857); let rel = null; process.on('exit', () => { if (rel) rel.kill(); });
const post = async (route, body) => (await fetch(REL + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: S.j(body) })).json();
const pt = (pr) => ({ proof: pr.proof.toString('base64'), pubs: pr.pubs.map(String) });
(async () => {
  if (!process.env.RPC_URL) { console.error('Set RPC_URL to a dedicated devnet RPC.'); process.exit(2); } const conn = new Connection(process.env.RPC_URL, 'confirmed'); if ((await conn.getGenesisHash()) !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') { console.error('Not devnet.'); process.exit(2); } const dep = JSON.parse(fs.readFileSync(ROOT + '/deploy.devnet.json', 'utf8'));
  const programs = Object.fromEntries(Object.entries(dep.programs).map(([k, v]) => [k, new PublicKey(v)])); const USDC = new PublicKey(dep.tokens.USDC.mint);
  const deployer = readKey(keyFile('DEPLOYER_KEYPAIR', 'deployer')); const relayerFile = keyFile('RELAYER_KEY', 'relayer'), postmanFile = keyFile('POSTMAN_KEY', 'postman'); const relayer = readKey(relayerFile), postman = readKey(postmanFile); const me = relayer.publicKey;
  const user = Keypair.generate(); fs.writeFileSync(path.join(os.tmpdir(), 'veyl-devnet-pools-user.json'), JSON.stringify(Array.from(user.secretKey)), { mode: 0o600 });
  const V = new Veyl({ connection: conn, programs, payer: deployer }); const U = new Veyl({ connection: conn, programs, payer: user }); V.lookupTable = U.lookupTable = new PublicKey(dep.lookupTable); V.lookupExtra = U.lookupExtra = (dep.lookupTables || []).map((k) => new PublicKey(k));
  const sol = async (k) => BigInt(await conn.getBalance(k)); const d0 = await sol(deployer.publicKey), r0 = await sol(me), m0 = await sol(postman.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: user.publicKey, lamports: 1.3 * LAMPORTS_PER_SOL })), [deployer]);
  const f = await V.factory(); const tier = await V.tierIndex(30); const BOND = f.bondLamports;
  check('devnet factory: permissionless listing with a 1 SOL bond, 30-day lock, 0.2% protocol fee, tier for bin step 30', BOND === 1_000_000_000n && Number(f.bondLock) === 30 * 86400 && f.protocolFeeBps === 20 && tier >= 0, `tier ${tier}`);
  // a brand-new token (not in deploy.devnet.json) against devnet USDC; opened at bin 30 (price ~1 there) so the liquidity sits in one bin array
  const NEW = await createMint(conn, deployer, 6); const [x, y] = S.canonicalPair(NEW, USDC); const pool = V.binPoolPda(x, y, 30); const A = 30; const newIsX = x.equals(NEW);
  const u0 = await sol(user.publicKey);
  await U.send([await U.createPoolIx(user.publicKey, x, y, tier, priceQ(1 / 1.003 ** A, 6, 6), A)]);
  const p = await V.binPool(pool); const bond = await V.bond(pool); const u1 = await sol(user.publicKey);
  check('an ordinary wallet lists NEW/USDC on devnet (NEW: a mint made now): pool at the chosen tier, 0.2% protocol fee, not delisted', !!p && p.binStep === 30 && p.feeTier === tier && p.protocolFeeBps === 20 && !p.delisted && p.activeId === A, pool.toBase58() + ' NEW ' + NEW.toBase58());
  check('the creator paid the 1 SOL bond into the pool\'s bond account, locked for 30 days', bond && bond.creator.equals(user.publicKey) && bond.amount === BOND && Number(bond.unlockAt - bond.createdAt) === 30 * 86400, `paid ${(Number(u0 - u1) / 1e9).toFixed(4)} SOL incl. rent`);
  check('the same pair at the same tier cannot be listed twice', await refused(V.send([await V.createPoolIx(deployer.publicKey, x, y, tier, priceQ(1, 6, 6), 0)]), /already in use|0x0/));
  check('the reversed pair is refused (canonical mint order)', await refused(V.send([await V.createPoolIx(deployer.publicKey, y, x, tier, priceQ(1, 6, 6), 0)]), /MintOrder/));
  check('the bond cannot be released before its lock', await refused(U.send([U.releaseBondIx(user.publicKey, pool)]), /BondLocked/));
  check('nobody but the creator can release the bond', await refused(V.send([V.releaseBondIx(deployer.publicKey, pool)]), /NotAuthority|ConstraintHasOne|ConstraintSeeds|BondLocked/));

  // ---- private flows for the new token: a relayer with the approved-set publisher, run here against devnet
  rel = spawn('node', [path.join(ROOT, 'relayer/relayer.js')], { env: { ...process.env, PORT: new URL(REL).port, RPC_URL: process.env.RPC_URL, DEPLOY_FILE: path.join(ROOT, 'deploy.devnet.json'), RELAYER_KEY: relayerFile, POSTMAN_KEY: postmanFile, ADMIT_INTERVAL_MS: '4000', ASP_INTERVAL_MS: '3600000', SEALED_CRANK: '0' }, stdio: ['ignore', 'inherit', 'inherit'] });
  await until(async () => { try { return (await fetch(REL + '/health')).ok; } catch { return false; } }, 90000, 1000);
  const health = await (await fetch(REL + '/health')).json(); check('relayer + approved-set publisher up against devnet', health.network === 'devnet' && health.relayer === me.toBase58() && health.publisher, JSON.stringify(health).slice(0, 140));
  const q0 = await post('/fee', { kind: 'transact', mint: NEW });
  check('before any liquidity the relayer refuses a fee in NEW (it cannot value it: no pool of it against a priced token is deep enough)', /cannot value/.test(q0.error || ''), String(q0.error || JSON.stringify(q0)).slice(0, 120));
  // 1. per-token setup, by the ordinary wallet: nothing exists for NEW yet; a deposit is refused until the shielded vault is there
  const EP = V.signerPda(); const shieldVault = V.shieldVault(NEW), entryVault = V.ata(NEW, EP); const exists = async (a) => !!(await conn.getAccountInfo(a));
  check('NEW has no shielded vault (ATA of the shield PDA), no entry vault (ATA of the entry signer) and no relayer fee account yet', !(await exists(shieldVault)) && !(await exists(entryVault)) && !(await exists(V.ata(NEW, me))));
  const mints = { [NEW.toBase58()]: { sym: 'NEW', decimals: 6 }, [USDC.toBase58()]: { sym: 'USDC', decimals: 6 } }; const w = new Z.ShieldWallet(require('crypto').randomBytes(32), { mints, pools: [] });
  const scan = async () => { const st = await V.readShield(); st.tree = new Z.Tree(st.leaves); w.scan(st); return st; };
  await fund(conn, deployer, NEW, user.publicKey, units(11_000, 6)); await fund(conn, deployer, USDC, user.publicKey, units(10_000, 6));
  const DEP = units(1_000, 6); await scan(); const d = w.deposit(NEW, DEP); const pd = await proveTransact(d.input);
  await U.send([U.postProofIx(user.publicKey, Z.KIND.TRANSACT, pd.proof, pd.pubs)], [], 1_400_000); const next0 = (await V.shield()).nextIndex;
  check('a shielded deposit of NEW is refused while its shielded vault does not exist (AccountNotInitialized on `vault`, veyl_pool ShieldDeposit)', await refused(U.send([await U.shieldDepositIx(user.publicKey, d.ext, pd.pubs)], [], 600_000), /AccountNotInitialized|3012/));
  const us0 = await sol(user.publicKey);
  await U.send([spl.createAssociatedTokenAccountIdempotentInstruction(user.publicKey, shieldVault, V.shieldPda(), NEW), await U.initVaultIx(user.publicKey, NEW)]);
  check('setup by the ordinary wallet (no authority): shielded vault = an idempotent ATA create for the shield PDA, entry vault = veyl_entry init_vault', (await exists(shieldVault)) && (await exists(entryVault)), `${(Number(us0 - (await sol(user.publicKey))) / 1e9).toFixed(5)} SOL rent + fee`);
  // 2. the deposit (same posted proof), admitted by the publisher, decrypted with the wallet's viewing key
  await U.send([await U.shieldDepositIx(user.publicKey, d.ext, pd.pubs)], [], 600_000);
  const pend = (await V.readShield()).pending.find((q) => q.depositor.equals(user.publicKey));
  check('shielded deposit of 1,000 NEW: it waits outside the tree (depositor, mint and amount public), the vault holds it', !!pend && pend.amount === DEP && pend.mint.equals(NEW) && (await V.tokenBalance(NEW, V.shieldPda())) === DEP);
  const admitted = await until(async () => !(await V.readShield()).pending.some((q) => q.depositor.equals(user.publicKey)), 180000);
  const st1 = await scan(); const mine = w.notes.filter((n) => !n.spent && n.mint === NEW.toBase58() && BigInt(n.amount) > 0n);
  check('the relayer\'s publisher admits it: both commitments in the tree; the NEW note decrypts with the viewing key (1,000 NEW)', admitted && st1.leaves.map(String).includes(String(d.commitments[0])) && w.balance(NEW) === DEP && mine.length === 1, `tree ${next0} -> ${(await V.shield()).nextIndex}`);

  // liquidity from the creator, a swap from someone else: the protocol fee is 0.2% of the input on top of the LP fee
  const ids = [A - 2, A - 1, A, A + 1, A + 2]; await U.send(await U.ensureBinAccountsIxs(user.publicKey, pool, ids, user.publicKey, user.publicKey), [], 400_000); await U.send([await U.mintIx(user.publicKey, pool, { ids, amountsX: ids.map((i) => (i >= A ? units(1_000, 6) : 0n)), amountsY: ids.map((i) => (i <= A ? units(1_000, 6) : 0n)) })], [], 1_400_000);
  await fund(conn, deployer, x, deployer.publicKey, units(1_000, 6)); await fund(conn, deployer, y, deployer.publicKey, units(1_000, 6));
  const b0 = await V.binPool(pool); const amt = units(100, 6); await V.send([await V.swapIx(deployer.publicKey, pool, true, amt)], [], 1_400_000); const b1 = await V.binPool(pool);
  const want = (amt * 20n + 9_999n) / 10_000n;
  check('a swap through the new pool pays exactly 0.2% protocol fee (ceil) on top of the LP fee', b1.protocolFeeX - b0.protocolFeeX === want && b1.totalFeeX - b0.totalFeeX > want, `${b1.protocolFeeX - b0.protocolFeeX} atoms of ${amt}`);

  // 3. a shielded swap NEW -> USDC through the new pool. The relayer's fee is paid in the input token (the spent leg) by
  // design, so NEW must be valued (REVIEW.md M-8: from its pool against USDC, >= $1,000 within 5% of the active bin, 50% haircut)
  let qs = {}; const valued = await until(async () => { qs = await post('/fee', { kind: 'shieldSwap', mint: NEW }); return !qs.error && BigInt(qs.fee) > 0n; }, 200000, 10000);
  check('once seeded (3,000 USDC within the band) the relayer values NEW and quotes a shielded swap fee in NEW', valued, JSON.stringify(qs).slice(0, 160));
  const lpN = await post('/fee', { kind: 'shieldLp', mint: NEW, legs: 1, core: { binPool: pool.toBase58(), lo: 3000 } }), lpU = await post('/fee', { kind: 'shieldLp', mint: USDC, legs: 1, core: { binPool: pool.toBase58(), lo: 3000 } });
  check('M-8 caps: a request costing the relayer > 0.03 SOL (new bin arrays) is refused in NEW ("pay the fee in a listed token"), the same in USDC is quoted', /listed token/.test(lpN.error || '') && !lpU.error && BigInt(lpU.fee) > 0n, String(lpN.error || '').slice(0, 90));
  const IN = units(300, 6); const feeS = BigInt(qs.fee); const q = await V.quoteLocal(pool, newIsX, IN); const ot = w.nextOneTime();
  const core = { tokenOut: USDC, routes: await V.prepareRoutes([{ amountIn: IN, hops: [{ pool, xForY: newIsX }] }]), minOut: q.out - q.out / 100n, receiptOwner: ot.pk, receiptBlinding: ot.blinding, deadline: Math.floor(Date.now() / 1000) + 900 };
  const ts = w.spend({ mint: NEW, pay: IN, fee: feeS, recipient: entryVault, relayer: V.ata(NEW, me), processor: EP, action: Z.swapAction(core) }); const ps = await proveTransact(ts.input);
  const sv0 = await V.tokenBalance(USDC, V.shieldPda()); const rs = await post('/submit', { kind: 'shieldSwap', core, leg: { ext: ts.ext, p: pt(ps) } });
  const ev = rs.txHash && (await V.events(rs.txHash)).find((e) => e.name === 'ShieldSwapped'); await scan();
  check('shielded swap of 300 NEW -> USDC through the new pool: a hidden USDC receipt note (decrypted), fee paid in NEW', !!ev && ev.amountOut >= core.minOut && w.balance(USDC) === ev.amountOut && w.balance(NEW) === DEP - IN - feeS && (await V.tokenBalance(USDC, V.shieldPda())) - sv0 === ev.amountOut, ev ? `${Number(ev.amountOut) / 1e6} USDC out, fee ${Number(feeS) / 1e6} NEW` : String(rs.error || JSON.stringify(rs)).slice(0, 300));
  check('the relayer made its own NEW fee account in that transaction and holds exactly the fee', (await V.tokenBalance(NEW, me)) === feeS);
  // 4. private withdrawals to fresh public addresses: the USDC received, then NEW
  const out = async (mint, payAmt, fee, to) => { const recipient = V.ata(mint, to); const t = w.spend({ mint, pay: payAmt, fee, recipient, relayer: V.ata(mint, me) }); const pr = await proveTransact(t.input); return post('/submit', { kind: 'transact', ext: t.ext, p: pt(pr), recipientOwner: to.toBase58() }); };
  const feeOf = async (mint, to) => { const r = await post('/fee', { kind: 'transact', mint, recipientOwner: to, ext: { extAmount: '-1', recipient: V.ata(mint, to) } }); if (r.error) throw new Error(r.error); return BigInt(r.fee); };
  const fresh1 = Keypair.generate().publicKey, fresh2 = Keypair.generate().publicKey;
  { const fee = await feeOf(USDC, fresh1); const got = w.balance(USDC) - fee; const r = await out(USDC, got, fee, fresh1); await scan();
    check('private withdrawal of the USDC received to a fresh address: exactly that much arrives, nothing left in the note', !!r.txHash && (await V.tokenBalance(USDC, fresh1)) === got && w.balance(USDC) === 0n, r.txHash ? `${Number(got) / 1e6} USDC, fee ${Number(fee) / 1e6} USDC` : String(r.error).slice(0, 300)); }
  { const fee = await feeOf(NEW, fresh2); const before = w.balance(NEW); const r = await out(NEW, units(200, 6), fee, fresh2); await scan();
    check('private withdrawal of 200 NEW to another fresh address (fee in NEW): exactly 200 arrive, the rest stays hidden', !!r.txHash && (await V.tokenBalance(NEW, fresh2)) === units(200, 6) && w.balance(NEW) === before - units(200, 6) - fee, r.txHash ? `fee ${Number(fee) / 1e6} NEW, ${Number(w.balance(NEW)) / 1e6} NEW still shielded` : String(r.error).slice(0, 300)); }
  rel.kill(); rel = null;

  check('only the factory authority can delist', await refused(U.send([await U.delistPoolIx(user.publicKey, pool)]), /NotAuthority|ConstraintHasOne/));
  const t0 = await sol(f.treasury); await V.send([await V.delistPoolIx(deployer.publicKey, pool)]); const t1 = await sol(f.treasury); const p2 = await V.binPool(pool);
  check('delist: the pool is flagged and the bond goes to the treasury (the deployer on devnet)', p2.delisted && !(await V.bond(pool)) && t1 - t0 >= BOND - 10_000n, `treasury +${(Number(t1 - t0) / 1e9).toFixed(4)} SOL`);
  check('a delisted pool refuses new liquidity', await refused(U.send([await U.mintIx(user.publicKey, pool, { ids: [A], amountsX: [units(10, 6)], amountsY: [units(10, 6)] })], [], 1_400_000), /Delisted|PoolDelisted|0x17/));
  const left = await sol(user.publicKey); if (left > 10_000n) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: deployer.publicKey, lamports: Number(left - 5_000n) })), [user]);
  const net = (a, b) => (Number(a - b) / 1e9).toFixed(4);
  console.log(`\n${pass} passed, ${fail} failed · devnet SOL net: deployer ${net(await sol(deployer.publicKey), d0)}, relayer ${net(await sol(me), r0)}, publisher ${net(await sol(postman.publicKey), m0)}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED', e.message, e.logs || ''); if (rel) rel.kill(); process.exit(1); });
