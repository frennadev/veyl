// Live market prices for the app, fetched in the browser. Four sources, each tried in turn with a 3-second timeout
// until every symbol has a price; every price says where it came from and when. Nothing here is ever Veyl pool data.
//
//   1. Pyth Hermes   GET {hermes}/v2/updates/price/latest?ids[]=<feed id>&parsed=true   (header X-API-Key when a key is set)
//                    { binary, parsed: [{ id, price: { price, conf, expo, publish_time }, ema_price, metadata }] }
//                    Pyth's Core upgrade (26 Aug 2026) put Hermes behind an API key, so it is only asked when VEYL_KEYS.pyth is set.
//   2. Jupiter       GET https://api.jup.ag/price/v3?ids=<mints>   keyless at 0.5 requests/s (x-api-key raises the limit)
//                    { <mint>: { usdPrice, blockId, decimals, priceChange24h } }   (mints without a reliable price are omitted)
//   3. CoinGecko     GET https://api.coingecko.com/api/v3/simple/price?ids=<ids>&vs_currencies=usd&include_24hr_change=true
//                    { <id>: { usd, usd_24h_change } }   keyless, CORS open, ~30 requests/min
//   4. Coinbase      GET https://api.exchange.coinbase.com/products/<SYM>-USD/ticker   { price, time, ... }   keyless, CORS open
//   History (the Sandbox's last 24 hours): Coinbase Exchange public candles
//                    GET https://api.exchange.coinbase.com/products/<SYM>-USD/candles?granularity=300&start&end
//                    [[time, low, high, open, close, volume], ...] newest first, at most 300 per request
// `market.tries` records each attempt ([source, 'ok' | reason]) so the app can say why a price is missing.
export const PYTH_FEEDS = {
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  USDC: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  USDT: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
  JUP: '0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
  BONK: '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
};
export const MAINNET_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
};
export const COINGECKO_IDS = { SOL: 'solana', USDC: 'usd-coin', USDT: 'tether', JUP: 'jupiter-exchange-solana', BONK: 'bonk' };
export const COINBASE_PRODUCTS = { SOL: 'SOL-USD', USDT: 'USDT-USD', JUP: 'JUP-USD', BONK: 'BONK-USD' }; // USDC is the quote: 1
export const ENDPOINTS = {
  hermes: ['https://hermes.pyth.network'],
  jupiter: ['https://api.jup.ag/price/v3'],
  coingecko: 'https://api.coingecko.com/api/v3/simple/price',
  coinbase: 'https://api.exchange.coinbase.com/products',
  candles: 'https://api.exchange.coinbase.com/products',
};
/// Origins the page must be allowed to reach (CSP connect-src).
export const ORIGINS = ['https://hermes.pyth.network', 'https://api.jup.ag', 'https://api.coingecko.com', 'https://api.exchange.coinbase.com'];

/// Hermes `parsed` entries -> { SYM: { usd, conf, at (ms), source } }. Price = price × 10^expo.
export function parsePyth(json, feeds = PYTH_FEEDS) {
  const bySym = {}; const ids = Object.fromEntries(Object.entries(feeds).map(([s, id]) => [id.replace(/^0x/, '').toLowerCase(), s]));
  for (const e of (json && json.parsed) || []) { const sym = ids[String(e.id || '').replace(/^0x/, '').toLowerCase()]; if (!sym || !e.price) continue;
    const ex = Number(e.price.expo); const usd = Number(e.price.price) * 10 ** ex; const conf = Number(e.price.conf) * 10 ** ex;
    if (!(usd > 0) || !Number.isFinite(usd)) continue; bySym[sym] = { usd, conf, at: Number(e.price.publish_time) * 1000, source: 'Pyth' }; }
  return bySym;
}
/// Jupiter Price API v3 (and the v2 shape { data: { mint: { price } } }) -> { SYM: { usd, change24h, source } }.
export function parseJupiter(json, mints = MAINNET_MINTS, now = Date.now()) {
  const bySym = {}; const src = json && json.data && typeof json.data === 'object' ? json.data : json || {};
  for (const [sym, mint] of Object.entries(mints)) { const e = src[mint]; if (!e) continue; const usd = Number(e.usdPrice !== undefined ? e.usdPrice : e.price);
    if (!(usd > 0) || !Number.isFinite(usd)) continue; bySym[sym] = { usd, change24h: e.priceChange24h !== undefined ? Number(e.priceChange24h) : null, at: now, source: 'Jupiter' }; }
  return bySym;
}
/// CoinGecko simple/price -> { SYM: { usd, change24h, source } }.
export function parseCoinGecko(json, ids = COINGECKO_IDS, now = Date.now()) {
  const bySym = {}; for (const [sym, id] of Object.entries(ids)) { const e = json && json[id]; if (!e) continue; const usd = Number(e.usd);
    if (!(usd > 0) || !Number.isFinite(usd)) continue; bySym[sym] = { usd, change24h: e.usd_24h_change !== undefined ? Number(e.usd_24h_change) : null, at: now, source: 'CoinGecko' }; }
  return bySym;
}
/// Coinbase Exchange ticker -> { usd, at, source } for one symbol, or null.
export function parseCoinbaseTicker(json, now = Date.now()) { const usd = Number(json && json.price); if (!(usd > 0) || !Number.isFinite(usd)) return null;
  const at = json.time ? Date.parse(json.time) : NaN; return { usd, at: Number.isFinite(at) ? at : now, source: 'Coinbase' }; }
/// Coinbase candles -> [{ t (s), close }] oldest first.
export function parseCandles(json) { if (!Array.isArray(json)) return []; return json.filter((c) => Array.isArray(c) && c.length >= 5 && Number(c[4]) > 0).map((c) => ({ t: Number(c[0]), close: Number(c[4]) })).sort((a, b) => a.t - b.t); }

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export class Market {
  constructor({ fetch: f = (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null), syms = Object.keys(MAINNET_MINTS), timeoutMs = 3000, keys = (typeof window !== 'undefined' && window.VEYL_KEYS) || {} } = {}) {
    this.f = f; this.syms = syms; this.timeoutMs = timeoutMs; this.keys = keys || {}; this.prices = {}; this.source = null; this.at = 0; this.error = null; this.listeners = new Set(); this.tries = []; this._lastJup = 0; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) { try { fn(this); } catch { /* listener */ } } }
  async _json(url, headers = {}) { const r = await withTimeout(this.f(url, { headers: { accept: 'application/json', ...headers } }), this.timeoutMs); if (!r.ok) throw new Error(new URL(url).host + ' answered ' + r.status); return r.json(); }
  /// Fetch every symbol through the chain (Pyth with a key, Jupiter, CoinGecko, Coinbase) until each has a price.
  /// Returns the prices, or throws with every attempt's reason when none came.
  async refresh() {
    if (!this.f) throw new Error('no fetch'); const got = {}; this.tries = []; const missing = () => this.syms.filter((s) => !got[s]);
    if (this.keys.pyth) for (const base of ENDPOINTS.hermes) { try { const q = this.syms.filter((s) => PYTH_FEEDS[s]).map((s) => 'ids[]=' + PYTH_FEEDS[s]).join('&');
      Object.assign(got, parsePyth(await this._json(base + '/v2/updates/price/latest?' + q + '&parsed=true', { 'X-API-Key': this.keys.pyth }))); this.tries.push(['Pyth', 'ok']); break; } catch (e) { this.tries.push(['Pyth', e.message]); } }
    else this.tries.push(['Pyth', 'skipped: needs an API key (VEYL_KEYS.pyth)']);
    if (missing().length) { const wait = 2200 - (Date.now() - this._lastJup); if (wait > 0 && this._lastJup) await new Promise((r) => setTimeout(r, wait)); // keyless Jupiter: 0.5 requests/s
      for (const base of ENDPOINTS.jupiter) { try { this._lastJup = Date.now(); const ms = missing(); const j = parseJupiter(await this._json(base + '?ids=' + ms.map((s) => MAINNET_MINTS[s]).join(','), this.keys.jupiter ? { 'x-api-key': this.keys.jupiter } : {}));
        for (const s of ms) if (j[s]) got[s] = j[s]; this.tries.push(['Jupiter', 'ok']); break; } catch (e) { this.tries.push(['Jupiter', e.message]); } } }
    if (missing().length) { try { const ms = missing().filter((s) => COINGECKO_IDS[s]); const j = parseCoinGecko(await this._json(ENDPOINTS.coingecko + '?ids=' + ms.map((s) => COINGECKO_IDS[s]).join(',') + '&vs_currencies=usd&include_24hr_change=true'));
      for (const s of ms) if (j[s]) got[s] = j[s]; this.tries.push(['CoinGecko', 'ok']); } catch (e) { this.tries.push(['CoinGecko', e.message]); } }
    if (missing().length) { let any = false, err = null; for (const s of missing()) { const prod = COINBASE_PRODUCTS[s]; if (!prod) continue;
      try { const t = parseCoinbaseTicker(await this._json(ENDPOINTS.coinbase + '/' + prod + '/ticker')); if (t) { got[s] = t; any = true; } } catch (e) { err = e.message; } }
      if (any && !got.USDC && this.syms.includes('USDC')) got.USDC = { usd: 1, at: Date.now(), source: 'Coinbase' }; // the quote currency of every Coinbase product here
      this.tries.push(['Coinbase', any ? 'ok' : err || 'no product']); }
    if (!Object.keys(got).length) { this.error = 'market price unavailable'; this._emit(); throw new Error(this.error + ' (' + this.tries.map((t) => t.join(': ')).join('; ') + ')'); }
    this.prices = { ...this.prices, ...got }; this.error = null; this.at = Date.now(); const srcs = [...new Set(Object.values(got).map((p) => p.source))]; this.source = srcs.join(' + '); this._emit(); return this.prices; }
  /// Why the last refresh went the way it did, for a tooltip: "Pyth: skipped … · Jupiter: api.jup.ag answered 429 · CoinGecko: ok".
  why() { return this.tries.map((t) => t.join(': ')).join(' · '); }
  usd(sym) { const p = this.prices[sym]; return p ? p.usd : null; }
  /// Y per X from two USD prices (e.g. SOL in USDC = SOL/USD ÷ USDC/USD).
  cross(x, y) { const a = this.usd(x), b = this.usd(y); return a && b ? a / b : null; }
  /// "Pyth · 3 s ago" for a symbol (or the newest price).
  label(sym) { const p = sym ? this.prices[sym] : Object.values(this.prices).sort((a, b) => b.at - a.at)[0]; if (!p) return 'market price unavailable';
    const s = Math.max(0, Math.round((Date.now() - p.at) / 1000)); return p.source + ' · ' + (s < 60 ? s + ' s' : Math.round(s / 60) + ' min') + ' ago'; }
  /// Five-minute closes in USD over the last `secs` (Coinbase public candles), oldest first; [] when unavailable.
  async history(sym, secs = 86400) { if (!this.f || sym === 'USDC') return [];
    const prod = COINBASE_PRODUCTS[sym] || sym + '-USD'; const end = Math.floor(Date.now() / 1000); const out = [];
    try { for (let t1 = end; t1 > end - secs; t1 -= 300 * 290) { const t0 = Math.max(end - secs, t1 - 300 * 290);
        const j = await this._json(ENDPOINTS.candles + '/' + prod + '/candles?granularity=300&start=' + new Date(t0 * 1000).toISOString() + '&end=' + new Date(t1 * 1000).toISOString()); out.push(...parseCandles(j)); }
    } catch { return []; }
    const seen = new Set(); return out.filter((c) => (seen.has(c.t) ? false : seen.add(c.t))).sort((a, b) => a.t - b.t); }
}
