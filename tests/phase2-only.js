#!/usr/bin/env node
// Phase 2 alone (npm run test:phase2): a fresh local validator and deployment, then tests/phase2.js. `npm test` runs it too,
// after the Phase 1 suite, on the same deployment.
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const S = require('../sdk/veyl.js'); require('../sdk/shield.js'); const { Veyl } = S;
const { prove } = require('../sdk/prover.js');
const { startValidator, deployAll, fund, units, sleep, priceQ, RPC_PORT } = require('../scripts/lib.js');
let pass = 0, fail = 0; const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '  ok  ' : '  FAIL') + ' ' + n + (extra !== '' ? '  ' + String(extra).slice(0, 200) : '')); };
const refused = async (p, re) => { try { await p; return false; } catch (e) { const t = String(e.message) + JSON.stringify(e.logs || e.transactionLogs || ''); if (!re.test(t)) console.log('    unexpected error:', t.slice(0, 600)); return re.test(t); } };
const CU = {}; const cuOf = async (conn, sig, label) => { const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); const m = (t.meta.logMessages || []).map((l) => l.match(/consumed (\d+) of \d+ compute units/)).filter(Boolean); if (m.length) CU[label] = Math.max(...m.map((x) => Number(x[1]))); };
const t0 = Date.now(); const lap = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-sol-p2-')); const payer = Keypair.generate(); const payerFile = path.join(TMP, 'payer.json'); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  const { val, rpc, conn } = await startValidator(TMP, payer, RPC_PORT);
  const done = (code) => { val.once('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(code); }); val.kill(); setTimeout(() => process.exit(code), 8000).unref(); };
  try {
    const [postman, relayer, alice, bob, carol, mallory] = Array.from({ length: 6 }, () => Keypair.generate());
    for (const k of [postman, relayer, alice, bob, carol, mallory]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 50 * LAMPORTS_PER_SOL), 'confirmed');
    const { V, dep, T, BP } = await deployAll({ rpc, payerFile, postman: postman.publicKey, relayer: relayer.publicKey });
    console.log('deployed in', lap());
    const as = (kp) => { const v = new Veyl({ connection: conn, programs: V.programs, payer: kp }); v.lookupTable = V.lookupTable; return v; };
    for (const k of [alice, bob, carol, mallory]) { await fund(conn, payer, T.USDC.mint, k.publicKey, units(100_000, 6)); await fund(conn, payer, T.SOL.mint, k.publicKey, units(1_000, 9)); await fund(conn, payer, T.USDT.mint, k.publicKey, units(100_000, 6)); }
    const C = { conn, payer, V, as, alice, bob, carol, mallory, relayer, postman, dep, T, BP, check, refused, cuOf, CU, prove, fund, units, priceQ, sleep, lap };
    await require('./phase2.js')(C);
  } catch (e) { console.error('\nTEST RUN CRASHED:', e); fail++; }
  console.log('\ncompute units:', JSON.stringify(CU));
  console.log(`\n${pass} passed, ${fail} failed  (${lap()})`); done(fail ? 1 : 0);
})();
