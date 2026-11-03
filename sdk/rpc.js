// RPC with a fallback: when the configured RPC fails (a dropped connection, a timeout, a rejected or expired key, a server
// error), the same JSON-RPC request is sent to Solana's public endpoint for that cluster; a rate limit (429) is first
// retried twice on the configured RPC after a short pause (bursts pass). The public endpoint is then used first for
// COOLDOWN_MS (only when it answered), and skipped for 10 minutes once it refuses access (401/403). In a browser on
// mainnet there is no public fallback at all: Solana's public mainnet RPC answers 403 to web pages. Resending is safe for every call,
// sendTransaction included (a signed transaction has one signature; sending it twice lands it once).
// Covers HTTP only: websocket subscriptions stay on the configured RPC (web3.js confirms by polling as well).
'use strict';
const { Connection } = require('@solana/web3.js');

const PUBLIC_RPC = { devnet: 'https://api.devnet.solana.com', mainnet: 'https://api.mainnet-beta.solana.com' };
const COOLDOWN_MS = 30_000, TIMEOUT_MS = 15_000;
/// HTTP statuses worth another endpoint: timeouts, rate limits, a bad or expired key, server errors.
const retryable = (status) => status === 408 || status === 429 || status === 401 || status === 403 || status >= 500;

/// Solana's public RPC for a deployment's cluster (config `cluster` / deploy `network`), or null (local: none).
const publicRpcFor = (cluster) => PUBLIC_RPC[cluster] || null;

/// A fetch for web3.js's Connection that falls back from `primary` to `fallback`.
///   base: the fetch to use (defaults to global fetch; the relayer passes its retrying one)
///   onSwitch(to, reason): called when requests move to the fallback ('fallback') or back ('primary')
function fallbackFetch(primary, fallback, { base, cooldownMs = COOLDOWN_MS, timeoutMs = TIMEOUT_MS, onSwitch = () => {}, now = () => Date.now() } = {}) {
  const f = base || ((...a) => globalThis.fetch(...a));
  let until = 0; // requests go to the fallback first until this time
  const timed = (url, init) => {
    if (!timeoutMs || (init && init.signal) || typeof AbortController === 'undefined') return f(url, init);
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    return Promise.resolve(f(url, { ...init, signal: ac.signal })).finally(() => clearTimeout(t));
  };
  const attempt = async (url, init) => { try { const r = await timed(url, init); return retryable(r.status) ? { fail: 'HTTP ' + r.status, r } : { r }; } catch (e) { return { fail: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'network error' }; } };
  let dead = 0; // a fallback that refused access (401/403: e.g. a public RPC that blocks browsers) is skipped until then
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  /* a rate limit (429) is usually a burst: the configured RPC again after a short pause before trying elsewhere */
  const primaryWithRetry = async (url, init) => { let a = await attempt(primary, init);
    for (let i = 0; i < 2 && a.fail && a.r && a.r.status === 429; i++) { await sleep(400 * 2 ** i); a = await attempt(primary, init); } return a; };
  const viaFallback = async (init) => { if (now() < dead) return { fail: 'fallback skipped' }; const b = await attempt(fallback, init);
    if (b.r && (b.r.status === 401 || b.r.status === 403)) { dead = now() + 10 * 60_000; until = 0; } return b; };
  return async (url, init) => {
    if (String(url) !== primary) return f(url, init); // not an RPC call this wrapper owns
    if (now() < until) { // cooling down: the fallback first, the configured RPC if that fails too
      const b = await viaFallback(init); if (!b.fail) return b.r;
      const a = await primaryWithRetry(url, init); if (!a.fail) { until = 0; onSwitch('primary', 'answered again'); return a.r; }
      if (a.r || b.r) return (a.r || b.r); throw new Error('RPC unreachable: ' + a.fail + '; public RPC: ' + b.fail);
    }
    const a = await primaryWithRetry(url, init); if (!a.fail) return a.r;
    const b = await viaFallback(init); if (!b.fail) { if (!until) onSwitch('fallback', a.fail); until = now() + cooldownMs; return b.r; }
    if (a.r || b.r) return (a.r || b.r); // both answered with an error status: the configured RPC's, for web3.js to retry or report
    throw new Error('RPC unreachable: ' + a.fail + '; public RPC: ' + b.fail);
  };
}

/// A Connection on `rpc` that falls back to the cluster's public RPC (none for local, or when `rpc` already is it).
function connectionFor(rpc, cluster, { commitment = 'confirmed', fetch: base, log = () => {}, fallback = null, ...rest } = {}) {
  /* Solana's public mainnet RPC refuses requests from web pages (403): in a browser it is no fallback there */
  const browser = typeof window !== 'undefined' && typeof document !== 'undefined';
  const pub = fallback || (browser && cluster === 'mainnet' ? null : publicRpcFor(cluster));
  const opts = { commitment, ...rest };
  if (pub && pub !== rpc) opts.fetch = fallbackFetch(rpc, pub, { base, onSwitch: (to, why) => log(to === 'fallback' ? `RPC failed (${why}): using ${pub} for now` : 'RPC answers again: back on it') });
  else if (base) opts.fetch = base;
  return new Connection(rpc, opts);
}

module.exports = { PUBLIC_RPC, publicRpcFor, fallbackFetch, connectionFor, retryable, COOLDOWN_MS };
