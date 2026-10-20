// The relayer's HTTP API (routes listed in relayer/relayer.js) on Express, its rate limits and background timers.
// Hardening (all in memory, nothing logged, no IPs kept past the window that limits them):
//   - per-client limits: RATE_GET reads and RATE_POST writes a minute (IPv6 clients counted per /64)
//   - at most MAX_INFLIGHT submissions at once (503 beyond), so a burst cannot queue unbounded RPC work
//   - chain reads shared between concurrent callers, and /pools, /sealed cached briefly (each costs many RPC calls)
//   - faucet: per address, per caller, per caller and pair, and DRIP_MAX_PER_HOUR in total
//   - security headers, JSON-object bodies only (200 KB), server timeouts, error messages without URLs (an RPC URL can carry a key)
"use strict";
const net = require("net");
const express = require("express");
const { j } = require("../sdk/veyl.js");
const { makeTokens } = require("./tokens.js");
const { makeActivity } = require("./activity.js");
const DRIP_EVERY = 6 * 3600_000;
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
/// Rate-limit key. Behind a proxy (Render, a CDN) every request comes from the proxy's address, so one client could use up
/// everyone's budget; TRUST_PROXY=<n> takes the address the n-th proxy from the right appended to X-Forwarded-For
/// (REVIEW.md L-2). Never logged.
function clientKey(req, trust = Number(process.env.TRUST_PROXY || 0)) {
  const xff = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return trust > 0 && xff.length >= trust
    ? xff[xff.length - trust]
    : req.socket.remoteAddress;
}
/// The bucket a client is counted in: its IPv4 address, or its IPv6 /64 (one subscriber usually holds a whole /64, so
/// counting single IPv6 addresses would let one client rotate through 2^64 of them).
function bucket(ip) {
  ip = String(ip || "");
  if (ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7))) return ip.slice(7);
  if (!net.isIPv6(ip)) return ip;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full =
    tail === undefined
      ? h
      : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return (
    full
      .slice(0, 4)
      .map((x) => parseInt(x, 16).toString(16))
      .join(":") + "::/64"
  );
}
/// Per-bucket counter over a fixed one-minute window. Dropped wholesale if it ever holds too many buckets.
function counter(max) {
  const m = new Map();
  setInterval(() => m.clear(), 60_000).unref();
  return (k) => {
    if (m.size > 100_000) m.clear();
    const n = (m.get(k) || 0) + 1;
    m.set(k, n);
    return n <= max;
  };
}
/// One chain read shared by every caller that asks while it runs, and its result kept `ms` (per key, at most 500 keys).
function shared(fn, ms = 0) {
  const m = new Map();
  return (k) => {
    const c = m.get(k);
    if (c && (!c.done || Date.now() - c.at < ms)) return c.p;
    if (m.size >= 500) m.clear();
    const e = { at: Date.now(), done: false };
    e.p = Promise.resolve()
      .then(() => fn(k))
      .finally(() => {
        e.done = true;
        e.at = Date.now();
      });
    e.p.catch(() => m.get(k) === e && m.delete(k)); // a failed read is not kept
    m.set(k, e);
    return e.p;
  };
}
const redact = (m) =>
  String(m)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "<url>")
    .slice(0, 300);

function app(relayer, srv = { inflight: 0 }) {
  const getOk = counter(num("RATE_GET", 600));
  const postOk = counter(num("RATE_POST", 30));
  const maxInflight = num("MAX_INFLIGHT", 16);
  const dripMaxHour = num("DRIP_MAX_PER_HOUR", 60);
  const dripPairsPerCaller = num("DRIP_PAIRS_PER_CALLER", 6);
  const drips = new Map(); // faucet: last drip per address, per caller and per address+pair, in memory only
  const pairDrips = new Map(); // faucet: pair drips per caller (times), in memory only
  let dripHour = { at: Date.now(), n: 0 };
  setInterval(() => {
    const old = Date.now() - DRIP_EVERY;
    for (const [k, at] of drips) if (at < old) drips.delete(k);
    for (const [k, ts] of pairDrips) {
      const live = ts.filter((t) => t >= old);
      if (live.length) pairDrips.set(k, live);
      else pairDrips.delete(k);
    }
  }, 600_000).unref();
  // CORS: ALLOWED_ORIGINS=https://veyl.example,https://www.veyl.example limits browsers to the site; unset = any origin.
  // A bare host (what a Render blueprint passes from the site service) means https://<host>.
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((x) => x.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .map((x) => (/^https?:\/\//.test(x) ? x : "https://" + x));
  const send = (res, code, o) =>
    res.status(code).type("application/json").send(j(o)); // j: bigint-safe JSON
  const pools = shared(() => relayer.binPools(), num("POOLS_CACHE_MS", 5_000));
  const sealed = shared(
    (pool) => relayer.sealedState(pool),
    num("SEALED_CACHE_MS", 1_000),
  );
  const shield = shared(() => relayer.shieldState()); // cached 3 s inside the relayer
  const state = shared((pool) => relayer.state(pool)); // cached 5 s inside the relayer, cleared by a submission
  const a = express();
  a.disable("x-powered-by");
  a.disable("etag");
  a.use((req, res, next) => {
    const origin = req.headers.origin;
    const allow = !allowed.length
      ? "*"
      : allowed.includes(origin)
        ? origin
        : allowed[0];
    res.set({
      "access-control-allow-origin": allow,
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "600",
      vary: "origin",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "cross-origin",
      "strict-transport-security": "max-age=31536000",
    });
    if (req.method === "OPTIONS") return res.status(204).end();
    req.clientKey = bucket(clientKey(req));
    if (!(req.method === "POST" ? postOk : getOk)(req.clientKey)) {
      res.set("retry-after", "60");
      return send(res, 429, { error: "slow down" });
    }
    next();
  });

  const poolParam = (req) => {
    const pool = req.query.pool;
    if (typeof pool !== "string" || !pool) throw new Error("pool?");
    return pool;
  };
  a.get("/info", (req, res) => send(res, 200, relayer.info()));
  a.get("/health", (req, res) => send(res, 200, relayer.health()));
  a.get("/pools", async (req, res) => send(res, 200, await pools("")));
  a.get("/shield", async (req, res) => send(res, 200, await shield("")));
  a.get("/sealed", async (req, res) =>
    send(res, 200, await sealed(poolParam(req))),
  );
  a.get("/state", async (req, res) => {
    const st = await state(poolParam(req));
    send(res, 200, {
      leaves: st.leaves,
      labels: st.labels,
      deposits: st.deposits,
    });
  });

  // Token metadata and logos from Jupiter, through the relayer (relayer/tokens.js): Jupiter and logo hosts never see a
  // client. Metadata is shared between concurrent callers and cached a minute per id list (and a day inside tokens.js);
  // icons are cached by browsers for a day (overriding no-store) and inside tokens.js, size-capped.
  const tokens = relayer.tokens || makeTokens({ network: (relayer.dep && relayer.dep.network) || process.env.NETWORK || "devnet" });
  if (!relayer.tokens && relayer.dep && relayer.dep.tokens && process.env.TOKENS_WARM !== "0")
    tokens.warm(relayer.dep.tokens).catch(() => {}); // the site's own tokens: cached before the first visitor asks
  // Every pool's trades, indexed in the background (relayer/activity.js): the app's figures and candles for all pools in
  // one request. ACTIVITY_INDEX=0 turns the indexer off (the app then reads the chain itself, as before).
  const activity = relayer.activity || (relayer.conn && relayer.dep && process.env.ACTIVITY_INDEX !== "0" ? makeActivity({ conn: relayer.conn, program: relayer.dep.programs.bin,
    pools: async () => { try { await relayer.discover(); } catch { /* the deployment's pools still index */ } return [...relayer.dep.binPools, ...(relayer.discovered || [])].map((b) => b.address); },
    log: (m) => console.error(m) }) : null);
  if (activity && !relayer.activity) activity.start();
  // bodies are built once per sweep inside activity.js; gzipped when the client takes it
  const sendBody = (req, res, b) => { res.status(200).type("application/json").append("vary", "accept-encoding");
    if (/\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) res.set("content-encoding", "gzip").send(b.gz); else res.send(b.json); };
  a.get("/activity", (req, res) => { if (!activity) return send(res, 404, { error: "no activity index here" }); sendBody(req, res, activity.summaryBody()); });
  a.get("/candles", (req, res) => { if (!activity) return send(res, 404, { error: "no activity index here" }); sendBody(req, res, activity.candlesBody(Number(req.query.res) || 3600)); });
  const tokenMeta = shared((ids) => tokens.getTokens(ids.split(",")), 60_000);
  a.get("/tokens", async (req, res) => {
    if (typeof req.query.ids !== "string") throw new Error("ids?");
    send(res, 200, { tokens: await tokenMeta(tokens.parseIds(req.query.ids).join(",")) });
  });
  a.get("/tokens/icon/:mint", async (req, res) => {
    let v;
    try { v = await tokens.getIcon(String(req.params.mint)); } catch { return send(res, 404, { error: "no icon" }); }
    res.status(200).set("cache-control", "public, max-age=86400, immutable").type(v.type).send(v.bytes);
  });

  // POSTs: a JSON object of at most 200 KB (any content type: the app's fetches are not all labelled)
  const body = [
    express.json({ limit: 200_000, strict: false, type: () => true }),
    (req, res, next) => {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
        return send(res, 400, { error: "expected a JSON object" });
      next();
    },
  ];
  a.post("/fee", body, async (req, res) =>
    send(res, 200, await relayer.feeQuote(req.body)),
  );
  a.post("/drip", body, async (req, res) => {
    const { tokens } = req.body;
    const to = String(req.body.to || "");
    const now = Date.now();
    const k = req.clientKey;
    const pair = Array.isArray(tokens) && tokens.length;
    const key = pair
      ? to + ":" + tokens.slice(0, 4).map(String).sort().join(",")
      : to;
    if (pair) {
      if (now - (drips.get(key) || 0) < DRIP_EVERY)
        return send(res, 429, {
          error: "Test tokens for this pair were already sent here recently.",
        });
      const mine = (pairDrips.get(k) || []).filter((t) => now - t < DRIP_EVERY);
      if (mine.length >= dripPairsPerCaller)
        return send(res, 429, {
          error:
            "Test tokens already sent here recently. Try again in a few hours.",
        });
    } else if (now - (drips.get(to) || drips.get("ip:" + k) || 0) < DRIP_EVERY)
      return send(res, 429, {
        error:
          "Test tokens already sent here recently. Try again in a few hours.",
      });
    if (now - dripHour.at > 3600_000) dripHour = { at: now, n: 0 };
    if (dripHour.n >= dripMaxHour)
      return send(res, 429, {
        error: "The faucet is busy. Try again in an hour.",
      });
    // claimed before the (slow) drip so two requests at once cannot both pass; given back if it fails
    const marks = pair ? [key] : [to, "ip:" + k];
    for (const m of marks) drips.set(m, now);
    if (pair) pairDrips.set(k, [...(pairDrips.get(k) || []), now]);
    dripHour.n++;
    try {
      send(res, 200, await relayer.drip(to, pair ? tokens : undefined));
    } catch (e) {
      for (const m of marks) if (drips.get(m) === now) drips.delete(m);
      if (pair)
        pairDrips.set(
          k,
          (pairDrips.get(k) || []).filter((t) => t !== now),
        );
      dripHour.n--;
      throw e;
    }
  });
  a.post("/submit", body, async (req, res) => {
    if (srv.inflight >= maxInflight) {
      res.set("retry-after", "5");
      return send(res, 503, {
        error: "The relayer is busy. Try again in a few seconds.",
      });
    }
    srv.inflight++;
    try {
      send(res, 200, await relayer.submit(req.body));
    } finally {
      srv.inflight--;
    }
  });

  a.use((req, res) => send(res, 404, { error: "not found" }));
  a.use((e, req, res, next) => {
    if (res.headersSent) return next(e); // Express 5 routes async rejections here
    if (e.type === "entity.too.large")
      return send(res, 413, { error: "too large" });
    send(res, 400, { error: redact(e.message) });
  });
  return a;
}
function serve(relayer, port = 8843) {
  const srv = { inflight: 0 };
  const server = app(relayer, srv).listen(port); // in-flight submissions, for the graceful stop
  Object.defineProperty(server, "inflight", { get: () => srv.inflight });
  // slow clients: the whole request (headers and body) within 30 s; idle keep-alive longer than a proxy's 60 s
  server.keepAliveTimeout = 61_000;
  server.headersTimeout = 30_000;
  server.requestTimeout = 30_000;
  server.maxConnections = num("MAX_CONNECTIONS", 2_000);
  if (process.env.SEALED_CRANK !== "0") {
    server.crank = setInterval(
      () =>
        relayer.crankSealed().catch((e) => console.error("crank", e.message)),
      Number(process.env.CRANK_INTERVAL_MS || 4_000),
    );
    server.crank.unref();
  }
  relayer.refreshBalance();
  server.bal = setInterval(() => relayer.refreshBalance(), 60_000);
  server.bal.unref();
  if (relayer.postman) {
    const publish = () =>
      relayer.publish().catch((e) => console.error("asp", e.message));
    publish();
    server.asp = setInterval(
      publish,
      Number(process.env.ASP_INTERVAL_MS || 30_000),
    );
    server.asp.unref();
    const admit = () =>
      relayer.approveDeposits().catch((e) => console.error("admit", e.message));
    admit();
    server.admit = setInterval(
      admit,
      Number(process.env.ADMIT_INTERVAL_MS || 5_000),
    );
    server.admit.unref();
  }
  return server;
}
module.exports = { serve, clientKey, bucket, app };
