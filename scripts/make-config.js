#!/usr/bin/env node
// Writes site/veyl.config.js (window.VEYL_CONFIG) from a deploy.<network>.json. Env: RELAYER_URL, CHAIN_NAME, EXPLORER, RPC_URL.
// Usage: node scripts/make-config.js deploy.local.json [> site/veyl.config.js]   (writes the file when no stdout redirect is wanted: OUT=site/veyl.config.js)
'use strict';
const fs = require('fs'); const path = require('path');
function makeConfig(dep, env = process.env) {
  const cfg = { cluster: dep.network, chainName: env.CHAIN_NAME || (dep.network === 'devnet' ? 'Solana devnet' : 'Local validator'), rpc: env.RPC_URL || dep.rpc, explorer: env.EXPLORER || (dep.network === 'devnet' ? 'https://solscan.io' : ''), explorerSuffix: dep.network === 'devnet' ? '?cluster=devnet' : '',
    relayer: env.RELAYER_URL || 'http://127.0.0.1:8843', programs: dep.programs, lookupTable: dep.lookupTable, lookupTables: dep.lookupTables || [], zk: { wasm: 'withdraw.wasm', zkey: 'withdraw_final.zkey', transact: { wasm: 'transact.wasm', zkey: 'transact_final.zkey' }, position: { wasm: 'position.wasm', zkey: 'position_final.zkey' }, swap: { wasm: 'swap.wasm', zkey: 'swap_final.zkey' }, claim: { wasm: 'claim.wasm', zkey: 'claim_final.zkey' } },
    prices: Object.fromEntries(Object.entries(dep.tokens).map(([k, t]) => [k, t.price])), tokens: Object.fromEntries(Object.entries(dep.tokens).map(([k, t]) => [k, { mint: t.mint, decimals: t.decimals, pool: t.pool }])),
    binPools: dep.binPools.map((b) => { const x = dep.tokens[b.x], y = dep.tokens[b.y]; return { id: b.id, x: b.x, y: b.y, bs: b.binStep, base: b.baseFee / 1e4, p0: x.price / y.price, address: b.address }; }) };
  return 'window.VEYL_CONFIG=' + JSON.stringify(cfg, null, 1) + ';\n';
}
module.exports = { makeConfig };
if (require.main === module) { const dep = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'deploy.local.json'), 'utf8')); const out = makeConfig(dep); if (process.env.OUT) fs.writeFileSync(process.env.OUT, out); else process.stdout.write(out); }
