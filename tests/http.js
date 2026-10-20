// The relayer's HTTP layer (relayer/http.js): limits, caching, faucet caps, headers, error redaction. No chain needed: a
// stand-in relayer answers. Run: node tests/http.js
const assert = require("assert");
const M = require("../relayer/http.js");
process.env.SEALED_CRANK = "0"; process.env.RATE_GET = "20"; process.env.RATE_POST = "10"; process.env.MAX_INFLIGHT = "2"; process.env.DRIP_MAX_PER_HOUR = "5"; process.env.DRIP_PAIRS_PER_CALLER = "2"; process.env.TRUST_PROXY = "1";
let rpc = 0; let release; const gate = new Promise((r) => (release = r));
const fake = { info: () => ({ a: 1n }), health: () => ({ ok: true }), binPools: async () => { rpc++; await new Promise((r) => setTimeout(r, 30)); return [{ n: rpc }]; },
  shieldState: async () => (rpc++, {}), sealedState: async (p) => (rpc++, { p }), state: async () => ({ leaves: [1n], labels: [], deposits: [], at: 1 }),
  feeQuote: async (b) => ({ feeBps: 5 }), drip: async (to, w) => { if (to === "bad") throw new Error("Invalid public key input"); return { sent: [to, w || null] }; },
  submit: async (b) => { if (b.kind === "slow") await gate; if (b.kind === "leak") throw new Error("failed: request to https://devnet.helius-rpc.com/?api-key=SECRET123 failed"); return { txs: ["x"] }; }, refreshBalance() {} };
const ok = (name, c) => { assert.ok(c, name); console.log("ok -", name); };
(async () => {
  const srv = M.serve(fake, 0); await new Promise((r) => srv.once("listening", r)); const U = "http://127.0.0.1:" + srv.address().port;
  let ip = 1; const as = (n) => ({ "x-forwarded-for": "198.51.100." + n });
  const go = async (m, p, body, h = as(ip)) => { const r = await fetch(U + p, { method: m, headers: h, body }); return { s: r.status, h: r.headers, b: await r.json().catch(() => null) }; };
  ok("bucket: IPv4, mapped IPv4, IPv6 /64", M.bucket("1.2.3.4") === "1.2.3.4" && M.bucket("::ffff:1.2.3.4") === "1.2.3.4" && M.bucket("2001:db8:0:1::5") === "2001:db8:0:1::/64" && M.bucket("2001:db8:0:1:aa:bb:cc:dd") === M.bucket("2001:0db8:0000:0001::9"));
  let r = await go("GET", "/info"); ok("GET /info 200, bigint-safe", r.s === 200 && r.b.a === "1");
  ok("security headers", r.h.get("x-content-type-options") === "nosniff" && r.h.get("x-frame-options") === "DENY" && /default-src 'none'/.test(r.h.get("content-security-policy")) && r.h.get("cache-control") === "no-store" && !r.h.get("x-powered-by") && !r.h.get("etag"));
  ok("CORS any origin by default", r.h.get("access-control-allow-origin") === "*");
  r = await go("OPTIONS", "/submit"); ok("preflight 204", r.s === 204 && /POST/.test(r.h.get("access-control-allow-methods")));
  ok("missing pool 400", (await go("GET", "/state")).s === 400);
  ok("repeated pool param 400", (await go("GET", "/state?pool=a&pool=b")).s === 400);
  ok("unknown path 404", (await go("GET", "/nope")).s === 404 && (await go("GET", "/submit")).s === 404);
  ip = 2; rpc = 0; const many = await Promise.all(Array.from({ length: 8 }, () => go("GET", "/pools")));
  ok("/pools: 8 concurrent calls, one chain read", many.every((x) => x.s === 200) && rpc === 1);
  await go("GET", "/pools"); ok("/pools cached", rpc === 1);
  ip = 3; for (let i = 0; i < 20; i++) await go("GET", "/health"); r = await go("GET", "/health"); ok("GET limit 429 + retry-after", r.s === 429 && r.h.get("retry-after") === "60");
  ok("another client unaffected", (await go("GET", "/health", undefined, as(4))).s === 200);
  ip = 5; ok("bad JSON 400", (await go("POST", "/fee", "{bad")).s === 400);
  ok("non-object body 400", (await go("POST", "/fee", "[1]")).s === 400 && (await go("POST", "/fee", "7")).s === 400);
  ok("body over 200 KB 413", (await go("POST", "/submit", JSON.stringify({ x: "a".repeat(210_000) }))).s === 413);
  r = await go("POST", "/submit", '{"kind":"leak"}'); ok("RPC URL and key redacted from errors", r.s === 400 && !/SECRET123|helius/.test(r.b.error) && /<url>/.test(r.b.error));
  ip = 6; const slow = [go("POST", "/submit", '{"kind":"slow"}'), go("POST", "/submit", '{"kind":"slow"}')]; await new Promise((r) => setTimeout(r, 50));
  r = await go("POST", "/submit", '{"kind":"ok"}'); ok("MAX_INFLIGHT: third concurrent submit 503", r.s === 503 && r.h.get("retry-after") === "5" && srv.inflight === 2);
  release(); await Promise.all(slow); ok("inflight back to 0", srv.inflight === 0);
  ip = 7; for (let i = 0; i < 10; i++) await go("POST", "/fee", "{}"); ok("POST limit 429", (await go("POST", "/fee", "{}")).s === 429);
  // faucet
  ip = 10; ok("drip ok", (await go("POST", "/drip", '{"to":"A"}')).s === 200);
  ok("same address again 429", (await go("POST", "/drip", '{"to":"A"}', as(11))).s === 429);
  ok("same caller, new address 429", (await go("POST", "/drip", '{"to":"B"}')).s === 429);
  ok("failed drip does not use up the limit", (await go("POST", "/drip", '{"to":"bad"}', as(12))).s === 400 && (await go("POST", "/drip", '{"to":"C"}', as(12))).s === 200);
  ip = 13; ok("pair drip", (await go("POST", "/drip", '{"to":"D","tokens":["JUP"]}')).s === 200);
  ok("same pair again 429", (await go("POST", "/drip", '{"to":"D","tokens":["JUP"]}')).s === 429);
  ok("2nd pair from caller ok", (await go("POST", "/drip", '{"to":"E","tokens":["JUP"]}')).s === 200);
  ok("3rd pair from caller 429 (DRIP_PAIRS_PER_CALLER)", (await go("POST", "/drip", '{"to":"F","tokens":["JUP"]}')).s === 429);
  ok("hourly faucet cap (5)", (await go("POST", "/drip", '{"to":"G"}', as(14))).s === 200 && (await go("POST", "/drip", '{"to":"H"}', as(15))).s === 429);
  const both = await Promise.all([go("POST", "/drip", '{"to":"Z","tokens":["X"]}', as(16)), go("POST", "/drip", '{"to":"Z","tokens":["X"]}', as(17))]);
  ok("two drips at once to the same pair: not both", both.filter((x) => x.s === 200).length <= 1);
  srv.close(); console.log("all ok");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
