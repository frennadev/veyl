// Token metadata and logos from Jupiter's token API, served by the relayer so neither Jupiter nor any logo host ever sees a
// user's IP or which tokens they look at; the site's CSP only has to allow images from the relayer.
//   getTokens(keys) -> { [key]: { mint, symbol, name, decimals, verified (Jupiter's flag), tags, icon } | null }
//     keys: mints (base58 public keys), or 'sym:<SYMBOL>' on devnet / local only (their mints are mock mints Jupiter has
//     never seen; a symbol match is for display there). On mainnet tokens are looked up by mint only, so a fake token can't
//     borrow a real token's logo by symbol.
//   getIcon(mint) -> { type, bytes }: the logo Jupiter lists for that mint (never a URL from a client), fetched over https
//     with no redirects, only from public addresses (checked after DNS, then pinned so a second lookup can't rebind), within
//     5 s and 256 KB, and only PNG, JPEG, WebP or GIF by their magic bytes (SVG is refused: it can carry script).
// Caches are in memory and capped (entries and total icon bytes); failures are cached briefly so junk can't hammer Jupiter.
"use strict";
const dns = require("dns");
const https = require("https");
const net = require("net");
const ipaddr = require("ipaddr.js");
const { PublicKey } = require("@solana/web3.js");

const MAX_IDS = 100, META_TTL = 24 * 3600_000, NEG_TTL = 10 * 60_000, ERR_TTL = 30_000, META_MAX = 5000;
const ICON_MAX_BYTES = 256 * 1024, ICON_TIMEOUT = 5000, ICON_CACHE_BYTES = 32 * 1024 * 1024, JUP_TIMEOUT = 8000;
const SYMBOL = /^[A-Za-z0-9.$_-]{1,16}$/;
/// Most memecoin logos are on IPFS, and the gateway Jupiter lists (often ipfs.io) rate-limits servers: when it refuses,
/// the same content id is tried on a second public gateway. Only the CID from Jupiter's URL is reused.
const IPFS_FALLBACK = "https://gateway.pinata.cloud/ipfs/";
const ipfsAlt = (url) => { const m = /^https:\/\/[^/]+\/ipfs\/([A-Za-z0-9]{20,100})\/?$/.exec(url); return m && !url.startsWith(IPFS_FALLBACK) ? IPFS_FALLBACK + m[1] : null; };
const QUEUE_MAX = 20, SYM_PER_CALL = 10; // Jupiter calls waiting at once; uncached symbol searches per request
const NATIVE_SOL = "So11111111111111111111111111111111111111112";

function isMint(s) {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try { return new PublicKey(s).toBase58() === s; } catch { return false; }
}

/// Addresses we never fetch from: anything ipaddr.js doesn't class as plain unicast (private, loopback, link-local, CGNAT,
/// multicast, reserved, documentation, IPv4-mapped / NAT64 / 6to4 / Teredo forms of those), plus two ranges ipaddr.js 1.x
/// still calls unicast: IPv4-compatible ::a.b.c.d (::/96) and 198.18/15 (benchmarking). Anything unparsable counts as private.
function isPrivate(ip) {
  let a; try { a = ipaddr.process(String(ip)); } catch { return true; }
  if (a.range() !== "unicast") return true;
  if (a.kind() === "ipv4") { const [x, y] = a.octets; return x === 198 && (y === 18 || y === 19); }
  const p = a.parts; return p.slice(0, 6).every((v) => v === 0); // ::/96
}

/// The image type from its first bytes, or null. SVG (text) never matches.
function imageType(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b.toString("ascii", 0, 6).match(/^GIF8[79]a$/)) return "image/gif";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/// Download an image under the rules above. `lookup` and `get` are injectable for tests.
async function fetchImage(url, { lookup = dns.promises.lookup, get = https.get } = {}) {
  let u; try { u = new URL(url); } catch { throw new Error("bad icon url"); }
  if (u.protocol !== "https:") throw new Error("icon url is not https");
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname, family: net.isIPv6(u.hostname) ? 6 : 4 }] : await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error("icon host resolves to a private address");
  const pin = addrs[0]; // connect to the address we checked, not a fresh lookup
  return new Promise((resolve0, reject0) => {
    // https.get's timeout is an idle timeout; this is the whole download's deadline (a host dripping bytes can't hold it open)
    const deadline = setTimeout(() => req.destroy(new Error("icon timed out")), ICON_TIMEOUT);
    const resolve = (v) => { clearTimeout(deadline); resolve0(v); }, reject = (e) => { clearTimeout(deadline); reject0(e); };
    const req = get(u, { timeout: ICON_TIMEOUT, headers: { accept: "image/png,image/jpeg,image/webp,image/gif" }, lookup: (h, o, cb) => (o && o.all ? cb(null, [pin]) : cb(null, pin.address, pin.family)) }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("icon host answered " + res.statusCode)); } // redirects included
      const chunks = []; let n = 0;
      res.on("data", (c) => { n += c.length; if (n > ICON_MAX_BYTES) { req.destroy(); return reject(new Error("icon over 256 KB")); } chunks.push(c); });
      res.on("end", () => { const bytes = Buffer.concat(chunks); const type = imageType(bytes); type ? resolve({ type, bytes }) : reject(new Error("not a PNG, JPEG, WebP or GIF")); });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("icon timed out")));
    req.on("error", reject);
  });
}

/// A capped least-recently-used map; `size(v)` counts toward `maxSize` (entries by default).
function lru(maxEntries, maxSize = Infinity, size = () => 0) {
  const m = new Map(); let total = 0;
  return {
    get(k) { const v = m.get(k); if (v) { m.delete(k); m.set(k, v); } return v; },
    set(k, v) { const old = m.get(k); if (old) { total -= size(old); m.delete(k); } m.set(k, v); total += size(v);
      while (m.size > maxEntries || total > maxSize) { const [k0, v0] = m.entries().next().value; m.delete(k0); total -= size(v0); } },
    get size() { return m.size; }, get bytes() { return total; },
  };
}

/// Jupiter's keyless API allows a handful of requests per short window: calls are spaced `gapMs` apart (one queue). The
/// queue is bounded: past `max` waiting calls new ones fail at once ("busy"), so junk ids can't grow it or delay real lookups.
function spaced(fn, gapMs, max = QUEUE_MAX) {
  let tail = Promise.resolve(), last = 0, waiting = 0;
  return (q) => { if (waiting >= max) return Promise.reject(new Error("token lookups busy")); waiting++;
    const run = tail.finally(() => waiting--).then(async () => { const wait = last + gapMs - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); last = Date.now(); return fn(q); });
    tail = run.catch(() => {}); return run; };
}

function makeTokens({ network = "devnet", apiKey = process.env.JUPITER_API_KEY, jupiter = null, image = fetchImage, now = () => Date.now(), gapMs, queueMax } = {}) {
  const base = apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  const search = jupiter || spaced(async (query) => {
    const r = await fetch(base + "/tokens/v2/search?query=" + encodeURIComponent(query), { headers: apiKey ? { "x-api-key": apiKey } : {}, signal: AbortSignal.timeout(JUP_TIMEOUT) });
    if (!r.ok) throw new Error("jupiter answered " + r.status); const j = await r.json(); return Array.isArray(j) ? j : [];
  }, gapMs ?? Number(process.env.JUP_GAP_MS || (apiKey ? 150 : 1100)), queueMax);
  const symAllowed = network !== "mainnet";
  const meta = lru(META_MAX); // key -> { v: entry | null, at, ttl }
  const icons = lru(META_MAX, ICON_CACHE_BYTES, (e) => (e.v ? e.v.bytes.length : 0)); // mint -> { v: { type, bytes } | null, at, ttl }
  const fresh = (e) => e && now() - e.at < e.ttl;
  const norm = (r) => ({
    entry: { mint: r.id, symbol: String(r.symbol || ""), name: String(r.name || ""), decimals: Number(r.decimals) || 0,
      verified: !!(r.isVerified || (Array.isArray(r.tags) && r.tags.includes("verified"))), tags: Array.isArray(r.tags) ? r.tags.slice(0, 8).map(String) : [],
      icon: r.icon ? "/tokens/icon/" + r.id : null },
    iconUrl: typeof r.icon === "string" ? r.icon : null,
  });
  const iconUrls = new Map(); // mint -> the icon URL Jupiter gave (the only URLs ever fetched)

  /// Parse ?ids=…: mints, and sym:<SYMBOL> where allowed; at most 100, deduplicated. Throws on anything else.
  function parseIds(str) {
    const keys = [...new Set(String(str || "").split(",").map((s) => s.trim()).filter(Boolean))];
    if (!keys.length || keys.length > MAX_IDS) throw new Error("ids: 1 to " + MAX_IDS + " token mints");
    for (const k of keys) {
      if (k.startsWith("sym:")) { if (!symAllowed) throw new Error("ids: look tokens up by mint on mainnet"); if (!SYMBOL.test(k.slice(4))) throw new Error("ids: bad symbol"); }
      else if (!isMint(k)) throw new Error("ids: not a token mint"); // no input echoed back
    }
    return keys;
  }

  /// `symLimit`: uncached symbol searches this call may start (each is its own spaced Jupiter call); the rest answer null
  /// uncached, so a request can't queue 100 searches. Only warm() lifts it.
  async function getTokens(keys, { symLimit = SYM_PER_CALL } = {}) {
    const out = {}; const mints = [];
    for (const k of keys) { const e = meta.get(k); if (fresh(e)) out[k] = e.v; else if (!k.startsWith("sym:")) mints.push(k); }
    if (mints.length) {
      let rows = []; try { rows = await search(mints.join(",")); } catch { rows = null; }
      const byMint = new Map((rows || []).filter((r) => r && r.id).map((r) => [r.id, r]));
      for (const m of mints) {
        const r = byMint.get(m);
        if (r) { const n = norm(r); meta.set(m, { v: n.entry, at: now(), ttl: META_TTL }); if (n.iconUrl) iconUrls.set(m, n.iconUrl); out[m] = n.entry; }
        else { meta.set(m, { v: null, at: now(), ttl: rows === null ? ERR_TTL : NEG_TTL }); out[m] = null; } // unknown (10 min), or Jupiter refused / down (30 s)
      }
    }
    for (const k of keys.filter((k) => k.startsWith("sym:") && !(k in out))) {
      if (symLimit-- <= 0) { out[k] = null; continue; }
      const sym = k.slice(4).toLowerCase(); let pick = null, failed = false;
      try { const rows = await search(k.slice(4)); pick = rows.filter((r) => r && String(r.symbol || "").toLowerCase() === sym && (r.isVerified || (Array.isArray(r.tags) && r.tags.includes("verified"))))[0] || null; } catch { failed = true; }
      if (pick) { const n = norm(pick); meta.set(k, { v: n.entry, at: now(), ttl: META_TTL }); if (n.iconUrl) iconUrls.set(pick.id, n.iconUrl); out[k] = n.entry; }
      else { meta.set(k, { v: null, at: now(), ttl: failed ? ERR_TTL : NEG_TTL }); out[k] = null; }
    }
    return out;
  }

  async function getIcon(mint) {
    if (!isMint(mint)) throw new Error("not a token mint");
    const e = icons.get(mint); if (fresh(e)) { if (!e.v) throw new Error("no icon"); return e.v; }
    if (!iconUrls.has(mint)) await getTokens([mint]); // only ever the URL Jupiter returned for this mint
    const url = iconUrls.get(mint);
    try { if (!url) throw new Error("no icon"); let v;
      try { v = await image(url); } catch (err) { const alt = ipfsAlt(url); if (!alt || !/answered (429|5\d\d)|timed out/.test(err.message)) throw err; v = await image(alt); }
      icons.set(mint, { v, at: now(), ttl: META_TTL }); return v; }
    catch (err) { icons.set(mint, { v: null, at: now(), ttl: NEG_TTL }); throw err; }
  }

  /// The keys a client asks for, for a deployment's tokens ({ SYMBOL: { mint } }): the same rule as the app
  /// (web/features/tokens/tokenData.ts remoteKey): by mint on mainnet and for native SOL, else sym:<SYMBOL> (mock mints).
  const keysFor = (toks) => [...new Set(Object.entries(toks || {}).map(([sym, t]) => (!symAllowed || (t && t.mint) === NATIVE_SOL ? t && t.mint : "sym:" + sym))
    .filter((k) => k && (k.startsWith("sym:") ? SYMBOL.test(k.slice(4)) : isMint(k))))].sort();

  /// Fill the caches (metadata, then every logo) for a deployment's tokens, so the first visitor isn't the one who waits
  /// on Jupiter's spaced calls. Best effort: failures are cached briefly like any other and retried by real requests.
  async function warm(toks) {
    const keys = keysFor(toks); const got = {};
    for (let i = 0; i < keys.length; i += MAX_IDS) Object.assign(got, await getTokens(keys.slice(i, i + MAX_IDS), { symLimit: Infinity }));
    for (const e of Object.values(got)) if (e && e.icon) await getIcon(e.mint).catch(() => {});
    return keys.length;
  }

  return { parseIds, getTokens, getIcon, keysFor, warm, _caches: { meta, icons } };
}

module.exports = { makeTokens, fetchImage, isPrivate, imageType, isMint, ipfsAlt, MAX_IDS, ICON_MAX_BYTES };
