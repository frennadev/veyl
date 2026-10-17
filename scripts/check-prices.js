#!/usr/bin/env node
// Checks the live price sources the app uses (engine/market.js) from this machine, in the app's own order, and prints what
// each answered. Run it where the app will be used when the app says "market price unavailable":
//   node scripts/check-prices.js                 # keyless, like the published app
//   PYTH_API_KEY=... JUPITER_API_KEY=... node scripts/check-prices.js
// Node 20+ (global fetch). HTTPS_PROXY is honoured when NODE_USE_ENV_PROXY=1 (Node 22.21+).
'use strict';
const path = require('path');
const code = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../engine/market.js')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const box = { exports: {} }; new Function('module', 'exports', 'require', code)(box, box.exports, require); const M = box.exports;
const keys = { pyth: process.env.PYTH_API_KEY, jupiter: process.env.JUPITER_API_KEY };
(async () => {
  console.log('Price sources, in the app\'s order (3 s timeout each):');
  const probes = [
    ['Pyth Hermes', M.ENDPOINTS.hermes[0] + '/v2/updates/price/latest?ids[]=' + M.PYTH_FEEDS.SOL + '&parsed=true', keys.pyth ? { 'X-API-Key': keys.pyth } : {}],
    ['Jupiter', M.ENDPOINTS.jupiter[0] + '?ids=' + M.MAINNET_MINTS.SOL, keys.jupiter ? { 'x-api-key': keys.jupiter } : {}],
    ['CoinGecko', M.ENDPOINTS.coingecko + '?ids=solana&vs_currencies=usd', {}],
    ['Coinbase', M.ENDPOINTS.coinbase + '/SOL-USD/ticker', {}],
  ];
  for (const [name, url, headers] of probes) {
    const t0 = Date.now(); try { const r = await Promise.race([fetch(url, { headers: { accept: 'application/json', ...headers } }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after 3 s')), 3000))]);
      const body = await r.text(); let sol = null; try { const j = JSON.parse(body); sol = name === 'Pyth Hermes' ? (M.parsePyth(j).SOL || {}).usd : name === 'Jupiter' ? (M.parseJupiter(j).SOL || {}).usd : name === 'CoinGecko' ? (M.parseCoinGecko(j).SOL || {}).usd : (M.parseCoinbaseTicker(j) || {}).usd; } catch { /* not JSON */ }
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(12)} HTTP ${r.status} in ${Date.now() - t0} ms` + (sol ? `  SOL = $${sol}` : `  ${body.slice(0, 120).replace(/\s+/g, ' ')}`));
    } catch (e) { console.log(`  FAIL ${name.padEnd(12)} ${e.message} (${Date.now() - t0} ms)`); }
  }
  console.log('\nThe app\'s own chain (Market.refresh):');
  const m = new M.Market({ keys, timeoutMs: 3000 });
  try { const p = await m.refresh(); for (const [s, v] of Object.entries(p)) console.log(`  ${s.padEnd(5)} $${v.usd}  ${v.source}`); console.log('  ' + m.why()); }
  catch (e) { console.log('  ' + e.message); console.log('\nNothing answered. From a browser the usual causes are: a network that blocks these hosts, an extension, or a Content-Security-Policy on the page host that omits them (connect-src must list ' + M.ORIGINS.join(', ') + ').'); process.exit(1); }
})();
