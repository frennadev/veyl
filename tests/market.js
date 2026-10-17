#!/usr/bin/env node
// Market price parsers (engine/market.js) against recorded response shapes: Pyth Hermes, Jupiter Price API v3 (and v2's
// { data } wrapper), CoinGecko, Coinbase ticker and candles; and the provider chain (Pyth only with a key, then Jupiter,
// CoinGecko, Coinbase, each for what is still missing; a clear failure when nothing answers) with a mocked fetch. No network.
'use strict';
const path = require('path'); const fs = require('fs');
const { check, finish, loadEngine } = require('./harness.js');
const mod = loadEngine('market.js');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/market', f), 'utf8'));
const close = (a, b, e = 1e-9) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b));
(async () => {
  const py = mod.parsePyth(fx('pyth-hermes-latest.json'));
  check('Pyth: price × 10^expo for SOL, USDC, USDT, JUP', close(py.SOL.usd, 147.48534567) && close(py.USDC.usd, 0.99990123) && close(py.USDT.usd, 1.00012) && close(py.JUP.usd, 0.40560185), JSON.stringify(Object.keys(py)));
  check('Pyth: publish time in ms, confidence scaled, source named', py.SOL.at === 1791900000000 && close(py.SOL.conf, 0.08834521) && py.SOL.source === 'Pyth');
  check('Pyth: ids with a 0x prefix match too; unknown ids ignored', mod.parsePyth({ parsed: [{ id: '0x' + mod.PYTH_FEEDS.SOL, price: { price: '1', expo: 0, conf: '0', publish_time: 1 } }, { id: 'ff', price: { price: '5', expo: 0 } }] }).SOL.usd === 1);
  check('Pyth: a zero or missing price is dropped', Object.keys(mod.parsePyth({ parsed: [{ id: mod.PYTH_FEEDS.SOL, price: { price: '0', expo: -8 } }] })).length === 0);
  const jp = mod.parseJupiter(fx('jupiter-price-v3.json'));
  check('Jupiter v3: usdPrice per mint, 24h change', close(jp.JUP.usd, 0.4056018512541055) && close(jp.SOL.usd, 147.4789340738336) && close(jp.JUP.change24h, 0.5292887924920519) && jp.SOL.source === 'Jupiter');
  check('Jupiter: a mint omitted from the response is simply absent', !jp.USDC && !jp.USDT);
  check('Jupiter v2 shape ({ data: { mint: { price } } }) still parses', close(mod.parseJupiter({ data: { [mod.MAINNET_MINTS.SOL]: { id: mod.MAINNET_MINTS.SOL, type: 'derivedPrice', price: '146.9' } } }).SOL.usd, 146.9));
  const cd = mod.parseCandles(fx('coinbase-candles.json'));
  check('Coinbase candles: oldest first, close = field 4', cd.length === 3 && cd[0].t === 1791899400 && cd[2].close === 147.48);
  // the provider chain with a mocked fetch
  const resp = (status, body) => Promise.resolve({ ok: status === 200, status, json: async () => body });
  const cg = mod.parseCoinGecko(fx('coingecko-simple-price.json'));
  check('CoinGecko: usd per id, 24h change, BONK included', close(cg.SOL.usd, 147.52) && close(cg.BONK.usd, 0.00001243) && close(cg.JUP.change24h, -1.1) && cg.SOL.source === 'CoinGecko', JSON.stringify(Object.keys(cg)));
  const cb = mod.parseCoinbaseTicker(fx('coinbase-ticker.json'));
  check('Coinbase ticker: price and time', close(cb.usd, 147.5) && cb.at === Date.parse('2026-10-13T20:00:00.000Z') && cb.source === 'Coinbase');
  check('Coinbase ticker: a missing price is null', mod.parseCoinbaseTicker({ message: 'NotFound' }) === null);
  // the provider chain with a mocked fetch
  const calls = []; const m1 = new mod.Market({ keys: {}, fetch: (u) => { calls.push(u); if (/hermes/.test(u)) return resp(401, {}); if (/jup\.ag/.test(u)) return resp(200, fx('jupiter-price-v3.json')); if (/coingecko/.test(u)) return resp(200, fx('coingecko-simple-price.json')); return resp(404, {}); } });
  const p1 = await m1.refresh(); check('no Pyth key: Pyth skipped, Jupiter answers SOL and JUP, CoinGecko fills the rest; sources named', close(p1.SOL.usd, 147.4789340738336) && p1.SOL.source === 'Jupiter' && p1.USDC.source === 'CoinGecko' && p1.BONK.source === 'CoinGecko' && m1.source === 'Jupiter + CoinGecko' && /^Jupiter · \d+ s ago$/.test(m1.label('SOL')), m1.source + ' | ' + m1.why());
  check('Pyth is not asked without a key; Jupiter asked once for every mint', !calls.some((u) => /hermes/.test(u)) && calls.filter((u) => /jup\.ag/.test(u)).length === 1 && /ids=So111.*DezXAZ/.test(calls.find((u) => /jup\.ag/.test(u))), calls.join(' '));
  const calls2 = []; const m2 = new mod.Market({ keys: { pyth: 'k' }, fetch: (u, o) => { calls2.push([u, o]); return /hermes/.test(u) ? resp(200, fx('pyth-hermes-latest.json')) : resp(500, {}); } }); await m2.refresh();
  check('with a Pyth key: Hermes asked with X-API-Key, parsed, every feed; cross price SOL in USDC', m2.source === 'Pyth' && calls2[0][1].headers['X-API-Key'] === 'k' && /hermes\.pyth\.network\/v2\/updates\/price\/latest\?ids\[\]=ef0d8b6f.*&parsed=true/.test(calls2[0][0]) && close(m2.cross('SOL', 'USDC'), 147.48534567 / 0.99990123));
  const m4 = new mod.Market({ keys: {}, fetch: (u) => { if (/jup\.ag/.test(u)) return resp(429, {}); if (/coingecko/.test(u)) return resp(429, {}); if (/SOL-USD\/ticker/.test(u)) return resp(200, fx('coinbase-ticker.json')); return resp(404, {}); } }); const p4 = await m4.refresh();
  check('Jupiter and CoinGecko rate-limited: Coinbase tickers answer SOL, USDC is 1; the reasons are kept', close(p4.SOL.usd, 147.5) && p4.USDC.usd === 1 && !p4.JUP && /Jupiter: api\.jup\.ag answered 429 · CoinGecko: api\.coingecko\.com answered 429 · Coinbase: ok/.test(m4.why()), m4.why());
  const m3 = new mod.Market({ keys: {}, fetch: () => Promise.reject(new Error('offline')) }); let err = null; try { await m3.refresh(); } catch (e) { err = e.message; }
  check('nothing answers: a clear "market price unavailable" with every reason, no invented price', /market price unavailable.*Jupiter: offline.*CoinGecko: offline.*Coinbase: offline/.test(err) && m3.usd('SOL') === null && m3.label('SOL') === 'market price unavailable', err);
  finish(null, { cu: false });
})();
