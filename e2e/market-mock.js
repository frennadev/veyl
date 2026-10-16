// Browser tests cannot reach the price APIs from here: these routes answer for them, in each API's own response shape
// (Pyth Hermes, Jupiter Price v3, CoinGecko, Coinbase ticker and candles). `fail` makes every one refuse, for the "market price
// unavailable" path; `jupiter: false` makes Jupiter answer 429 so the CoinGecko and Coinbase fallbacks are exercised.
'use strict';
const FEEDS = { SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', USDC: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a', USDT: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b', JUP: '0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996', BONK: '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419' };
const MINTS = { SOL: 'So11111111111111111111111111111111111111112', USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' };
const PRICES = { SOL: 162.37, USDC: 0.9999, USDT: 1.0002, JUP: 0.4521, BONK: 0.00001243 };
const GECKO = { SOL: 'solana', USDC: 'usd-coin', USDT: 'tether', JUP: 'jupiter-exchange-solana', BONK: 'bonk' };
const json = (body, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
async function mockMarket(target, { prices = PRICES, fail = false, pyth = true, jupiter = true, gecko = true, counter = null } = {}) {
  const hit = (k) => { if (counter) counter[k] = (counter[k] || 0) + 1; };
  await target.route(/hermes\.pyth\.network/, (r) => { hit('pyth'); if (fail || !pyth) return r.fulfill(json({ message: 'unauthorized' }, 401)); const now = Math.floor(Date.now() / 1000);
    r.fulfill(json({ binary: { encoding: 'hex', data: [] }, parsed: Object.entries(FEEDS).map(([s, id]) => ({ id, price: { price: String(Math.round(prices[s] * 1e8)), conf: '10000', expo: -8, publish_time: now - 2 }, ema_price: { price: String(Math.round(prices[s] * 1e8)), conf: '10000', expo: -8, publish_time: now - 2 }, metadata: { slot: 1 } })) })); });
  await target.route(/jup\.ag\/price/, (r) => { hit('jupiter'); if (fail) return r.fulfill(json({}, 503)); if (!jupiter) return r.fulfill(json({ error: 'rate limited' }, 429)); r.fulfill(json(Object.fromEntries(Object.entries(MINTS).map(([s, m]) => [m, { usdPrice: prices[s], blockId: 1, decimals: 6, priceChange24h: 0.4 }])))); });
  await target.route(/api\.coingecko\.com/, (r) => { hit('gecko'); if (fail || !gecko) return r.fulfill(json({ status: { error_code: 429 } }, 429)); const ids = (new URL(r.request().url()).searchParams.get('ids') || '').split(',');
    r.fulfill(json(Object.fromEntries(Object.entries(GECKO).filter(([, id]) => ids.includes(id)).map(([s, id]) => [id, { usd: prices[s], usd_24h_change: 0.3 }])))); });
  await target.route(/api\.exchange\.coinbase\.com\/products\/[A-Z]+-USD\/ticker/, (r) => { hit('ticker'); if (fail) return r.fulfill(json({ message: 'unavailable' }, 503)); const sym = new URL(r.request().url()).pathname.split('/')[2].split('-')[0];
    r.fulfill(json({ price: String(prices[sym] || 1), time: new Date().toISOString(), bid: '0', ask: '0', volume: '0', size: '0', trade_id: 1 })); });
  await target.route(/api\.exchange\.coinbase\.com/, (r) => { hit('candles'); if (fail) return r.fulfill(json({ message: 'unavailable' }, 503)); const u = new URL(r.request().url()); const sym = u.pathname.split('/')[2].split('-')[0];
    const t0 = Math.floor(Date.parse(u.searchParams.get('start')) / 1000), t1 = Math.floor(Date.parse(u.searchParams.get('end')) / 1000); const p = prices[sym] || 1; const out = [];
    for (let t = t1 - (t1 % 300); t >= t0; t -= 300) { const stable = sym === 'USDT' || sym === 'USDC'; const c = stable ? p * (1 + 0.0001 * Math.sin(t / 5000)) : p * (1 - 0.03 * ((t1 - t) / 86400)) * (1 + 0.004 * Math.sin(t / 2400 + sym.length)); out.push([t, c * 0.999, c * 1.001, c, c, 100]); } r.fulfill(json(out)); });
}
module.exports = { mockMarket, PRICES };
/// The Solana-markets APIs (GeckoTerminal, DexScreener, Meteora, Raydium, Orca) answered from the recorded fixtures.
const fs = require('fs'), path = require('path'); const FX = (f) => fs.readFileSync(path.join(__dirname, '../tests/fixtures/markets', f), 'utf8');
async function mockMarkets(target, { fail = false, limited = null, counter = null } = {}) { const hit = (k) => { if (counter) counter[k] = (counter[k] || 0) + 1; };
  const J = (b, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: typeof b === 'string' ? b : JSON.stringify(b) });
  await target.route(/api\.geckoterminal\.com/, (r) => { hit('gecko'); const u = r.request().url(); if (fail || limited === 'gecko') return r.fulfill(J({ errors: [{ status: '429', title: 'Too Many Requests' }] }, 429)); if (/ohlcv/.test(u)) return r.fulfill(J(FX('gecko-ohlcv.json'))); if (/trending/.test(u)) return r.fulfill(J({ data: [], included: [] })); r.fulfill(J(FX('gecko-pools.json'))); });
  await target.route(/api\.dexscreener\.com/, (r) => { hit('dexscreener'); if (fail) return r.fulfill(J({ message: 'down' }, 503)); r.fulfill(J(FX('dexscreener-search.json'))); });
  await target.route(/dlmm-api\.meteora\.ag/, (r) => { hit('meteora'); if (fail) return r.fulfill(J({}, 503)); r.fulfill(J(FX('meteora-groups.json'))); });
  await target.route(/api-v3\.raydium\.io/, (r) => { hit('raydium'); if (fail) return r.fulfill(J({}, 503)); r.fulfill(J(FX('raydium-list.json'))); });
  await target.route(/api\.orca\.so/, (r) => { hit('orca'); if (fail) return r.fulfill(J({}, 503)); r.fulfill(J(FX('orca-pools.json'))); }); }
module.exports.mockMarkets = mockMarkets;
