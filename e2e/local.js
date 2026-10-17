#!/usr/bin/env node
// Local mode, end to end: a local validator, the real deploy (programs, pools), `scripts/seed.js` (liquidity and trades from
// the deployer), the production site built for that deployment, the app in Chromium (on-chain mode). Every figure the
// pools table, the pool page and the stats strip show is checked against the chain read independently here: vault balances,
// the bin pool account, and each pool's Swapped events from its transactions. Market prices are mocked (the API shapes).
'use strict';
const path = require('path'); const fs = require('fs'); const os = require('os');
const { Keypair, PublicKey, Connection } = require('@solana/web3.js');
const { chromium } = require('playwright');
const S = require('../sdk/veyl.js'); require('../sdk/shield.js');
const { startValidator, deployAll, sleep, fund } = require('../scripts/lib.js'); const spl = require('@solana/spl-token'); const { seed } = require('../scripts/seed.js');
const { build } = require('../scripts/build-site.js'); const { serveDist } = require('../scripts/serve-dist.js'); const { mockMarket, PRICES } = require('./market-mock.js');
const PORT = 8875, WEB = 'http://127.0.0.1:' + PORT, RPC_PORT = Number(process.env.LOCAL_RPC_PORT || 8953);
const { check, lap, chromePath, finish } = require('./harness.js');
// the app's own number formatting (site/app.html: tiny, pct), so a displayed figure can be compared as text
const SUBS = '₀₁₂₃₄₅₆₇₈₉';
function tiny(n) { if (!isFinite(n) || n <= 0) return '0'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e4) return n.toLocaleString('en-US', { maximumFractionDigits: 0 }); if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 }); if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (n >= 0.001) return String(+n.toPrecision(4)); const z = -Math.floor(Math.log10(n)) - 1; const d = String(Math.round(n * Math.pow(10, z + 4))).slice(0, 4).replace(/0+$/, '') || '0'; return '0.0' + String(z).split('').map((c) => SUBS[c]).join('') + d; }
const pct = (pips) => (pips / 1e4).toFixed(pips < 1000 ? 3 : 2).replace(/0$/, '') + '%';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-local-')); const payer = Keypair.generate(); const payerFile = path.join(dir, 'payer.json'); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  const { val, rpc, conn } = await startValidator(dir, payer, RPC_PORT); let browser, web; const keepDeploy = fs.existsSync(path.join(__dirname, '../deploy.local.json')) ? fs.readFileSync(path.join(__dirname, '../deploy.local.json')) : null;
  try {
    const { V, dep } = await deployAll({ rpc, payerFile, network: 'local' }); check('local deploy: programs and the curated bin pools', dep.binPools.length === 5, lap());
    const did = await seed({ V, conn, payer, dep, trades: 4, log: () => {} }); check('npm run seed: liquidity and trades in every curated pool', did.length === 5 && did.every((d) => d.minted && d.swaps === 4), lap());
    const site = build('local', { out: path.join(dir, 'site'), env: { RELAYER_URL: 'http://127.0.0.1:9' }, log: () => {} }); web = serveDist(PORT, site.out);
    check('the build lets the page reach the RPC and the price APIs (CSP connect-src)', /connect-src[^;]*127\.0\.0\.1:8953[^;]*hermes\.pyth\.network[^;]*api\.jup\.ag/.test(site.policy), (site.policy.match(/connect-src [^;]+/) || [''])[0]);
    browser = await chromium.launch({ executablePath: chromePath() }); const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await mockMarket(ctx);
    await ctx.addInitScript(() => { try { localStorage.setItem('veyl:mode', 'devnet'); localStorage.setItem('veyl:cols', JSON.stringify(['chart', 'age', 'price', 'apr', 'fpt', 'liq', 'vol', 'fee'])); localStorage.setItem('veyl:iv', '86400'); } catch {} });
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(WEB + '/app.html#pools');
    await pg.waitForFunction(() => document.querySelectorAll('#poolRows tr[data-pool]').length === 5 && !document.querySelector('#poolRows .skel') && /\$/.test((document.querySelector('#poolRows tr[data-pool="sol-usdc"] td[data-col="vol"]') || {}).textContent || ''), null, { timeout: 90000 });
    check('chip: On-chain · Local validator', /On-chain · Local validator/.test(await pg.textContent('#modeBtn')), await pg.textContent('#modeBtn'));
    // the chain, read here independently
    const U = { SOL: PRICES.SOL, USDC: PRICES.USDC, USDT: PRICES.USDT, JUP: PRICES.JUP, BONK: PRICES.BONK }; /* every launch token has a market price now; one without would be valued through its pool */ const now = Math.floor(Date.now() / 1000); const exp = {};
    const bal = async (k) => BigInt((await conn.getTokenAccountBalance(k)).value.amount);
    for (const b of dep.binPools) { const pk = new PublicKey(b.address); const bp = await V.binPool(pk); const X = dep.tokens[b.x], Y = dep.tokens[b.y];
      const rx = (await bal(bp.vaultX)) - bp.protocolFeeX, ry = (await bal(bp.vaultY)) - bp.protocolFeeY; const px = Number(S.priceOf(bp.basePrice, bp.binStep, bp.activeId)) / 2 ** 128 * 10 ** (X.decimals - Y.decimals);
      const sigs = await conn.getSignaturesForAddress(pk, { limit: 1000 }, 'confirmed'); const sw = [];
      for (const s of sigs) { if (s.err) continue; const t = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); for (const e of S.parseEvents(t.meta.logMessages)) if (e.name === 'Swapped' && e.pool.equals(pk) && (t.blockTime || now) > now - 86400) sw.push(e); }
      exp[b.id] = { b, bp, rx, ry, px, sw, X, Y }; }
    for (const e of Object.values(exp)) { const { b } = e; if (U[b.y] && !U[b.x]) U[b.x] = e.px * U[b.y]; if (U[b.x] && !U[b.y]) U[b.y] = U[b.x] / e.px; }
    let tvlSum = 0;
    for (const e of Object.values(exp)) { const { b, X, Y } = e; const fx = (a) => Number(a) / 10 ** X.decimals, fy = (a) => Number(a) / 10 ** Y.decimals;
      const tvl = fx(e.rx) * U[b.x] + fy(e.ry) * U[b.y]; tvlSum += tvl; let vx = 0n, vy = 0n, fxs = 0n, fys = 0n; for (const s of e.sw) { if (s.xForY) { vx += s.amountIn; fxs += s.fee; } else { vy += s.amountIn; fys += s.fee; } }
      const vol = fx(vx) * U[b.x] + fy(vy) * U[b.y]; const row = (c) => pg.textContent('#poolRows tr[data-pool="' + b.id + '"] td[data-col="' + c + '"]');
      const liqT = await row('liq'), volT = await row('vol'), priceT = await row('price'), feeT = await row('fee'); const fee = Number(await V.currentFee(new PublicKey(b.address)));
      check(b.id + ': liquidity = (vaults − protocol fees) × market prices', liqT.startsWith('$' + tiny(tvl)), liqT + ' vs $' + tiny(tvl));
      check(b.id + ': volume 24h and swap count = its Swapped events', volT.startsWith('$' + tiny(vol)) && new RegExp(e.sw.length + ' swaps').test(volT), volT + ' vs $' + tiny(vol) + ' / ' + e.sw.length);
      check(b.id + ': price = the active bin\'s price; fee now = the pool\'s dynamic fee', priceT.startsWith(tiny(e.px)) && feeT.startsWith(pct(fee)), priceT + ' · ' + feeT + ' vs ' + tiny(e.px) + ' · ' + pct(fee));
      e.tvl = tvl; e.vol = vol; e.fees = fx(fxs) * U[b.x] + fy(fys) * U[b.y]; }
    const kp = await pg.textContent('#kpis'); check('stats strip: TVL = the sum over pools; SOL price = the market (mocked Jupiter)', kp.includes('TVL · on-chain$' + tiny(tvlSum)) && /SOL\$162\.37/.test(kp) && /Jupiter · \d+ s ago/.test(kp), kp);
    // the pool page
    await pg.click('#poolRows tr[data-pool="sol-usdc"]'); await pg.waitForFunction(() => /\$/.test(document.getElementById('pStats').textContent) && /\d/.test(document.getElementById('pPx').textContent), null, { timeout: 30000 }); await sleep(500);
    const e = exp['sol-usdc']; const ps = await pg.textContent('#pStats');
    check('pool page: liquidity, volume 24h, fees 24h from the chain', ps.includes('Liquidity$' + tiny(e.tvl)) && ps.includes('Volume 24h$' + tiny(e.vol)) && ps.includes('Fees 24h$' + tiny(e.fees)), ps.slice(0, 200));
    check('pool page: price and the market reference beside it', (await pg.textContent('#pPx')).startsWith(tiny(e.px)) && /market 162\.3\d/.test(await pg.textContent('#pPx')), await pg.textContent('#pPx'));
    const bars = await pg.$$eval('#binChart rect[data-bin]', (r) => r.filter((x) => parseFloat(x.getAttribute('height')) > 0).length); check('pool page: bins drawn from the bin arrays', bars >= 30, bars);
    // activity: the on-chain swaps
    await pg.click('.side-nav [data-go="activity"]'); await pg.waitForTimeout(800); const nSwaps = Object.values(exp).reduce((n, x) => n + x.sw.length, 0);
    check('activity: the on-chain swaps across the pools', (await pg.$$('#ledger .row')).length === Math.min(40, nSwaps), nSwaps);
    // Devnet without a deployment: dashes, never sandbox or invented figures
    const nctx = await browser.newContext({ viewport: { width: 1200, height: 800 } }); await mockMarket(nctx); await nctx.addInitScript(() => { try { localStorage.setItem('veyl:mode', 'devnet'); } catch {} });
    const np = await nctx.newPage(); await np.route(/veyl\.config\.js$/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.VEYL_CONFIG=null;' }));
    await np.goto(WEB + '/app.html#pools'); await np.waitForTimeout(2500); const nk = await np.textContent('#kpis'); const nrow = await np.textContent('#poolRows');
    check('no deployment: no made-up figures; only the market SOL price shows', !/TVL|Your positions/.test(nk) && /\$162\.37/.test(nk) && !/\$\d/.test(nrow), nk);
    await nctx.close();
    // No wallet needed: a deposit address made in this browser, funded from outside, native SOL wrapped, a private deposit, leftovers sent out
    { const lc = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await mockMarket(lc); await lc.addInitScript(() => { try { localStorage.setItem('veyl:mode', 'devnet'); } catch {} });
      const lp = await lc.newPage(); const lerr = []; lp.on('pageerror', (e) => lerr.push(e.message));
      await lp.goto(WEB + '/app.html#home'); await lp.waitForFunction(() => window.veylEngine && window.veylEngine.zw, null, { timeout: 30000 }); await sleep(1500);
      await lp.click('#acctBtn'); const startTxt = await lp.textContent('#dlgBody'); await lp.click('#stLocal'); await lp.waitForSelector('#fBal', { timeout: 15000 });
      const addr = await lp.evaluate(() => window.veylEngine.account); const fundTxt = await lp.textContent('#dlgBody');
      check('no wallet: Get started offers "No wallet needed" first; a deposit address is made in this browser and shown to fund', /No wallet needed/.test(startTxt) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) && fundTxt.includes(addr) && (await lp.evaluate(() => Array.isArray(window.veylEngine.store.data.depositKey))), addr);
      const ap = new PublicKey(addr); await conn.confirmTransaction(await conn.requestAirdrop(ap, 2e9), 'confirmed'); const usdc = new PublicKey(dep.tokens.USDC.mint); await fund(conn, payer, usdc, ap, 250_000_000n);
      await lp.waitForFunction(() => /250/.test(document.getElementById('fBal').textContent), null, { timeout: 30000 }).catch(() => {});
      check('funding from outside shows up in the dialog (250 USDC)', /250/.test(await lp.textContent('#fBal')), (await lp.textContent('#fBal')).replace(/\s+/g, ' '));
      const W = 'So11111111111111111111111111111111111111112'; await lp.evaluate(async (W) => { const E = window.veylEngine; await E._sendAll([await E.wrapIxs(W, 300000000n)], 200000); }, W);
      const wata = spl.getAssociatedTokenAddressSync(new PublicKey(W), ap); const wbal = (await conn.getTokenAccountBalance(wata)).value.amount;
      check('native SOL is wrapped for a SOL deposit (0.3 SOL lands in the wrapped-SOL account)', wbal === '300000000', wbal);
      await lp.click('#fGo'); await lp.click('#dA [data-a="USDC"]'); await lp.fill('#dAmt', '100'); await lp.click('#dGo'); await lp.waitForSelector('#doneBtn, #errClose', { timeout: 180000 }); const dt = await lp.textContent('#dlgBody');
      check('a private deposit straight from the deposit address, no wallet involved', /Deposited 100(\.0+)? USDC/.test(dt), dt.replace(/\s+/g, ' ').slice(0, 160)); await lp.click('#doneBtn, #errClose');
      const dest = Keypair.generate().publicKey; await lp.click('#acctBtn'); await lp.click('#acctPop [data-sweep]'); await lp.fill('#swpTo', dest.toBase58()); await lp.click('#swpGo'); await lp.waitForSelector('#doneBtn, #errClose', { timeout: 60000 });
      const st = await lp.textContent('#dlgBody'); const dU = (await conn.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(usdc, dest))).value.amount; const dS = await conn.getBalance(dest); const left = await conn.getBalance(ap);
      check('send what\'s left out: the other 150 USDC and the SOL reach the address, the deposit address is emptied', /Sent/.test(st) && dU === '150000000' && dS > 1e9 && left === 0, [dU, dS, left].join(' / '));
      check('no-wallet flow: no page errors', lerr.length === 0, lerr.join(' | ')); await lc.close(); }
    check('no page errors', errs.length === 0, errs.join(' | '));
  } catch (e) { check('local e2e ran to the end', false, e.stack); }
  finally { if (browser) await browser.close(); if (web) web.close(); val.kill(); if (keepDeploy) fs.writeFileSync(path.join(__dirname, '../deploy.local.json'), keepDeploy); }
  finish();
})();
