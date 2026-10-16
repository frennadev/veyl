#!/usr/bin/env node
// A local batch committee for development, tests and the end-to-end run: n node processes (committee/node.js) on
// 127.0.0.1:8863.. with fresh node keys, which run the dealerless key generation among themselves over HTTP. Returns the
// registration for set_committee (from the transcript every node wrote) and the processes. Never for real funds: one
// machine runs every member, so whoever controls it holds all the shares (DEPLOY.md, "Batch committee").
//   node scripts/committee-local.js [--n 3] [--t 2] [--dir .localnet/committee]     (keeps running; Ctrl-C stops)
'use strict';
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const { Keypair } = require('@solana/web3.js');
const { boxKeyOf } = require('../committee/node.js'); const D = require('../committee/dkg.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startLocalCommittee({ n = 3, t = 2, basePort = Number(process.env.COMMITTEE_PORT || 8863), dir, deployFile = null, rpc = null, session = 'local-' + Date.now(), log = () => {}, env = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true }); const keys = []; const procs = [];
  for (let i = 1; i <= n; i++) { const f = path.join(dir, `node-${i}.json`); if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 }); keys.push(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f))))); }
  const peers = keys.map((k, i) => ({ index: i + 1, url: `http://127.0.0.1:${basePort + i}`, node: k.publicKey.toBase58(), boxKey: Buffer.from(boxKeyOf(k).publicKey).toString('base64') }));
  for (let i = 1; i <= n; i++) { const cfg = path.join(dir, `config-${i}.json`); fs.writeFileSync(cfg, JSON.stringify({ index: i, t, n, peers }, null, 1));
    const p = spawn(process.execPath, [path.join(__dirname, '../committee/node.js')], { env: { ...process.env, ...env, COMMITTEE_CONFIG: cfg, NODE_KEY: path.join(dir, `node-${i}.json`), STATE_DIR: path.join(dir, `state-${i}`), DKG_SESSION: session, PORT: String(basePort + i - 1), ...(deployFile ? { DEPLOY_FILE: deployFile } : {}), ...(rpc ? { RPC_URL: rpc } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => log(String(d).trim())); p.stderr.on('data', (d) => log(String(d).trim())); procs.push(p); }
  // wait for every node's transcript; they must be identical
  let trs = null; for (let k = 0; k < 240 && !trs; k++) { await sleep(500); const got = [];
    for (const p of peers) { try { const r = await fetch(p.url + '/transcript'); if (r.ok) got.push(await r.json()); } catch {} }
    if (got.length === n) trs = got; }
  if (!trs) { procs.forEach((p) => p.kill()); throw new Error('the local committee did not finish its key generation'); }
  const hashes = new Set(trs.map((x) => D.transcriptHash(x).toString('hex'))); if (hashes.size !== 1) throw new Error('nodes wrote different transcripts');
  const v = D.verifyTranscript(trs[0]); if (!v.ok) throw new Error('transcript does not verify: ' + v.errs.join(', '));
  return { procs, peers, keys, transcript: trs[0], registration: D.registration(trs[0], 0 /* dev: every member on one machine */), stop: () => procs.forEach((p) => p.kill()) };
}
module.exports = { startLocalCommittee };
if (require.main === module) {
  const a = process.argv.slice(2); const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  startLocalCommittee({ n: Number(arg('n', 3)), t: Number(arg('t', 2)), dir: path.resolve(arg('dir', path.join(__dirname, '../.localnet/committee'))), deployFile: arg('deploy', null), rpc: process.env.RPC_URL || null, log: console.log })
    .then(async (c) => { console.log('committee up:', c.peers.map((p) => p.url).join(' '), '\njoint key', D.hexP(c.registration.pk).slice(0, 32) + '…', 'transcript sha256', c.registration.transcript.toString('hex'));
      // the nodes pay for their share transactions: on a local validator, airdrop them some SOL
      if (process.env.RPC_URL) { const { Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js'); const conn = new Connection(process.env.RPC_URL, 'confirmed'); for (const k of c.keys) { try { await conn.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL); } catch { /* not a test validator */ } } }
      fs.writeFileSync(path.join(path.resolve(arg('dir', path.join(__dirname, '../.localnet/committee'))), 'transcript.json'), JSON.stringify(c.transcript, null, 1));
      process.on('SIGINT', () => { c.stop(); process.exit(0); }); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
