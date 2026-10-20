// relayer/activity.js: the trade index behind GET /activity and /candles. No network: the RPC is a stand-in; the logs are
// real log lines (invoke frames + "Program data:" events), so the bin-program check is the production one.
// Run: node tests/activity.js
const assert = require("assert");
const zlib = require("zlib");
const { PublicKey } = require("@solana/web3.js");
const S = require("../sdk/veyl.js");
const { makeActivity } = require("../relayer/activity.js");
const ok = (name, c) => { assert.ok(c, name); console.log("ok -", name); };

const BIN = "6yKrpy8JDoxFfbWdCKUre7Q7PVdvLzmzdSYWa86X4YLk", EVIL = "4q6p4io7m3pgxpMqRDSKBRsAb6gCBGCKvTRabZtp1QHn";
const POOL = "6Fcjq2zJ5FiRBQnD8NMYkC9PgbvtSiQGKLtusRK1P8Yh", OTHER = "BE2Rsg1P7cstjX7FvvTjonLLYT8Qc5EvrDdF2uptXX15";
const NOW = 1_800_000_000;

/// A Swapped event as the program logs it: "Program data: " + base64(discriminator + fields).
function swappedLine({ pool = POOL, xForY = true, amountIn = 100n, activeId = 0 }) {
  const b = Buffer.alloc(8 + 32 * 3 + 1 + 8 * 3 + 4 + 8); let o = 0;
  S.disc("Swapped", "event").copy(b, o); o += 8;
  for (const k of [pool, OTHER, OTHER]) { new PublicKey(k).toBuffer().copy(b, o); o += 32; }
  b.writeUInt8(xForY ? 1 : 0, o); o += 1; b.writeBigUInt64LE(amountIn, o); o += 8; b.writeBigUInt64LE(90n, o); o += 8; b.writeBigUInt64LE(1n, o); o += 8;
  b.writeInt32LE(activeId, o); o += 4; b.writeBigUInt64LE(0n, o);
  return "Program data: " + b.toString("base64");
}
/// The logs of a transaction where `program` logged the event inside its own invoke frame.
const logsBy = (program, ev) => [`Program ${program} invoke [1]`, swappedLine(ev), `Program ${program} success`];

(async () => {
  let txs = []; let sigCalls = 0, txCalls = 0;
  const swap = (sig, t, activeId, o = {}) => ({ sig, t, logs: logsBy(o.program || BIN, { activeId, ...o }), err: o.err || null });
  const conn = {
    async getSignaturesForAddress(_k, { limit, before }) { sigCalls++; const all = [...txs].sort((a, b) => b.t - a.t); const i = before ? all.findIndex((x) => x.sig === before) + 1 : 0; return all.slice(i, i + limit).map((x) => ({ signature: x.sig, blockTime: x.t, err: x.err })); },
    async getTransactions(sigs) { txCalls++; return sigs.map((s) => { const x = txs.find((y) => y.sig === s); return x ? { blockTime: x.t, meta: { logMessages: x.logs } } : null; }); },
  };
  assert.throws(() => makeActivity({ conn, pools: async () => [] }), /bin program/); ok("the bin program id is required", true);
  const act = makeActivity({ conn, program: BIN, pools: async () => [POOL], gapMs: 0, now: () => NOW });
  txs = [swap("a", NOW - 8 * 86400, 1), swap("b", NOW - 7200, 5), swap("c", NOW - 3700, 7, { xForY: false }), swap("d", NOW - 100, 3), swap("e", NOW - 50, 9, { err: { x: 1 } }),
    swap("f", NOW - 40, 4, { pool: OTHER }), swap("forged", NOW - 30, 99, { program: EVIL, amountIn: 10n ** 18n })];
  await act.sweep();
  let p = act.summary().pools[POOL];
  ok("a Swapped look-alike logged by another program is ignored (forged volume, forged price)", !p.recent.some((s) => s[6] === 99) && p.agg[86400].vx === "200");
  ok("only this pool's swaps; failed transactions and older-than-kept ones left out", p.recent.map((s) => s[6]).join() === "5,7,3");
  ok("no sender or recipient kept: [t, side, in, out, fee, protocolFee, bin, signature]", p.recent.every((s) => s.length === 8 && !JSON.stringify(s).includes(OTHER)) && p.recent[0][7] === "b");
  ok("totals per window (1 h: one swap; 24 h: three, per side) and the bin before each window", p.agg[3600].n === 1 && p.agg[86400].n === 3 && p.agg[86400].vy === "100" && p.agg[3600].startId === 7 && p.agg[86400].startId === null); // the swap before 24 h is older than the 7 days kept
  // incremental: only what's new is read
  txs.push(swap("g", NOW - 10, 6)); sigCalls = 0; txCalls = 0; await act.sweep();
  p = act.summary().pools[POOL];
  ok("a second sweep reads only the new transactions", p.recent.map((s) => s[6]).join() === "5,7,3,6" && txCalls === 1 && sigCalls === 1);
  // candles (bin ids): hour buckets; [-2h] holds bins 5 then 7 (one sell of each side), [-1h] holds 3 then 6
  const c = act.candles(3600).pools[POOL];
  ok("candles: one per hour with trades, OHLC in bin ids, volume per side", c.length === 2 && c[0].slice(1, 5).join() === "5,7,5,7" && c[0][5] === "100" && c[0][6] === "100" && c[0][7] === 2);
  ok("a candle opens at the previous one's close", c[1].slice(1, 5).join() === "7,7,3,6");
  assert.throws(() => act.candlesBody(61), /res/); ok("only the fixed resolutions", true);
  // bodies: built once per sweep, gzipped
  const b1 = act.summaryBody(), b2 = act.summaryBody();
  ok("the response body is serialized once per sweep (same object), with a gzip of it", b1 === b2 && zlib.gunzipSync(b1.gz).toString() === b1.json && JSON.parse(b1.json).pools[POOL]);
  await act.sweep(); ok("a new sweep builds a fresh body", act.summaryBody() !== b1);
  // a global cap across pools trims the oldest first
  const two = makeActivity({ conn, program: BIN, pools: async () => [POOL, OTHER], gapMs: 0, now: () => NOW, maxTotal: 3 });
  await two.sweep(); const left = [...two._byPool.values()].flatMap((A) => A.swaps.map((s) => s[0])).sort();
  ok("past the global cap the oldest swaps go, whichever pool they're in", left.length === 3 && left[0] === NOW - 100);
  { const saved = txs; txs = Array.from({ length: 6 }, (_, i) => swap('tie-' + i, NOW - 1, i));
    const tied = makeActivity({ conn, program: BIN, pools: async () => [POOL], gapMs: 0, now: () => NOW, maxTotal: 3 });
    await tied.sweep(); ok('global memory cap is strict when trades have equal timestamps', tied.summary().pools[POOL].recent.length === 3); txs = saved;
  }
  // A partial RPC response must not advance the cursor or partially append swaps.
  { const original = conn.getTransactions; txs.push(swap('retry-a', NOW - 5, 11), swap('retry-b', NOW - 4, 12));
    conn.getTransactions = async (sigs) => (await original(sigs)).map((tx, i) => i === 1 ? null : tx);
    const before = act.summary().pools[POOL].recent.length; await act.sweep();
    ok('missing transaction: no partial commit or cursor advance', act.summary().pools[POOL].recent.length === before);
    conn.getTransactions = original; await act.sweep(); const after = act.summary().pools[POOL].recent;
    ok('next sweep recovers missing transactions exactly once', after.length === before + 2 && after.filter((s) => s[7] === 'retry-a').length === 1 && after.some((s) => s[7] === 'retry-b'));
  }
  // stop during an in-flight sweep must not resurrect the polling timer.
  { let release, calls = 0; const gate = new Promise((r) => { release = r; });
    const stopped = makeActivity({ conn, program: BIN, pools: async () => { calls++; await gate; return []; }, intervalMs: 5 });
    stopped.start(); stopped.start(); stopped.stop(); release(); await new Promise((r) => setTimeout(r, 25));
    ok('start is idempotent; stop during sweep prevents rescheduling', calls === 1);
  }
  console.log("all ok");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
