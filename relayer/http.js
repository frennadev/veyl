// The relayer's HTTP API (routes listed in relayer/relayer.js), its rate limits and background timers.
'use strict';
const http = require('http');
const { j } = require('../sdk/veyl.js');
/// Rate-limit key. Behind a proxy (Render, a CDN) every request comes from the proxy's address, so one client could use up
/// everyone's budget; TRUST_PROXY=<n> takes the address the n-th proxy from the right appended to X-Forwarded-For
/// (REVIEW.md L-2). Never logged.
function clientKey(req, trust = Number(process.env.TRUST_PROXY || 0)) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return trust > 0 && xff.length >= trust ? xff[xff.length - trust] : req.socket.remoteAddress;
}
function serve(relayer, port = 8843) {
  const hits = new Map(); // in memory only, never logged
  const drips = new Map(); // faucet: last drip per address and per caller, in memory only
  setInterval(() => hits.clear(), 60_000).unref();
  // CORS: ALLOWED_ORIGINS=https://veyl.example,https://www.veyl.example limits browsers to the site; unset = any origin.
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const json = (res, code, o, req) => { const origin = req && req.headers.origin; const allow = !allowed.length ? '*' : allowed.includes(origin) ? origin : allowed[0];
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': allow, 'access-control-allow-headers': 'content-type', vary: 'origin', 'cache-control': 'no-store' }); res.end(j(o)); };
  const srv = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, {}, req);
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/info') return json(res, 200, relayer.info(), req);
      if (url.pathname === '/health') return json(res, 200, relayer.health(), req);
      if (url.pathname === '/pools') return json(res, 200, await relayer.binPools(), req);
      if (url.pathname === '/shield') return json(res, 200, await relayer.shieldState(), req);
      if (url.pathname === '/sealed') { const pool = url.searchParams.get('pool'); if (!pool) throw new Error('pool?'); return json(res, 200, await relayer.sealedState(pool), req); }
      if (url.pathname === '/state') { const pool = url.searchParams.get('pool'); if (!pool) throw new Error('pool?'); const st = await relayer.state(pool); return json(res, 200, { leaves: st.leaves, labels: st.labels, deposits: st.deposits }, req); }
      if (req.method !== 'POST' || (url.pathname !== '/submit' && url.pathname !== '/fee' && url.pathname !== '/drip')) return json(res, 404, { error: 'not found' }, req);
      const k = clientKey(req); const n = (hits.get(k) || 0) + 1; hits.set(k, n); if (n > 30) return json(res, 429, { error: 'slow down' }, req);
      let body = ''; for await (const c of req) { body += c; if (body.length > 200_000) return json(res, 413, { error: 'too large' }, req); }
      if (url.pathname === '/fee') return json(res, 200, await relayer.feeQuote(JSON.parse(body)), req);
      if (url.pathname === '/drip') { const to = String((JSON.parse(body) || {}).to || ''); const now = Date.now(); const last = drips.get(to) || drips.get('ip:' + k) || 0;
        const wantPair = Array.isArray((JSON.parse(body) || {}).tokens) && (JSON.parse(body) || {}).tokens.length;
        if (!wantPair && now - last < 6 * 3600_000) return json(res, 429, { error: 'Test tokens already sent here recently. Try again in a few hours.' }, req);
        const want = (JSON.parse(body) || {}).tokens; const key = to + (Array.isArray(want) && want.length ? ':' + want.slice(0, 4).sort().join(',') : '');
        if (key !== to) { if (now - (drips.get(key) || 0) < 6 * 3600_000) return json(res, 429, { error: 'Test tokens for this pair were already sent here recently.' }, req); const r = await relayer.drip(to, want); drips.set(key, now); return json(res, 200, r, req); }
        const r = await relayer.drip(to); drips.set(to, now); drips.set('ip:' + k, now); return json(res, 200, r, req); }
      srv.inflight++; try { json(res, 200, await relayer.submit(JSON.parse(body)), req); } finally { srv.inflight--; }
    } catch (e) { json(res, 400, { error: String(e.message).slice(0, 300) }, req); }
  });
  srv.inflight = 0; srv.listen(port);
  if (process.env.SEALED_CRANK !== '0') { srv.crank = setInterval(() => relayer.crankSealed().catch((e) => console.error('crank', e.message)), Number(process.env.CRANK_INTERVAL_MS || 4_000)); srv.crank.unref(); }
  relayer.refreshBalance(); srv.bal = setInterval(() => relayer.refreshBalance(), 60_000); srv.bal.unref();
  if (relayer.postman) { relayer.publish(); srv.asp = setInterval(() => relayer.publish(), Number(process.env.ASP_INTERVAL_MS || 30_000)); srv.asp.unref();
    const admit = () => relayer.approveDeposits().catch((e) => console.error('admit', e.message)); admit(); srv.admit = setInterval(admit, Number(process.env.ADMIT_INTERVAL_MS || 5_000)); srv.admit.unref(); }
  return srv;
}
module.exports = { serve, clientKey };
