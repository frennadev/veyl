// Shared by the test runners (tests/*.js): pass/fail counting, refusal matching, compute-unit capture, a fresh local
// validator, and loading a site/ source module in Node.
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const counts = { pass: 0, fail: 0 };
const t0 = Date.now(); const lap = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const check = (n, ok, extra = '') => { ok ? counts.pass++ : counts.fail++; console.log((ok ? '  ok  ' : '  FAIL') + ' ' + n + (extra !== '' ? '  ' + String(extra).slice(0, 200) : '')); };
/// true when the promise rejects with an error (or program logs) matching re; prints any other error
const refused = async (p, re) => { try { await p; return false; } catch (e) { const t = String(e.message) + JSON.stringify(e.logs || e.transactionLogs || ''); if (!re.test(t)) console.log('    unexpected error:', t.slice(0, 600)); return re.test(t); } };
const CU = {}; const cuOf = async (conn, sig, label) => { const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); const m = (t.meta.logMessages || []).map((l) => l.match(/consumed (\d+) of \d+ compute units/)).filter(Boolean); if (m.length) CU[label] = Math.max(...m.map((x) => Number(x[1]))); };

/// A local validator on a fresh ledger in a temp dir, with a funded payer. done(code) stops it, deletes the ledger
/// (each run would otherwise leave ~150 MB behind) and exits.
async function freshValidator(prefix = 'veyl-') {
  const { startValidator, RPC_PORT } = require('../scripts/lib.js');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); const payer = Keypair.generate(); const payerFile = path.join(TMP, 'payer.json'); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  const { val, rpc, conn } = await startValidator(TMP, payer, RPC_PORT);
  const done = (code) => { val.once('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(code); }); val.kill(); setTimeout(() => process.exit(code), 8000).unref(); };
  return { TMP, payer, payerFile, val, rpc, conn, done };
}
/// n new keypairs, each airdropped `sol` SOL
async function funded(conn, n, sol = 50) { const ks = Array.from({ length: n }, () => Keypair.generate()); for (const k of ks) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed'); return ks; }
/// prints the compute units and the totals, then done(1) on any failure
function finish(done, { cu = true } = {}) { if (cu) console.log('\ncompute units:', JSON.stringify(CU)); console.log(`\n${counts.pass} passed, ${counts.fail} failed  (${lap()})`); (done || process.exit)(counts.fail ? 1 : 0); }
/// an engine/ ES module (market.js, markets.js), bundled for Node with esbuild
function loadEngine(file) {
  const code = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../engine', file)], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const box = { exports: {} }; new Function('module', 'exports', 'require', code)(box, box.exports, require); return box.exports;
}

module.exports = { counts, check, refused, CU, cuOf, lap, freshValidator, funded, finish, loadEngine };
