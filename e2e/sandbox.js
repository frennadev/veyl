#!/usr/bin/env node
// Veyl Sandbox, end to end in Chromium: the production build (dist/site, its CSP and headers), the app in Sandbox mode (its
// default) and the homepage's Try-it card. Every private step makes a REAL Groth16 proof in the browser's Web Worker and the
// sandbox verifies it with snarkjs against the circuit's verifying key. Flows: faucet -> public swap -> private swap -> add
// liquidity -> a limit order filled by a price move -> claim fees -> shielded send to a Veyl address -> deposit -> sealed
// batch (2-of-3 committee, bots) settles -> claim; then reload persistence, reset, the mode switch, and the homepage card.
'use strict';
const path = require('path'); const fs = require('fs'); const os = require('os');
const { chromium } = require('playwright');
const { build } = require('../scripts/build-site.js'); const { mockMarket, mockMarkets, PRICES } = require('./market-mock.js'); const { serveDist } = require('../scripts/serve-dist.js');
const PORT = 8874; const WEB = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0; const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '  ok  ' : '  FAIL') + ' ' + n + (extra ? '  ' + String(extra).replace(/\s+/g, ' ').slice(0, 170) : '')); };
const t0 = Date.now(); const lap = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
const chromePath = () => { const d = '/opt/pw-browsers'; if (!fs.existsSync(d)) return undefined; const c = fs.readdirSync(d).find((x) => /^chromium-\d+$/.test(x)); if (!c) return undefined; for (const p of ['chrome-linux/chrome', 'chrome-linux64/chrome']) if (fs.existsSync(path.join(d, c, p))) return path.join(d, c, p); };
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'veyl-sandbox-shots'); fs.mkdirSync(SHOTS, { recursive: true });

(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-sbx-site-'));
  const site = build('devnet', { out, env: {}, log: () => {} }); const web = serveDist(PORT, site.out); let browser;
  try {
    const cfg = site.sandbox; const parts = Object.values(cfg.zk).flatMap((z) => z.zkey);
    const sizes = parts.map((f) => fs.statSync(path.join(out, f)).size);
    check('build: sandbox circuits, proving keys in parts under 8 MB, verifying keys, sandbox.config.js', parts.length >= 5 && Math.max(...sizes) <= 7_500_000 && fs.existsSync(path.join(out, cfg.vkeys)) && fs.existsSync(path.join(out, 'sandbox.config.js')) && fs.existsSync(path.join(out, 'committee-worker.js')), parts.length + ' parts');
    const h = await fetch(WEB + '/' + parts[0], { method: 'HEAD' }); check('key parts served as octet-stream, cached', h.headers.get('content-type') === 'application/octet-stream' && /immutable/.test(h.headers.get('cache-control') || ''));
    browser = await chromium.launch({ executablePath: chromePath() });
    // the in-browser demo chain is a developer mode now (the public app is on-chain only): every context here opts in
    { const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc(o); await c.addInitScript(() => { try { if (!localStorage.getItem('veyl:mode')) localStorage.setItem('veyl:mode', 'sandbox-dev'); } catch { /* storage blocked */ } }); return c; }; }
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const hits = {}; await mockMarket(ctx, { counter: hits }); const mkHits = {}; await mockMarkets(ctx, { counter: mkHits }); const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|ERR_CONNECTION/.test(m.text())) errs.push(m.text()); });
    const done = async (label, ms = 180000) => { await pg.waitForSelector('#doneBtn, #actErr', { timeout: ms }); const err = await pg.$('#actErr'); const body = await pg.textContent('#dlgBody'); if (err) { check(label, false, await err.textContent()); await pg.click('#errClose'); return null; } await pg.screenshot({ path: path.join(SHOTS, label.replace(/\W+/g, '-').slice(0, 40) + '.png') }); return body; };
    const closeDone = async () => { if (await pg.$('#doneBtn')) await pg.click('#doneBtn'); };
    const ev = (f, a) => pg.evaluate(f, a);

    await pg.goto(WEB + '/app.html'); await pg.waitForFunction(() => window.veylEngine && window.veylEngine.sandbox, null, { timeout: 30000 });
    check('the app opens in the demo by default, one small Demo chip in the app bar', /Demo/.test(await pg.textContent('#modeBtn')) && !/ractice/.test(await pg.textContent('body')), lap());
    await pg.waitForFunction(() => /\$162\.37/.test(document.getElementById('kpis').textContent), null, { timeout: 15000 }).catch(() => {});
    const kps = await pg.textContent('#kpiSol'); check('top bar: only the live SOL market price, with source and age ("Jupiter · N s ago")', /SOL\$162\.37/.test(kps) && /Jupiter · \d+ s ago/.test(kps), kps);
    const anchor = await ev(() => { const e = window.veylEngine; const P = [...e.chain.pools.values()].find((q) => q.id === 'sol-usdc'); return { px: e.chain.humanPrice(P), anchored: e.chain.anchored }; });
    check('sandbox SOL–USDC price tracks the market (within 1%), seeded along the last 24 hours of candles', Math.abs(anchor.px / (PRICES.SOL / PRICES.USDC) - 1) < 0.01 && anchor.anchored === 'history', JSON.stringify(anchor));
    check('no Pyth key: Hermes not asked, Jupiter answered every mint (CoinGecko and Coinbase not needed); the 24h history from public candles', !hits.pyth && hits.jupiter >= 1 && !hits.gecko && !hits.ticker && hits.candles >= 3, JSON.stringify(hits));
    check('the mode chip explains the price chain on hover', /Pyth: skipped.*Jupiter: ok/.test(await pg.getAttribute('#modeBtn', 'title')), await pg.getAttribute('#modeBtn', 'title'));
    await pg.waitForFunction(() => window.veylEngine && window.veylEngine.shieldBalance('USDT') === 800000000n, null, { timeout: 60000 }).catch(() => {});
    check('first open: the demo wallet is funded automatically, no banner or button to click first', (await ev(() => window.veylEngine.shieldBalance('USDT') === 800000000n)) && !(await pg.isVisible('#stateBanner')));
    await ev(() => window.veylEngine.pause(true)); // bots off: nothing moves under the test except what it does
    await pg.waitForFunction(() => /\$/.test(document.getElementById('poolRows').textContent), null, { timeout: 15000 });
    const head = await pg.textContent('#poolHead');
    check('pools list: price, liquidity and fee only; no simulated volume, APR, fees or age in practice mode', (await pg.$$('#poolRows tr')).length === 5 && /Price/.test(head) && /Liquidity/.test(head) && /Fee now/.test(head) && !/APR|Volume|Fees \/ TVL|Age/.test(head) && (await pg.$$('#poolRows .spk')).length === 0, head);

    // the app shell: sidebar, top bar, the pools table, rows -> pool page
    const kp = await pg.textContent('#kpis'); check('top bar: no simulated TVL, positions or fees', !/TVL|Your positions|Fees earned/.test(kp), kp);
    check('sidebar: one flat list and one Docs link', /SwapPoolsSealedswapsPortfolioPrivacyActivityDocs/.test((await pg.textContent('#side')).replace(/\s+/g, '').replace('Collapse', '')));
    check('pools toolbar: just search (no interval, sort, columns, filters or category chips in the way)', await pg.isVisible('#poolQ') && !(await pg.isVisible('#poolSort')) && !(await pg.isVisible('#colBtn')) && !(await pg.isVisible('#tokChips')));
    const rowsOrder = () => pg.$$eval('#poolRows tr[data-pool]', (r) => r.map((x) => x.dataset.pool));
    await pg.click('#poolHead th[data-sort="liq"]'); await pg.waitForTimeout(300);
    const liqs = await pg.$$eval('#poolRows td[data-col="liq"]', (t) => t.map((x) => Number(x.textContent.replace(/[^\d.]/g, ''))));
    check('clicking a column header sorts by it (liquidity)', liqs.every((v, i) => i === 0 || liqs[i - 1] >= v) && (await pg.getAttribute('#poolHead th[data-sort="liq"]', 'aria-sort')) === 'descending', liqs.join());
    await pg.fill('#poolQ', 'bonk'); await pg.waitForTimeout(200); check('search narrows the list', (await rowsOrder()).join() === 'bonk-sol', (await rowsOrder()).join()); await pg.fill('#poolQ', ''); await pg.waitForTimeout(200);
    await pg.click('#poolRows tr[data-pool="sol-usdt"]'); await pg.waitForFunction(() => /sol-usdt/.test(location.hash) && /\d/.test(document.getElementById('pPx').textContent), null, { timeout: 10000 });
    const ph = await pg.textContent('#pStats'); check('row opens the pool page: price, liquidity, fee now, bin step; no simulated volume, fees or price history', /Liquidity\$/.test(ph) && /Fee now/.test(ph) && /Bin step0\.10%/.test(ph) && !/Volume|Fees 24h|all time/.test(ph) && !(await pg.isVisible('#pxCard')) && !(await pg.isVisible('#pIv')) && !(await pg.isVisible('#pParamsCard')), ph.slice(0, 120));
    await pg.click('.side-nav [data-go="sealed"]'); await pg.waitForFunction(() => document.querySelectorAll('#sealPools .sealcard').length === 2, null, { timeout: 15000 });
    check('Sealed swaps page: each sealed pool\'s batch', /SOL–USDC/.test(await pg.textContent('#sealPools')));
    await pg.click('#sideCol'); const coll = await ev(() => document.body.classList.contains('side-c')); await pg.click('#sideCol'); check('sidebar collapses and expands', coll && !(await ev(() => document.body.classList.contains('side-c'))));
    await pg.click('.side-nav [data-go="pools"]'); await pg.waitForTimeout(400);

    // Markets: external Solana pools from keyless APIs (mocked here in their own shapes), never mixed into Veyl's figures
    await pg.evaluate(() => { location.hash = '#markets'; }); await pg.waitForFunction(() => document.querySelectorAll('#mkRows tr[data-mk]').length === 5, null, { timeout: 20000 });
    check('Markets: five sources asked, pools merged (the same pool from two sources is one row)', mkHits.gecko >= 1 && mkHits.dexscreener >= 1 && mkHits.meteora >= 1 && mkHits.raydium >= 1 && mkHits.orca >= 1 && (await pg.$$eval('#mkRows tr[data-mk]', (r) => r.length)) === 5, JSON.stringify(mkHits));
    const mkTop = await pg.textContent('#mkRows tr[data-mk]'); check('Markets: labelled external, DEX badge, source + freshness per row', /Solana markets · live · external DEXes/.test(await pg.textContent('.extline')) && /ORCA|Orca/.test(mkTop) && /Orca \+ GeckoTerminal · \d+ s/.test(mkTop), mkTop.replace(/\s+/g, ' ').slice(0, 120));
    check('Markets never enter Veyl\'s own top bar', !/TVL|\$18\.23M/.test(await pg.textContent('#kpis')));
    await pg.selectOption('#mkSort', 'liq'); await pg.waitForTimeout(200); check('Markets: sort by liquidity', /\$18\.23M/.test(await pg.textContent('#mkRows tr[data-mk]')));
    await pg.click('#mkDex [data-dex="meteora"]'); await pg.waitForTimeout(200); const met = await pg.textContent('#mkRows'); check('Markets: DEX filter; Meteora row shows bin step and APR from Meteora, price from DexScreener', (await pg.$$('#mkRows tr[data-mk]')).length === 1 && /bin 0\.10%/.test(met) && /\$162\.43/.test(met)); await pg.click('#mkDex [data-dex="all"]');
    await pg.click('#mkIv [data-iv="h1"]'); await pg.waitForTimeout(200); check('Markets: 1h interval relabels; sources without 1h show a dash', /Volume 1h/.test(await pg.textContent('#mkHead')) && /\$2\.40M/.test(await pg.textContent('#mkRows'))); await pg.click('#mkIv [data-iv="h24"]');
    await pg.click('#mkRows tr[data-mk]'); await pg.waitForFunction(() => /candles · GeckoTerminal/.test((document.getElementById('mkChartNote') || {}).textContent || ''), null, { timeout: 15000 });
    const dr = await pg.textContent('#mkDrawer'); check('Markets: detail drawer with candles, copyable addresses, DEX and explorer links', /3 hourly candles/.test(dr) && /So11111111111111111111111111111111111111112/.test(dr) && (await pg.$$('#mkDrawer .links a')).length === 4 && (await pg.$$('#mkDrawer [data-copy]')).length === 3);
    await pg.click('#mkMirror'); await pg.waitForTimeout(300); check('Markets: "Mirror on Veyl" queues a request for the owner, creates nothing', /SOL–USDC/.test(await pg.textContent('#mirrorList')) && /waiting for the factory authority/.test(await pg.textContent('#mirrorList')) && (await ev(() => window.veylEngine.chain.pools.size)) === 5);
    await pg.keyboard.press('Escape'); await pg.waitForTimeout(400);
    // every market source down / rate-limited: honest states, nothing invented
    const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }); await mockMarket(dctx); await mockMarkets(dctx, { fail: true }); const dp = await dctx.newPage();
    await dp.goto(WEB + '/app.html#markets'); await dp.waitForFunction(() => /No market data|retry in/.test(document.getElementById('mkRows').textContent + document.getElementById('mkSrcs').textContent), null, { timeout: 30000 });
    check('Markets down: every source badge says so with a retry countdown (429 and 5xx back off), no rows invented', /GeckoTerminal · retry in \d+ s/.test(await dp.textContent('#mkSrcs')) && /Orca · retry in \d+ s/.test(await dp.textContent('#mkSrcs')) && (await dp.$$('#mkRows tr[data-mk]')).length === 0, (await dp.textContent('#mkSrcs')).slice(0, 160));
    await dctx.close();
    await pg.click('.side-nav [data-go="pools"]'); await pg.waitForTimeout(400);

    // faucet
    await pg.click('#acctBtn'); await pg.click('#acctPop [data-faucet]'); let b = await done('faucet');
    check('top up from the account menu, said in one line', b && /Topped up/.test(b) && !/ractice|sandbox #/.test(b), b && b.slice(0, 90)); await closeDone();

    // public swap on the swap page (instant, no proof)
    await pg.goto(WEB + '/app.html#swap'); await pg.waitForTimeout(500); await pg.click('#swSrc [data-src="pub"]'); await pg.fill('#swIn', '100'); await pg.waitForFunction(() => !document.getElementById('swGo').disabled, null, { timeout: 10000 });
    await pg.click('#swGo'); b = await done('public swap');
    check('public swap from the play wallet: no proof, everything public', b && /Got/.test(b) && !/Proof verified/.test(b) && /Signer/.test(b), b && b.slice(0, 80)); await closeDone();

    // private swap (transact proof)
    await pg.click('#swSrc [data-src="priv"]'); await pg.fill('#swIn', '50'); await pg.waitForFunction(() => !document.getElementById('swGo').disabled, null, { timeout: 10000 });
    await pg.click('#swGo'); b = await done('private swap');
    const m = b && b.match(/verified in (\d+) ms/);
    check('private swap: real transact proof made in the worker and verified in the browser', b && /Proof verified · transact circuit/.test(b) && m, b && (b.match(/Proof verified[^·]*·[^·]*·[^·]*·[^a]*/) || [''])[0]);
    check('… and the chain view: route and amounts public, the swapper hidden', b && /shield_swap/.test(b) && /Who swapped/.test(b)); await closeDone();

    // public add around the price
    await pg.goto(WEB + '/app.html#pool-sol-usdc'); await pg.waitForTimeout(1200); await pg.click('#srcSeg [data-src="pub"]'); await pg.fill('#amtX', '2'); await pg.fill('#amtY', '300');
    await pg.waitForFunction(() => !document.getElementById('actGo').disabled, null, { timeout: 10000 }); await pg.click('#actGo'); b = await done('add liquidity');
    check('add liquidity (spot, 11 bins) from the play wallet', b && /Position added/.test(b), lap()); await closeDone();
    const bars0 = await pg.$$eval('#binChart rect.bar', (r) => r.length); check('bin chart drawn from sandbox state (71 bins)', bars0 === 71, bars0);

    // limit order, then a bot buy fills it
    await pg.click('#tabs [data-tab="limit"]'); await pg.click('#ordSeg [data-o="sell"]'); await pg.waitForTimeout(200); await pg.fill('#ordAmt', '0.5');
    await pg.waitForFunction(() => !document.getElementById('actGo').disabled, null, { timeout: 10000 }); await pg.click('#actGo'); b = await done('limit order');
    check('sell order placed above the price', b && /Order placed/.test(b)); await closeDone();
    const pool = await ev(() => window.veylEngine.cfg.binPools.find((p) => p.id === 'sol-usdc').address);
    const y0 = await pg.getAttribute('#binChart rect.bar:nth-child(36)', 'height');
    const act = await ev((a) => { const e = window.veylEngine; const P = e.chain.pool(a).p; const ob = e.myOrders().filter((o) => !o.closed).slice(-1)[0].binId; for (let i = 0; i < 60 && P.activeId <= ob + 1; i++) e.nudge(a, false, 300); e.nudge(a, true, 0.5); return P.activeId - ob; }, pool);
    await pg.waitForTimeout(1500); const y1 = await pg.getAttribute('#binChart rect.bar:nth-child(36)', 'height');
    check('bots / trades move the price past the order: the bins redraw in place', act > 0 && y0 !== y1, 'bins past the order ' + act);
    await pg.goto(WEB + '/app.html#portfolio'); await pg.waitForFunction(() => /Filled/.test(document.getElementById('ordList').textContent), null, { timeout: 20000 }).catch(() => {});
    check('the order shows filled', /Filled/.test(await pg.textContent('#ordList')));
    await pg.click('#ordList [data-ow]'); await pg.click('#oGo'); b = await done('order withdrawn'); check('filled order withdrawn: USDC back to the wallet', b && /Order withdrawn/.test(b) && /USDC/.test(b)); await closeDone();

    // claim fees on the position
    await ev((a) => { const e = window.veylEngine; const P = e.chain.pool(a); for (let i = 0; i < 300 && P.p.activeId > 1; i++) e.nudge(a, true, 1.5); for (let i = 0; i < 4; i++) { e.nudge(a, true, 3); e.nudge(a, false, 450); } }, pool); await pg.waitForTimeout(5500);
    await pg.waitForSelector('#posList [data-pa="claim"]:not([disabled])', { timeout: 20000 }); await pg.click('#posList [data-pa="claim"]'); await pg.click('#cGo'); b = await done('claim fees');
    check('claim fees earned by the position', b && /Fees claimed/.test(b)); await closeDone();
    // rebalance
    await pg.click('#posList [data-pa="rebalance"]'); await pg.waitForFunction(() => !document.getElementById('rbGo').disabled, null, { timeout: 15000 }); await pg.click('#rbGo'); b = await done('rebalance');
    check('rebalance around the current price', b && /Rebalanced/.test(b)); await closeDone();

    // shielded send to Mara (inside the pool) and a deposit
    await pg.click('[data-open="withdraw"]'); await pg.click('#wA [data-a="USDC"]'); await pg.fill('#wAmt', '25'); await pg.click('#wMara'); await pg.click('#wGo'); b = await done('shielded send');
    check('shielded send to a Veyl address: hidden amount, Mara receives', b && /Mara's shielded USDC here: 25/.test(b) && /none: not even the token|no amounts|Amount/.test(b), b && b.slice(0, 120)); await closeDone();
    await pg.click('[data-open="deposit"]'); await pg.click('#dA [data-a="USDT"]'); await pg.fill('#dAmt', '100'); await pg.click('#dGo'); b = await done('deposit');
    check('deposit into the shielded balance (proof, then admitted by the simulated publisher)', b && /Deposited 100(\.00)? USDT/.test(b)); await closeDone();
    await pg.waitForFunction(() => window.veylEngine.chain.shield.pending.length === 0, null, { timeout: 15000 }); await ev(() => window.veylEngine.shieldSync());
    check('deposit admitted: USDT in the shielded balance', await ev(() => window.veylEngine.shieldBalance('USDT') === 1700000000n));

    // sealed batch
    await pg.goto(WEB + '/app.html#pool-sol-usdc'); await pg.waitForTimeout(1500); await pg.click('#tabs [data-tab="swap"]'); await pg.waitForSelector('#swMode:not([hidden])', { timeout: 10000 });
    await pg.click('#swMode [data-m="sealed"]'); await pg.fill('#pswIn', '0.4'); await pg.waitForFunction(() => !document.getElementById('actGo').disabled, null, { timeout: 15000 });
    await pg.click('#actGo'); b = await done('sealed swap');
    check('sealed swap: swap proof verified, amount encrypted to the 2-of-3 committee', b && /Sealed into batch/.test(b) && /swap circuit/.test(b) && /committee/.test(b)); await closeDone();
    await ev((a) => { const e = window.veylEngine; const P = e.chain.pool(a); for (let i = 0; i < 3; i++) { e.chain.botSeal(P, 0, 50_000_000n); e.chain.botSeal(P, 1, 8_000_000n); } e.closeSoon(a); }, pool);
    await pg.waitForSelector('#pSeal [data-sc]', { timeout: 60000 }).catch(() => {}); const sealTxt = await pg.textContent('#pSeal');
    check('the batch closes and settles: two committee shares with Chaum-Pedersen proofs, totals by BSGS, one net swap', /Settled/.test(sealTxt) && await ev((a) => { const s = window.veylEngine.chain.sealed.get(a); const b0 = s.batches.get(0); return b0.state === 'settled' && b0.verified === 3; }, pool), sealTxt.slice(0, 120));
    await pg.click('#pSeal [data-sc]'); b = await done('sealed claim'); check('claim: claim proof verified, output into a hidden note', b && /Claimed/.test(b) && /claim circuit/.test(b)); await closeDone();

    // activity ledger, persistence, mode switch, reset
    await pg.goto(WEB + '/app.html#activity'); await pg.waitForTimeout(800); const led = await pg.textContent('#actList');
    check('activity lists what you did, kept in this browser', /Wallet funded/.test(led) && /Top up/.test(led) && !(await pg.isVisible('#ledgerWrap')), led.slice(0, 120));
    const before = await ev(() => window.veylEngine.chain.seq); await ev(() => { window.veylEngine._dirty = true; window.veylEngine.save(); });
    await pg.reload(); await pg.waitForFunction(() => window.veylEngine && window.veylEngine.sandbox, null, { timeout: 30000 });
    await ev(async () => { await window.veylEngine.init(); await window.veylEngine.shieldSync(); });
    const rl = [await ev(() => window.veylEngine.chain.seq), String(await ev(() => window.veylEngine.shieldBalance('USDT'))), before]; check('state survives a reload (localStorage)', rl[0] >= before && rl[1] === '1700000000', JSON.stringify(rl));
    await pg.click('#modeBtn'); await pg.click('#modePop [data-mode="devnet"]'); await pg.waitForLoadState('load'); await pg.waitForTimeout(800);
    check('mode switch: with no deployment the app shows no mode chip, no banner, nothing simulated', !(await pg.isVisible('#modeBtn')) && !(await pg.isVisible('#stateBanner')) && !/soon|launch/i.test(await pg.innerText('body')) && !(await ev(() => !!(window.veylEngine && window.veylEngine.sandbox))));
    check('with no deployment the privacy page says to connect', /Connect a wallet to run the checks/.test(await (async () => { await pg.evaluate(() => { location.hash = '#privacy'; }); await pg.waitForTimeout(300); return pg.textContent('#pg-privacy'); })()));
    await pg.goto(WEB + '/app.html?mode=sandbox-dev'); await pg.waitForFunction(() => window.veylEngine && window.veylEngine.sandbox, null, { timeout: 30000 });
    await pg.click('#acctBtn'); await pg.click('#acctPop [data-sbxreset]'); await pg.click('#rsYes'); await pg.waitForFunction(() => window.veylEngine && window.veylEngine.sandbox && window.veylEngine.chain.seq <= 2, null, { timeout: 30000 });
    await pg.waitForFunction(() => window.veylEngine.shieldBalance('USDT') === 800000000n, null, { timeout: 60000 }).catch(() => {});
    check('start over: a fresh chain and a freshly funded demo wallet', (await ev(() => window.veylEngine.shieldBalance('USDT'))) === 800000000n);

    // homepage card (mobile)
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await mockMarket(mctx); const mp = await mctx.newPage(); mp.on('pageerror', (e) => errs.push('home: ' + e.message));
    await mp.goto(WEB + '/index.html'); await mp.locator('#how').scrollIntoViewIfNeeded(); await mp.waitForTimeout(300);
    check('homepage: the showcase is an illustration: bins, the range outlined, no balances, prices or demo tag', (await mp.$$eval('#lpBins rect.b', (r) => r.length)) === 51 && (await mp.$$eval('#lpBins rect.rng', (r) => r.length)) === 1 && /Spot across 11 bins/.test(await mp.textContent('#lpPrev')) && !/\$|Demo|practice/i.test(await mp.textContent('#lpCard')), await mp.textContent('#lpPrev'));
    await mp.click('#lpShape [data-s="curve"]'); await mp.click('#lpRange [data-w="2"]'); await mp.waitForTimeout(300);
    check('homepage: shape and range controls update the illustration', /Curve across 5 bins/.test(await mp.textContent('#lpPrev')), await mp.textContent('#lpPrev'));
    await mp.click('#lpGo'); await mp.waitForFunction(() => document.getElementById('lpSteps').dataset.state === 'done', null, { timeout: 20000 });
    check('homepage: See how it works walks the five steps and lights the chosen bins', (await mp.$$eval('#lpSteps li.ok', (l) => l.length)) === 5 && (await mp.$$eval('#lpBins rect.mine', (r) => r.length)) === 5 && /Do it for real in the app/.test(await mp.textContent('#lpMsg')), await mp.textContent('#lpMsg'));
    const hp = await mp.textContent('#pools'); check('homepage: the twelve pools with their parameters', /Deep pairs/.test(hp) && (await mp.$$eval('#poolRows tr', (r) => r.length)) === 12 && /WIF–USDC/.test(hp), hp.replace(/\s+/g, ' ').slice(0, 120));
    check('homepage: no horizontal scroll at 390 px', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await mp.goto(WEB + '/app.html#pools'); await mp.waitForFunction(() => document.querySelectorAll('#poolCards .pcard').length === 5, null, { timeout: 30000 });
    const card = await mp.textContent('#poolCards .pcard'); check('mobile: the table becomes compact cards with price, liquidity and fee', !(await mp.isVisible('#poolTable')) && /Price/.test(card) && /Liquidity\$/.test(card) && /Fee/.test(card) && !/APR|Volume/.test(card), card.replace(/\s+/g, ' ').slice(0, 100));
    await mp.click('#poolCards .pcard'); await mp.waitForFunction(() => /#pool-/.test(location.hash), null, { timeout: 10000 }); check('mobile: a card opens its pool', true);
    await mp.goto(WEB + '/app.html#pools'); await mp.click('#menuBtn'); await mp.waitForTimeout(400); check('mobile: the sidebar opens as a drawer', await mp.evaluate(() => document.getElementById('side').classList.contains('open')));
    check('mobile app: no horizontal scroll at 390 px', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    // the market unreachable: fallback prices, said plainly; everything else works
    const fctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }); await mockMarket(fctx, { fail: true }); const fp = await fctx.newPage();
    await fp.goto(WEB + '/app.html#pools'); await fp.waitForFunction(() => window.veylEngine && document.querySelectorAll('#poolRows tr[data-pool]').length === 5 && !document.querySelector('#poolRows .skel'), null, { timeout: 40000 });
    check('market unreachable: no made-up SOL price in the top bar, the chip explains on hover; practice still runs', !(await fp.$('#kpiSol')) && /No market price/.test(await fp.getAttribute('#modeBtn', 'title')) && /prices as of 14 Oct 2026/.test(await fp.textContent('#poolCount')), await fp.textContent('#kpis'));
    await fctx.close();
    // Jupiter rate-limited (429, the keyless limit is 0.5 requests/s): CoinGecko answers; the label names it
    const gctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }); await mockMarket(gctx, { jupiter: false }); const gp = await gctx.newPage();
    await gp.goto(WEB + '/app.html#pools'); await gp.waitForFunction(() => /CoinGecko · \d+ s ago/.test(document.getElementById('kpiSol').textContent), null, { timeout: 40000 }).catch(() => {});
    check('Jupiter refuses (429): CoinGecko answers, the stats strip says so, the chip explains the chain', /\$162\.37/.test(await gp.textContent('#kpiSol')) && /CoinGecko · \d+ s ago/.test(await gp.textContent('#kpiSol')) && /Jupiter: api\.jup\.ag answered 429 · CoinGecko: ok/.test(await gp.getAttribute('#modeBtn', 'title')), await gp.textContent('#kpiSol'));
    await gctx.close();
    check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } catch (e) { check('sandbox e2e ran to the end', false, e.stack); }
  finally { if (browser) await browser.close(); web.close(); }
  console.log(`\n${pass} passed, ${fail} failed (${lap()})`); process.exit(fail ? 1 : 0);
})();
