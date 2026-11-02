// Opening prices for a deploy: config "prices" values of "live" are fetched at that moment from two independent sources,
// CoinGecko and Jupiter's price API (by mint), which must agree within LIVE_PRICE_MAX_SPREAD (default 0.01 = 1%); their
// mean is used. LAUNCH_PRICES_JSON='{"SOL":94.2}' pins a price by hand (it wins over the config and over "live").
// Used by deploy.js (a real deploy stops when a live price cannot be had) and preflight.js (reports what it would use).
'use strict';
const GECKO = { SOL: 'solana', USDC: 'usd-coin', USDT: 'tether', JUP: 'jupiter-exchange-solana', BONK: 'bonk', WIF: 'dogwifcoin', JTO: 'jito-governance-token', PYTH: 'pyth-network', RAY: 'raydium' };
const getJson = async (url, ms = 10_000) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } };
/// { sym: { price, sources: { coingecko, jupiter } } } for each symbol, or { sym: { error } }.
async function fetchLive(syms, mints, { get = getJson, maxSpread = Number(process.env.LIVE_PRICE_MAX_SPREAD || 0.01) } = {}) {
  const out = {}; if (!syms.length) return out; let cg = {}, jup = {};
  const ids = syms.map((s) => GECKO[s]).filter(Boolean);
  try { if (ids.length) cg = await get('https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' + ids.join(',')); } catch (e) { cg = { _error: e.message }; }
  const ms = syms.map((s) => mints[s]).filter(Boolean);
  try { if (ms.length) jup = await get('https://lite-api.jup.ag/price/v3?ids=' + ms.join(',')); } catch (e) { jup = { _error: e.message }; }
  for (const s of syms) { const a = GECKO[s] && cg[GECKO[s]] ? Number(cg[GECKO[s]].usd) : NaN, b = mints[s] && jup[mints[s]] ? Number(jup[mints[s]].usdPrice) : NaN;
    if (!(a > 0) || !(b > 0)) { out[s] = { error: `no live price for ${s} (CoinGecko ${a > 0 ? a : cg._error || 'none'}, Jupiter ${b > 0 ? b : jup._error || 'none'}): set LAUNCH_PRICES_JSON='{"${s}":<USD price>}'` }; continue; }
    const spread = Math.abs(a - b) / Math.min(a, b); const price = Number(((a + b) / 2).toPrecision(6));
    out[s] = spread > maxSpread ? { error: `${s}: CoinGecko ${a} and Jupiter ${b} differ by ${(spread * 100).toFixed(2)}% (> ${(maxSpread * 100).toFixed(2)}%): try again, or set LAUNCH_PRICES_JSON` } : { price, sources: { coingecko: Number(a.toPrecision(6)), jupiter: Number(b.toPrecision(6)) } }; }
  return out;
}
/// The config's prices with every "live" value fetched and LAUNCH_PRICES_JSON applied: { prices, live: { sym: {...} }, errors: [] }.
async function resolvePrices(cfg, env = process.env, opts = {}) {
  const prices = { ...(cfg.prices || {}) }; const pinned = env.LAUNCH_PRICES_JSON ? JSON.parse(env.LAUNCH_PRICES_JSON) : {};
  for (const k of Object.keys(prices)) if (k.startsWith('_')) delete prices[k];
  for (const [s, v] of Object.entries(pinned)) prices[s] = Number(v);
  const want = Object.entries(prices).filter(([, v]) => v === 'live').map(([s]) => s);
  const live = await fetchLive(want, cfg.mints || {}, opts); const errors = [];
  for (const s of want) { if (live[s].error) { errors.push(live[s].error); delete prices[s]; } else prices[s] = live[s].price; }
  return { prices, live, errors };
}
module.exports = { fetchLive, resolvePrices, GECKO };
