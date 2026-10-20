#!/usr/bin/env node
// Veyl on Solana, end to end: local validator (8933) -> deploy -> relayer + approved-set publisher (8845, E2E_RELAYER_PORT) -> the site and the
// real app in Chromium (8873) with a mock Phantom wallet. Phase 2: a shielded deposit (REAL transact proof made in the
// browser's Web Worker), take-back of a pending deposit, a hidden send to a Veyl address, a withdrawal to a fresh wallet, a
// shielded swap, shielded liquidity (add, zap, claim, rebalance, remove: position proofs), a shielded limit order, public
// Phase 1 actions alongside, encrypted backup/restore of the shielded seed; Phase 3: three committee nodes (DKG over HTTP)
// and six browser users sealing swaps into one batch, settled by the nodes, claimed in the UI, plus a refund; then the
// static pages. Chromium at /opt/pw-browsers.
'use strict';
const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs'); const os = require('os');
const { Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const { chromium } = require('playwright');
const S = require('../sdk/veyl.js'); const { Veyl, zeros, STATE_DEPTH } = S; const Z = require('../sdk/shield.js');
const { ROOT, RPC_PORT, startValidator, deployAll, fund, units, sleep } = require('../scripts/lib.js'); const { makeConfig } = require('../scripts/make-config.js');
const { build } = require('../scripts/build-site.js'); const { serveDist } = require('../scripts/serve-dist.js');
// its own relayer port (E2E_RELAYER_PORT): 8843 is the relayer's default, and a devnet relayer left running there used to answer
// this test instead of its own (whose spawn then failed to bind), with another approved-set publisher behind it
const RELAYER_PORT = Number(process.env.E2E_RELAYER_PORT || 8845), WEB_PORT = Number(process.env.E2E_WEB_PORT || 8873); const WEB = 'http://127.0.0.1:' + WEB_PORT;
const portFree = (port) => new Promise((ok) => { const s = require('net').createServer(); s.once('error', () => ok(false)); s.listen(port, '127.0.0.1', () => s.close(() => ok(true))); });
const { counts, check, lap, chromePath, finish: report } = require('./harness.js');
/// the app opens in Sandbox mode by default; this test drives the deployment (Devnet mode against the local validator)
const { mockMarket } = require('./market-mock.js'); // the price APIs are not reachable from tests: answered in their own shapes
const DEVNET = () => { try { localStorage.setItem('veyl:mode', 'devnet'); } catch { /* storage blocked */ } };
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'veyl-e2e-shots'); fs.mkdirSync(SHOTS, { recursive: true });

(async () => {
  for (const [name, port] of [['E2E_RELAYER_PORT', RELAYER_PORT], ['E2E_WEB_PORT', WEB_PORT]]) if (!(await portFree(port))) { console.error(`port ${port} is taken (another relayer or site?): stop it or set ${name}`); process.exit(1); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-e2e-')); const payer = Keypair.generate(); const payerFile = path.join(dir, 'payer.json'); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  const { val, rpc, conn } = await startValidator(dir, payer, RPC_PORT); let browser, web, rel;
  try {
    const [relayer, postman, user, lp] = Array.from({ length: 4 }, () => Keypair.generate());
    for (const k of [relayer, postman, user, lp]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 50 * LAMPORTS_PER_SOL), 'confirmed');
    const { V, dep, T, BP } = await deployAll({ rpc, payerFile, postman: postman.publicKey, relayer: relayer.publicKey });
    check('deployed: programs, pools, entry, lookup table', dep.programs.pool && dep.lookupTable, lap());
    fs.writeFileSync(path.join(ROOT, 'site/veyl.config.js'), makeConfig(dep, { RELAYER_URL: 'http://127.0.0.1:' + RELAYER_PORT, CHAIN_NAME: 'Local validator' }));
    // liquidity in SOL/USDC so a swap has somewhere to go
    const SOL = T.SOL.mint, USDC = T.USDC.mint; const BPX = BP.find((b) => b.id === 'sol-usdc');
    await fund(conn, payer, SOL, lp.publicKey, units(500, 9)); await fund(conn, payer, USDC, lp.publicKey, units(200_000, 6));
    const L = new Veyl({ connection: conn, programs: V.programs, payer: lp }); const ids = []; const ax = []; const ay = [];
    for (let i = -6; i <= 6; i++) { ids.push(i); ax.push(i >= 0 ? units(5, 9) : 0n); ay.push(i <= 0 ? units(2000, 6) : 0n); }
    await L.send([...(await V.ensureBinAccountsIxs(lp.publicKey, BPX.address, ids, lp.publicKey, lp.publicKey)), await V.mintIx(lp.publicKey, BPX.address, { ids, amountsX: ax, amountsY: ay })], [], 1_400_000);
    check('SOL/USDC seeded with public liquidity', (await V.binPool(BPX.address)).seeded);
    await fund(conn, payer, T.USDT.mint, payer.publicKey, units(600, 6));
    await V.send([await V.initRewardIx(payer.publicKey, BPX.address, 0, T.USDT.mint, 900, payer.publicKey)]); await V.send([await V.fundRewardIx(payer.publicKey, BPX.address, 0, units(600, 6))]);
    check('SOL/USDC farm reward: 600 USDT over 15 minutes', (await V.binPool(BPX.address)).rewards[0].initialized);
    // the user's mock wallet gets tokens
    await fund(conn, payer, USDC, user.publicKey, units(5_000, 6)); await fund(conn, payer, SOL, user.publicKey, units(2, 9));
    // relayer + publisher
    const relayerFile = path.join(dir, 'relayer.json'), postmanFile = path.join(dir, 'postman.json'); fs.writeFileSync(relayerFile, JSON.stringify([...relayer.secretKey])); fs.writeFileSync(postmanFile, JSON.stringify([...postman.secretKey]));
    rel = spawn('node', [path.join(ROOT, 'relayer/relayer.js')], { env: { ...process.env, PORT: String(RELAYER_PORT), RPC_URL: rpc, DEPLOY_FILE: path.join(ROOT, 'deploy.local.json'), RELAYER_KEY: relayerFile, POSTMAN_KEY: postmanFile, ASP_INTERVAL_MS: '2500', ADMIT_INTERVAL_MS: '3600000', FEE_COVER: '0.0005' }, stdio: ['ignore', 'inherit', 'inherit'] });
    for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:' + RELAYER_PORT + '/health')).ok) break; } catch {} await sleep(500); }
    const info = await (await fetch('http://127.0.0.1:' + RELAYER_PORT + '/info')).json();
    check('relayer up: fee range, entry signer, lookup table', info.minFeeBps === 5 && info.entrySigner === V.signerPda().toBase58() && info.lookupTable === dep.lookupTable);
    const st0 = await (await fetch('http://127.0.0.1:' + RELAYER_PORT + '/state?pool=' + T.USDC.pool.toBase58())).json();
    check('/state serves the empty USDC tree', Array.isArray(st0.leaves) && st0.leaves.length === 0);
    // the production build (dist/site) served with its production headers (_headers: CSP with 'wasm-unsafe-eval', MIME, cache)
    const site = build('local', { env: { RELAYER_URL: 'http://127.0.0.1:' + RELAYER_PORT }, log: () => {} });
    web = serveDist(WEB_PORT, site.out);
    const hApp = await fetch(WEB + '/app.html'), hZ = await fetch(WEB + '/' + site.zk.zkey, { method: 'HEAD' }), hW = await fetch(WEB + '/' + site.zk.wasm, { method: 'HEAD' });
    const hT = await fetch(WEB + '/' + site.zk.transact.zkey, { method: 'HEAD' }), hP = await fetch(WEB + '/' + site.zk.position.wasm, { method: 'HEAD' }), hWk = await fetch(WEB + '/prove-worker.js', { method: 'HEAD' });
    check('the build ships the transact and position circuits (content-hashed) and the proving worker', hT.ok && hP.ok && hWk.ok && /immutable/.test(hT.headers.get('cache-control') || ''), site.zk.transact.zkey + ' ' + site.zk.position.wasm);
    const cspHdr = hApp.headers.get('content-security-policy') || '';
    check("dist/site served with the production CSP ('wasm-unsafe-eval', no 'unsafe-inline' scripts) and zkey/wasm MIME + immutable cache",
      /script-src 'self' 'wasm-unsafe-eval'(;|$)/.test(cspHdr) && hW.headers.get('content-type') === 'application/wasm' && /immutable/.test(hZ.headers.get('cache-control') || '') && hZ.headers.get('content-type') === 'application/octet-stream', cspHdr.slice(0, 120));

    browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); await page.addInitScript(DEVNET); await mockMarket(page);
    const errs = [], cspErrs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text() + ' ' + JSON.stringify(m.location())); if (/Content Security Policy|Refused to (load|execute|connect|compile|create)/i.test(m.text()) && !/fonts\.g/.test(m.text())) cspErrs.push(m.text()); });
    // a mock Phantom: window.solana with connect + signTransaction, signing with the user's key inside the page
    await page.addInitScript(({ secret, pubkey }) => {
      window.solana = { isPhantom: true, isMock: true, publicKey: { toString: () => pubkey, toBase58: () => pubkey }, connect: async () => ({ publicKey: pubkey }),
        signTransaction: async (tx) => { const kp = window.Veyl.Keypair.fromSecretKey(Uint8Array.from(secret)); if (typeof tx.partialSign === 'function') tx.partialSign(kp); else tx.sign([kp]); return tx; },
        signAllTransactions: async (txs) => { for (const tx of txs) await window.solana.signTransaction(tx); return txs; }, on() {}, removeListener() {} };
    }, { secret: [...user.secretKey], pubkey: user.publicKey.toBase58() });
    // every CSP violation on every page, including ones the page catches itself (reported from the page to the test)
    await page.exposeFunction('veylCspReport', (v) => cspErrs.push(v));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.veylCspReport(e.violatedDirective + ' ' + e.blockedURI + ' ' + (e.sourceFile || '') + ':' + e.lineNumber)));
    await page.goto(WEB + '/app.html'); await sleep(3000);
    check('engine (window.Veyl) and snarkjs loaded in the browser', await page.evaluate(() => !!(window.Veyl && window.Veyl.Engine && window.snarkjs)));
    check('app shows the network label and the no-wallet banner', /Local validator/.test(await page.textContent('#netLbl')) && /No wallet needed/.test(await page.textContent('#stateBanner')));
    await page.screenshot({ path: path.join(SHOTS, 'app-disconnected.png') });
    await page.click('#acctBtn'); await page.click('#dlgBody [data-wal="0"]'); await sleep(3000);
    check('wallet connected through the UI', (await page.textContent('#acctBtn')).includes('…'));
    // ===================================================================== Phase 2: the shielded pool from the app
    const EP = V.signerPda();
    const store = () => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('veyl:')))));
    const dlgText = async () => (await page.textContent('#dlgBody')).replace(/\s+/g, ' ');
    const finish = async () => { await page.waitForSelector('#doneBtn, #errClose', { timeout: 600000 }); const t = await dlgText(); if (await page.$('#doneBtn')) await page.click('#doneBtn'); else { console.log('    dialog error:', t.slice(-400)); await page.click('#errClose'); } await sleep(900); return t; };
    const ready = async (sel = '#actGo') => { try { await page.waitForFunction((s) => { const b = document.querySelector(s); return b && !b.disabled; }, sel, { timeout: 30000 }); return true; } catch { console.log('    not ready:', await page.textContent(sel)); return false; } };
    const openPool = async (id) => { await page.evaluate((h) => { location.hash = h; }, 'pool-' + id); await page.waitForFunction(() => !document.querySelector('#pStats .skel') && /\d/.test(document.querySelector('#pStats').textContent), null, { timeout: 30000 }); await sleep(800); };
    // the tab and the source; Add and Zap keep the exact range (bin presets, shape) under "More options", so open it
    const panel = async (tab, src) => { await page.click('#tabs [data-tab="' + tab + '"]'); await page.click('#srcSeg [data-src="' + src + '"]'); await sleep(300);
      await page.evaluate(() => { const b = document.querySelector('#moreBtn[aria-expanded="false"]'); if (b) b.click(); }); await sleep(100); };
    const toPortfolio = async () => { await page.evaluate(() => { location.hash = 'pools'; }); await sleep(300); await page.click('[data-go="home"]'); await sleep(300); await page.waitForFunction(() => !document.body.dataset.loading && !document.querySelector('#posList .skel'), null, { timeout: 90000 }); await sleep(500); };
    const swapLp = async (xForY, amount) => L.send([await L.swapIx(lp.publicKey, BPX.address, xForY, amount)], [], 1_400_000);
    const proveMs = () => page.evaluate(() => (window.veylEngine.lastProof ? window.veylEngine.lastProof : null));
    const PROVE = { transact: [], position: [], swap: [], claim: [] }; const noteProof = async () => { const p = await proveMs(); if (p) PROVE[p.circuit].push(p.ms); return p; };
    /// the approved-set publisher's job (the relayer admits on a long interval here, so a deposit can be taken back first)
    const approveAll = async () => { const st = await V.readShield(); const P = new Veyl({ connection: conn, programs: V.programs, payer: postman }); let n = 0;
      for (const p of st.pending) { await P.send([V.approveDepositIx(postman.publicKey, p.pending, p.depositor)]); n++; } return n; };
    const mints = Object.fromEntries(Object.values(T).map((t) => [t.mint.toBase58(), { sym: t.sym, decimals: t.decimals }]));
    const friend = new Z.ShieldWallet(require('crypto').randomBytes(32), { mints, pools: [] });
    const scan = async (w) => { const st = await V.readShield(); st.tree = new Z.Tree(st.leaves); w.scan(st); };

    // the Veyl address (spending + viewing public keys) on the portfolio
    await page.click('[data-go="home"]'); await sleep(1200);
    const vaddr = (await page.textContent('#veylAddr code')).trim();
    check('portfolio shows this browser\'s Veyl address (veyl: + spending and viewing public keys) with a copy button', vaddr.startsWith('veyl:') && Z.decodeAddress(vaddr).pk > 0n && !!(await page.$('#veylAddr [data-copy]')), vaddr.slice(0, 24) + '…');
    // deposit 1,000 USDC: the proof is made in the Web Worker, the wallet signs the post + the deposit; it waits for approval
    await page.click('[data-open="deposit"]'); await sleep(600); if (await page.$('#dAck')) { await page.click('#dAck'); await sleep(300); } /* the backup step before a first real deposit: accept the risk */ await page.click('#dA [data-a="USDC"]'); await page.fill('#dAmt', '1000'); await page.click('#dGo');
    await page.waitForSelector('#doneBtn, #errClose', { timeout: 300000 }); const dTxt = await dlgText(); const dp = await noteProof();
    check('shielded deposit through the UI: transact proof made in a Web Worker, wallet-signed', /Deposited 1,?000 USDC/.test(dTxt) && dp && dp.worker === true, dTxt.slice(0, 120) + (dp ? ` (worker proof ${dp.ms} ms)` : ''));
    await page.click('#doneBtn'); await sleep(2500); await toPortfolio();
    const sh1 = await V.shield(); const pend1 = (await V.readShield()).pending;
    check('on chain: 1,000 USDC in the shielded vault, the notes pending outside the tree (depositor + amount public)', pend1.length === 1 && pend1[0].amount === units(1000, 6) && pend1[0].depositor.equals(user.publicKey) && sh1.nextIndex === 0n && BigInt((await conn.getTokenAccountBalance(V.shieldVault(USDC))).value.amount) === units(1000, 6));
    check('portfolio lists the pending deposit with "Take back"', /waiting for a quick automatic check/.test(await page.textContent('#noteList')) && !!(await page.$('#noteList [data-cancel]')));
    // a second deposit, taken back before approval (the depositor's exit; no proof needed)
    await page.click('[data-open="deposit"]'); await sleep(600); if (await page.$('#dAck')) { await page.click('#dAck'); await sleep(300); } await page.click('#dA [data-a="USDC"]'); await page.fill('#dAmt', '25'); await page.click('#dGo'); await page.waitForSelector('#doneBtn, #errClose', { timeout: 300000 }); await page.click('#doneBtn, #errClose'); await sleep(1500); await toPortfolio();
    const w0 = await V.tokenBalance(USDC, user.publicKey); const pend2 = (await V.readShield()).pending.find((p) => p.amount === units(25, 6));
    if (pend2 && (await page.$('#noteList [data-cancel="' + pend2.pending.toBase58() + '"]'))) { await page.click('#noteList [data-cancel="' + pend2.pending.toBase58() + '"]'); var tb = await finish(); } else var tb = 'no take-back button';
    /* only this test's publisher holds the postman key and it admits once an hour here: a deposit admitted anyway means another publisher with that key ran */
    const admitted = (await V.shield()).nextIndex > 0n; if (admitted) tb = 'the deposit was admitted before the take-back: another approved-set publisher with this POSTMAN_KEY is running; ' + tb;
    check('take back a pending deposit from the UI: the wallet gets the 25 USDC back', !admitted && (await V.tokenBalance(USDC, user.publicKey)) - w0 === units(25, 6) && (await V.readShield()).pending.length === 1, tb.slice(0, 160));
    check('the publisher admits the first deposit into the tree', (await approveAll()) === 1 && (await V.shield()).nextIndex === 2n);
    await toPortfolio(); await page.waitForFunction(() => /1,?000/.test(document.querySelector('#balList').textContent), null, { timeout: 30000 }).catch(() => {});
    check('shielded balance shows 1,000 USDC (decrypted from the chain with the viewing key)', /1,?000/.test(await page.textContent('#balList')), await page.textContent('#balList'));
    await page.screenshot({ path: path.join(SHOTS, 'app-shielded.png') });
    // send 200 USDC to another Veyl address: stays inside the pool
    await page.click('[data-open="withdraw"]'); await sleep(500); await page.click('#wA [data-a="USDC"]'); await page.fill('#wAmt', '200'); await page.fill('#wTo', friend.address); await sleep(200);
    const kind = await page.textContent('#wKind'); await page.click('#wGo'); let t = await finish(); const sp = await noteProof(); await scan(friend);
    check('private send to a Veyl address through the UI: the receiver decrypts a 200 USDC note; no amount on chain', /Sent 200(\.0+)? USDC/.test(t) && /stays private/.test(kind) && friend.balance(USDC) === units(200, 6), t.slice(0, 120) + (sp ? ` (worker proof ${sp.ms} ms)` : ''));
    // send 300 USDC to a fresh Solana address: leaves the pool (amount + receiver public)
    const fresh = Keypair.generate().publicKey; const rel0 = await V.tokenBalance(USDC, relayer.publicKey);
    await page.click('[data-open="withdraw"]'); await sleep(500); await page.click('#wA [data-a="USDC"]'); await page.fill('#wAmt', '300'); await page.fill('#wTo', fresh.toBase58()); await page.click('#wGo'); t = await finish(); await noteProof();
    check('private withdrawal to a fresh wallet: it receives exactly 300 USDC; the relayer earned its flat fee', /Sent 300(\.0+)? USDC/.test(t) && (await V.tokenBalance(USDC, fresh)) === units(300, 6) && (await V.tokenBalance(USDC, relayer.publicKey)) > rel0, t.slice(0, 120));
    await page.click('[data-open="withdraw"]'); await sleep(400); await page.click('#wA [data-a="USDC"]'); await page.fill('#wAmt', '10'); await page.fill('#wTo', user.publicKey.toBase58()); await page.click('#wGo');
    await page.waitForSelector('#errClose', { timeout: 60000 }); check('UI refuses to send to the depositing wallet', /deposited from/.test(await page.textContent('#dlgBody'))); await page.click('#errClose'); await sleep(300);
    // private swap 300 USDC -> SOL from shielded notes
    await page.click('[data-go="swap"]'); await sleep(800);
    await page.click('#swTokIn'); await sleep(300); await page.click('[data-pick="USDC"]'); await sleep(300);
    await page.click('#swTokOut'); await sleep(300); await page.click('[data-pick="SOL"]'); await sleep(300);
    await page.fill('#swIn', '300'); await sleep(4000);
    const q = await page.inputValue('#swOut'); check('live quote from the bin pool on the device: ' + q + ' SOL', parseFloat(q) > 1.8 && parseFloat(q) < 2.1);
    await page.screenshot({ path: path.join(SHOTS, 'app-swap.png') });
    await page.click('#swGo'); console.log('  proving the swap...', lap()); t = await finish();
    check('private swap through the UI into a shielded SOL note', /Got [12]\.\d+ SOL/.test(t), t.slice(0, 160));
    await toPortfolio(); const bl = await page.textContent('#balList');
    check('portfolio shows both shielded balances (SOL from the swap\'s receipt note)', /SOL/.test(bl) && /USDC/.test(bl), bl);
    await page.screenshot({ path: path.join(SHOTS, 'app-portfolio.png') });
    const bak = await store();
    check('the shielded account (one seed: spending, viewing and one-time keys) is stored locally; no note list is needed to recover', !!(bak.shield && bak.shield.seed && bak.shield.seed.length >= 32), (bak.shield ? Object.keys(bak.shield).join(',') : 'no shield'));

    // ===================================================================== pools: list, pool page, positions, orders
    await page.evaluate(() => { location.hash = 'pools'; }); await page.waitForFunction(() => document.querySelectorAll('#poolRows tr[data-pool]').length === 5 && !document.querySelector('#poolRows .skel'), null, { timeout: 30000 });
    const solRow = await page.textContent('#poolRows tr[data-pool="sol-usdc"]');
    check('pools list: 5 pools from the deployment, SOL–USDC with its live fee, price and liquidity from the chain, every pool marked Private', /0\.05%/.test(solRow) && /1[45]\d\.\d+/.test(solRow) && (await page.$$eval('#poolRows tr[data-pool]', (r) => r.filter((x) => /Private/.test(x.textContent)).length)) === 5, solRow.replace(/\s+/g, ' '));
    await page.fill('#poolQ', 'bonk'); await sleep(300); const nCash = await page.$$eval('#poolRows tr[data-pool]', (r) => r.length); await page.fill('#poolQ', '');
    await page.fill('#poolQ', 'usdt'); await sleep(300); const nUsdt = await page.$$eval('#poolRows tr[data-pool]', (r) => r.map((x) => x.dataset.pool).join(','));
    await page.fill('#poolQ', ''); await page.click('#poolHead th[data-sort="liq"]'); await sleep(300); const first = await page.$eval('#poolRows tr[data-pool]', (r) => r.dataset.pool);
    check('pools list: search by pair or token, and sort by liquidity (the seeded pool first)', nCash === 1 && (nUsdt === 'sol-usdt,usdt-usdc' || nUsdt === 'usdt-usdc,sol-usdt') && first === 'sol-usdc', `cash ${nCash} · USDT ${nUsdt} · top ${first}`);
    await page.screenshot({ path: path.join(SHOTS, 'app-pools-live.png') });
    await page.click('#poolRows tr[data-pool="sol-usdc"]'); await page.waitForFunction(() => document.querySelectorAll('#binChart rect[data-bin]').length > 60, null, { timeout: 30000 }); await sleep(800);
    const bars = await page.$$eval('#binChart rect[data-bin]', (r) => r.filter((x) => parseFloat(x.getAttribute('height')) > 0).map((x) => +x.dataset.bin));
    const bp0 = await V.binPool(BPX.address);
    check('pool page: liquidity histogram drawn from the chain (seeded bins around the active one, active highlighted)', bars.length >= 13 && bars.includes(bp0.activeId) && (await page.$('#binChart rect[data-bin="' + bp0.activeId + '"][fill="var(--act)"]')) !== null, bars.join(','));
    await page.screenshot({ path: path.join(SHOTS, 'app-pool-live.png'), fullPage: true });

    // public add (wallet), unchanged from Phase 1
    await panel('add', 'pub'); await page.click('#presets [data-w="5"]'); await page.fill('#amtX', '0.5'); await page.fill('#amtY', '100'); await sleep(400);
    const prevPath = await page.$eval('#binChart path', (p) => p.getAttribute('d')).catch(() => '');
    check('add panel: the shape preview (SDK shapeWeights) is drawn over the 11-bin range', /^M/.test(prevPath) && (await page.$$eval('#mini rect', (r) => r.length)) === 11);
    if (await ready()) { await page.click('#actGo'); t = await finish(); }
    let st = await store(); const pubPos = st.positions.find((x) => x.kind === 'public');
    let pv = pubPos && (await V.position(BPX.address, pubPos.owner, user.publicKey, pubPos.ids));
    check('public add through the UI: wallet-signed, an 11-bin position owned by (one-time id, your wallet)', /Position added/.test(t) && pubPos && pubPos.ids.length === 11 && pv.value.x > 0n && pv.value.y > 0n, t);
    // shielded add: legs from hidden SOL + USDC notes, a position proof; shares minted exactly into the shielded aggregate
    const aggOf = async () => { const ps = await page.evaluate(() => window.veylEngine.shieldPositions().map((p) => ({ id: p.id, lo: p.windowLo, shares: p.note.shares.map(String) }))); return ps; };
    await panel('add', 'priv'); await page.click('#presets [data-w="5"]'); await page.fill('#amtX', '0.4'); await page.fill('#amtY', '60'); await sleep(300);
    console.log('  proving a shielded add (2 legs + position)...', lap()); if (await ready()) { await page.click('#actGo'); t = await finish(); } await noteProof();
    let zps = await aggOf(); const zp = zps[0];
    const aggOnChain = zp && (await V.aggregateOf(BPX.address, zp.lo));
    check('shielded add through the UI: two hidden-amount legs + a position proof; the aggregate holds exactly the note\'s shares', /Position added/.test(t) && /not who added it or how big your position is/.test(t) && zp && aggOnChain.every((s, i) => s === BigInt(zp.shares[i])) && zp.shares.some((s) => s !== '0'), t.slice(0, 140) + ' ' + lap());
    check('on chain the shares belong to the shielded owner PDA (never a wallet or a one-time key)', !!(await V.shareAccount(BPX.address, V.shieldOwner(), EP, S.chunkOf(zp.lo))));
    // public zap (wallet)
    await panel('zap', 'pub'); await page.click('#zapSeg [data-z="y"]'); await page.click('#presets [data-w="5"]'); await page.fill('#zapAmt', '100'); await sleep(1500);
    const zprev = await page.textContent('#zapPrev');
    check('zap panel: planZap preview of the internal swap', /USDC → [\d.]+ SOL/.test(zprev), zprev);
    if (await ready()) { await page.click('#actGo'); t = await finish(); }
    st = await store(); const pz = st.positions.filter((x) => x.zap && x.kind === 'public')[0]; pv = pz && (await V.position(BPX.address, pz.owner, user.publicKey, pz.ids));
    check('public zap: 100 USDC in -> part swapped to SOL inside the pool -> both sides in the bins', /Zapped in/.test(t) && pz && pv.value.x > 0n && pv.value.y > 0n, t);
    // limit orders: a public sell above the price, a shielded buy below it
    await panel('limit', 'pub'); await page.click('#ordSeg [data-o="sell"]'); await sleep(300); await page.fill('#ordAmt', '0.2'); await sleep(300);
    if (await ready()) { await page.click('#actGo'); t = await finish(); }
    st = await store(); const po = st.orders.find((o) => o.kind === 'public'); let oi = po && (await V.position(BPX.address, po.owner, user.publicKey, [po.binId]));
    check('public limit order (sell SOL 3 bins above the price) placed from the wallet', /Order placed/.test(t) && po && po.isAsk && oi.orders.length === 1 && oi.orders[0].unfilledX >= units(0.1999, 9), t);
    await panel('limit', 'priv'); await page.click('#ordSeg [data-o="buy"]'); await sleep(300); await page.fill('#ordAmt', '30'); await sleep(300);
    console.log('  proving a shielded order...', lap()); if (await ready()) { await page.click('#actGo'); t = await finish(); } await noteProof();
    st = await store(); const qo = (st.shield.orders || [])[0];
    check('shielded limit order (buy SOL 3 bins below) from hidden USDC notes, held by the aggregate; an order note on this device', /Order placed/.test(t) && qo && !qo.isAsk && (await page.evaluate((o) => window.veylEngine.zw.orderNotes(o.pool, o.binId, o.isAsk).length, qo)) === 1, t.slice(0, 120) + ' ' + lap());
    await page.screenshot({ path: path.join(SHOTS, 'app-pool-positions.png'), fullPage: true });

    // trading: the LP sells SOL down through the shielded bid (filling it), then buys back; positions earn fees
    { const pl = await V.binPool(BPX.address); const bins = await V.bins(BPX.address, S.chunksForSwap(pl, true)); let a = units(1, 9);
      for (let k = 0; k < 120; k++) { let sim = null; try { sim = S.simulateSwap(pl, bins, true, a, Math.floor(Date.now() / 1000)); } catch {} if (sim && sim.endId < qo.binId) break; a += units(1, 9); }
      await swapLp(true, a); await swapLp(false, units(1500, 6)); await swapLp(true, units(2, 9)); }
    oi = await V.position(BPX.address, V.shieldOwner(), EP, [qo.binId]);
    check('the shielded bid is filled on chain by a public swap through its bin', oi.orders.length >= 1 && oi.orders[0].filled && oi.orders[0].filledX > 0n);
    // shielded zap (one USDC note): its harvest also books the fees the trades left in the aggregate's bins
    await openPool('sol-usdc'); await panel('zap', 'priv'); await page.click('#zapSeg [data-z="y"]'); await page.click('#presets [data-w="5"]'); await page.fill('#zapAmt', '40'); await sleep(1500);
    console.log('  proving a shielded zap...', lap()); if (await ready()) { await page.click('#actGo'); t = await finish(); } await noteProof();
    zps = await aggOf();
    check('shielded zap through the UI: one USDC note -> a two-sided shielded position (size hidden)', /Zapped in/.test(t) && /held privately: nobody can see how big it is/.test(t) && zps.length >= 1, t.slice(0, 140) + ' ' + lap());

    // portfolio: shielded + public positions and orders
    await toPortfolio();
    const pos0 = await page.textContent('#posList'), ord0 = await page.textContent('#ordList');
    check('portfolio: shielded and public positions with range and status; shielded ones say rewards are not earned', /Private/.test(pos0) && /Public/.test(pos0) && /In range|Out of range/.test(pos0) && /Not earned while shielded|not earn/i.test(pos0), pos0.replace(/\s+/g, ' ').slice(0, 200));
    await page.waitForFunction(() => /Filled/.test(document.querySelector('#ordList').textContent), null, { timeout: 30000 }).catch(() => {}); const ord1 = await page.textContent('#ordList');
    check('portfolio: the shielded bid shows Filled, the public ask Open', /Filled/.test(ord1) && /Open/.test(ord1), ord1.replace(/\s+/g, ' ').slice(0, 200));
    await page.screenshot({ path: path.join(SHOTS, 'app-portfolio-live.png'), fullPage: true });

    // withdraw the orders: shielded (spends the order note -> receipt notes), public (wallet)
    const sol0 = await V.tokenBalance(SOL, user.publicKey); const solZ0 = await page.evaluate(() => String(window.veylEngine.shieldBalance('SOL')));
    await page.click('#ordList [data-ow="' + qo.id + '"]'); await sleep(400); await page.click('#oGo'); t = await finish(); await noteProof();
    const solZ1 = await page.evaluate(() => String(window.veylEngine.shieldBalance('SOL')));
    check('shielded order withdrawal: the order note is spent (a transact proof on its virtual asset); the SOL it bought returns as a shielded note', /Order withdrawn/.test(t) && BigInt(solZ1) > BigInt(solZ0) && (await page.evaluate((o) => window.veylEngine.zw.orderNotes(o.pool, o.binId, o.isAsk).length, qo)) === 0, t.slice(0, 140));
    await page.click('#ordList [data-ow="' + po.id + '"]'); await sleep(400); await page.click('#oGo'); t = await finish();
    check('public order withdrawal: the unfilled SOL back to the wallet', /Order withdrawn/.test(t) && (await V.tokenBalance(SOL, user.publicKey)) > sol0, t);

    // claim fees: public, then shielded (amounts hidden; the relayer's flat fee comes out of the claim)
    await toPortfolio(); const usdc0 = await V.tokenBalance(USDC, user.publicKey);
    pv = await V.position(BPX.address, pubPos.owner, user.publicKey, pubPos.ids);
    await page.click('#posList [data-pa="claim"][data-id="' + pubPos.id + '"]'); await sleep(400); await page.click('#cGo'); t = await finish();
    check('public fee claim: the wallet receives the position\'s unclaimed fees', /Fees claimed/.test(t) && ((await V.tokenBalance(USDC, user.publicKey)) > usdc0 || (await V.tokenBalance(SOL, user.publicKey)) > sol0) && (pv.fees.x > 0n || pv.fees.y > 0n), t);
    await toPortfolio(); const zId = zp.id; const zb0 = await page.evaluate(() => [String(window.veylEngine.shieldBalance('SOL')), String(window.veylEngine.shieldBalance('USDC'))]);
    await page.click('#posList [data-pa="claim"][data-id="' + zId + '"]'); await sleep(400); await page.click('#cGo'); t = await finish(); await noteProof();
    const zb1 = await page.evaluate(() => [String(window.veylEngine.shieldBalance('SOL')), String(window.veylEngine.shieldBalance('USDC'))]);
    check('shielded fee claim: one position proof; the fees land as hidden notes (no amount on chain)', /Fees claimed/.test(t) && (BigInt(zb1[0]) > BigInt(zb0[0]) || BigInt(zb1[1]) > BigInt(zb0[1])), t.slice(0, 160));
    // farm reward (public position)
    await toPortfolio(); const rw0 = await V.tokenBalance(T.USDT.mint, user.publicKey);
    if (await page.$('#posList [data-pa="reward"][data-id="' + pubPos.id + '"]')) { await page.click('#posList [data-pa="reward"][data-id="' + pubPos.id + '"]'); await sleep(400); await page.click('#rGo'); t = await finish(); } else t = 'no reward button';
    check('farm reward claim (public position): USDT paid to the wallet', /Rewards claimed/.test(t) && (await V.tokenBalance(T.USDT.mint, user.publicKey)) > rw0, t);

    // rebalance the shielded position inside its 16-bin window: one proof, burn + exact mint
    await toPortfolio();
    await page.click('#posList [data-pa="rebalance"][data-id="' + zId + '"]'); await ready('#rbGo'); const rbN = +(await page.textContent('#rbN')); await page.click('#rbGo'); t = await finish(); await noteProof();
    const zall = await aggOf(); const live = zall.filter((x) => x.shares.some((v) => v !== '0'));
    let aggOk = live.length >= 1; for (const x of live) { const a = await V.aggregateOf(BPX.address, x.lo); aggOk = aggOk && a.every((v, i) => v >= BigInt(x.shares[i])); }
    check('shielded rebalance: position proofs move the shares around the price (inside the 16-bin window: one proof; across windows: remove + add); the aggregate covers every note', /Rebalanced/.test(t) && aggOk && rbN >= 3, t.slice(-160) + ' · notes ' + zall.map((x) => x.lo + ':' + x.shares.filter((v) => v !== '0').length + ' bins').join(', '));
    const zW = live[0].id;

    // withdraw: public 50% (wallet), shielded 100% (receipts -> shielded balance)
    await toPortfolio(); const pv1 = await V.position(BPX.address, pubPos.owner, user.publicKey, pubPos.ids);
    await page.click('#posList [data-pa="withdraw"][data-id="' + pubPos.id + '"]'); await sleep(400); await page.click('#wdPct [data-p="50"]'); await page.click('#wdGo'); t = await finish();
    const pv2 = await V.position(BPX.address, pubPos.owner, user.publicKey, pubPos.ids);
    check('public withdrawal of 50%: half the shares burned, tokens to the wallet', /Withdrew 50%/.test(t) && pv2.value.y < pv1.value.y && pv2.value.y > 0n, t);
    await toPortfolio(); if (!(await page.waitForSelector('#posList [data-pa="withdraw"][data-id="' + zW + '"]', { timeout: 20000 }).catch(() => null))) console.log('    posList:', (await page.textContent('#posList')).replace(/\s+/g, ' ').slice(0, 600), JSON.stringify(await page.evaluate(() => window.veylEngine.shieldPositions().map((p) => p.id))));
    await page.click('#posList [data-pa="withdraw"][data-id="' + zW + '"]'); await sleep(400); await page.click('#wdGo'); t = await finish(); await noteProof();
    const zl = (await aggOf()).find((x) => x.id === zW);
    check('shielded withdrawal of 100%: the note\'s shares burned from the aggregate, proceeds back as shielded notes', /Withdrew 100%/.test(t) && /private balance/.test(t) && (!zl || zl.shares.every((s) => s === '0')), t.slice(0, 160));
    await page.screenshot({ path: path.join(SHOTS, 'app-portfolio-after.png'), fullPage: true });

    // encrypted backup -> clear the browser -> restore (the seed brings back every shielded note and position)
    st = await store(); await toPortfolio(); const balBefore = await page.textContent('#balList');
    await page.click('#bkBanner [data-backup="export"]'); await sleep(300); await page.fill('#bkP1', 'violet harbour 42'); await page.fill('#bkP2', 'violet harbour 42');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#bkGo')]); const bkFile = path.join(dir, 'backup.json'); await dl.saveAs(bkFile); await page.waitForSelector('#doneBtn'); await page.click('#doneBtn');
    const bk = fs.readFileSync(bkFile, 'utf8'); const bkj = JSON.parse(bk);
    check('backup: an encrypted file (PBKDF2 + AES-GCM); the shielded seed and position keys are not in clear', bkj.veyl === 'backup' && bkj.cipher === 'AES-256-GCM' && !bk.includes(st.shield.seed) && !/nullifier|secret|"key"|seed/.test(bk));
    await page.evaluate(() => localStorage.clear()); await page.reload(); await sleep(3000); await page.click('#acctBtn'); await page.click('#dlgBody [data-wal="0"]'); await sleep(2500); await toPortfolio();
    const emptyBal = await page.textContent('#balList'); const addrNew = (await page.textContent('#veylAddr code')).trim();
    await page.click('#bkBanner [data-backup="import"]'); await sleep(300); await page.setInputFiles('#rsFile', bkFile); await page.fill('#rsP', 'wrong passphrase'); await page.click('#rsGo'); await sleep(4000);
    const wrong = await page.textContent('#rsErr');
    await page.fill('#rsP', 'violet harbour 42'); await page.click('#rsGo'); await page.waitForSelector('#doneBtn', { timeout: 60000 }); t = await dlgText(); await page.click('#doneBtn'); await toPortfolio(); await sleep(1500);
    const balAfter = await page.textContent('#balList'); const addrBack = (await page.textContent('#veylAddr code')).trim();
    check('restore: a wrong passphrase is refused; the right one restores the shielded account (same Veyl address, balances rescanned from the chain)', /Wrong passphrase/.test(wrong) && /Restored/.test(t) && addrNew !== vaddr && addrBack === vaddr && !/USDC/.test(emptyBal) && /USDC/.test(balAfter) && balAfter.replace(/\s+/g, '') === balBefore.replace(/\s+/g, ''), `${balBefore.replace(/\s+/g, ' ')} -> ${balAfter.replace(/\s+/g, ' ')}; ${wrong}`);
    await page.screenshot({ path: path.join(SHOTS, 'app-portfolio-restored.png'), fullPage: true });
    const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
    console.log('  browser proving (Web Worker, ms): transact', JSON.stringify(PROVE.transact), 'avg', avg(PROVE.transact), '· position', JSON.stringify(PROVE.position), 'avg', avg(PROVE.position));
    fs.writeFileSync(path.join(SHOTS, 'proving.json'), JSON.stringify({ transact: PROVE.transact, position: PROVE.position, avg: { transact: avg(PROVE.transact), position: avg(PROVE.position) } }, null, 1));
    // ===================================================================== Phase 3: sealed batch swaps in the browser
    // three committee node processes run the dealerless DKG and are registered; six separate browser users (their own
    // shielded accounts) seal swaps into ONE batch from the pool page (three per direction, proofs in each page's Web
    // Worker); the nodes close it, prove their partial decryptions on chain and settle it; every user claims in the UI.
    // Then a lone seller in a pool that allows no rollover is refunded from the UI.
    { const { startLocalCommittee } = require('../scripts/committee-local.js'); const SE = require('../sdk/sealed.js'); const J = require('../sdk/bjj.js'); const { proveTransact } = require('../sdk/prover.js');
      const POOL = new PublicKey(BPX.address); const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-e2e-committee-'));
      const cmt = await startLocalCommittee({ n: 3, t: 2, dir: cdir, deployFile: path.join(ROOT, 'deploy.local.json'), rpc, env: { WATCH_MS: '1500', BSGS_BITS: '40' } });
      try {
        for (const k of cmt.keys) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
        await V.send([V.initCommitteeIx(payer.publicKey)]); await V.send([V.setCommitteeIx(payer.publicKey, cmt.registration)], [], 1_400_000);
        const health = await Promise.all(cmt.peers.map(async (p) => (await fetch(p.url + '/health')).json()));
        check('three committee nodes ran the dealerless key generation over HTTP and the authority registered their joint key (2 of 3)', health.every((h) => h.dkg === 'done' && h.pk === health[0].pk) && J.eq((await V.committee()).pk, cmt.registration.pk));
        const params = { epochSlots: 1200, settleTimeout: 900, minIn: [units(0.01, 9), units(1, 6)], kMin: 3, maxRollovers: 2, maxDrift: 60 };
        // users: six separate browser contexts, each with its own shielded account
        const users = []; const userErrs = [];
        for (let i = 0; i < 6; i++) { const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.addInitScript(DEVNET); await mockMarket(ctx); const pg = await ctx.newPage();
          pg.on('pageerror', (e) => userErrs.push(e.message)); pg.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::ERR|fonts\.g/.test(m.text())) userErrs.push(m.text()); });
          await pg.goto(WEB + '/app.html'); await pg.waitForFunction(() => window.veylEngine && window.veylEngine.zw, null, { timeout: 30000 }); users.push({ ctx, pg, dir: i < 3 ? 0 : 1, addr: await pg.evaluate(() => window.veylEngine.veylAddress()) }); }
        // fund them privately: a faucet account deposits once (Node proofs), then sends each user a hidden note
        const faucet = new Z.ShieldWallet(require('crypto').randomBytes(32), { mints, pools: [] });
        await fund(conn, payer, SOL, payer.publicKey, units(20, 9)); await fund(conn, payer, USDC, payer.publicKey, units(5_000, 6));
        for (const [m, a] of [[SOL, units(12, 9)], [USDC, units(3_000, 6)]]) { await scan(faucet); const d = faucet.deposit(m, a); const pr = await proveTransact(d.input); await V.send([V.postProofIx(payer.publicKey, 1, pr.proof, pr.pubs)], [], 1_400_000); await V.send([await V.shieldDepositIx(payer.publicKey, d.ext, pr.pubs)], [], 600_000); await approveAll(); }
        const R2 = new Veyl({ connection: conn, programs: V.programs, payer: relayer }); R2.lookupTable = V.lookupTable;
        for (const u of users) { await scan(faucet); const t2 = faucet.spend({ mint: u.dir === 0 ? SOL : USDC, send: u.dir === 0 ? units(3, 9) : units(600, 6), to: u.addr, hideToken: true }); const pr = await proveTransact(t2.input);
          await R2.send([V.postProofIx(relayer.publicKey, 1, pr.proof, pr.pubs)], [], 1_400_000); await R2.sendV0([await V.shieldTransactIx(relayer.publicKey, t2.ext, pr.pubs)], [], 600_000); }
        // sealed swaps for the pool, batch 0 open from now (a long first epoch: six browser proofs one after another, each a few
        // tens of seconds while the other five pages poll)
        await V.send([V.initSealedPoolIx(payer.publicKey, POOL, params)]); const seq = 0n;
        const sizes = [['0.8', '1.25', '0.4'], ['95', '210.5', '60']];
        const openSeal = async (pg) => { await pg.evaluate(() => { location.hash = 'pools'; }); await sleep(300); await pg.evaluate((h) => { location.hash = h; }, 'pool-sol-usdc'); await pg.waitForFunction(() => !document.querySelector('#pStats .skel') && /\d/.test(document.querySelector('#pStats').textContent), null, { timeout: 30000 });
          await pg.click('#tabs [data-tab="swap"]'); await pg.waitForFunction(() => !document.querySelector('#swMode').hidden, null, { timeout: 20000 }); await sleep(400); };
        const finishOn = async (pg) => { await pg.waitForSelector('#doneBtn, #errClose', { timeout: 600000 }); const tx = (await pg.textContent('#dlgBody')).replace(/\s+/g, ' '); if (await pg.$('#doneBtn')) await pg.click('#doneBtn'); else { console.log('    dialog error:', tx.slice(-300)); await pg.click('#errClose'); } await sleep(600); return tx; };
        const SW = []; let firstShot = false;
        for (const [k, u] of users.entries()) { const pg = u.pg; await pg.reload(); await pg.waitForFunction(() => window.veylEngine && window.veylEngine.zw, null, { timeout: 30000 }); await openSeal(pg);
          const mode = await pg.evaluate(() => [...document.querySelectorAll('#swMode [data-m]')].map((b) => b.dataset.m + ':' + b.getAttribute('aria-pressed') + ':' + b.textContent).join('|'));
          if (k === 0) check('pool page, Swap: "Sealed" is the default mode while the pool has an open batch; "Instant" stays available and says what it reveals', /sealed:true/.test(mode) && /instant:false:.*amount is public at the pool/i.test(mode) && /until it closes/.test(await pg.textContent('#sealBox')), mode.replace(/\s+/g, ' ').slice(0, 140));
          if ((u.dir === 1) !== !(await pg.evaluate(() => document.querySelector('#pswTkIn').textContent.includes('SOL')))) await pg.click('#pswFlip');
          await pg.fill('#pswIn', sizes[u.dir][k % 3]); await sleep(1500);
          if (!firstShot) { await pg.screenshot({ path: path.join(SHOTS, 'sealed-panel.png') }); firstShot = true; }
          const ok = await (async () => { try { await pg.waitForFunction(() => { const b = document.querySelector('#actGo'); return b && !b.disabled; }, null, { timeout: 60000 }); return true; } catch { console.log('    not ready:', await pg.textContent('#actGo')); return false; } })();
          if (k === 0) { const sn = (await pg.textContent('#actSeen')).replace(/\s+/g, ' '); check('the sealed form says what stays hidden (this swap\'s size, encrypted to the committee) and what is public (that a swap joined the batch; its totals and clearing price after settlement)', /size/.test(sn) && /encrypted on this device/.test(sn) && /totals/.test(sn) && /clearing price/.test(sn), sn.slice(0, 160)); }
          await pg.click('#actGo'); const tx = await finishOn(pg); const lp2 = await pg.evaluate(() => window.veylEngine.lastProof);
          SW.push({ u, text: tx, ms: lp2 && lp2.circuit === 'swap' ? lp2.ms : null, ok });
          if (k === 0) await pg.screenshot({ path: path.join(SHOTS, 'sealed-submitted.png') }); }
        PROVE.swap = SW.map((x) => x.ms).filter(Boolean);
        // from the next batch on: shorter epochs and no rollover (the refund case below)
        await V.send([V.setSealedParamsIx(payer.publicKey, POOL, { ...params, epochSlots: 150, maxRollovers: 0 })]);
        let b = await V.batch(POOL, seq);
        check('six users sealed swaps into batch 0 from the browser (3 sell SOL, 3 sell USDC), each proof made in its page\'s Web Worker', SW.every((x) => /Sealed into batch 0/.test(x.text)) && b.count[0] === 3 && b.count[1] === 3, 'browser swap proofs ' + PROVE.swap.join('/') + ' ms');
        { const pg = users[0].pg; await sleep(4500); const row = (await pg.textContent('#pSeal')).replace(/\s+/g, ' ');
          check('the user\'s sealed swap shows as Submitted, waiting for its batch; the batch card shows sellers per side, never amounts', /Submitted/.test(row) && /waiting for it to close/.test(row) && /Selling SOL\s*3/.test((await pg.textContent('#sealBox')).replace(/\s+/g, ' ')), row.slice(0, 120));
          await pg.screenshot({ path: path.join(SHOTS, 'sealed-waiting-open.png') }); }
        // the relayer carried six swaps and saw no amount
        { const rs = await conn.getSignaturesForAddress(relayer.publicKey, { limit: 40 }); let leaks = 0, seen = 0;
          for (const s2 of rs) { const t2 = await conn.getTransaction(s2.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!t2 || !(t2.meta.logMessages || []).some((l) => /submit_swap|SubmitSwap/i.test(l))) continue; seen++;
            const raw = Buffer.from(t2.transaction.message.serialize()).toString('hex'); for (const v of [units(0.8, 9), units(1.25, 9), units(95, 6), units(210.5, 6)]) if (raw.includes(S.u64(v).toString('hex'))) leaks++; }
          check('the relayer submitted the six sealed swaps; no swap amount appears in any of its transactions', seen === 6 && leaks === 0, `${seen} submit_swap transactions`); }
        // the epoch ends: the nodes close, decrypt (shares checked on chain) and settle on their own
        const tClose = Date.now(); let sawSealed = false; const mob = await users[3].ctx.browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await users[3].ctx.storageState() }); await mob.addInitScript(DEVNET); await mockMarket(mob); const mp = await mob.newPage();
        await mp.goto(WEB + '/app.html#pool-sol-usdc'); await mp.waitForFunction(() => window.veylEngine && document.querySelectorAll('#binChart rect[data-bin]').length > 30, null, { timeout: 30000 }); await sleep(1500);
        await mp.click('[data-sheet="swap"]'); await sleep(900); await mp.screenshot({ path: path.join(SHOTS, 'm-sealed-panel.png') }); await mp.click('#panelX'); await sleep(300);
        // the budget is counted from the epoch's end slot, not from the last swap: a loaded validator makes slots slower than 400 ms
        for (let dl = Date.now() + 600e3; b.state !== 'settled' && Date.now() < dl;) { await sleep(1000); b = await V.batch(POOL, seq); if (b.state === 'open' && BigInt(await conn.getSlot('confirmed')) < b.endSlot) dl = Date.now() + 600e3;
          if (b.state === 'closed' && !sawSealed) { sawSealed = true; await users[0].pg.waitForFunction(() => /Waiting for the batch/.test(document.querySelector('#pSeal').textContent), null, { timeout: 15000 }).catch(() => {}); await users[0].pg.screenshot({ path: path.join(SHOTS, 'sealed-waiting-batch.png') }); await mp.screenshot({ path: path.join(SHOTS, 'm-sealed-waiting.png'), fullPage: false }); } }
        const hs = await Promise.all(cmt.peers.map(async (p) => (await fetch(p.url + '/health')).json()));
        check('the committee nodes closed batch 0, proved their partial decryptions on chain and settled it (totals public, individual sizes never decrypted)', b.state === 'settled' && b.totals[0] === units(2.45, 9) && b.totals[1] === units(365.5, 6) && hs.filter((h) => h.lastShare).length >= 2, `${Math.round((Date.now() - tClose) / 1000)} s from the last swap; ${b.count.join(' + ')} sellers; net ${b.xForY ? 'SOL->USDC' : 'USDC->SOL'} ${b.netIn} -> ${b.netOut}`);
        // every user claims from the UI
        const feeQ = async (sym) => BigInt((await (await fetch('http://127.0.0.1:' + RELAYER_PORT + '/fee', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'sealedClaim', mint: T[sym].mint.toBase58() }) })).json()).fee);
        const claims = [];
        for (const [k, u] of users.entries()) { const pg = u.pg; const other = u.dir === 0 ? 'USDC' : 'SOL';
          await pg.waitForFunction(() => document.querySelector('#pSeal [data-sc]'), null, { timeout: 30000 }).catch(() => {});
          if (k === 0) { await sleep(4500); await pg.screenshot({ path: path.join(SHOTS, 'sealed-settled-claim.png') }); } // one poll later: the batch card has caught up with the row
          const before = await pg.evaluate((sym) => String(window.veylEngine.shieldBalance(sym)), other); const fee = await feeQ(other);
          await pg.click('#pSeal [data-sc]'); const tx = await finishOn(pg); await pg.waitForFunction(([sym, b0]) => String(window.veylEngine.shieldBalance(sym)) !== b0 || (window.veylEngine.shieldSync(), false), [other, before], { timeout: 20000, polling: 1000 }).catch(() => {}); const after = await pg.evaluate((sym) => String(window.veylEngine.shieldBalance(sym)), other);
          const amt = units(Number(sizes[u.dir][k % 3]), u.dir === 0 ? 9 : 6); const want = (amt * b.num[u.dir]) / b.den[u.dir] - fee; const lp3 = await pg.evaluate(() => window.veylEngine.lastProof);
          claims.push({ ok: /Claimed/.test(tx) && BigInt(after) - BigInt(before) === want, ms: lp3 && lp3.circuit === 'claim' ? lp3.ms : null, d: [/Claimed/.test(tx), String(BigInt(after) - BigInt(before)), String(want)].join(':') });
          if (k === 0) { await sleep(4500); await pg.screenshot({ path: path.join(SHOTS, 'sealed-claimed.png') }); } }
        PROVE.claim = claims.map((x) => x.ms).filter(Boolean);
        check('six claims from the UI: each user\'s shielded balance grows by exactly floor(amount x num / den) - the relayer\'s fee (claim proofs in the Web Worker)', claims.every((c) => c.ok) && (await V.batch(POOL, seq)).claims.every((c) => c === 3), (claims.every((c) => c.ok) ? '' : ' · failing ' + claims.map((c, i) => (c.ok ? '' : i + '=' + c.d)).filter(Boolean).join(' ')) + ' · batch claims ' + (await V.batch(POOL, seq)).claims.join('/') + ' · ms ' + PROVE.claim.join('/'));
        // refund in the UI: a lone seller in a batch with no rollover left fails at close and is refunded
        let st = await V.sealedState(POOL); if (st.batch.endSlot - BigInt(st.slot) < 60n) { while (BigInt(await conn.getSlot('confirmed')) < st.batch.endSlot) await sleep(1000); for (let i = 0; i < 30; i++) { await sleep(1000); st = await V.sealedState(POOL); if (st.batch.endSlot > BigInt(st.slot) + 60n) break; } } // the nodes extend the empty batch
        { const u = users[1]; const pg = u.pg; await openSeal(pg); await pg.fill('#pswIn', '0.5'); await sleep(1200); await pg.waitForFunction(() => { const x = document.querySelector('#actGo'); return x && !x.disabled; }, null, { timeout: 60000 }); await pg.click('#actGo'); await finishOn(pg);
          const seq2 = (await V.sealedState(POOL)).batch.seq; for (let dl = Date.now() + 240e3; Date.now() < dl;) { const x = await V.batch(POOL, seq2); if (x.state === 'failed') break; if (x.state === 'open' && BigInt(await conn.getSlot('confirmed')) < x.endSlot) dl = Date.now() + 240e3; await sleep(1000); }
          await pg.waitForFunction(() => /Refund/.test(document.querySelector('#pSeal').textContent) && document.querySelector('#pSeal [data-sc]'), null, { timeout: 30000 }).catch(() => {}); await pg.screenshot({ path: path.join(SHOTS, 'sealed-refund.png') });
          await mp.goto(WEB + '/app.html#pool-sol-usdc'); await sleep(2500); await mp.screenshot({ path: path.join(SHOTS, 'm-sealed-rows.png'), fullPage: true });
          const before = await pg.evaluate(() => String(window.veylEngine.shieldBalance('SOL'))); const fee = await feeQ('SOL'); await pg.click('#pSeal [data-sc]'); const tx = await finishOn(pg); const after = await pg.evaluate(() => String(window.veylEngine.shieldBalance('SOL')));
          check('a lone seller (the side is under the k-floor, no rollover left): the batch fails at close; the UI shows Refund; the refund returns the SOL as a hidden note (minus the relayer\'s fee)', /Refunded/.test(tx) && BigInt(after) - BigInt(before) === units(0.5, 9) - fee && (await V.batch(POOL, seq2)).state === 'failed'); }
        check('phone (390 px) with sealed swaps: the pool page and sheet fit without horizontal scroll', (await mp.evaluate(() => document.documentElement.scrollWidth)) <= 390);
        check('no browser errors in the six users\' pages', userErrs.length === 0, JSON.stringify(userErrs.slice(0, 2)));
        fs.writeFileSync(path.join(SHOTS, 'proving.json'), JSON.stringify({ transact: PROVE.transact, position: PROVE.position, swap: PROVE.swap, claim: PROVE.claim, avg: { transact: avg(PROVE.transact), position: avg(PROVE.position), swap: avg(PROVE.swap), claim: avg(PROVE.claim) } }, null, 1));
        console.log('  browser proving (Web Worker, ms): swap', JSON.stringify(PROVE.swap), 'avg', avg(PROVE.swap), '· claim', JSON.stringify(PROVE.claim), 'avg', avg(PROVE.claim));
        await mob.close(); for (const u of users) await u.ctx.close();
      } finally { cmt.stop(); fs.rmSync(cdir, { recursive: true, force: true }); } }
    // a 390 px phone: the pool page and its sheet with live data
    { const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await m.addInitScript(DEVNET); await mockMarket(m); await m.goto(WEB + '/app.html#pool-sol-usdc'); await m.waitForFunction(() => document.querySelectorAll('#binChart rect[data-bin]').length > 60, null, { timeout: 30000 }); await sleep(800);
      await m.screenshot({ path: path.join(SHOTS, 'm-pool-live.png') }); await m.click('[data-sheet="add"]'); await sleep(600); await m.screenshot({ path: path.join(SHOTS, 'm-pool-sheet-live.png') });
      check('phone (390 px): pool page and its action sheet fit without horizontal scroll', (await m.evaluate(() => document.documentElement.scrollWidth)) <= 390); await m.close(); }
    // privacy: after the deposit, the user's wallet never appears in a transaction again
    const sigs = await conn.getSignaturesForAddress(user.publicKey, { limit: 100 });
    const own = sigs.filter((s) => !s.err); const lastOwn = Math.max(...own.map((s) => s.slot));
    const relayerSigs = await conn.getSignaturesForAddress(relayer.publicKey, { limit: 300 }); let mentions = 0;
    for (const s of relayerSigs) { const t = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!t) continue; const keys = t.transaction.message.getAccountKeys ? t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses }).keySegments().flat() : t.transaction.message.accountKeys; if (keys.some((k) => k.equals(user.publicKey))) mentions++; }
    check("the user's wallet appears in none of the relayer's transactions (" + relayerSigs.length + ' checked): its private actions never touch it', mentions === 0 && lastOwn > 0);
    // static pages
    for (const pg of ['index', 'docs']) { await page.goto(WEB + '/' + pg + '.html'); await sleep(800); const txt = await page.textContent('body');
      check(pg + '.html renders, says it has not yet had an independent audit, and makes no audit claim', /not yet had an independent audit/.test(txt) && !/audited by|fully audited/.test(txt)); }
    await page.goto(WEB + '/index.html'); await page.locator('#pools').scrollIntoViewIfNeeded(); 
    check('home page: the twelve pools with their parameters', /Deep pairs/.test(await page.textContent('#pools')) && (await page.$$eval('#poolRows tr', (r) => r.length)) === 12, await page.textContent('#poolsNote'));
    await page.screenshot({ path: path.join(SHOTS, 'home.png'), fullPage: false });
    const violations = cspErrs;
    check('no Content-Security-Policy violations (proofs made under the production CSP)', violations.length === 0, JSON.stringify(violations.slice(0, 3)));
    { const real = errs.filter((e) => !/favicon|ERR_TUNNEL|fonts.googleapis|fonts.gstatic|net::ERR/.test(e)); check('no browser errors', real.length === 0, JSON.stringify(real.slice(0, 3))); }
  } catch (e) { console.error('\nE2E CRASHED:', e); counts.fail++; }
  finally { if (browser) await browser.close(); if (web) web.close(); if (rel) rel.kill(); await new Promise((r) => { val.once('exit', r); val.kill(); setTimeout(r, 8000); }); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  report(`  screenshots in ${SHOTS}`);
})();
