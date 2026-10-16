#!/usr/bin/env node
// npm run seed -- --network <local|devnet> [--trades N]
// After a deploy: puts real liquidity and a few real trades into the curated bin pools, so the app's pools table, pool pages
// and charts show on-chain data straight away. Uses the deployer key (DEPLOYER_KEYPAIR), which is the mint authority of the
// mock mints on local and devnet: it mints itself test tokens, adds a curve of liquidity around each pool's price (a public
// position owned by the deployer) and makes a few swaps both ways. Idempotent: a pool that already holds liquidity gets no
// second curve (pass --again to add one). Refuses mainnet (real mints: the deployer cannot mint them).
'use strict';
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const { Veyl, shapeWeights, distribute, chunkOf } = require('../sdk/veyl.js'); require('../sdk/shield.js');
const { fund, units, readKey, sleep } = require('./lib.js');

/// dep = deploy.<network>.json; V a Veyl client paying with `payer`. Returns what it did per pool.
async function seed({ V, conn, payer, dep, trades = 4, again = false, span = 20, usdPerSide = 20_000, log = console.log }) {
  const out = []; const tok = (sym) => ({ ...dep.tokens[sym], mint: new PublicKey(dep.tokens[sym].mint) });
  for (const b of dep.binPools) { const pool = new PublicKey(b.address); const p = await V.binPool(pool); if (!p) { log('skip ' + b.id + ': not on chain'); continue; }
    const X = tok(b.x), Y = tok(b.y); const a = p.activeId; const did = { id: b.id, minted: false, swaps: 0 };
    if (!p.seeded || again) {
      const ids = []; for (let i = a - span; i <= a + span; i++) ids.push(i); const w = shapeWeights(ids, a, 'curve');
      const ux = Number(X.price) || 1, uy = Number(Y.price) || 1; const ax = units(usdPerSide / ux, X.decimals), ay = units(usdPerSide / uy, Y.decimals);
      await fund(conn, payer, X.mint, payer.publicKey, ax * 2n); await fund(conn, payer, Y.mint, payer.publicKey, ay * 2n);
      const xs = distribute(ax, w.weightsX), ys = distribute(ay, w.weightsY); const keep = ids.map((_, i) => xs[i] > 0n || ys[i] > 0n);
      const I = ids.filter((_, i) => keep[i]), XS = xs.filter((_, i) => keep[i]), YS = ys.filter((_, i) => keep[i]);
      for (let k = 0; k < I.length; k += 14) { const s = I.slice(k, k + 14);
        await V.send([...(await V.ensureBinAccountsIxs(payer.publicKey, pool, s, payer.publicKey, payer.publicKey)), await V.mintIx(payer.publicKey, pool, { ids: s, amountsX: XS.slice(k, k + 14), amountsY: YS.slice(k, k + 14) })], [], 1_400_000); }
      did.minted = true; log('liquidity in ' + b.id + ': ' + I.length + ' bins around bin ' + a);
    } else log('liquidity in ' + b.id + ': already there');
    // a few trades, both ways, a few bins each (real swaps: they move the price, pay fees and emit Swapped events)
    for (let t = 0; t < trades; t++) { const xForY = t % 2 === 1; const sym = xForY ? X : Y; const usd = 300 + 200 * t; const amt = units(usd / (Number(sym.price) || 1), sym.decimals);
      await fund(conn, payer, sym.mint, payer.publicKey, amt); await V.send([await V.swapIx(payer.publicKey, pool, xForY, amt)], [], 1_400_000); did.swaps++; await sleep(150); }
    log('trades in ' + b.id + ': ' + did.swaps); out.push(did); }
  return out;
}
module.exports = { seed };

if (require.main === module) (async () => {
  const N = require('./net.js'); const a = N.parseArgs(); if (a.network === 'mainnet') { console.error('seed refuses mainnet: the deployer cannot mint real tokens.'); process.exit(2); }
  const dep = N.loadDeploy(a.network); if (!dep) { console.error('no deploy.' + a.network + '.json: run npm run deploy -- --network ' + a.network + ' first'); process.exit(2); }
  const k = N.deployerKey(); if (k.error) { console.error(k.error); process.exit(2); }
  const rpc = process.env.RPC_URL || dep.rpc; const conn = new Connection(rpc, 'confirmed'); const payer = k.keypair || readKey(k.file);
  const V = new Veyl({ connection: conn, programs: dep.programs, payer }); if (dep.lookupTable) V.lookupTable = new PublicKey(dep.lookupTable); V.lookupExtra = (dep.lookupTables || []).map((t) => new PublicKey(t));
  const ti = a.rest.indexOf('--trades'); const trades = ti >= 0 ? Number(a.rest[ti + 1]) : 4;
  const si = a.rest.indexOf('--span'); const span = si >= 0 ? Number(a.rest[si + 1]) : 20; const ui = a.rest.indexOf('--usd'); const usdPerSide = ui >= 0 ? Number(a.rest[ui + 1]) : 20_000;
  const r = await seed({ V, conn, payer, dep, trades, span, usdPerSide, again: a.rest.includes('--again'), log: (m) => console.log('  ' + m) });
  console.log('seeded ' + r.length + ' pools on ' + a.network + ' (' + rpc + ')');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
