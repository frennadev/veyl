#!/usr/bin/env node
// One phase alone on a fresh local validator and deployment: node tests/phase-only.js <2|3> (npm run test:phase2 / test:phase3).
// `npm test` runs every phase on one deployment (tests/run.js).
'use strict';
const S = require('../sdk/veyl.js'); require('../sdk/shield.js'); const { Veyl } = S;
const { prove } = require('../sdk/prover.js');
const { deployAll, fund, units, sleep, priceQ } = require('../scripts/lib.js');
const { counts, check, refused, CU, cuOf, lap, freshValidator, funded, finish } = require('./harness.js');
const phase = process.argv[2]; if (!['2', '3'].includes(phase)) { console.error('usage: node tests/phase-only.js <2|3>'); process.exit(2); }
(async () => {
  const { rpc, conn, payer, payerFile, done } = await freshValidator(`veyl-sol-p${phase}-`);
  try {
    const [postman, relayer, alice, bob, carol, mallory] = await funded(conn, 6);
    const { V, dep, T, BP } = await deployAll({ rpc, payerFile, postman: postman.publicKey, relayer: relayer.publicKey });
    console.log('deployed in', lap());
    const as = (kp) => { const v = new Veyl({ connection: conn, programs: V.programs, payer: kp }); v.lookupTable = V.lookupTable; return v; };
    for (const k of [alice, bob, carol, mallory]) { await fund(conn, payer, T.USDC.mint, k.publicKey, units(100_000, 6)); await fund(conn, payer, T.SOL.mint, k.publicKey, units(1_000, 9)); await fund(conn, payer, T.USDT.mint, k.publicKey, units(100_000, 6)); }
    const C = { conn, payer, V, as, alice, bob, carol, mallory, relayer, postman, dep, T, BP, check, refused, cuOf, CU, prove, fund, units, priceQ, sleep, lap };
    await require(`./phase${phase}.js`)(C);
  } catch (e) { console.error('\nTEST RUN CRASHED:', e); counts.fail++; }
  finish(done);
})();
