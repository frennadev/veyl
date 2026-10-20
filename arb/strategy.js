// What the arbitrage bot does with one pool, as a pure function: compare the pool's price with the market's, and when the
// gap is wider than what a trade costs (the pool's swap fee + the 0.2% protocol fee + a safety margin), size a swap that
// moves the pool toward the market price but stops while every unit it trades is still profitable at market value.
// It keeps Veyl's prices honest, so limit orders fill when the market moves (they fill only when trading crosses their bin).
// No I/O: the runner (arb.js) passes the pool, the market price and a `simulate(amountIn)` that is SDK simulateSwap on the
// pool's current bins, so a plan is exactly what the program would do.
'use strict';
const S = require('../sdk/veyl.js');

const Q = Number(S.Q), PIPS = Number(S.PIPS);
const DEFAULTS = {
  marginBps: 10,        // extra edge on top of fees before trading (covers price-feed noise and rounding)
  slippageBps: 50,      // minOut = expected out minus this
  maxTradeUsd: 2_000,   // per swap
  minProfitUsd: 0.5,    // profit after the transaction's own cost, below which a trade isn't worth it
  txCostUsd: 0.01,      // what one swap transaction costs in SOL fees (the runner sets it from the SOL price)
  reserve: {},          // { SYM: human units never traded away }, e.g. SOL for transaction fees
};

/// Y per X in human units at bin `id`.
const humanPrice = (p, id, decX, decY) => (Number(S.priceOf(p.basePrice, p.binStep, id)) / Q) * 10 ** (decX - decY);
/// The fee a swap pays right now as a fraction (the pool's dynamic fee at its active bin, plus the protocol fee).
function feeFraction(p, now) {
  const { ref, iref } = S.refsOf(p, now);
  const lp = Number(S.feeOf(p, S.accOf(ref, iref, p.activeId))) / PIPS;
  const proto = (p.protocolFeeBps === undefined ? Number(S.PROTOCOL_FEE_BPS) : p.protocolFeeBps) / 10_000;
  return lp + proto;
}

/// The furthest bin a swap may end in and still be buying (or selling) below (above) market after fees.
/// Buying X (price rising): the last id whose price × (1 + fee + margin) ≤ market. Selling X: the first id whose
/// price × (1 − fee − margin) ≥ market. Bins are a geometric grid, so this is a log, then a ±1 check against priceOf.
function limitBin(p, decX, decY, market, cost, buyingX) {
  const target = buyingX ? market / (1 + cost) : market / (1 - cost);
  const step = Math.log(1 + p.binStep / 10_000);
  let id = p.activeId + Math.round(Math.log(target / humanPrice(p, p.activeId, decX, decY)) / step);
  if (buyingX) { while (humanPrice(p, id, decX, decY) > target) id--; while (humanPrice(p, id + 1, decX, decY) <= target) id++; }
  else { while (humanPrice(p, id, decX, decY) < target) id++; while (humanPrice(p, id - 1, decX, decY) >= target) id--; }
  return id;
}

/// The cheap first look (no bins needed): is the gap past the cost, and which way would a swap go?
/// Returns { xForY: true|false|null, pool, market, gapBps, costBps, reason? } (null: no trade).
function direction({ p, decX, decY, market, usd = { x: 1, y: 1 }, now = Math.floor(Date.now() / 1000), cfg = {} }) {
  const c = { ...DEFAULTS, ...cfg };
  if (p.delisted) return { xForY: null, reason: 'delisted' };
  if (!p.seeded) return { xForY: null, reason: 'no liquidity' };
  if (!(market > 0) || !(usd.x > 0) || !(usd.y > 0)) return { xForY: null, reason: 'no market price' };
  const pool = humanPrice(p, p.activeId, decX, decY);
  const cost = feeFraction(p, now) + c.marginBps / 10_000;
  const gap = market / pool - 1;
  const base = { pool, market, cost, gapBps: Math.round(gap * 10_000), costBps: Math.round(cost * 10_000) };
  if (Math.abs(gap) <= cost) return { xForY: null, reason: 'in line', ...base };
  return { xForY: gap < 0, ...base }; // gap > 0: the pool sells X too cheaply, so buy X with Y (pushes its price up)
}

/// One pool's decision.
///   p: SDK decodeBinPool result · decX/decY: token decimals · market: Y per X (human) · usd: { x, y } dollars per token
///   balance: { x, y } raw units the bot holds · simulate(xForY, amountIn) → { out, endId, fee } (SDK simulateSwap)
/// Returns { action: 'swap', xForY, amountIn, minOut, out, … } or { action: 'none', reason }.
function plan({ p, decX, decY, market, usd, balance, simulate, now = Math.floor(Date.now() / 1000), symX = 'X', symY = 'Y', cfg = {} }) {
  const c = { ...DEFAULTS, ...cfg, reserve: { ...DEFAULTS.reserve, ...(cfg.reserve || {}) } };
  const d = direction({ p, decX, decY, market, usd, now, cfg: c });
  const { cost, ...base } = d; delete base.xForY; delete base.reason;
  if (d.xForY === null) return { action: 'none', reason: d.reason, ...base };
  const xForY = d.xForY, buyingX = !xForY;
  const [decIn, decOut, usdIn, usdOut, symIn] = xForY ? [decX, decY, usd.x, usd.y, symX] : [decY, decX, usd.y, usd.x, symY];
  const limit = limitBin(p, decX, decY, market, cost, buyingX);
  const within = (endId) => (buyingX ? endId <= limit : endId >= limit);

  const reserveRaw = BigInt(Math.round((c.reserve[symIn] || 0) * 10 ** decIn));
  const have = (xForY ? balance.x : balance.y) - reserveRaw;
  const capUsd = BigInt(Math.floor((c.maxTradeUsd / usdIn) * 10 ** decIn));
  let hi = have < capUsd ? have : capUsd;
  if (hi <= 0n) return { action: 'none', reason: 'no ' + symIn + ' to trade', ...base };

  // the largest amount whose swap still ends at or before the limit bin (more input only ever moves the price further)
  const tryAmt = (a) => { try { const r = simulate(xForY, a); return within(r.endId) ? r : null; } catch { return null; } };
  let lo = 0n, best = null;
  if (tryAmt(hi)) { lo = hi; best = tryAmt(hi); }
  else for (let i = 0; i < 48 && hi - lo > 1n; i++) { const mid = (lo + hi) / 2n; const r = tryAmt(mid); if (r) { lo = mid; best = r; } else hi = mid; }
  if (!best || lo === 0n || best.out === 0n) return { action: 'none', reason: 'too little liquidity before the market price', ...base };

  const inUsd = (Number(lo) / 10 ** decIn) * usdIn, outUsd = (Number(best.out) / 10 ** decOut) * usdOut;
  const profitUsd = outUsd - inUsd - c.txCostUsd; // simulate() already took the LP, volatility and protocol fees out of `out`
  if (profitUsd < c.minProfitUsd) return { action: 'none', reason: `profit $${profitUsd.toFixed(2)} below $${c.minProfitUsd}`, ...base };
  const minOut = (best.out * BigInt(10_000 - c.slippageBps)) / 10_000n;
  return { action: 'swap', xForY, amountIn: lo, out: best.out, minOut, endId: best.endId, limitId: limit, inUsd, outUsd, profitUsd, ...base };
}

module.exports = { plan, direction, humanPrice, feeFraction, limitBin, DEFAULTS };
