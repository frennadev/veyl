#!/usr/bin/env node
// The mainnet sealed-batch committee under ONE operator (the owner), made on this machine: three node keys, then the
// dealerless key generation among three local node processes. Writes the public transcript to
// committee/transcript.mainnet.json (commit it) and leaves each node's secrets in the keys folder, to paste into the three
// Render committee services (render.yaml). Whoever holds all three shares could decrypt individual sealed swap sizes:
// config/mainnet.json "waivers" must say "single-operator-committee" for preflight to accept it. Move nodes to independent
// operators later (committee/OPERATOR.md).
//
//   npm run committee:mainnet                       # into ~/keys/veyl/committee-mainnet
//   KEYS=<dir> npm run committee:mainnet
// Refuses to run again once committee/transcript.mainnet.json exists (a new key generation means a new committee).
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { Keypair } = require('@solana/web3.js');
const D = require('../committee/dkg.js'); const { startLocalCommittee } = require('./committee-local.js');

const ROOT = path.join(__dirname, '..'); const dir = path.resolve(process.env.KEYS || path.join(os.homedir(), 'keys/veyl/committee-mainnet'));
const out = path.join(ROOT, 'committee/transcript.mainnet.json');
if ((dir + path.sep).startsWith(ROOT + path.sep)) { console.error('KEYS must be outside the repo.'); process.exit(2); }
if (fs.existsSync(out)) { console.error(`${path.relative(ROOT, out)} exists: the mainnet committee is already made. A new key generation is a new committee (set_committee between batches).`); process.exit(2); }

(async () => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  console.log(`key generation (2 of 3) on this machine, keys in ${dir} ...`);
  const c = await startLocalCommittee({ n: 3, t: 2, dir, session: `mainnet-one-operator-${day}`, env: { NETWORK: 'mainnet' } });
  try {
    fs.writeFileSync(out, JSON.stringify(c.transcript, null, 1) + '\n');
    for (let i = 1; i <= 3; i++) { const s = path.join(dir, `state-${i}`); if (fs.existsSync(s)) { fs.chmodSync(s, 0o700); for (const f of fs.readdirSync(s)) fs.chmodSync(path.join(s, f), f === 'share.json' ? 0o600 : 0o644); } }
    const nodes = [1, 2, 3].map((i) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(dir, `node-${i}.json`))))).publicKey.toBase58());
    console.log(`
================================================================ mainnet committee
  transcript  ${path.relative(ROOT, out)}  (public: commit it)  sha256 ${D.transcriptHash(c.transcript).toString('hex').slice(0, 16)}…
  joint key   ${D.hexP(c.registration.pk).slice(0, 32)}…
${nodes.map((n, i) => `  node ${i + 1}      ${n}    fund ~0.3 SOL (pays its share and settle transactions)`).join('\n')}

Render, service veyl-sol-committee-N (paste each file's contents; never commit them; secrets are not printed here):
  NODE_SECRET_KEY = ${dir}/node-N.json
  COMMITTEE_JSON  = ${dir}/config-N.json      (public keys only)
  SHARE_JSON      = ${dir}/state-N/share.json  (this member's KEY SHARE: secret)
  RPC_URL         = your paid mainnet RPC
  e.g. pbcopy < ${dir}/state-1/share.json   then paste, and clear the clipboard after

Back the folder up offline with the rest of your mainnet keys. Then in config/mainnet.json: add the
"single-operator-committee" waiver and set "sealed" -> "later": false, and the deploy registers the committee and
opens the SOL/USDC sealed pool.`);
  } finally { c.stop(); }
  process.exit(0);
})().catch((e) => { console.error('key generation failed: ' + e.message); process.exit(1); });
