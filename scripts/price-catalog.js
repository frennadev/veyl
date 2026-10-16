#!/usr/bin/env node
// Prices every token in config/<network>.json from live markets, for the opening price of each pool (devnet / local only).
// Meteora's own DLMM API first (each pair's current price, chained through SOL and the stablecoins to US dollars), then
// CoinGecko for the majors. Writes cfg.prices; a token left without a price is skipped by the deploy, with its pools.
//   node scripts/price-catalog.js --network devnet [--file meteora.json]   (--file: a saved API response, for tests)
'use strict';
const fs = require('fs'); const path = require('path');
const net = (process.argv.indexOf('--network') > 0 ? process.argv[process.argv.indexOf('--network') + 1] : 'devnet');
if (net === 'mainnet') { console.error('price-catalog is for devnet/local only'); process.exit(2); }
const P = path.join(__dirname, '../config/' + net + '.json'); const cfg = JSON.parse(fs.readFileSync(P, 'utf8'));
const fileArg = process.argv.indexOf('--file') > 0 ? process.argv[process.argv.indexOf('--file') + 1] : null;
const STABLE = { USDC: 1, USDT: 1, USDG: 1, JupUSD: 1, USDe: 1 };
const norm = (s) => (s === 'Bonk' ? 'BONK' : s);
async function meteoraPairs() {
  if (fileArg) return JSON.parse(fs.readFileSync(fileArg, 'utf8')).groups.flatMap((g) => g.pairs);
  const out = [];
  for (let page = 0; page < 8; page++) { // the 800 deepest pools are plenty to price every catalog pair
    const r = await fetch('https://dlmm-api.meteora.ag/pair/all_by_groups?page=' + page + '&limit=100&sort_key=tvl&order_by=desc'); if (!r.ok) break;
    const j = await r.json(); const ps = (j.groups || []).flatMap((g) => g.pairs || []); if (!ps.length) break; out.push(...ps); }
  return out;
}
(async () => {
  const want = new Set(cfg.tokens); const usd = { ...STABLE }; const pairs = [];
  try { for (const p of await meteoraPairs()) { if (p.is_blacklisted || p.hide || !(p.current_price > 0)) continue; const [x, y] = String(p.name).split('-').map(norm); if (!x || !y) continue;
      pairs.push({ x, y, px: Number(p.current_price), liq: Number(p.liquidity) || 0 }); } } catch (e) { console.log('Meteora API unreachable (' + e.message + ')'); }
  pairs.sort((a, b) => b.liq - a.liq); // the deepest pool sets each price
  for (let pass = 0; pass < 4; pass++) for (const p of pairs) {
    if (usd[p.y] !== undefined && usd[p.x] === undefined) usd[p.x] = p.px * usd[p.y];
    else if (usd[p.x] !== undefined && usd[p.y] === undefined && p.px > 0) usd[p.y] = usd[p.x] / p.px; }
  const missing = [...want].filter((s) => !(usd[s] > 0));
  if (missing.length) { // CoinGecko by symbol for anything Meteora did not price (the majors, mostly)
    const ids = { SOL: 'solana', JUP: 'jupiter-exchange-solana', BONK: 'bonk', WIF: 'dogwifcoin', JTO: 'jito-governance-token', PYTH: 'pyth-network', RAY: 'raydium', WBTC: 'wrapped-bitcoin', cbBTC: 'coinbase-wrapped-btc', WETH: 'weth', HYPE: 'hyperliquid', DOGE: 'dogecoin', PEPE: 'pepe', ENA: 'ethena', INJ: 'injective-protocol', STRK: 'starknet', ZEC: 'zcash', PENGU: 'pudgy-penguins' };
    const q = missing.filter((s) => ids[s]); if (q.length) try { const j = await (await fetch('https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' + q.map((s) => ids[s]).join(','))).json(); for (const s of q) if (j[ids[s]] && j[ids[s]].usd > 0) usd[s] = j[ids[s]].usd; } catch {} }
  const prices = {}; for (const s of want) if (usd[s] > 0) prices[s] = Number(usd[s].toPrecision(6));
  cfg.prices = prices; fs.writeFileSync(P, JSON.stringify(cfg, null, 2) + '\n');
  const left = [...want].filter((s) => !prices[s]); const pools = cfg.binPools.length;
  console.log('priced ' + Object.keys(prices).length + ' of ' + want.size + ' tokens' + (left.length ? ' (no price, skipped: ' + left.join(', ') + ')' : '') + ' · ' + pools + ' pools listed');
})();
