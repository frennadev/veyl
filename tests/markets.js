#!/usr/bin/env node
// Solana markets (engine/markets.js): parsers against recorded response shapes (GeckoTerminal, DexScreener, Meteora DLMM,
// Raydium, Orca, OHLCV), the merge (one row per pool, the DEX's own figures first), and the client's cache, rate limit and
// backoff with a mocked fetch. No network.
'use strict';
const path = require('path'); const fs = require('fs');
const { check, finish, loadEngine } = require('./harness.js');
const M = loadEngine('markets.js');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/markets', f), 'utf8'));
const close = (a, b, e = 1e-6) => a != null && Math.abs(a - b) <= e * Math.max(1, Math.abs(b));
(async () => {
  const g = M.parseGecko(fx('gecko-pools.json'));
  check('GeckoTerminal: pools with tokens and DEX from included[], numbers parsed', g.length === 2 && g[0].pair === 'SOL–USDC' && g[0].dex === 'Orca' && close(g[0].priceUsd, 162.41) && close(g[0].liquidityUsd, 18234567.12) && close(g[0].volume.h24, 41000000.75) && close(g[0].change.h24, 3.04) && g[0].txns24h === 24235, JSON.stringify(g[0].pair));
  check('GeckoTerminal: null reserve stays null; pool age from pool_created_at; Pump.fun named', g[1].liquidityUsd === null && g[1].dex === 'Pump.fun' && g[1].ageSec > 0 && g[0].createdAt === 1710148320);
  const d = M.parseDexScreener(fx('dexscreener-search.json'));
  check('DexScreener: Solana pairs only, labels, txns, change, liquidity.usd', d.length === 1 && d[0].dex === 'Meteora DLMM' && d[0].labels[0] === 'DLMM' && close(d[0].liquidityUsd, 9500000.25) && close(d[0].change.h24, 3.0) && d[0].txns24h === 23500 && d[0].createdAt === 1710140000);
  const m = M.parseMeteora(fx('meteora-groups.json'));
  check('Meteora: bin step, base fee, 24h volume / fees, APR; hidden and blacklisted pools dropped', m.length === 1 && m[0].binStep === 10 && close(m[0].feePct, 0.1) && close(m[0].feesUsd24h, 22000.12) && close(m[0].aprPct, 0.2316) && close(m[0].volume.h1, 900000) && m[0].pair === 'SOL–USDC');
  const r = M.parseRaydium(fx('raydium-list.json'));
  check('Raydium: concentrated and standard pools, fee rate as a percentage, day volume / fees / APR, open time', r.length === 2 && r[0].dex === 'Raydium CLMM' && close(r[0].feePct, 0.04) && close(r[0].volume.h24, 31000000.2) && close(r[0].aprPct, 33.5) && r[0].createdAt === 1700000000 && r[1].dex === 'Raydium' && r[1].createdAt === null);
  const o = M.parseOrca(fx('orca-pools.json'));
  check('Orca: tvlUsdc, 24h stats, fee rate (hundredths of a bp), APR from yieldOverTvl', o.length === 1 && close(o[0].liquidityUsd, 18234567.12) && close(o[0].feesUsd24h, 16400.3) && close(o[0].feePct, 0.04) && close(o[0].aprPct, 0.000899 * 365 * 100) && o[0].tickSpacing === 4);
  const c = M.parseOhlcv(fx('gecko-ohlcv.json')); check('OHLCV: oldest first, close and volume', c.length === 3 && c[0].t === 1791892800 && close(c[2].c, 162.41));
  const rows = M.mergeRows([g, d, m, r, o]);
  const sol = rows.find((x) => x.address === 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'), met = rows.find((x) => x.address === 'BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh');
  check('merge: the same Orca pool from GeckoTerminal and Orca is one row; Orca\'s fees and fee tier, Gecko\'s price and change', rows.length === 5 && sol.sources.length === 2 && sol.source === 'Orca' && close(sol.feesUsd24h, 16400.3) && close(sol.priceUsd, 162.41) && close(sol.change.h24, 3.04) && sol.ageSec > 0, JSON.stringify(sol.sources));
  check('merge: the Meteora pool from Meteora and DexScreener keeps Meteora\'s bin step and APR, takes DexScreener\'s price', met.sources.length === 2 && met.binStep === 10 && close(met.aprPct, 0.2316) && close(met.priceUsd, 162.43) && met.txns24h === 23500);
  // the client
  const resp = (status, body) => Promise.resolve({ ok: status === 200, status, json: async () => body }); const calls = [];
  const fetch1 = (u) => { calls.push(u); if (/geckoterminal.*trending/.test(u)) return resp(429, {}); if (/geckoterminal/.test(u)) return resp(200, fx('gecko-pools.json')); if (/dexscreener/.test(u)) return resp(200, fx('dexscreener-search.json')); if (/meteora/.test(u)) return resp(200, fx('meteora-groups.json')); if (/raydium/.test(u)) return resp(200, fx('raydium-list.json')); if (/orca/.test(u)) return resp(200, fx('orca-pools.json')); return resp(404, {}); };
  const mk = new M.Markets({ fetch: fetch1 }); const L = await mk.list({ limit: 50 });
  check('list: every source asked, rows merged, a 429 on one call backs that source off and is reported in its state', L.rows.length >= 5 && mk.state.gecko.ok === false && mk.state.gecko.until > Date.now() && /rate limited/.test(mk.state.gecko.error) && mk.state.meteora.ok === true, Object.keys(L.errors).join(','));
  const n1 = calls.length; await mk.list({ limit: 50 }); check('cache: a second listing within the TTL makes no new requests', calls.length === n1, calls.length + ' vs ' + n1);
  let err = null; try { await mk.get('gecko', M.SOURCES.gecko.base + '/search/pools?query=x'); } catch (e) { err = e; } check('rate limited: a new GeckoTerminal request waits out the backoff (retryIn given), no made-up data', err && err.retryIn > 0 && err.source === 'gecko');
  const det = await mk.detail('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'); check('detail: DexScreener pair (or its absence) and candles rate-limited reported per part', 'pair' in det && det.candlesError === 'rate limited' && Array.isArray(det.candles));
  const mk2 = new M.Markets({ fetch: () => Promise.reject(new Error('offline')) }); const L2 = await mk2.list(); check('every source down: an empty list with an error per source, never fabricated rows', L2.rows.length === 0 && Object.keys(L2.errors).length === 5 && mk2.state.orca.error === 'offline');
  check('keyed sources are slots only, none present by default', mk.keyed().length === 4 && mk.keyed().every((k) => !k.present));
  finish(null, { cu: false });
})();
