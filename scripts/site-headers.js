// HTTP headers for the static site, one source for vercel.json, netlify.toml and dist/site/_headers.
// CSP: scripts only from the site itself (the build moves each page's inline script into a file), WebAssembly allowed
// ('wasm-unsafe-eval') for snarkjs, its prover workers from blob:, styles inline + Google Fonts, connections only to the
// site, the RPC and the relayer. The proving key and circuit are content-hashed by the build, so they cache for a year.
'use strict';
/// Live market prices (engine/market.js): Pyth Hermes, Jupiter's Price API, CoinGecko, Coinbase's ticker and candles. Read-only.
const MARKET = ['https://hermes.pyth.network', 'https://api.jup.ag', 'https://api.coingecko.com', 'https://api.exchange.coinbase.com',
  // Solana markets (engine/markets.js): GeckoTerminal, DexScreener, Meteora DLMM, Raydium, Orca: keyless, read-only
  'https://api.geckoterminal.com', 'https://api.dexscreener.com', 'https://dlmm-api.meteora.ag', 'https://api-v3.raydium.io', 'https://api.orca.so'];
const origin = (u) => { try { const x = new URL(u); return x.origin; } catch { return null; } };
// @solana/web3.js opens its websocket on the RPC host, at port + 1 when the URL names a port (solana-test-validator style).
const wsOrigins = (u) => { try { const x = new URL(u); const proto = x.protocol === 'https:' ? 'wss:' : 'ws:'; const out = [`${proto}//${x.host}`]; if (x.port) out.push(`${proto}//${x.hostname}:${Number(x.port) + 1}`); return out; } catch { return []; } };

/// connect: URLs the browser must reach over HTTP (RPC, relayer); ws: URLs whose websocket it also opens (the RPC).
/// Empty = only the site itself (no deployment yet).
function csp(connect = [], { ws = [], loose = false } = {}) {
  const c = loose ? ["'self'", 'https:', 'wss:'] : ["'self'", ...new Set([...connect.map(origin), ...ws.flatMap(wsOrigins), ...MARKET].filter(Boolean))];
  const https = loose || connect.every((u) => /^https:/.test(u));
  return [
    "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self' blob:", `connect-src ${c.join(' ')}`,
    "img-src 'self' data:", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
const security = (policy) => ({
  'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', 'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
});
const YEAR = 'public, max-age=31536000, immutable';
/// [pattern, headers] in Netlify _headers path syntax (also translated for Vercel).
function rules(policy) {
  return [
    ['/*', security(policy)],
    ['/*.wasm', { 'Content-Type': 'application/wasm', 'Cache-Control': YEAR }],
    ['/*.zkey', { 'Content-Type': 'application/octet-stream', 'Cache-Control': YEAR }],
    ['/zk/*', { 'Cache-Control': YEAR }],
    ['/*.bin', { 'Content-Type': 'application/octet-stream' }],
    ['/sandbox.config.js', { 'Cache-Control': 'no-cache' }],
    ['/*.js', { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300, must-revalidate' }],
    ['/*.html', { 'Cache-Control': 'no-cache' }],
    ['/veyl.config.js', { 'Cache-Control': 'no-cache' }],
  ];
}
const netlifyHeadersFile = (policy) => rules(policy).map(([p, h]) => p + '\n' + Object.entries(h).map(([k, v]) => `  ${k}: ${v}`).join('\n')).join('\n\n') + '\n';
const vercelSource = (p) => (p === '/*' ? '/(.*)' : p.endsWith('/*') ? p.slice(0, -1) + '(.*)' : p.replace('/*.', '/(.*)\\.'));
const vercelHeaders = (policy) => rules(policy).map(([p, h]) => ({ source: vercelSource(p), headers: Object.entries(h).map(([key, value]) => ({ key, value })) }));
function netlifyToml(policy, build) {
  const q = (s) => JSON.stringify(s);
  return `# Netlify: builds the static site and serves dist/site. The build also writes dist/site/_headers with the CSP narrowed to\n# this deployment's RPC and relayer (both policies apply; the narrower one wins).\n[build]\n  command = ${q(build.command)}\n  publish = "dist/site"\n\n[build.environment]\n  NODE_VERSION = "20"\n  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"\n\n` +
    rules(policy).map(([p, h]) => `[[headers]]\n  for = ${q(p)}\n  [headers.values]\n` + Object.entries(h).map(([k, v]) => `    ${k} = ${q(v)}`).join('\n')).join('\n\n') + '\n';
}
module.exports = { MARKET, csp, rules, netlifyHeadersFile, vercelHeaders, netlifyToml };
