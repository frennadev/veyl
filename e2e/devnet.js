#!/usr/bin/env node
// Devnet, end to end: the live devnet deployment (deploy.devnet.json), a relayer + approved-set publisher + faucet run here
// against devnet with the devnet keys, the production site built for devnet, the real app in Chromium with a mock Phantom.
// Proves on the public network what e2e/run.js proves on a local validator: test tokens from the faucet, a shielded deposit
// (taken back once, then admitted by the publisher), a private send, a private withdrawal, a private swap, a shielded
// position (add, fee claim, withdrawal), backup/restore, the no-wallet mode, and that the user's wallet appears in none of
// the relayer's transactions. Expected values come from the chain (prices, pools, tree size), never from constants, so it
// can run again on the same deployment. Costs real devnet SOL: the deployer funds the relayer, the publisher and the
// no-wallet address and pays the faucet; the SOL each key spent is printed at the end. Sealed swaps stay off on devnet.
//   node e2e/devnet.js     keys: DEPLOYER_KEYPAIR, RELAYER_KEY, POSTMAN_KEY (default ~/keys/veyl/devnet-*.json); RPC_URL (test + relayer) and
//   SITE_RPC_URL (the page) for a dedicated RPC: the public devnet endpoint rate-limits one machine running all three
'use strict';
const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs'); const os = require('os');
const { Keypair, PublicKey, Connection, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { chromium } = require('playwright'); const spl = require('@solana/spl-token');
const S = require('../sdk/veyl.js'); const { Veyl } = S; const Z = require('../sdk/shield.js'); const SE = require('../sdk/sealed.js');
const { ROOT, fund, units, sleep, readKey } = require('../scripts/lib.js');
const { build } = require('../scripts/build-site.js'); const { serveDist } = require('../scripts/serve-dist.js');
const { check, lap, chromePath, finish: report } = require('./harness.js');
const RELAYER_PORT = Number(process.env.RELAYER_PORT || 8843), WEB_PORT = Number(process.env.WEB_PORT || 8873); /* other ports while e2e/run.js runs */ const WEB = 'http://127.0.0.1:' + WEB_PORT; const REL = 'http://127.0.0.1:' + RELAYER_PORT;
const KEYS = path.join(os.homedir(), 'keys/veyl'); const keyFile = (env, name) => process.env[env] || path.join(KEYS, 'devnet-' + name + '.json');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'veyl-devnet-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const DEVNET = () => { try { localStorage.setItem('veyl:mode', 'devnet'); } catch { /* storage blocked */ } };

(async () => {
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy.devnet.json'), 'utf8')); const rpc = process.env.RPC_URL || dep.rpc;
  // the public devnet RPC rate-limits by IP, and the test, the page and the relayer share one here: back off and retry on 429
  const fetchRetry = async (url, init) => { for (let i = 0; ; i++) { let r; try { r = await fetch(url, init); } catch (e) { if (i >= 8) throw e; } if (r && (r.status !== 429 || i >= 8)) return r; await sleep(Math.min(30000, 1500 * 2 ** i)); } }; // and dropped connections
  const conn = new Connection(rpc, { commitment: 'confirmed', fetch: fetchRetry, disableRetryOnRateLimit: true }); const deployer = readKey(keyFile('DEPLOYER_KEYPAIR', 'deployer'));
  const relayerFile = keyFile('RELAYER_KEY', 'relayer'), postmanFile = keyFile('POSTMAN_KEY', 'postman'); const relayer = readKey(relayerFile), postman = readKey(postmanFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-devnet-')); let browser, web, rel;
  const programs = Object.fromEntries(Object.entries(dep.programs).map(([k, v]) => [k, new PublicKey(v)]));
  const V = new Veyl({ connection: conn, programs, payer: deployer }); V.lookupTable = new PublicKey(dep.lookupTable); V.lookupExtra = (dep.lookupTables || []).map((k) => new PublicKey(k));
  const T = Object.fromEntries(Object.entries(dep.tokens).map(([sym, t]) => [sym, { ...t, sym, mint: new PublicKey(t.mint) }])); const SOL = T.SOL.mint, USDC = T.USDC.mint;
  const REAL_SOL = SOL.toBase58() === 'So11111111111111111111111111111111111111112'; /* devnet on real wrapped SOL: SOL is wrapped, not minted */
  const sz = (mock, real) => (REAL_SOL ? real : mock);
  const BPX = dep.binPools.find((b) => b.id === 'sol-usdc'); const POOL = new PublicKey(BPX.address);
  const user = Keypair.generate(); const sol = (k) => conn.getBalance(k.publicKey || k);
  const pay = async (to, lamports) => sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: to, lamports })), [deployer], { commitment: 'confirmed' });
  const spent0 = { deployer: await sol(deployer), relayer: await sol(relayer), postman: await sol(postman) };
  try {
    check('deploy.devnet.json matches the chain: programs, shielded pool and SOL/USDC are on devnet', !!(await conn.getAccountInfo(programs.entry)) && !!(await V.shield()) && !!(await V.binPool(POOL)), dep.programs.entry);
    // the relayer pays fees and rent for private actions; the publisher pays for admissions
    if (spent0.relayer < 0.4 * LAMPORTS_PER_SOL) await pay(relayer.publicKey, 0.5 * LAMPORTS_PER_SOL - spent0.relayer);
    if (spent0.postman < 0.04 * LAMPORTS_PER_SOL) await pay(postman.publicKey, 0.05 * LAMPORTS_PER_SOL - spent0.postman);
    const start = { relayer: await sol(relayer), postman: await sol(postman) };
    // admitMs: how often the publisher admits pending deposits (paused at first so a deposit can be taken back, then on)
    const startRelayer = async (admitMs) => { if (rel) { rel.kill(); await sleep(1500); }
      rel = spawn('node', [path.join(ROOT, 'relayer/relayer.js')], { env: { ...process.env, PORT: String(RELAYER_PORT), RPC_URL: rpc, DEPLOY_FILE: path.join(ROOT, 'deploy.devnet.json'), RELAYER_KEY: relayerFile, POSTMAN_KEY: postmanFile, FAUCET_KEY: keyFile('DEPLOYER_KEYPAIR', 'deployer'), ADMIT_INTERVAL_MS: String(admitMs), ALLOWED_ORIGINS: WEB }, stdio: ['ignore', 'inherit', 'inherit'] });
      for (let i = 0; i < 90; i++) { try { if ((await fetch(REL + '/health')).ok) return; } catch {} await sleep(1000); } };
    await startRelayer(24 * 3600e3);
    const health = await (await fetch(REL + '/health')).json(); const info = await (await fetch(REL + '/info')).json();
    check('relayer up against devnet: network, its key, entry signer and lookup table match the deployment', health.network === 'devnet' && health.relayer === relayer.publicKey.toBase58() && info.entrySigner === V.signerPda().toBase58() && info.lookupTable === dep.lookupTable, JSON.stringify(health).slice(0, 160));
    const site = build('devnet', { out: path.join(dir, 'site'), env: { ...process.env, RELAYER_URL: REL }, log: () => {} }); web = serveDist(WEB_PORT, site.out);
    const cs = (site.policy.match(/connect-src [^;]+/) || [''])[0]; const rpcHost = new URL(process.env.SITE_RPC_URL || dep.rpc).host;
    check('the devnet build lets the page reach its RPC and the relayer (CSP connect-src)', cs.includes('https://' + rpcHost) && cs.includes(REL), rpcHost);

    browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); await page.addInitScript(DEVNET);
    const errs = [], cspErrs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (/Content Security Policy|Refused to (load|execute|connect|compile|create)/i.test(m.text()) && !/fonts\.g/.test(m.text())) cspErrs.push(m.text()); });
    await page.addInitScript(({ secret, pubkey }) => {
      window.solana = { isPhantom: true, isMock: true, publicKey: { toString: () => pubkey, toBase58: () => pubkey }, connect: async () => ({ publicKey: pubkey }),
        signTransaction: async (tx) => { const kp = window.Veyl.Keypair.fromSecretKey(Uint8Array.from(secret)); if (typeof tx.partialSign === 'function') tx.partialSign(kp); else tx.sign([kp]); return tx; },
        signAllTransactions: async (txs) => { for (const tx of txs) await window.solana.signTransaction(tx); return txs; }, on() {}, removeListener() {} };
    }, { secret: [...user.secretKey], pubkey: user.publicKey.toBase58() });
    await page.goto(WEB + '/app.html', { waitUntil: 'domcontentloaded', timeout: 90000 }); await page.waitForFunction(() => window.Veyl && window.veylEngine, null, { timeout: 60000 }); await sleep(2000);
    check('app on devnet: network label and the no-wallet banner', /Devnet/i.test(await page.textContent('#netLbl')) && /No wallet needed/.test(await page.textContent('#stateBanner')), await page.textContent('#netLbl'));
    await page.click('#acctBtn'); await page.click('#dlgBody [data-wal="0"]'); await sleep(3000);
    check('wallet connected through the UI', (await page.textContent('#acctBtn')).includes('…'));

    const store = () => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('veyl:') && k !== 'veyl:mode'))));
    const dlgText = async () => (await page.textContent('#dlgBody')).replace(/\s+/g, ' ');
    const finish = async () => { await page.waitForSelector('#doneBtn, #errClose', { timeout: 180000 }); const t = await dlgText(); if (await page.$('#doneBtn')) await page.click('#doneBtn'); else { console.log('    dialog error:', t.slice(-400)); await page.click('#errClose'); } await sleep(900); return t; };
    const ready = async (sel = '#actGo') => { try { await page.waitForFunction((s) => { const b = document.querySelector(s); return b && !b.disabled; }, sel, { timeout: 60000 }); return true; } catch { console.log('    not ready:', await page.textContent(sel)); return false; } };
    const openPool = async (id) => { await page.evaluate((h) => { location.hash = h; }, 'pool-' + id); await page.waitForFunction(() => !document.querySelector('#pStats .skel') && /\d/.test(document.querySelector('#pStats').textContent), null, { timeout: 60000 }); await sleep(800); };
    const panel = async (tab, src) => { await page.click('#tabs [data-tab="' + tab + '"]'); await page.click('#srcSeg [data-src="' + src + '"]'); await sleep(300); };
    const toPortfolio = async () => { await page.evaluate(() => { location.hash = 'pools'; }); await sleep(300); await page.click('[data-go="home"]'); await sleep(300); await page.waitForFunction(() => !document.body.dataset.loading && !document.querySelector('#posList .skel'), null, { timeout: 30000 }).catch(() => {}); await sleep(600); };
    const mints = Object.fromEntries(Object.values(T).map((t) => [t.mint.toBase58(), { sym: t.sym, decimals: t.decimals }]));
    const friend = new Z.ShieldWallet(require('crypto').randomBytes(32), { mints, pools: [] });
    const scan = async (w) => { const st = await V.readShield(); st.tree = new Z.Tree(st.leaves); w.scan(st); };
    /* a real network asks for a backup (or an explicit acknowledgement) before the first deposit: this test acknowledges */
    const ackBackup = async (pg) => { const b = await pg.waitForSelector('#dAck, #dAmt', { timeout: 15000 }).catch(() => null); if (b && (await pg.$('#dAck'))) { await pg.click('#dAck'); await pg.waitForSelector('#dAmt', { timeout: 15000 }); } };
    const until = async (fn, ms, step = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; };
    // each section reports on its own: a failure is recorded and the run goes on with the next one
    const ONLY = (process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean); // e.g. ONLY=deposits,swap,position (prerequisites included by hand)
    const section = async (name, fn) => { if (ONLY.length && !ONLY.some((k) => name.startsWith(k))) { console.log('  (skipped: ' + name + ')'); return; } try { await fn(); } catch (e) { check(name + ': ran to the end', false, String(e.message).split('\n')[0].slice(0, 200) + (Array.isArray(e.logs) ? ' | ' + e.logs.slice(-4).join(' | ').slice(0, 400) : '')); await page.click('#doneBtn, #errClose', { timeout: 3000 }).catch(() => {}); await sleep(500); } };

    // test tokens from the relayer's faucet, through the account menu
    await page.click('#acctBtn'); await page.click('#acctPop [data-drip]');
    const dripped = await until(async () => (await V.tokenBalance(USDC, user.publicKey)) > 0n && (await sol(user)) > 0, 120000);
    const u0 = await V.tokenBalance(USDC, user.publicKey);
    check('faucet (POST /drip): the wallet gets test USDC, SOL and the core basket, plus SOL for fees', dripped && u0 >= units(900, 6) && (REAL_SOL ? (await sol(user)) >= 40_000_000 : (await V.tokenBalance(SOL, user.publicKey)) >= units(4, 9)), `${Number(u0) / 1e6} USDC, ${(await sol(user)) / 1e9} SOL for fees`);
    await page.click('#doneBtn, #errClose').catch(() => {}); await sleep(1000);

    await page.click('[data-go="home"]'); await sleep(1200);
    const vaddr = (await page.textContent('#veylAddr code')).trim(); // also checked after the restore
    check('portfolio shows this browser\'s Veyl address', vaddr.startsWith('veyl:') && Z.decodeAddress(vaddr).pk > 0n, vaddr.slice(0, 24) + '…');
    let t, zp; const DLG = { timeout: 180000 };
    await section('deposits', async () => {
      // a deposit taken back before the publisher admits it (the depositor's own exit; admissions are paused until after it)
      const next0 = (await V.shield()).nextIndex;
      await page.click('[data-open="deposit"]'); await sleep(600); await ackBackup(page); await page.click('#dA [data-a="USDC"]'); await page.fill('#dAmt', '25'); await page.click('#dGo'); await page.waitForSelector('#doneBtn, #errClose', DLG); await page.click('#doneBtn, #errClose'); await sleep(1500); await toPortfolio();
      await page.waitForSelector('#noteList [data-cancel]', { timeout: 60000 }).catch(() => {});
      const w0 = await V.tokenBalance(USDC, user.publicKey); const pend = (await V.readShield()).pending.find((p) => p.depositor.equals(user.publicKey) && p.amount === units(25, 6)); let tb = pend ? 'no Take back button' : 'no pending 25 USDC deposit on chain';
      if (pend && (await page.$('#noteList [data-cancel="' + pend.pending.toBase58() + '"]'))) { await page.click('#noteList [data-cancel="' + pend.pending.toBase58() + '"]'); tb = await finish(); }
      const tookBack = (await V.tokenBalance(USDC, user.publicKey)) - w0 === units(25, 6);
      check('take back a pending deposit from the UI: the wallet gets the 25 USDC back', tookBack, tb.slice(0, 120));
      await startRelayer(5000); // the publisher's automatic admissions from here on
      // a shielded deposit: transact proof in the Web Worker, wallet-signed; the relayer's publisher admits it into the tree
      await page.click('[data-open="deposit"]'); await sleep(600); await ackBackup(page); await page.click('#dA [data-a="USDC"]'); await page.fill('#dAmt', '500'); await page.click('#dGo');
      await page.waitForSelector('#doneBtn, #errClose', DLG); const dTxt = await dlgText(); await page.click('#doneBtn, #errClose'); await sleep(1500);
      check('shielded deposit through the UI on devnet: 500 USDC waits outside the tree (depositor + amount public)', /Deposited 500(\.0+)? USDC/.test(dTxt), dTxt.slice(0, 120));
      const admitted = await until(async () => !(await V.readShield()).pending.some((p) => p.depositor.equals(user.publicKey)), 180000, 5000);
      check('the relayer\'s approved-set publisher admits it into the tree', admitted && (await V.shield()).nextIndex >= next0 + 2n, `tree ${next0} -> ${(await V.shield()).nextIndex}`);
      const want = tookBack ? '500' : '525'; await toPortfolio(); await page.waitForFunction((w) => document.querySelector('#balList').textContent.includes(w), want, { timeout: 60000 }).catch(() => {});
      check('shielded balance shows ' + want + ' USDC (decrypted from devnet with the viewing key)', (await page.textContent('#balList')).includes(want), (await page.textContent('#balList')).replace(/\s+/g, ' '));
    });
    await section('send and withdraw', async () => {
      // a private send to a Veyl address (stays in the pool) and a withdrawal to a fresh address (leaves it)
      await page.click('[data-open="withdraw"]'); await sleep(500); await page.click('#wA [data-a="USDC"]'); await page.fill('#wAmt', '50'); await page.fill('#wTo', friend.address); await sleep(200); await page.click('#wGo'); t = await finish(); await scan(friend);
      check('private send to a Veyl address: the receiver decrypts a 50 USDC note; no amount on chain', /Sent 50(\.0+)? USDC/.test(t) && friend.balance(USDC) === units(50, 6), t.slice(0, 120));
      const fresh = Keypair.generate().publicKey; const rel0 = await V.tokenBalance(USDC, relayer.publicKey);
      await page.click('[data-open="withdraw"]'); await sleep(500); await page.click('#wA [data-a="USDC"]'); await page.fill('#wAmt', '100'); await page.fill('#wTo', fresh.toBase58()); await page.click('#wGo'); t = await finish();
      check('private withdrawal to a fresh address: it receives exactly 100 USDC; the relayer earned its flat fee', /Sent 100(\.0+)? USDC/.test(t) && (await V.tokenBalance(USDC, fresh)) === units(100, 6) && (await V.tokenBalance(USDC, relayer.publicKey)) > rel0, t.slice(0, 120));
    });
    await section('swap', async () => {
      // a private swap from shielded USDC into SOL; the quote and the result follow the pool's own price
      const bp0 = await V.binPool(POOL); const px = Number(S.priceOf(bp0.basePrice, bp0.binStep, bp0.activeId)) / 2 ** 128 * 10 ** (T.SOL.decimals - T.USDC.decimals);
      await page.click('[data-go="swap"]'); await sleep(800); await page.click('#swTokIn'); await sleep(300); await page.click('[data-pick="USDC"]'); await sleep(300); await page.click('#swTokOut'); await sleep(300); await page.click('[data-pick="SOL"]'); await sleep(300);
      await page.fill('#swIn', '150'); await page.waitForFunction(() => parseFloat(document.getElementById('swOut').value) > 0, null, { timeout: 60000 }).catch(() => {}); const q = parseFloat(await page.inputValue('#swOut')); const want = 150 / px;
      check('live quote from the devnet pool on the device (within 5% of 150 USDC at the active price)', q > want * 0.95 && q < want * 1.01, `${q} SOL vs ${want.toFixed(4)}`);
      await page.click('#swGo'); console.log('  proving the swap...', lap()); t = await finish(); const got = parseFloat((t.match(/Got ([\d.]+) SOL/) || [])[1] || '0');
      check('private swap on devnet into a shielded SOL note', /Got [\d.]+ SOL/.test(t) && got > want * 0.95, t.slice(0, 160));
    });
    const aggOf = () => page.evaluate(() => window.veylEngine.shieldPositions().map((p) => ({ id: p.id, lo: p.windowLo, shares: p.note.shares.map(String) })));
    await section('shielded position', async () => {
      // add (two hidden legs + a position proof), earn fees from real volume, claim them, withdraw
      const a0 = (await V.binPool(POOL)).activeId; // the volume below keeps the price around the bin the position was added at
      await openPool('sol-usdc'); await panel('add', 'priv'); await page.click('#presets [data-w="5"]'); await page.fill('#amtX', '1'); await page.fill('#amtY', '120'); await sleep(400);
      console.log('  proving a shielded add...', lap()); if (await ready()) { await page.click('#actGo'); t = await finish(); }
      zp = (await aggOf())[0]; const agg = zp && (await V.aggregateOf(POOL, zp.lo));
      check('shielded add on devnet: the shielded aggregate holds the note\'s shares; the position is owned by the shielded PDA', /Position added/.test(t) && zp && zp.shares.some((s) => s !== '0') && agg && zp.shares.every((s, i) => agg[i] >= BigInt(s)) && !!(await V.shareAccount(POOL, V.shieldOwner(), V.signerPda(), S.chunkOf(zp.lo))), t.slice(0, 140));
      // fees: public round trips through its bins (the deployer, with minted test tokens) until they are worth claiming
      await fund(conn, deployer, USDC, deployer.publicKey, units(100000, 6)); await fund(conn, deployer, SOL, deployer.publicKey, units(sz(1000, 1.5), 9));
      const volume = async (n) => { for (let i = 0; i < n; i++) { const bp = await V.binPool(POOL); const xForY = bp.activeId > a0 + 1 || (bp.activeId >= a0 - 1 && i % 2 === 1); // sell SOL above, buy below
        await V.send([await V.swapIx(deployer.publicKey, POOL, xForY, xForY ? units(sz(10, 0.04), 9) : units(sz(1000, 4), 6))], [], 1_400_000); await sleep(300); } };
      // fees reach a claimable state at the next shielded action in these bins (a claim is proven against the growth recorded at
      // the last harvest; the program harvests after the proof): volume, then a small second shielded add here, then the claim
      await volume(30);
      await openPool('sol-usdc'); await panel('add', 'priv'); await page.click('#presets [data-w="5"]'); await page.fill('#amtX', '0.02'); await page.fill('#amtY', '2'); await sleep(400);
      if (await ready()) { await page.click('#actGo'); t = await finish(); } check('a second, small shielded add in the same bins harvests the fees collected since the first', /Position added/.test(t), t.slice(0, 120));
      zp = (await aggOf()).find((x) => x.lo === zp.lo) || zp; // in the same 16-bin window the add merges into the same position (a new note, a new id)
      const claimSel = '#posList [data-pa="claim"][data-id="' + zp.id + '"]'; let enabled = false;
      for (let i = 0; i < 9 && !enabled; i++) { await toPortfolio(); enabled = await page.$eval(claimSel, (b) => !b.disabled).catch(() => false); if (!enabled) await sleep(10000); }
      if (!enabled) { const dump = () => page.evaluate(() => window.veylEngine.zw.notes.filter((n) => n.kind === 2 || n.lo !== undefined).map((n) => ({ lo: n.lo, spent: !!n.spent, kind: n.kind, shares: (n.shares || []).filter((x) => String(x) !== '0').length, c: String(n.commitment || '').slice(0, 10) })));
        console.log('    position notes after the second add:', JSON.stringify(await dump()), 'window of the first:', zp.lo);
        await page.evaluate(() => window.veylEngine.shieldSync()); console.log('    ...after a forced shieldSync:', JSON.stringify(await dump()), JSON.stringify(await page.evaluate(() => window.veylEngine.shieldPositions().map((p) => [p.id, p.windowLo]))));
        // the numbers behind a disabled Claim: the note, the on-chain fee growth, what the engine computes
        const n = await page.evaluate((lo) => { const E = window.veylEngine; const p = E.shieldPositions().find((x) => x.windowLo === lo); return p && { shares: p.note.shares.map(String), debt: p.note.debt.map(String) }; }, zp.lo);
        const g = await V.growthOf(POOL, zp.lo); const cl = n && Z.claimable(n.shares, n.debt, g);
        console.log('    claim disabled after the second add:', JSON.stringify({ shares: n && n.shares.filter((x) => x !== '0').length, claimable: cl && cl.map((c) => String(c.q)), growthNonZero: g.map((a) => a.filter((x) => x !== 0n).length) })); }
      await toPortfolio(); const zb0 = await page.evaluate(() => [String(window.veylEngine.shieldBalance('SOL')), String(window.veylEngine.shieldBalance('USDC'))]);
      await page.click(claimSel, { timeout: 5000 }); await sleep(400); await page.click('#cGo'); t = await finish();
      const zb1 = await page.evaluate(() => [String(window.veylEngine.shieldBalance('SOL')), String(window.veylEngine.shieldBalance('USDC'))]);
      check('shielded fee claim on devnet: one position proof; the fees land as hidden notes', /Fees claimed/.test(t) && (BigInt(zb1[0]) > BigInt(zb0[0]) || BigInt(zb1[1]) > BigInt(zb0[1])), t.slice(0, 160));
      await toPortfolio(); await page.waitForSelector('#posList [data-pa="withdraw"][data-id="' + zp.id + '"]', { timeout: 30000 }).catch(() => null);
      await page.click('#posList [data-pa="withdraw"][data-id="' + zp.id + '"]'); await sleep(400); await page.click('#wdGo'); t = await finish();
      const zl = (await aggOf()).find((x) => x.id === zp.id);
      check('shielded withdrawal of 100% on devnet: the shares leave the aggregate, proceeds back as shielded notes', /Withdrew 100%/.test(t) && (!zl || zl.shares.every((s) => s === '0')), t.slice(0, 160));
      await page.screenshot({ path: path.join(SHOTS, 'devnet-portfolio.png'), fullPage: true });
    });
    await section('zap, limit order, rebalance', async () => {
      // a shielded limit order: buy SOL 3 bins below the price from hidden USDC notes
      await openPool('sol-usdc'); await panel('limit', 'priv'); await page.click('#ordSeg [data-o="buy"]'); await sleep(300); await page.fill('#ordAmt', '30'); await sleep(300);
      if (await ready()) { await page.click('#actGo'); t = await finish(); }
      const qo = ((await store()).shield.orders || []).slice(-1)[0];
      check('shielded limit order on devnet: a bid from hidden USDC notes, held by the shielded aggregate; an order note on this device', /Order placed/.test(t) && qo && !qo.isAsk && (await page.evaluate((o) => window.veylEngine.zw.orderNotes(o.pool, o.binId, o.isAsk).length, qo)) >= 1, t.slice(0, 120));
      // filled by a public swap down through its bin (the deployer), then the price is walked back up
      const a0 = (await V.binPool(POOL)).activeId;
      { const pl = await V.binPool(POOL); const bins = await V.bins(POOL, S.chunksForSwap(pl, true)); let a = units(sz(1, 0.05), 9);
        for (let k = 0; k < 200; k++) { let sim = null; try { sim = S.simulateSwap(pl, bins, true, a, Math.floor(Date.now() / 1000)); } catch {} if (sim && sim.endId < qo.binId) break; a += units(sz(1, 0.05), 9); }
        await fund(conn, deployer, SOL, deployer.publicKey, a); await V.send([await V.swapIx(deployer.publicKey, POOL, true, a)], [], 1_400_000); }
      const oi = await V.position(POOL, V.shieldOwner(), V.signerPda(), [qo.binId]);
      check('the shielded bid is filled on devnet by a public swap through its bin', oi.orders.some((o) => o.filled && o.filledX > 0n));
      await fund(conn, deployer, USDC, deployer.publicKey, units(20000, 6));
      for (let i = 0; i < 60 && (await V.binPool(POOL)).activeId < a0; i++) await V.send([await V.swapIx(deployer.publicKey, POOL, false, units(sz(400, 3), 6))], [], 1_400_000); /* small steps: real-SOL pools are seeded thin */
      // withdraw the order: its note is spent, the SOL it bought comes back as a shielded note
      await toPortfolio(); const solZ0 = await page.evaluate(() => String(window.veylEngine.shieldBalance('SOL')));
      await page.waitForSelector('#ordList [data-ow="' + qo.id + '"]', { timeout: 30000 }); await page.click('#ordList [data-ow="' + qo.id + '"]'); await sleep(400); await page.click('#oGo'); t = await finish();
      const solZ1 = await page.evaluate(() => String(window.veylEngine.shieldBalance('SOL')));
      check('shielded order withdrawal on devnet: the order note is spent; the SOL it bought returns as a shielded note', /Order withdrawn/.test(t) && BigInt(solZ1) > BigInt(solZ0), t.slice(0, 140));
      // a shielded zap: one USDC note -> a two-sided position (part swapped inside the pool)
      await openPool('sol-usdc'); await panel('zap', 'priv'); await page.click('#zapSeg [data-z="y"]'); await page.click('#presets [data-w="5"]'); await page.fill('#zapAmt', '20'); await sleep(1500);
      if (await ready()) { await page.click('#actGo'); t = await finish(); }
      check('shielded zap on devnet: one USDC note -> a two-sided shielded position (size hidden)', /Zapped in/.test(t) && (await aggOf()).some((x) => x.shares.some((v) => v !== '0')), t.slice(0, 140));
      // rebalance a live shielded position around the price
      const live = (await aggOf()).find((x) => x.shares.some((v) => v !== '0'));
      await toPortfolio(); await page.click('#posList [data-pa="rebalance"][data-id="' + live.id + '"]'); await ready('#rbGo'); await page.click('#rbGo'); t = await finish();
      const notes = (await aggOf()).filter((x) => x.shares.some((v) => v !== '0')); let covered = notes.length >= 1;
      for (const x of notes) { const a = await V.aggregateOf(POOL, x.lo); covered = covered && a.every((v, i) => v >= BigInt(x.shares[i])); }
      check('shielded rebalance on devnet: position proofs move the shares around the price; the aggregate covers every note', /Rebalanced/.test(t) && covered, t.slice(-140));
    });
    await section('sealed swaps', async () => {
      // the committee: registered on devnet from committee/transcript.devnet.json, its three nodes running (scripts/committee-local.js)
      const J = require('../sdk/bjj.js'); const { proveTransact } = require('../sdk/prover.js'); const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/devnet.json'), 'utf8'));
      const peers = [8863, 8864, 8865].map((p) => 'http://127.0.0.1:' + p); const hs = await Promise.all(peers.map(async (u) => { try { return await (await fetch(u + '/health')).json(); } catch { return null; } }));
      const c = await V.committee(); const st0 = await V.sealedState(POOL);
      check('the batch committee is registered on devnet (2 of 3, the transcript\'s joint key) and its three nodes are up', !!c && c.t === 2 && c.n === 3 && hs.every((h) => h && h.dkg === 'done' && h.pk === hs[0].pk) && !!st0, c ? `epoch ${c.epoch}, ${hs.filter(Boolean).length} nodes up` : 'no committee on chain: run the key generation, then npm run deploy -- --network devnet');
      if (!c || !st0) return;
      const base = require('../scripts/deploy.js').sealedParams(cfg, dep, 'sol-usdc'); const setParams = async (p) => V.send([V.setSealedParamsIx(deployer.publicKey, POOL, p)]);
      // a batch long enough for six browser users to seal into it: wait until the current (empty) batch is extended under it
      const waitRoom = async (slots) => { for (let i = 0; i < 120; i++) { const x = await V.sealedState(POOL); if (x.batch.state === 'open' && x.batch.count[0] + x.batch.count[1] === 0 && x.batch.endSlot - BigInt(x.slot) > BigInt(slots)) return x; await sleep(3000); } throw new Error('no fresh batch with room'); };
      const finishOn = async (pg) => { await pg.waitForSelector('#doneBtn, #errClose', { timeout: 180000 }); const tx = (await pg.textContent('#dlgBody')).replace(/\s+/g, ' '); if (await pg.$('#doneBtn')) await pg.click('#doneBtn'); else { console.log('    dialog error:', tx.slice(-300)); await pg.click('#errClose'); } await sleep(600); return tx; };
      const openSeal = async (pg) => { await pg.evaluate(() => { location.hash = 'pools'; }); await sleep(300); await pg.evaluate((h) => { location.hash = h; }, 'pool-sol-usdc'); await pg.waitForFunction(() => !document.querySelector('#pStats .skel') && /\d/.test(document.querySelector('#pStats').textContent), null, { timeout: 60000 });
        await pg.click('#tabs [data-tab="swap"]'); await pg.waitForFunction(() => !document.querySelector('#swMode').hidden, null, { timeout: 30000 }); await sleep(400); };
      const users = []; const userErrs = [];
      try {
        for (let i = 0; i < 6; i++) { const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.addInitScript(DEVNET); const pg = await ctx.newPage(); pg.on('pageerror', (e) => userErrs.push(e.message));
          await pg.goto(WEB + '/app.html', { waitUntil: 'domcontentloaded', timeout: 90000 }); await pg.waitForFunction(() => window.veylEngine && window.veylEngine.zw, null, { timeout: 60000 }); users.push({ ctx, pg, dir: i < 3 ? 0 : 1, addr: await pg.evaluate(() => window.veylEngine.veylAddress()) }); }
        // fund them privately: one deposit from Node (admitted by the relayer's publisher), then a hidden note to each user
        const fw = new Z.ShieldWallet(require('crypto').randomBytes(32), { mints, pools: [] });
        await fund(conn, deployer, SOL, deployer.publicKey, units(sz(12, 0.6), 9)); await fund(conn, deployer, USDC, deployer.publicKey, units(2000, 6));
        for (const [m, a] of [[SOL, units(sz(10, 0.5), 9)], [USDC, units(1900, 6)]]) { await scan(fw); const d = fw.deposit(m, a); const pr = await proveTransact(d.input);
          await V.send([V.postProofIx(deployer.publicKey, 1, pr.proof, pr.pubs)], [], 1_400_000); await V.send([await V.shieldDepositIx(deployer.publicKey, d.ext, pr.pubs)], [], 600_000);
          await until(async () => !(await V.readShield()).pending.some((x) => x.depositor.equals(deployer.publicKey)), 120000, 4000); }
        const R2 = new Veyl({ connection: conn, programs, payer: relayer }); R2.lookupTable = V.lookupTable; R2.lookupExtra = V.lookupExtra;
        for (const u of users) { await scan(fw); const t2 = fw.spend({ mint: u.dir === 0 ? SOL : USDC, send: u.dir === 0 ? units(sz(3, 0.15), 9) : units(600, 6), to: u.addr, hideToken: true }); const pr = await proveTransact(t2.input);
          await R2.send([V.postProofIx(relayer.publicKey, 1, pr.proof, pr.pubs)], [], 1_400_000); await R2.sendV0([await V.shieldTransactIx(relayer.publicKey, t2.ext, pr.pubs)], [], 600_000); }
        // six users seal into one batch from the pool page (3 sell SOL, 3 sell USDC), proofs in each page's Web Worker
        await setParams({ ...base, epochSlots: 1500n, settleTimeout: 1500n }); const st = await waitRoom(1200); const seq = st.batch.seq; // after funding: room for six
        const sizes = REAL_SOL ? [['0.04', '0.06', '0.02'], ['95', '210.5', '60']] : [['0.8', '1.25', '0.4'], ['95', '210.5', '60']]; const SW = [];
        for (const [k, u] of users.entries()) { const pg = u.pg; await pg.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }); await pg.waitForFunction(() => window.veylEngine && window.veylEngine.zw, null, { timeout: 60000 }); await openSeal(pg);
          const mode = await pg.evaluate(() => [...document.querySelectorAll('#swMode [data-m]')].map((b) => b.dataset.m + ':' + b.getAttribute('aria-pressed')).join('|'));
          if (k === 0) check('pool page on devnet: "Sealed" is the default swap mode while the pool has an open batch', /sealed:true/.test(mode), mode);
          if ((u.dir === 1) !== !(await pg.evaluate(() => document.querySelector('#pswTkIn').textContent.includes('SOL')))) await pg.click('#pswFlip');
          await pg.fill('#pswIn', sizes[u.dir][k % 3]); await pg.waitForFunction(() => { const b = document.querySelector('#actGo'); return b && !b.disabled; }, null, { timeout: 90000 });
          await pg.click('#actGo'); SW.push(await finishOn(pg)); }
        let b = await V.batch(POOL, seq);
        check('six users sealed swaps into one devnet batch from the browser (3 sell SOL, 3 sell USDC)', SW.every((x) => /Sealed into batch/.test(x)) && b.count[0] === 3 && b.count[1] === 3, `batch ${seq}: ${b.count.join(' + ')}`);
        { const rs = await conn.getSignaturesForAddress(relayer.publicKey, { limit: 60 }, 'confirmed'); let seen = 0, leaks = 0;
          for (const s2 of rs) { const t2 = await conn.getTransaction(s2.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!t2 || !(t2.meta.logMessages || []).some((l) => /submit_swap|SubmitSwap/i.test(l))) continue; seen++;
            const raw = Buffer.from(t2.transaction.message.serialize()).toString('hex'); for (const v of [...sizes[0].map((x) => units(Number(x), 9)), ...sizes[1].map((x) => units(Number(x), 6))]) if (raw.includes(S.u64(v).toString('hex'))) leaks++; }
          check('the relayer submitted the sealed swaps on devnet; no swap amount appears in any of its transactions', seen >= 6 && leaks === 0, `${seen} submit_swap transactions, ${leaks} amounts seen`); }
        // the epoch ends: the committee nodes close it, prove their partial decryptions on chain and settle it
        const tClose = Date.now(); for (let dl = Date.now() + 1500e3; b.state !== 'settled' && b.state !== 'failed' && Date.now() < dl;) { await sleep(5000); b = await V.batch(POOL, seq); }
        const hs2 = await Promise.all(peers.map(async (u) => { try { return await (await fetch(u + '/health')).json(); } catch { return {}; } }));
        check('the committee settled the devnet batch: totals public, individual sizes never decrypted, one net swap', b.state === 'settled' && b.totals[0] === sizes[0].reduce((t, x) => t + units(Number(x), 9), 0n) && b.totals[1] === sizes[1].reduce((t, x) => t + units(Number(x), 6), 0n) && hs2.filter((h) => h.lastShare).length >= 2, `${b.state} ${Math.round((Date.now() - tClose) / 1000)} s after the last swap`);
        // every user claims from the UI: exactly floor(amount x num / den) - the relayer's fee
        const feeQ = async (sym) => BigInt((await (await fetch(REL + '/fee', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'sealedClaim', mint: T[sym].mint.toBase58() }) })).json()).fee);
        const claims = [];
        for (const [k, u] of users.entries()) { const pg = u.pg; const other = u.dir === 0 ? 'USDC' : 'SOL'; await pg.waitForFunction(() => document.querySelector('#pSeal [data-sc]'), null, { timeout: 60000 }).catch(() => {});
          const before = await pg.evaluate((sym) => String(window.veylEngine.shieldBalance(sym)), other); const fee = await feeQ(other);
          await pg.click('#pSeal [data-sc]'); const tx = await finishOn(pg); await pg.waitForFunction(([sym, b0]) => String(window.veylEngine.shieldBalance(sym)) !== b0 || (window.veylEngine.shieldSync(), false), [other, before], { timeout: 60000, polling: 2000 }).catch(() => {});
          const after = await pg.evaluate((sym) => String(window.veylEngine.shieldBalance(sym)), other); const amt = units(Number(sizes[u.dir][k % 3]), u.dir === 0 ? 9 : 6); const want = (amt * b.num[u.dir]) / b.den[u.dir] - fee;
          claims.push({ ok: /Claimed/.test(tx) && BigInt(after) - BigInt(before) === want, d: String(BigInt(after) - BigInt(before)) + '/' + String(want) }); }
        check('six claims from the UI on devnet: each shielded balance grows by exactly floor(amount x num / den) - the relayer\'s fee', claims.every((x) => x.ok), claims.map((x) => x.d).join(' '));
        // a lone seller with no rollover left: the batch fails at close and the UI refunds it
        await setParams({ ...base, epochSlots: 150n, maxRollovers: 0 }); await waitRoom(60);
        { const u = users[1]; const pg = u.pg; await openSeal(pg); if (await pg.evaluate(() => !document.querySelector('#pswTkIn').textContent.includes('SOL'))) await pg.click('#pswFlip');
          const lone = REAL_SOL ? '0.03' : '0.5'; await pg.fill('#pswIn', lone); await pg.waitForFunction(() => { const x = document.querySelector('#actGo'); return x && !x.disabled; }, null, { timeout: 90000 }); await pg.click('#actGo'); await finishOn(pg);
          const seq2 = (await V.sealedState(POOL)).batch.seq; for (let dl = Date.now() + 600e3; Date.now() < dl;) { const x = await V.batch(POOL, seq2); if (x.state === 'failed') break; await sleep(4000); }
          await pg.waitForFunction(() => /Refund/.test(document.querySelector('#pSeal').textContent) && document.querySelector('#pSeal [data-sc]'), null, { timeout: 60000 }).catch(() => {});
          const before = await pg.evaluate(() => String(window.veylEngine.shieldBalance('SOL'))); const fee = await feeQ('SOL'); await pg.click('#pSeal [data-sc]'); const tx = await finishOn(pg);
          await pg.waitForFunction((b0) => String(window.veylEngine.shieldBalance('SOL')) !== b0 || (window.veylEngine.shieldSync(), false), before, { timeout: 60000, polling: 2000 }).catch(() => {});
          const after = await pg.evaluate(() => String(window.veylEngine.shieldBalance('SOL')));
          check('a lone seller on devnet (under the k-floor, no rollover left): the batch fails at close; the UI refunds the SOL as a hidden note (minus the relayer\'s fee)', /Refunded/.test(tx) && BigInt(after) - BigInt(before) === units(Number(lone), 9) - fee && (await V.batch(POOL, seq2)).state === 'failed', `got ${BigInt(after) - BigInt(before)} want ${units(Number(lone), 9) - fee} (fee ${fee}), batch ${(await V.batch(POOL, seq2)).state} · ` + tx.slice(0, 60)); }
        check('no browser errors in the sealed users\' pages', userErrs.length === 0, userErrs.slice(0, 2).join(' | '));
      } finally { await setParams(base).catch((e) => console.log('    could not restore the sealed params:', e.message)); for (const u of users) await u.ctx.close().catch(() => {}); }
    });
    await section('privacy', async () => {
      // the user's wallet signs only its own deposits: it appears in none of the relayer's transactions
      const sigs = (await conn.getSignaturesForAddress(relayer.publicKey, { limit: 200 }, 'confirmed')).filter((s) => !s.err && s.blockTime * 1000 >= Date.now() - 3 * 3600e3); let seen = 0, linked = 0;
      for (const s of sigs) { const tx = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!tx) continue; seen++;
        const keys = [...tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys, ...((tx.meta.loadedAddresses || {}).writable || []), ...((tx.meta.loadedAddresses || {}).readonly || [])].map(String);
        if (keys.includes(user.publicKey.toBase58())) linked++; }
      check('the user\'s wallet appears in none of the relayer\'s transactions on devnet', seen >= 5 && linked === 0, `${seen} relayer transactions, ${linked} with the wallet`);
    });
    await section('backup and restore', async () => {
      const st = await store(); await toPortfolio();
      await page.click('#bkBanner [data-backup="export"]'); await sleep(300); await page.fill('#bkP1', 'amber lantern 19'); await page.fill('#bkP2', 'amber lantern 19');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#bkGo')]); const bkFile = path.join(dir, 'backup.json'); await dl.saveAs(bkFile); await page.waitForSelector('#doneBtn'); await page.click('#doneBtn');
      const bk = fs.readFileSync(bkFile, 'utf8');
      check('backup: an encrypted file; the shielded seed is not in clear', JSON.parse(bk).cipher === 'AES-256-GCM' && !bk.includes(st.shield.seed));
      await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }); await sleep(3000); await page.click('#acctBtn'); await page.click('#dlgBody [data-wal="0"]'); await sleep(2500); await toPortfolio();
      await page.click('#bkBanner [data-backup="import"]'); await sleep(300); await page.setInputFiles('#rsFile', bkFile); await page.fill('#rsP', 'amber lantern 19'); await page.click('#rsGo'); await page.waitForSelector('#doneBtn', { timeout: 120000 }); t = await dlgText(); await page.click('#doneBtn'); await toPortfolio(); await sleep(2500);
      const addrBack = (await page.textContent('#veylAddr code')).trim(); const balAfter = await page.textContent('#balList');
      check('restore on devnet: same Veyl address, balances rescanned from the chain', /Restored/.test(t) && addrBack === vaddr && /USDC/.test(balAfter) && /SOL/.test(balAfter), balAfter.replace(/\s+/g, ' ').slice(0, 120));
    });
    // no wallet: a deposit address made in this browser, funded from outside, a private deposit, leftovers sent out
    await section('no wallet', async () => { const lc = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await lc.addInitScript(DEVNET); const lp = await lc.newPage(); const lerr = []; lp.on('pageerror', (e) => lerr.push(e.message));
      try {
        await lp.goto(WEB + '/app.html#home', { waitUntil: 'domcontentloaded', timeout: 90000 }); await lp.waitForFunction(() => window.veylEngine && window.veylEngine.zw, null, { timeout: 60000 }); await sleep(1500);
        await lp.click('#acctBtn'); await lp.waitForSelector('#stLocal', { timeout: 30000 }); await lp.click('#stLocal'); await lp.waitForSelector('#fBal', { timeout: 60000 }).catch(async (e) => { await lp.screenshot({ path: path.join(SHOTS, 'devnet-nowallet.png') }); throw e; }); const addr = await lp.evaluate(() => window.veylEngine.account); const ap = new PublicKey(addr);
        await pay(ap, 0.03 * LAMPORTS_PER_SOL); await fund(conn, deployer, USDC, ap, units(80, 6));
        await lp.waitForFunction(() => /80/.test(document.getElementById('fBal').textContent), null, { timeout: 60000 }).catch(() => {});
        check('no wallet: a deposit address made in this browser; funding from outside shows up (80 USDC)', /80/.test(await lp.textContent('#fBal')), addr);
        await lp.click('#fGo'); await ackBackup(lp); await lp.click('#dA [data-a="USDC"]'); await lp.fill('#dAmt', '50'); await lp.click('#dGo'); await lp.waitForSelector('#doneBtn, #errClose', DLG); const dt = await lp.textContent('#dlgBody');
        check('no wallet: a private deposit straight from the deposit address on devnet', /Deposited 50(\.0+)? USDC/.test(dt), dt.replace(/\s+/g, ' ').slice(0, 160)); await lp.click('#doneBtn, #errClose');
        const dest = Keypair.generate().publicKey; await lp.click('#acctBtn'); await lp.click('#acctPop [data-sweep]'); await lp.fill('#swpTo', dest.toBase58()); await lp.click('#swpGo'); await lp.waitForSelector('#doneBtn, #errClose', { timeout: 120000 });
        const swept = await lp.textContent('#dlgBody'); const dU = (await conn.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(USDC, dest))).value.amount;
        check('no wallet: what\'s left (30 USDC and the SOL) reaches another address; the deposit address is emptied', /Sent/.test(swept) && dU === String(units(30, 6)) && (await conn.getBalance(ap)) === 0, `${dU} / ${await conn.getBalance(ap)}`);
        check('no-wallet flow: no page errors', lerr.length === 0, lerr.join(' | '));
      } finally { await lc.close(); } });

    check('no Content-Security-Policy violations', cspErrs.length === 0, cspErrs.join(' | ').slice(0, 300));
    check('no browser errors', errs.length === 0, errs.join(' | ').slice(0, 300));
    const used = { deployer: spent0.deployer - (await sol(deployer)), relayer: start.relayer - (await sol(relayer)), postman: start.postman - (await sol(postman)) };
    console.log('  devnet SOL spent:', Object.entries(used).map(([k, v]) => k + ' ' + (v / 1e9).toFixed(4)).join(' · '), '(deployer includes funding the relayer, the publisher and the no-wallet address)');
  } catch (e) { check('devnet e2e ran to the end', false, e.stack); }
  finally { if (browser) await browser.close(); if (web) web.close(); if (rel) rel.kill(); }
  report();
})();
