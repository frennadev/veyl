// Every pool's trades (its Swapped events), indexed once by the relayer for every visitor, so a browser gets a pool's
// figures (volume, fees, APR) and its price history in one request instead of re-reading thousands of transactions from
// the RPC on every page load. Read from the chain only (getSignaturesForAddress + getTransactions, incrementally), and only
// public fields: the time, the side, the amounts, the fee, the protocol fee, the bin after the swap and its transaction. Who swapped (sender,
// recipient) is never kept or served.
// Integrity: only Swapped events logged by the bin program's own frame count (logEvents tags each event with the program
// whose invoke frame logged it); any program can log a look-alike line in a transaction that merely mentions a pool.
// Privacy: the endpoints answer for every pool at once (fixed windows and resolutions), so a request says nothing about
// which pool a visitor looks at. Display data: the app's own figures, not a price source for swaps.
// Cost: bodies are serialized (and gzipped) once per sweep, not per request; memory is capped across all pools.
//   summary() -> { at, pools: { [address]: { agg: { [3600|21600|86400]: { vx, vy, fx, fy, px, py, n, startId } },
//                  recent: [[t, xForY 1|0, amountIn, amountOut, fee, protocolFee, activeId, signature]] (latest 200 in 24 h),
//                  created, complete, oldestT, newest } } }      (amounts as decimal strings; startId: the bin before the window)
//   candles(res) -> { at, res, pools: { [address]: [[t, open, high, low, close, volumeX, volumeY, swaps]] } }
//                    open/high/low/close are bin ids (the price is (1 + binStep)^id, converted on the device); a candle opens
//                    at the previous one's close; buckets without trades are left out.
"use strict";
const { PublicKey } = require("@solana/web3.js");
const zlib = require("zlib");
const S = require("../sdk/veyl.js");

const DAY = 86_400;
const AGG_WINDOWS = [3600, 6 * 3600, DAY], RECENT = 200;
const RESOLUTIONS = { 300: DAY, 900: 3 * DAY, 3600: 7 * DAY, 14400: 7 * DAY, 86400: 7 * DAY }; // resolution -> span served
const KEEP = 7 * DAY, PAGE = 1000, TX_CHUNK = 50, MAX_SWAPS = 50_000;
const MAX_TOTAL = Number(process.env.ACTIVITY_MAX_SWAPS || 500_000); // across every pool

function makeActivity({ conn, pools, program, parse = (logs) => S.logEvents(logs).filter((e) => e.program === program), maxTotal = MAX_TOTAL, intervalMs = Number(process.env.ACTIVITY_MS || 20_000), gapMs = Number(process.env.ACTIVITY_GAP_MS || 250), now = () => Math.floor(Date.now() / 1000), log = () => {} }) {
  const byPool = new Map(); // address -> { swaps: [...], newest, created, complete, oldestT }
  if (!program && !arguments[0].parse) throw new Error("activity: the bin program id is required (only its own events count)");
  let timer = null, running = null, readyAt = 0;
  const bodies = new Map(); // what -> { at, json, gz }: serialized once per sweep
  const pause = () => new Promise((r) => setTimeout(r, gapMs));

  /// One pool, incrementally: new signatures down to the newest already seen (the first time: back to KEEP), their
  /// transactions in chunks, their Swapped events for this pool.
  async function refresh(addr) {
    const key = new PublicKey(addr); const A = byPool.get(addr) || { swaps: [], newest: null, created: null, complete: false, oldestT: Infinity };
    const t = now(); const fresh = []; let before;
    for (let page = 0; page < 50; page++) {
      const sigs = await conn.getSignaturesForAddress(key, { limit: PAGE, before }, "confirmed"); await pause();
      if (!sigs.length) { if (!A.newest) A.complete = true; break; }
      let stop = false; for (const s of sigs) { if (s.signature === A.newest) { stop = true; break; } fresh.push(s); }
      before = sigs[sigs.length - 1].signature;
      if (stop) break; if (sigs.length < PAGE) { A.complete = true; break; }
      if ((sigs[sigs.length - 1].blockTime || t) < t - KEEP && A.newest === null) break;
    }
    const ok = fresh.filter((s) => !s.err && (s.blockTime || t) >= t - KEEP);
    for (let i = 0; i < ok.length; i += TX_CHUNK) {
      const chunk = ok.slice(i, i + TX_CHUNK);
      const txs = await conn.getTransactions(chunk.map((s) => s.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); await pause();
      txs.forEach((tx, k) => { if (!tx) return; const bt = tx.blockTime || chunk[k].blockTime || t;
        for (const e of parse(tx.meta && tx.meta.logMessages)) {
          if (e.name === "Swapped" && e.pool.toBase58() === addr) A.swaps.push([bt, e.xForY ? 1 : 0, String(e.amountIn), String(e.amountOut), String(e.fee), String(e.protocolFee ?? 0n), e.activeId, chunk[k].signature]);
          if (e.name === "PoolCreated" && e.pool.toBase58() === addr) A.created = bt;
        } });
    }
    if (fresh.length) A.newest = fresh[0].signature;
    for (const s of fresh) if (s.blockTime && s.blockTime < A.oldestT) A.oldestT = s.blockTime;
    A.swaps.sort((a, b) => a[0] - b[0]);
    const cut = t - KEEP; let drop = 0; while (drop < A.swaps.length && A.swaps[drop][0] < cut) drop++;
    if (drop) A.swaps.splice(0, drop); if (A.swaps.length > MAX_SWAPS) A.swaps.splice(0, A.swaps.length - MAX_SWAPS);
    byPool.set(addr, A);
  }

  /// Every pool once (one at a time: the relayer shares its RPC with everything else it does).
  async function sweep() {
    if (running) return running;
    running = (async () => { try { for (const a of await pools()) { try { await refresh(a); } catch (e) { log("activity: " + a.slice(0, 8) + " " + (e && e.message)); } } capTotal(); readyAt = now(); bodies.clear(); } finally { running = null; } })();
    return running;
  }
  function start() { if (timer) return; const tick = () => { sweep().finally(() => { timer = setTimeout(tick, intervalMs); if (timer.unref) timer.unref(); }); }; tick(); }
  function stop() { clearTimeout(timer); timer = null; }

  /// Past `maxTotal` swaps across all pools, the oldest go (whichever pool they're in).
  function capTotal() {
    let total = 0; for (const A of byPool.values()) total += A.swaps.length; if (total <= maxTotal) return;
    const times = []; for (const A of byPool.values()) for (const s of A.swaps) times.push(s[0]);
    times.sort((a, b) => b - a); const cut = times[maxTotal - 1];
    for (const A of byPool.values()) { let drop = 0; while (drop < A.swaps.length && A.swaps[drop][0] < cut) drop++; if (drop) A.swaps.splice(0, drop); }
  }

  /// Every pool's totals over the app's windows, and its latest trades (for the activity list and the price path).
  function summary() {
    const t = now(); const out = {};
    for (const [addr, A] of byPool) {
      const agg = {};
      for (const w of AGG_WINDOWS) { const t0 = t - w; let vx = 0n, vy = 0n, fx = 0n, fy = 0n, px = 0n, py = 0n, n = 0, startId = null;
        for (const [ts, x, i, , f, pf, id] of A.swaps) { if (ts <= t0) { startId = id; continue; } n++; if (x) { vx += BigInt(i); fx += BigInt(f); px += BigInt(pf); } else { vy += BigInt(i); fy += BigInt(f); py += BigInt(pf); } }
        agg[w] = { vx: String(vx), vy: String(vy), fx: String(fx), fy: String(fy), px: String(px), py: String(py), n, startId }; }
      const day = A.swaps.filter((s) => s[0] > t - DAY);
      out[addr] = { agg, recent: day.slice(-RECENT), created: A.created, complete: A.complete, oldestT: Number.isFinite(A.oldestT) ? A.oldestT : null, newest: A.newest };
    }
    return { at: readyAt, pools: out };
  }

  /// A response body, serialized and gzipped once per sweep: { json, gz }.
  function body(what, make) {
    const c = bodies.get(what); if (c) return c;
    const json = JSON.stringify(make()); const b = { json, gz: zlib.gzipSync(json) }; bodies.set(what, b); return b;
  }

  function candles(res) {
    const span = RESOLUTIONS[res]; if (!span) throw new Error("res: one of " + Object.keys(RESOLUTIONS).join(", ") + " seconds");
    const t0 = now() - span; const out = {};
    for (const [addr, A] of byPool) {
      const rows = []; let cur = null, close = null;
      for (const [t, xForY, amountIn, , , , id] of A.swaps) {
        if (t <= t0) { close = id; continue; } // trades before the span only set where the first candle opens
        const b = t - (t % res);
        if (!cur || cur[0] !== b) { if (cur) rows.push(cur); const open = close ?? id; cur = [b, open, Math.max(open, id), Math.min(open, id), id, 0n, 0n, 0]; }
        cur[2] = Math.max(cur[2], id); cur[3] = Math.min(cur[3], id); cur[4] = id; cur[7]++;
        if (xForY) cur[5] += BigInt(amountIn); else cur[6] += BigInt(amountIn);
        close = id;
      }
      if (cur) rows.push(cur);
      out[addr] = rows.map((r) => [r[0], r[1], r[2], r[3], r[4], String(r[5]), String(r[6]), r[7]]);
    }
    return { at: readyAt, res, pools: out };
  }

  return { refresh, sweep, start, stop, summary, candles, summaryBody: () => body("summary", summary),
    candlesBody: (res) => { if (!RESOLUTIONS[res]) throw new Error("res: one of " + Object.keys(RESOLUTIONS).join(", ") + " seconds"); return body("candles:" + res, () => candles(res)); },
    _byPool: byPool };
}

module.exports = { makeActivity, AGG_WINDOWS, RESOLUTIONS };
