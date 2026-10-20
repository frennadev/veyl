// RPC with a fallback: when the configured RPC fails (a dropped connection, a timeout, rate limiting, a rejected or expired
// key, a server error), the same JSON-RPC request is sent to Solana's public endpoint for that cluster. After a failure the
// public endpoint is used first for COOLDOWN_MS, then the configured RPC is tried again. Resending is safe for every call,
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
  return async (url, init) => {
    if (String(url) !== primary) return f(url, init); // not an RPC call this wrapper owns
    if (now() < until) { // cooling down: the fallback first, the configured RPC if that fails too
      const b = await attempt(fallback, init); if (!b.fail) return b.r;
      const a = await attempt(primary, init); if (!a.fail) { until = 0; onSwitch('primary', 'answered again'); return a.r; }
      if (a.r || b.r) return (a.r || b.r); throw new Error('RPC unreachable: ' + a.fail + '; public RPC: ' + b.fail);
    }
    const a = await attempt(primary, init); if (!a.fail) return a.r;
    if (!until) onSwitch('fallback', a.fail); until = now() + cooldownMs;
    const b = await attempt(fallback, init); if (!b.fail) return b.r;
    if (a.r || b.r) return (b.r || a.r); // both answered with an error status: hand one back for web3.js to report
    throw new Error('RPC unreachable: ' + a.fail + '; public RPC: ' + b.fail);
  };
}

/// A Connection on `rpc` that falls back to the cluster's public RPC (none for local, or when `rpc` already is it).
function connectionFor(rpc, cluster, { commitment = 'confirmed', fetch: base, log = () => {}, ...rest } = {}) {
  const pub = publicRpcFor(cluster);
  const opts = { commitment, ...rest };
  if (pub && pub !== rpc) opts.fetch = fallbackFetch(rpc, pub, { base, onSwitch: (to, why) => log(to === 'fallback' ? `RPC failed (${why}): using ${pub} for now` : 'RPC answers again: back on it') });
  else if (base) opts.fetch = base;
  return new Connection(rpc, opts);
}

module.exports = { PUBLIC_RPC, publicRpcFor, fallbackFetch, connectionFor, retryable, COOLDOWN_MS };
