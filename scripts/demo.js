#!/usr/bin/env node
// Everything local, in one process: validator (8933) -> a 2-of-3 batch committee (8863-8865, key generation over HTTP) ->
// programs, pools, entry, committee, sealed pools -> relayer + approved-set publisher (8843) -> the site and the app (8873). Mock mints are created; FUND=<wallet> mints 10 SOL-token, 10,000 USDC/USDT, 10,000 JUP, 100,000,000 BONK
// to that wallet (your Phantom address, switched to http://127.0.0.1:8933) so you can deposit from the app.
'use strict';
const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
const { Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { ROOT, RPC_PORT, startValidator, fund, units, sleep } = require('./lib.js');
const RELAYER_PORT = Number(process.env.PORT || 8843), WEB_PORT = 8873;
const MIME = { html: 'text/html', css: 'text/css', js: 'application/javascript', png: 'image/png', webp: 'image/webp', json: 'application/json', wasm: 'application/wasm', zkey: 'application/octet-stream' };
function serveSite(port) { return http.createServer((req, res) => { let f = req.url.split('?')[0]; f = f === '/' ? '/index.html' : f; const fp = path.join(ROOT, 'site', f); if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory() || f.startsWith('/_')) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[f.split('.').pop()] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(res); }).listen(port); }
if (require.main === module) (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-demo-')); const payer = Keypair.generate(); const payerFile = path.join(dir, 'payer.json'); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  console.log('starting a local validator on :' + RPC_PORT); const { val, rpc, conn } = await startValidator(dir, payer, RPC_PORT);
  process.on('exit', () => val.kill()); // never leave the validator behind, also when the deploy fails
  const relayer = Keypair.generate(), postman = Keypair.generate(); for (const k of [relayer, postman]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 100 * LAMPORTS_PER_SOL), 'confirmed');
  const relayerFile = path.join(dir, 'relayer.json'), postmanFile = path.join(dir, 'postman.json'); fs.writeFileSync(relayerFile, JSON.stringify([...relayer.secretKey])); fs.writeFileSync(postmanFile, JSON.stringify([...postman.secretKey]));
  // Phase 3: a local batch committee (3 node processes on 8863-8865, dealerless key generation over HTTP; all on this
  // machine, so for development only). Its transcript is what the deploy registers; the nodes then watch the deployment.
  const { startLocalCommittee } = require('./committee-local.js'); const cdir = path.join(dir, 'committee');
  const cmt = await startLocalCommittee({ n: 3, t: 2, dir: cdir, deployFile: path.join(ROOT, 'deploy.local.json'), rpc, log: (m) => { if (/DKG done|settled|closed|share for/.test(m)) console.log('  [committee] ' + m); } });
  process.on('exit', () => cmt.stop()); const tfile = path.join(cdir, 'transcript.json'); fs.writeFileSync(tfile, JSON.stringify(cmt.transcript, null, 1));
  for (const k of cmt.keys) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
  console.log('batch committee up (2 of 3): ' + cmt.peers.map((p) => p.url).join(' '));
  // the one deploy entrypoint (preflight -> programs -> pools -> ... -> deploy.local.json -> site/veyl.config.js -> committee + sealed pools)
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/deploy.js'), '--network', 'local'], { stdio: 'inherit', env: { ...process.env, DEPLOYER_KEYPAIR: payerFile, RPC_URL: rpc, POSTMAN_PUBKEY: postman.publicKey.toBase58(), RELAYER_PUBKEY: relayer.publicKey.toBase58(), RELAYER_URL: 'http://127.0.0.1:' + RELAYER_PORT, COMMITTEE_TRANSCRIPT: tfile } });
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy.local.json'), 'utf8')); const T = Object.fromEntries(Object.entries(dep.tokens).map(([k, t]) => [k, { ...t, sym: k, mint: new PublicKey(t.mint) }]));
  console.log('programs deployed', JSON.stringify(dep.programs, null, 1));
  if (process.env.FUND) { const who = new PublicKey(process.env.FUND); await conn.requestAirdrop(who, 5e9).catch(() => {}); for (const t of Object.values(T)) await fund(conn, payer, t.mint, who, units(t.sym === 'SOL' ? 10 : t.sym === 'BONK' ? 100_000_000 : 10_000, t.decimals)); console.log('funded', process.env.FUND, 'with mock tokens and 5 SOL'); }
  const rel = spawn('node', [path.join(ROOT, 'relayer/relayer.js')], { env: { ...process.env, PORT: String(RELAYER_PORT), RPC_URL: rpc, DEPLOY_FILE: path.join(ROOT, 'deploy.local.json'), RELAYER_KEY: relayerFile, POSTMAN_KEY: postmanFile }, stdio: 'inherit' });
  const web = serveSite(WEB_PORT);
  await sleep(1500); console.log(`\nVeyl is up: http://localhost:${WEB_PORT}  (app: http://localhost:${WEB_PORT}/app.html, relayer: http://127.0.0.1:${RELAYER_PORT})`);
  const stop = () => { rel.kill(); cmt.stop(); val.kill(); web.close(); process.exit(0); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
})().catch((e) => { console.error(e); process.exit(1); });
module.exports = { serveSite };
