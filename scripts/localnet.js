#!/usr/bin/env node
// npm run localnet: a local solana-test-validator on RPC 8933 (websocket 8934, gossip 11933) that keeps running.
// Funds the key in DEPLOYER_KEYPAIR, or makes a throwaway one in .localnet/deployer.json (gitignored) and prints its path.
// Then, in another terminal:  DEPLOYER_KEYPAIR=.localnet/deployer.json npm run deploy -- --network local
'use strict';
const fs = require('fs'); const path = require('path');
const { Keypair } = require('@solana/web3.js');
const { ROOT, RPC_PORT, startValidator, readKey } = require('./lib.js');
(async () => {
  const dir = path.join(ROOT, '.localnet'); fs.mkdirSync(dir, { recursive: true });
  const file = process.env.DEPLOYER_KEYPAIR || path.join(dir, 'deployer.json');
  if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 }); }
  const payer = readKey(file);
  if (process.env.RESET !== '0') fs.rmSync(path.join(dir, 'ledger'), { recursive: true, force: true });
  const { val, rpc } = await startValidator(dir, payer, RPC_PORT);
  console.log(`local validator up: ${rpc}  (deployer ${payer.publicKey.toBase58()} funded; key file ${path.relative(ROOT, file)})`);
  console.log(`next: DEPLOYER_KEYPAIR=${path.relative(ROOT, file)} npm run deploy -- --network local`);
  const stop = () => { val.kill('SIGTERM'); process.exit(0); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
  val.on('exit', (c) => { console.error('validator exited', c); process.exit(1); });
})().catch((e) => { console.error(e.message); process.exit(1); });
