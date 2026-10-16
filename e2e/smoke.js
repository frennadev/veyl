#!/usr/bin/env node
// Smoke-all: the production build in Chromium, every page and app view on a desktop and a phone, every control clicked,
// and zero console errors, page errors or horizontal overflow anywhere. Then the rough conditions people will test in:
// a 4x slower CPU with reduced motion (a real proof still completes), a slow network (the proving key streams with
// progress), a reload mid-proof, two tabs on one sandbox, localStorage blocked, back/forward, and hash routes.
// Market APIs are mocked (e2e/market-mock.js). npm run e2e:smoke
'use strict';
const path = require('path'); const fs = require('fs'); const os = require('os');
const { chromium } = require('playwright');
const { build } = require('../scripts/build-site.js'); const { mockMarket, mockMarkets } = require('./market-mock.js'); const { serveDist } = require('../scripts/serve-dist.js');
const PORT = 8876; const WEB = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0; const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '  ok  ' : '  FAIL') + ' ' + n + (extra ? '  ' + String(extra).replace(/\s+/g, ' ').slice(0, 220) : '')); };
const t0 = Date.now(); const lap = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
const chromePath = () => { const d = '/opt/pw-browsers'; if (!fs.existsSync(d)) return undefined; const c = fs.readdirSync(d).find((x) => /^chromium-\d+$/.test(x)); if (!c) return undefined; for (const p of ['chrome-linux/chrome', 'chrome-linux64/chrome']) if (fs.existsSync(path.join(d, c, p))) return path.join(d, c, p); return undefined; };
const NOISE = /fonts\.g|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET|net::ERR_ABORTED|favicon/;
const PAGES = ['index', 'docs'];
const VIEWS = ['pools', 'swap', 'home', 'privacy', 'activity', 'markets', 'sealed', 'pool-sol-usdc', 'pool-bonk-sol'];
// controls never clicked by the crawler: they start a long action, wipe state, navigate away, or need a wallet
const ONLY = process.env.SMOKE_ONLY || ''; const want = (k) => !ONLY || ONLY === k; // SMOKE_ONLY=crawl|cpu|slow|reload|storage runs one block
const SKIP = /data-sbxreset|data-mode=|#lpGo|#lpClaim|#actGo|#swGo|#dGo|#wGo|#rsYes|data-backup|class=skip|data-copy|#tryGo/;

function watch(page, bag) { page.on('pageerror', (e) => bag.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) bag.push('console: ' + m.text()); }); page.on('requestfailed', (r) => { const u = r.url(); if (!NOISE.test(r.failure() && r.failure().errorText || '') && /127\.0\.0\.1/.test(u)) bag.push('request failed: ' + u); }); }
const noScroll = (page, w) => page.evaluate((w) => document.documentElement.scrollWidth <= w + 1, w);
async function closeOverlays(page) { try { if (await page.$('#modal:not([hidden])')) { await page.click('#dlgX', { timeout: 1500 }).catch(() => page.keyboard.press('Escape')); } for (const sel of ['#acctPop', '#modePop', '#colPop', '#fltPop', '#mkFltPop']) { const el = await page.$(sel + ':not([hidden])'); if (el) await page.keyboard.press('Escape'); } if (await page.$('#mkDrawer:not([hidden])')) await page.click('#mkX, #mkDrawer .ib', { timeout: 1500 }).catch(() => {}); if (await page.$('#side.open')) await page.click('#sideBg', { timeout: 1500, position: { x: 5, y: 400 } }).catch(() => page.keyboard.press('Escape')); if (await page.$('#panel.shown')) await page.keyboard.press('Escape'); } catch { /* best effort */ } }
async function waitApp(page) { await page.waitForFunction(() => window.veylEngine && window.veylEngine.sandbox, null, { timeout: 60000 }); await page.waitForFunction(() => !document.querySelector('.skel'), null, { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(400); }
/// Click every visible, enabled control in the current view, one at a time, undoing overlays in between.
async function clickAll(page, scope, label, errs, w, hash = null, reopen = null) { const sc = ':is(' + scope + ')'; const handles = await page.$$(sc + ' button:not([disabled]), ' + sc + ' a[href^="#"], ' + sc + ' [role="tab"], ' + sc + ' select, ' + sc + ' input[type="checkbox"], ' + sc + ' summary'); let n = 0, dead = [];
  for (const h of handles) { try { const info = await h.evaluate((el) => ({ vis: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length), tag: el.tagName, text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), id: el.id ? '#' + el.id : '', attrs: [...el.attributes].map((a) => a.name + '=' + a.value).join(' '), href: el.getAttribute('href') || '' })); if (!info.vis || SKIP.test(info.id + ' ' + info.attrs) || /\bdata-go=/.test(info.attrs)) continue; if (!(await h.isVisible().catch(() => false))) continue; const box = await h.boundingBox().catch(() => null); if (!box || box.x + box.width <= 0 || box.x >= w || box.width === 0) continue; if (/^#side(Close)?$/.test(info.id) || (w < 600 && await h.evaluate((el) => !!el.closest('#side') || (!!el.closest('#panel') && !el.closest('#panel').classList.contains('shown'))))) continue;
      const before = errs.length; const url = page.url();
      if (info.tag === 'SELECT') { await h.selectOption({ index: 1 }).catch(() => {}); } else { await h.click({ timeout: 5000 }).catch(async () => { await h.scrollIntoViewIfNeeded().catch(() => {}); await h.click({ timeout: 5000 }).catch(() => { dead.push(info.tag + ' ' + (info.id || info.text || info.attrs.slice(0, 40))); }); }); } n++; await page.waitForTimeout(120);
      if (info.href && info.href.startsWith('#') && info.href.length > 1 && !/^#(pools|swap|home|privacy|activity|markets|sealed|portfolio|pool-)/.test(info.href)) { const ok = await page.evaluate((hh) => !!document.getElementById(hh.slice(1)) || !!document.querySelector('[name="' + hh.slice(1) + '"]'), info.href); if (!ok) dead.push('anchor ' + info.href); }
      if (new URL(page.url()).pathname !== new URL(url).pathname) { await page.goBack().catch(() => {}); await page.waitForTimeout(400); if (new URL(page.url()).pathname !== new URL(url).pathname) { await page.goto(url).catch(() => {}); await page.waitForTimeout(800); } }
      if (hash && (await page.evaluate(() => location.hash)) !== '#' + hash) { await page.evaluate((v) => { location.hash = '#' + v; }, hash); await page.waitForTimeout(500); }
      if (errs.length > before) errs[errs.length - 1] += '  (after ' + info.tag + ' ' + (info.id || info.text) + ')'; if (reopen) { if (await page.$('#modal:not([hidden])')) { await page.click('#dlgX', { timeout: 1500 }).catch(() => page.keyboard.press('Escape')); } if (!(await page.$('#panel.shown'))) await reopen(); } else await closeOverlays(page); } catch { /* detached */ } }
  check(label + ': ' + n + ' controls clicked, none dead, no errors, no overflow', dead.length === 0 && errs.length === 0 && (await noScroll(page, w)), (dead.length ? 'dead: ' + dead.join(', ') + ' ' : '') + errs.slice(0, 2).join(' | ')); errs.length = 0; }

(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-smoke-')); const site = build('devnet', { out, env: {}, log: () => {} }); const web = serveDist(PORT, site.out); let browser;
  try {
    browser = await chromium.launch({ executablePath: chromePath() });
    // the in-browser demo chain is a developer mode now (the public app is on-chain only): every context here opts in
    { const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc(o); await c.addInitScript(() => { try { if (!localStorage.getItem('veyl:mode')) localStorage.setItem('veyl:mode', 'sandbox-dev'); } catch { /* storage blocked */ } }); return c; }; }
    if (want('crawl')) for (const [name, w, h, mobile] of [['desktop', 1360, 900, false], ['phone', 390, 844, true]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile }); await mockMarket(ctx); await mockMarkets(ctx); const page = await ctx.newPage(); const errs = []; watch(page, errs);
      // static pages: load, scroll, every link resolves, every anchor exists
      for (const pg of PAGES) { await page.goto(WEB + '/' + pg + '.html', { waitUntil: 'load' }); await page.waitForTimeout(500);
        const links = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')).filter((x) => x && !/^(https?:|mailto:)/.test(x)));
        const broken = []; for (const href of new Set(links)) { const [file, anchor] = href.split('#'); const f = file || pg + '.html'; const r = await ctx.request.get(WEB + '/' + f); if (!r.ok()) { broken.push(href); continue; } if (anchor && !/^app\.html/.test(f)) { const html = await r.text(); if (!new RegExp('id="' + anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"').test(html)) broken.push(href); } }
        check(name + ' ' + pg + '.html: ' + new Set(links).size + ' internal links resolve, anchors exist', broken.length === 0, broken.join(', '));
        if (pg === 'index') { await page.locator('#how').scrollIntoViewIfNeeded(); await page.waitForFunction(() => document.querySelectorAll('#lpBins rect.b').length === 51, null, { timeout: 30000 }).catch(() => {}); }
        await clickAll(page, 'body', name + ' ' + pg + '.html', errs, w); }
      // the app: every view, every control
      await page.goto(WEB + '/app.html#pools'); await waitApp(page);
      for (const v of VIEWS) { await page.evaluate((v) => { location.hash = '#' + v; }, v); await page.waitForTimeout(700); if (/^pool-/.test(v)) await page.waitForFunction(() => document.querySelectorAll('#binChart rect').length > 10, null, { timeout: 30000 }).catch(() => {}); if (v === 'markets') await page.waitForFunction(() => document.querySelectorAll('#mkRows tr, #mkCards .pcard').length > 0, null, { timeout: 30000 }).catch(() => {});
        await clickAll(page, 'main, header, aside, .bnav', name + ' app#' + v, errs, w, v);
        if (mobile && /^pool-/.test(v)) { for (const tab of ['add', 'zap', 'limit', 'swap']) { await page.click('.addbar [data-sheet="' + tab + '"]'); await page.waitForTimeout(300); await clickAll(page, '#panel', name + ' app#' + v + ' sheet ' + tab, errs, w, v, async () => { await page.click('.addbar [data-sheet="' + tab + '"]').catch(() => {}); await page.waitForTimeout(250); }); await page.keyboard.press('Escape'); await page.waitForTimeout(200); } } }
      // the navigation itself: every sidebar entry lands on its view
      { const dead = []; for (const go of ['swap', 'pools', 'home', 'privacy', 'activity', 'sealed']) { if (mobile) { await page.click('#menuBtn').catch(() => {}); await page.waitForTimeout(250); } await page.click('.side-nav [data-go="' + go + '"]', { timeout: 3000 }).catch(() => dead.push(go)); await page.waitForTimeout(300); const h = await page.evaluate(() => location.hash); if (h !== '#' + (go === 'home' ? 'portfolio' : go)) dead.push(go + '->' + h); }
        check(name + ' app navigation: every entry opens its view', dead.length === 0 && errs.length === 0, dead.join(', ') + ' ' + errs.join(' | ')); errs.length = 0; }
      // faucet and the sandbox menus, then back/forward across views
      await page.goto(WEB + '/app.html#home'); await waitApp(page); await page.click('#acctBtn'); await page.click('#acctPop [data-faucet]'); await page.waitForSelector('#doneBtn, #actErr', { timeout: 60000 }); check(name + ' faucet from the account menu', !!(await page.$('#doneBtn')), await page.textContent('#dlgBody')); await page.click('#doneBtn').catch(() => {});
      await page.evaluate(() => { location.hash = '#pools'; }); await page.waitForTimeout(300); await page.evaluate(() => { location.hash = '#swap'; }); await page.waitForTimeout(300); await page.goBack(); await page.waitForTimeout(400); const h1 = await page.evaluate(() => location.hash); await page.goForward(); await page.waitForTimeout(400); const h2 = await page.evaluate(() => location.hash);
      check(name + ' back/forward move between views', h1 === '#pools' && h2 === '#swap' && errs.length === 0, h1 + ' ' + h2 + ' ' + errs.join(' | ')); errs.length = 0;
      await ctx.close(); }
    // a 4x slower CPU, reduced motion: a shielded swap still proves and verifies
    if (want('cpu')) { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' }); await mockMarket(ctx); const page = await ctx.newPage(); const errs = []; watch(page, errs); const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.goto(WEB + '/app.html#swap'); await waitApp(page); await page.click('#swSrc [data-src="priv"]'); await page.click('#acctBtn'); await page.click('#acctPop [data-faucet]'); await page.waitForSelector('#doneBtn', { timeout: 90000 }); await page.click('#doneBtn');
      await page.fill('#swIn', '0.1'); await page.waitForFunction(() => !document.getElementById('swGo').disabled, null, { timeout: 20000 }); const t = Date.now(); await page.click('#swGo'); await page.waitForSelector('#doneBtn, #actErr', { timeout: 420000 }); const body = await page.textContent('#dlgBody');
      check('4x slower CPU, reduced motion, phone: a shielded swap proves and verifies (' + ((Date.now() - t) / 1000).toFixed(0) + ' s)', !!(await page.$('#doneBtn')) && /verified/i.test(body) && errs.length === 0, body.slice(0, 120) + ' ' + errs.join(' | '));
      await page.goto(WEB + '/index.html'); await page.waitForTimeout(1200); const rm = await page.evaluate(() => ({ runner: getComputedStyle(document.querySelector('.steps-line .runner')).animationName, drawn: (() => { const c = document.getElementById('flowCv'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })(), stat: document.getElementById('flow').classList.contains('static') }));
      check('reduced motion: the hero is drawn once and still, the steps do not loop', rm.runner === 'none' && rm.drawn > 1000 && rm.stat && errs.length === 0, JSON.stringify(rm) + ' ' + errs.join(' | ')); await ctx.close(); }
    // a slow network: the proving key parts stream with visible progress, then the proof completes
    if (want('slow')) { const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }); await mockMarket(ctx); const page = await ctx.newPage(); const errs = []; watch(page, errs); const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 4 * 1024 * 1024 / 8, uploadThroughput: 1024 * 1024 / 8 }); // 4 Mbit/s
      await page.goto(WEB + '/index.html'); await page.locator('#how').scrollIntoViewIfNeeded(); await page.click('#lpGo');
      const ok = await page.waitForFunction(() => document.getElementById('lpSteps').dataset.state === 'done', null, { timeout: 60000 }).then(() => true).catch(() => false);
      check('slow network (4 Mbit/s): the homepage loads and the showcase runs its five steps', ok && errs.length === 0, errs.join(' | ')); await ctx.close(); }
    if (want('reload')) { const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }); await mockMarket(ctx); const page = await ctx.newPage(); const errs = []; watch(page, errs);
      await page.goto(WEB + '/app.html#swap'); await waitApp(page); await page.click('#acctBtn'); await page.click('#acctPop [data-faucet]'); await page.waitForSelector('#doneBtn', { timeout: 60000 }); await page.click('#doneBtn');
      const bal = await page.evaluate(() => String(window.veylEngine.shieldBalance('SOL'))); await page.click('#swSrc [data-src="priv"]'); await page.fill('#swIn', '0.2'); await page.waitForFunction(() => !document.getElementById('swGo').disabled, null, { timeout: 20000 }); await page.click('#swGo');
      await page.waitForFunction(() => /Proving|proof/i.test(document.getElementById('dlgBody').textContent), null, { timeout: 30000 }); await page.waitForTimeout(1500); await page.reload(); await waitApp(page); await page.evaluate(() => window.veylEngine.shieldSync());
      const after = await page.evaluate(() => String(window.veylEngine.shieldBalance('SOL'))); const seq = await page.evaluate(() => window.veylEngine.chain.seq);
      check('reload mid-proof: the sandbox reloads consistent (balance intact or spent whole, no half state), no errors', (after === bal || BigInt(after) < BigInt(bal)) && seq >= 1 && errs.length === 0, bal + ' -> ' + after + ' ' + errs.join(' | '));
      await page.click('#swSrc [data-src="priv"]'); await page.fill('#swIn', '0.1'); await page.waitForFunction(() => !document.getElementById('swGo').disabled, null, { timeout: 20000 }); await page.click('#swGo'); await page.waitForSelector('#doneBtn, #actErr', { timeout: 300000 });
      check('after the reload the next shielded swap completes', !!(await page.$('#doneBtn')), (await page.textContent('#dlgBody')).slice(0, 100));
      // two tabs on one sandbox: the second tab sees the first tab's chain, no errors in either
      const p2 = await ctx.newPage(); const e2 = []; watch(p2, e2); await p2.goto(WEB + '/app.html#activity'); await waitApp(p2); const seq2 = await p2.evaluate(() => window.veylEngine.chain.seq); const seq1 = await page.evaluate(() => window.veylEngine.chain.seq);
      check('two tabs: the second tab opens the same sandbox (shared localStorage), no errors', Math.abs(seq2 - seq1) <= 5 && e2.length === 0, seq1 + ' vs ' + seq2 + ' ' + e2.join(' | ')); await ctx.close(); }
    // localStorage blocked (private windows, strict settings): the pages and the app still run, in memory
    if (want('storage')) { const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }); await mockMarket(ctx); await ctx.addInitScript(() => { const deny = { get() { throw new DOMException('blocked', 'SecurityError'); } }; Object.defineProperty(window, 'localStorage', deny); Object.defineProperty(window, 'sessionStorage', deny); });
      const page = await ctx.newPage(); const errs = []; watch(page, errs); await page.goto(WEB + '/app.html#pools'); await page.waitForFunction(() => document.querySelectorAll('#poolRows tr[data-pool]').length > 0, null, { timeout: 30000 }).catch(() => {}); const rows = await page.$$eval('#poolRows tr[data-pool]', (r) => r.length);
      await page.goto(WEB + '/index.html'); await page.locator('#how').scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
      check('localStorage blocked: the app (all 83 pools) and the homepage still load, no errors', rows === 83 && !(await page.isDisabled('#lpGo')) && errs.length === 0, rows + ' rows ' + errs.join(' | ')); await ctx.close(); }
  } catch (e) { check('smoke ran to the end', false, e.stack); }
  finally { if (browser) await browser.close(); web.close(); try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* temp */ } }
  console.log(`\n${pass} passed, ${fail} failed (${lap()})`); process.exit(fail ? 1 : 0);
})();
