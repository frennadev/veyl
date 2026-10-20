#!/usr/bin/env node
// RPC fallback (sdk/rpc.js) with a fake fetch: the configured RPC is used while it answers; a dropped connection, a timeout,
// rate limiting, a bad key or a server error moves the same request to the cluster's public RPC, which stays first for
// the cooldown before the configured RPC is tried again; a client error (400) is not retried; local has no fallback.
// Then a real web3.js Connection through it. No network.
'use strict';
const { check, finish } = require('./harness.js');
const R = require('../sdk/rpc.js');

const MAIN = 'https://rpc.example.test/?api-key=k', PUB = R.PUBLIC_RPC.devnet;
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const status = (s) => ({ ok: false, status: s, json: async () => ({}), text: async () => '' });
/// a fake network: `plan[url]` is a list of responses (or errors) handed out in order; the last one repeats
function net(plan) { const calls = []; const f = async (url, init) => { calls.push({ url, body: init && init.body }); const q = plan[url]; const r = q.length > 1 ? q.shift() : q[0];
  if (r instanceof Error) throw r; if (r === 'hang') return new Promise((_, no) => init.signal.addEventListener('abort', () => no(Object.assign(new Error('aborted'), { name: 'AbortError' })))); return r; }; f.calls = calls; return f; }

(async () => {
  check('public RPC per cluster; none for local', R.publicRpcFor('devnet') === 'https://api.devnet.solana.com' && R.publicRpcFor('mainnet') === 'https://api.mainnet-beta.solana.com' && R.publicRpcFor('local') === null);

  let t = 0; const switches = [];
  let n = net({ [MAIN]: [ok({ r: 'main' })], [PUB]: [ok({ r: 'pub' })] });
  let F = R.fallbackFetch(MAIN, PUB, { base: n, now: () => t, onSwitch: (to, why) => switches.push([to, why]) });
  check('the configured RPC answers: it is used, the public one is not', (await (await F(MAIN, { body: 'a' })).json()).r === 'main' && n.calls.every((c) => c.url === MAIN));

  for (const [label, bad] of [['a dropped connection', new TypeError('fetch failed')], ['rate limiting (429)', status(429)], ['a rejected key (401)', status(401)], ['a server error (503)', status(503)]]) {
    t += 60_000; n = net({ [MAIN]: [bad], [PUB]: [ok({ r: 'pub' })] }); F = R.fallbackFetch(MAIN, PUB, { base: n, now: () => t });
    const r = await (await F(MAIN, { body: '{"method":"getSlot"}' })).json();
    check(label + ': the same request goes to the public RPC', r.r === 'pub' && n.calls[1].url === PUB && n.calls[1].body === n.calls[0].body);
  }

  n = net({ [MAIN]: ['hang'], [PUB]: [ok({ r: 'pub' })] }); F = R.fallbackFetch(MAIN, PUB, { base: n, timeoutMs: 30 });
  check('a configured RPC that hangs times out, then the public RPC answers', (await (await F(MAIN, { body: 'x' })).json()).r === 'pub');

  n = net({ [MAIN]: [status(400)], [PUB]: [ok({ r: 'pub' })] }); F = R.fallbackFetch(MAIN, PUB, { base: n });
  check('a client error (400) is returned as is, not retried elsewhere', (await F(MAIN, {})).status === 400 && n.calls.length === 1);

  // cooldown: after a failure the public RPC goes first; the configured one gets another try after it
  t = 0; switches.length = 0;
  n = net({ [MAIN]: [status(429), ok({ r: 'main' })], [PUB]: [ok({ r: 'pub' })] }); F = R.fallbackFetch(MAIN, PUB, { base: n, now: () => t, onSwitch: (to, why) => switches.push([to, why]) });
  await F(MAIN, {}); t = 10_000; const during = await (await F(MAIN, {})).json();
  check('during the cooldown the public RPC is asked first (the configured one is not called)', during.r === 'pub' && n.calls.length === 3 && n.calls[2].url === PUB);
  t = 31_000; const after = await (await F(MAIN, {})).json();
  check('after the cooldown the configured RPC is tried again, and used', after.r === 'main' && n.calls.at(-1).url === MAIN);
  check('one switch reported per failure, with the reason', switches.length === 1 && switches[0][0] === 'fallback' && switches[0][1] === 'HTTP 429', JSON.stringify(switches));

  t = 0; n = net({ [MAIN]: [status(503), ok({ r: 'main' })], [PUB]: [status(503)] }); switches.length = 0;
  F = R.fallbackFetch(MAIN, PUB, { base: n, now: () => t, onSwitch: (to) => switches.push(to) });
  await F(MAIN, {}); t = 5_000; const back = await (await F(MAIN, {})).json();
  check('in the cooldown, if the public RPC fails too, the configured one is asked and taken back', back.r === 'main' && switches.join() === 'fallback,primary');

  n = net({ [MAIN]: [new TypeError('down')], [PUB]: [new TypeError('down')] }); F = R.fallbackFetch(MAIN, PUB, { base: n });
  let msg = ''; try { await F(MAIN, {}); } catch (e) { msg = e.message; }
  check('both unreachable: a clear error naming both failures', /RPC unreachable: down; public RPC: down/.test(msg), msg);
  n = net({ [MAIN]: [status(429)], [PUB]: [status(503)] }); F = R.fallbackFetch(MAIN, PUB, { base: n });
  check('both answer with an error status: one response is handed back for web3.js to report', (await F(MAIN, {})).status === 503);
  n = net({ 'https://other.test': [ok({})] }); F = R.fallbackFetch(MAIN, PUB, { base: n });
  await F('https://other.test', {}); check('another URL passes straight through', n.calls.length === 1 && n.calls[0].url === 'https://other.test');

  // a real web3.js Connection
  const rpcReply = (url, init) => { const req = JSON.parse(init.body); return ok({ jsonrpc: '2.0', id: req.id, result: url === PUB ? 222 : 111 }); };
  let down = true; const seen = [];
  const base = async (url, init) => { seen.push(url); if (url === MAIN && down) throw new TypeError('fetch failed'); return rpcReply(url, init); };
  const c = R.connectionFor(MAIN, 'devnet', { fetch: base });
  check('connectionFor: web3.js getSlot falls back to the public devnet RPC', (await c.getSlot()) === 222 && seen.join() === [MAIN, PUB].join());
  const local = R.connectionFor('http://127.0.0.1:8899', 'local', { fetch: async (u, i) => { seen.push('local'); return rpcReply(u, i); } });
  check('connectionFor on local: no fallback, the given fetch is kept', (await local.getSlot()) === 111 && seen.at(-1) === 'local');
  seen.length = 0; const already = R.connectionFor(PUB, 'devnet', { fetch: base }); await already.getSlot();
  check('connectionFor when the RPC already is the public one: no second endpoint', seen.length === 1 && seen[0] === PUB);
  finish(null, { cu: false });
})().catch((e) => { console.error(e); process.exit(1); });
