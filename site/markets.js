// Solana markets: live liquidity pools across other DEXes, read in the browser from keyless public APIs. These are external
// pools, never Veyl's: the app labels them so and keeps them out of Veyl's own figures.
//
//   GeckoTerminal  https://api.geckoterminal.com/api/v2/networks/solana/{pools,trending_pools}?include=base_token,quote_token,dex
//                  search: /api/v2/search/pools?query=&network=solana · OHLCV: /networks/solana/pools/{addr}/ohlcv/{day|hour|minute}
//                  JSON:API: data[].attributes {name, address, base_token_price_usd, pool_created_at, reserve_in_usd, fdv_usd,
//                  price_change_percentage{m5,h1,h6,h24}, volume_usd{m5,h1,h6,h24}, transactions}, relationships.dex; included[]
//                  keyless, ~30 requests/min, cached 60 s upstream
//   DexScreener    https://api.dexscreener.com/latest/dex/search?q= · /latest/dex/pairs/solana/{addr} · /token-pairs/v1/solana/{mint}
//                  { pairs: [{ chainId, dexId, url, pairAddress, labels, baseToken, quoteToken, priceUsd, txns, volume{h24..},
//                  priceChange{h24..}, liquidity{usd}, fdv, marketCap, pairCreatedAt }] }   keyless, ~300/min
//   Meteora DLMM   https://dlmm-api.meteora.ag/pair/all_by_groups?page=&limit=&sort_key=volume&order_by=desc&search_term=
//                  { groups: [{ name, pairs: [{ address, name, mint_x, mint_y, bin_step, base_fee_percentage, liquidity, trade_volume_24h,
//                  fees_24h, apr, apy, current_price, volume{hour_1,...}, fees{...}, fee_tvl_ratio{...} }] }], total }   keyless
//   Raydium        https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=volume24h&sortType=desc&pageSize=&page=
//                  { success, data: { count, data: [{ id, type, programId, mintA{address,symbol,decimals}, mintB, price, feeRate, tvl,
//                  openTime, day{volume, volumeFee, apr}, week, month }] } }   keyless, cached 60 s upstream
//   Orca           https://api.orca.so/v2/solana/pools?sortBy=volume24h&sortDirection=desc&minTvl=&size=
//                  { data: [{ address, tokenA{address,symbol,decimals}, tokenB, tickSpacing, feeRate, price, tvlUsdc,
//                  stats: { "24h": { volume, fees, yieldOverTvl } }, updatedAt }], meta: { next, previous } }   keyless
// Keyed sources (Birdeye, Helius, Jupiter Pro, Pyth) are config slots only: nothing here needs a key.
export const SOURCES = {
  gecko: { name: 'GeckoTerminal', base: 'https://api.geckoterminal.com/api/v2', ttl: 60_000, perMin: 28 },
  dexscreener: { name: 'DexScreener', base: 'https://api.dexscreener.com', ttl: 45_000, perMin: 200 },
  meteora: { name: 'Meteora', base: 'https://dlmm-api.meteora.ag', ttl: 60_000, perMin: 60 },
  raydium: { name: 'Raydium', base: 'https://api-v3.raydium.io', ttl: 60_000, perMin: 60 },
  orca: { name: 'Orca', base: 'https://api.orca.so/v2/solana', ttl: 60_000, perMin: 60 },
};
export const ORIGINS = Object.values(SOURCES).map((s) => new URL(s.base).origin);
export const DEX_NAMES = { 'meteora': 'Meteora DLMM', 'meteora-dlmm': 'Meteora DLMM', 'meteora-damm': 'Meteora DAMM', 'raydium': 'Raydium', 'raydium-clmm': 'Raydium CLMM', 'raydium-cpmm': 'Raydium CPMM', 'orca': 'Orca', 'pump-fun': 'Pump.fun', 'pumpswap': 'PumpSwap', 'pumpfun': 'Pump.fun', 'lifinity': 'Lifinity', 'phoenix': 'Phoenix', 'openbook': 'OpenBook' };
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const dexOf = (id) => { const k = String(id || '').toLowerCase(); return DEX_NAMES[k] || (k ? k.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Other'); };
const ageOf = (iso) => { if (!iso) return null; const t = typeof iso === 'number' ? iso : Date.parse(iso); return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 1000)) : null; };

// ------------------------------------------------------------------------------------------------ parsers -> rows
/// A row: { key, address, dex, dexId, pair, base{symbol,address}, quote{symbol,address}, priceUsd, change{m5,h1,h6,h24},
///          liquidityUsd, volume{m5,h1,h6,h24}, feesUsd24h, aprPct, binStep, feePct, createdAt (s), ageSec, source, at, url, explorer }
const row = (o) => ({ change: {}, volume: {}, feesUsd24h: null, aprPct: null, binStep: null, feePct: null, createdAt: null, ageSec: null, ...o, key: 'solana:' + o.address, explorer: 'https://solscan.io/account/' + o.address });

export function parseGecko(json, now = Date.now()) {
  const inc = new Map(); for (const i of (json && json.included) || []) inc.set(i.id, i);
  const list = Array.isArray(json && json.data) ? json.data : json && json.data ? [json.data] : []; const out = [];
  for (const d of list) { const a = d.attributes || {}; const rel = d.relationships || {}; const tok = (r) => { const id = r && r.data && r.data.id; const t = inc.get(id); return { address: String(id || '').replace(/^solana_/, ''), symbol: t && t.attributes ? t.attributes.symbol : null }; };
    const base = tok(rel.base_token), quote = tok(rel.quote_token); const dexId = rel.dex && rel.dex.data ? rel.dex.data.id : null; const name = a.name || ((base.symbol || '?') + ' / ' + (quote.symbol || '?'));
    const [bs, qs] = name.split(' / '); if (!base.symbol) base.symbol = bs; if (!quote.symbol) quote.symbol = qs;
    const pc = a.price_change_percentage || {}, vol = a.volume_usd || {};
    out.push(row({ address: a.address, dex: dexOf(dexId), dexId, pair: base.symbol + '–' + quote.symbol, base, quote, priceUsd: num(a.base_token_price_usd), change: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
      liquidityUsd: num(a.reserve_in_usd), volume: { m5: num(vol.m5), h1: num(vol.h1), h6: num(vol.h6), h24: num(vol.h24) }, fdvUsd: num(a.fdv_usd), txns24h: a.transactions && a.transactions.h24 ? (num(a.transactions.h24.buys) || 0) + (num(a.transactions.h24.sells) || 0) : null,
      createdAt: a.pool_created_at ? Math.floor(Date.parse(a.pool_created_at) / 1000) : null, ageSec: ageOf(a.pool_created_at), source: 'GeckoTerminal', at: now, url: 'https://www.geckoterminal.com/solana/pools/' + a.address })); }
  return out;
}
export function parseDexScreener(json, now = Date.now()) { const list = Array.isArray(json) ? json : (json && (json.pairs || json.pair && [json.pair])) || []; const out = [];
  for (const p of list) { if (p.chainId && p.chainId !== 'solana') continue; const base = { address: p.baseToken && p.baseToken.address, symbol: p.baseToken && p.baseToken.symbol }, quote = { address: p.quoteToken && p.quoteToken.address, symbol: p.quoteToken && p.quoteToken.symbol };
    const v = p.volume || {}, c = p.priceChange || {}; const tx = p.txns && p.txns.h24;
    out.push(row({ address: p.pairAddress, dex: dexOf(p.dexId), dexId: p.dexId, pair: base.symbol + '–' + quote.symbol, base, quote, priceUsd: num(p.priceUsd), change: { m5: num(c.m5), h1: num(c.h1), h6: num(c.h6), h24: num(c.h24) },
      liquidityUsd: p.liquidity ? num(p.liquidity.usd) : null, volume: { m5: num(v.m5), h1: num(v.h1), h6: num(v.h6), h24: num(v.h24) }, fdvUsd: num(p.fdv), marketCapUsd: num(p.marketCap), txns24h: tx ? (num(tx.buys) || 0) + (num(tx.sells) || 0) : null, labels: p.labels || [],
      createdAt: p.pairCreatedAt ? Math.floor(Number(p.pairCreatedAt) / 1000) : null, ageSec: p.pairCreatedAt ? ageOf(Number(p.pairCreatedAt)) : null, source: 'DexScreener', at: now, url: p.url || 'https://dexscreener.com/solana/' + p.pairAddress })); }
  return out; }
export function parseMeteora(json, now = Date.now()) { const pairs = Array.isArray(json) ? json : (json && json.groups ? json.groups.flatMap((g) => g.pairs || []) : (json && json.pairs) || []); const out = [];
  for (const p of pairs) { if (p.hide || p.is_blacklisted) continue; const [bs, qs] = String(p.name || '').split('-'); const base = { address: p.mint_x, symbol: bs }, quote = { address: p.mint_y, symbol: qs };
    const vol = p.volume || {}, fees = p.fees || {}; const liq = num(p.liquidity); const f24 = num(p.fees_24h) ?? num(fees.hour_24);
    out.push(row({ address: p.address, dex: 'Meteora DLMM', dexId: 'meteora', pair: bs + '–' + qs, base, quote, priceUsd: null, priceNative: num(p.current_price), liquidityUsd: liq, volume: { h1: num(vol.hour_1), h6: num(vol.hour_4) ?? null, h24: num(p.trade_volume_24h) ?? num(vol.hour_24) },
      feesUsd24h: f24, fees: { h1: num(fees.hour_1), h24: f24 }, aprPct: num(p.apr), apyPct: num(p.apy), binStep: num(p.bin_step), feePct: num(p.base_fee_percentage), feeTvl: p.fee_tvl_ratio ? num(p.fee_tvl_ratio.hour_24) : null, verified: p.is_verified !== false,
      source: 'Meteora', at: now, url: 'https://app.meteora.ag/dlmm/' + p.address })); }
  return out; }
export function parseRaydium(json, now = Date.now()) { const list = (json && json.data && (Array.isArray(json.data) ? json.data : json.data.data)) || []; const out = [];
  for (const p of list) { const A = p.mintA || p.mint1 || {}, B = p.mintB || p.mint2 || {}; const base = { address: A.address, symbol: A.symbol }, quote = { address: B.address, symbol: B.symbol }; const d = p.day || {};
    const type = String(p.type || '').toLowerCase(); const dexId = type === 'concentrated' ? 'raydium-clmm' : type === 'standard' ? 'raydium' : 'raydium-' + type;
    out.push(row({ address: p.id, dex: dexOf(dexId), dexId, pair: (base.symbol || '?') + '–' + (quote.symbol || '?'), base, quote, priceUsd: null, priceNative: num(p.price), liquidityUsd: num(p.tvl), volume: { h24: num(d.volume) }, feesUsd24h: num(d.volumeFee), aprPct: num(d.apr), feePct: num(p.feeRate) != null ? num(p.feeRate) * 100 : null,
      createdAt: num(p.openTime) || null, ageSec: num(p.openTime) ? Math.max(0, Math.floor(now / 1000) - num(p.openTime)) : null, source: 'Raydium', at: now, url: 'https://raydium.io/liquidity/increase/?mode=add&pool_id=' + p.id })); }
  return out; }
export function parseOrca(json, now = Date.now()) { const list = (json && json.data) || []; const out = [];
  for (const p of list) { const A = p.tokenA || {}, B = p.tokenB || {}; const base = { address: p.tokenMintA || A.address, symbol: A.symbol }, quote = { address: p.tokenMintB || B.address, symbol: B.symbol }; const s = (p.stats && p.stats['24h']) || {};
    out.push(row({ address: p.address, dex: 'Orca', dexId: 'orca', pair: (base.symbol || '?') + '–' + (quote.symbol || '?'), base, quote, priceUsd: null, priceNative: num(p.price), liquidityUsd: num(p.tvlUsdc), volume: { h24: num(s.volume) }, feesUsd24h: num(s.fees), aprPct: num(s.yieldOverTvl) != null ? num(s.yieldOverTvl) * 365 * 100 : null,
      feePct: num(p.feeRate) != null ? num(p.feeRate) / 1e4 : null, tickSpacing: num(p.tickSpacing), updatedAt: p.updatedAt || null, source: 'Orca', at: now, url: 'https://www.orca.so/pools/' + p.address })); }
  return out; }
/// GeckoTerminal OHLCV -> [{ t, o, h, l, c, v }] oldest first. { data: { attributes: { ohlcv_list: [[ts, o, h, l, c, v], ...] } } }
export function parseOhlcv(json) { const l = (json && json.data && json.data.attributes && json.data.attributes.ohlcv_list) || []; return l.map((x) => ({ t: Number(x[0]), o: num(x[1]), h: num(x[2]), l: num(x[3]), c: num(x[4]), v: num(x[5]) })).filter((x) => x.c != null).sort((a, b) => a.t - b.t); }

// ------------------------------------------------------------------------------------------------ merge: one row per pool
/// The same pool from several sources becomes one row: every field takes the first source that has it, in the order given
/// (the DEX's own API first for its own pools, since it knows bin steps, fees and APR; aggregators fill price and change).
const PRI = { Meteora: 0, Raydium: 0, Orca: 0, GeckoTerminal: 1, DexScreener: 2 };
export function mergeRows(lists) { const by = new Map(); const fill = (a, b) => { for (const [k, v] of Object.entries(b)) { if (k === 'sources' || k === 'key') continue; if (v && typeof v === 'object' && !Array.isArray(v)) { a[k] = a[k] && typeof a[k] === 'object' ? a[k] : {}; for (const [kk, vv] of Object.entries(v)) if (a[k][kk] == null && vv != null) a[k][kk] = vv; } else if ((a[k] == null || a[k] === '') && v != null) a[k] = v; } };
  for (const r of lists.flat()) { if (!r || !r.address) continue; const cur = by.get(r.key); if (!cur) { by.set(r.key, { ...r, sources: [r.source] }); continue; }
    if ((PRI[r.source] ?? 3) < (PRI[cur.source] ?? 3)) { const nxt = { ...r, sources: [...new Set([...cur.sources, r.source])] }; fill(nxt, cur); by.set(r.key, nxt); } else { fill(cur, r); if (!cur.sources.includes(r.source)) cur.sources.push(r.source); } }
  // a price in dollars for DEX-native rows: the quote token's dollar price times the pool price, when an aggregator gave the pair
  for (const r of by.values()) { if (r.priceUsd == null && r.priceNative != null && r.quoteUsd != null) r.priceUsd = r.priceNative * r.quoteUsd; if (r.ageSec == null && r.createdAt) r.ageSec = Math.max(0, Math.floor(Date.now() / 1000) - r.createdAt); }
  return [...by.values()]; }

// ------------------------------------------------------------------------------------------------ the client: cache, rate limits, honest states
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
export class Markets {
  /// opts: { fetch, keys: { birdeye, helius, jupiter, pyth }, proxy: url prefix for sources the browser cannot call, sources: [ids] }
  constructor(opts = {}) { this.f = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null); this.keys = opts.keys || {}; this.proxy = opts.proxy || null; this.enabled = opts.sources || Object.keys(SOURCES);
    this.cache = new Map(); this.state = {}; for (const id of Object.keys(SOURCES)) this.state[id] = { ok: null, at: 0, error: null, until: 0, calls: [] }; this.listeners = new Set(); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); } _emit() { for (const fn of this.listeners) { try { fn(this); } catch { /* listener */ } } }
  _limited(id) { const st = this.state[id]; const now = Date.now(); st.calls = st.calls.filter((t) => t > now - 60_000); if (st.until > now) return st.until - now; if (st.calls.length >= SOURCES[id].perMin) return 60_000 - (now - st.calls[0]); return 0; }
  /// One request, cached per URL for the source's TTL; a 429 or 5xx backs the whole source off (doubling, up to 5 min).
  async get(id, url, { ttl = SOURCES[id].ttl, params = null } = {}) { if (!this.f) throw new Error('no fetch'); const key = url; const c = this.cache.get(key); const now = Date.now(); if (c && now - c.at < ttl) return c.body;
    const st = this.state[id]; const wait = this._limited(id); if (wait > 0) { if (c) return c.body; const e = new Error('rate limited'); e.retryIn = wait; e.source = id; throw e; }
    st.calls.push(now); let r; try { r = await withTimeout(this.f(url, { headers: { accept: 'application/json' } }), 12_000); } catch (e) { st.ok = false; st.error = e.message; st.at = now; this._emit(); if (c) return c.body; throw e; }
    if (r.status === 429 || r.status >= 500) { const back = Math.min(300_000, (st.backoff || 15_000) * 2); st.backoff = back; st.until = now + back; st.ok = false; st.error = r.status === 429 ? 'rate limited' : 'answered ' + r.status; st.at = now; this._emit(); if (c) return c.body; const e = new Error(st.error); e.retryIn = back; e.source = id; throw e; }
    if (!r.ok) { st.ok = false; st.error = 'answered ' + r.status; st.at = now; this._emit(); throw new Error(st.error); }
    const body = await r.json(); this.cache.set(key, { at: now, body }); st.ok = true; st.error = null; st.at = now; st.backoff = 0; this._emit(); return body; }
  /// The main listing: every enabled source's top pools by volume, merged. Sources that fail are reported, not fatal.
  async list({ limit = 100 } = {}) { const jobs = {
      gecko: async () => { const a = await this.get('gecko', SOURCES.gecko.base + '/networks/solana/pools?include=base_token,quote_token,dex&page=1'); const b = await this.get('gecko', SOURCES.gecko.base + '/networks/solana/trending_pools?include=base_token,quote_token,dex&page=1').catch(() => null); return [...parseGecko(a), ...(b ? parseGecko(b) : [])]; },
      meteora: async () => parseMeteora(await this.get('meteora', SOURCES.meteora.base + '/pair/all_by_groups?page=0&limit=' + Math.min(limit, 100) + '&sort_key=volume&order_by=desc&include_unknown=false&hide_low_tvl=5000')),
      raydium: async () => parseRaydium(await this.get('raydium', SOURCES.raydium.base + '/pools/info/list?poolType=all&poolSortField=volume24h&sortType=desc&pageSize=' + Math.min(limit, 100) + '&page=1')),
      orca: async () => parseOrca(await this.get('orca', SOURCES.orca.base + '/pools?sortBy=volume24h&sortDirection=desc&minTvl=5000&size=' + Math.min(limit, 100))),
      dexscreener: async () => { const got = []; let last = null; for (const q of ['SOL/USDC', 'SOL/USDT']) { try { got.push(...parseDexScreener(await this.get('dexscreener', SOURCES.dexscreener.base + '/latest/dex/search?q=' + encodeURIComponent(q)))); } catch (e) { last = e; } } if (!got.length && last) throw last; return got; } };
    const lists = []; const errors = {}; await Promise.all(this.enabled.filter((id) => jobs[id]).map(async (id) => { try { lists.push(await jobs[id]()); } catch (e) { errors[id] = e.retryIn ? { retryIn: e.retryIn, message: e.message } : { message: e.message }; } }));
    const rows = mergeRows(lists); const usd = {}; for (const r of rows) if (r.priceUsd != null && r.base && r.base.address) usd[r.base.address] = r.priceUsd; usd['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] = usd['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] || 1;
    for (const r of rows) if (r.priceUsd == null && r.priceNative != null && r.quote && usd[r.quote.address] != null) r.priceUsd = r.priceNative * usd[r.quote.address];
    return { rows, errors, at: Date.now() }; }
  async search(q) { const out = []; const errors = {};
    try { out.push(...parseDexScreener(await this.get('dexscreener', SOURCES.dexscreener.base + '/latest/dex/search?q=' + encodeURIComponent(q)))); } catch (e) { errors.dexscreener = { message: e.message, retryIn: e.retryIn }; }
    try { out.push(...parseGecko(await this.get('gecko', SOURCES.gecko.base + '/search/pools?query=' + encodeURIComponent(q) + '&network=solana&include=base_token,quote_token,dex'))); } catch (e) { errors.gecko = { message: e.message, retryIn: e.retryIn }; }
    try { out.push(...parseMeteora(await this.get('meteora', SOURCES.meteora.base + '/pair/all_by_groups?page=0&limit=30&sort_key=volume&order_by=desc&search_term=' + encodeURIComponent(q)))); } catch (e) { errors.meteora = { message: e.message, retryIn: e.retryIn }; }
    return { rows: mergeRows([out]), errors, at: Date.now() }; }
  /// One pool's detail: DexScreener's pair (price, change, txns) and GeckoTerminal's candles (timeframe day|hour|minute).
  async detail(address, timeframe = 'hour', agg = 1) { const out = { address }; try { out.pair = parseDexScreener(await this.get('dexscreener', SOURCES.dexscreener.base + '/latest/dex/pairs/solana/' + address))[0] || null; } catch (e) { out.pairError = e.message; }
    try { out.candles = parseOhlcv(await this.get('gecko', SOURCES.gecko.base + '/networks/solana/pools/' + address + '/ohlcv/' + timeframe + '?aggregate=' + agg + '&limit=120', { ttl: 120_000 })); } catch (e) { out.candles = []; out.candlesError = e.retryIn ? 'rate limited' : e.message; }
    return out; }
  /// What a key would add, for the UI's "add a key for more" line.
  keyed() { return [['birdeye', 'Birdeye', 'token security, holders and OHLCV for every pool'], ['helius', 'Helius', 'a faster, higher-limit Solana RPC (devnet and mainnet reads)'], ['jupiter', 'Jupiter Pro', 'higher rate limits on prices and routes'], ['pyth', 'Pyth Hermes', 'first-party oracle prices']].map(([id, name, adds]) => ({ id, name, adds, present: !!this.keys[id] })); }
}
