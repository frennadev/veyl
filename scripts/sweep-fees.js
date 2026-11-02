#!/usr/bin/env node
// Collect the protocol fee (0.2% of every swap) that has built up in every bin pool: one report, then (with --yes) one
// withdraw_protocol_fee per pool into the fee authority's own token accounts (created if missing).
//
//   RPC_URL=<rpc> FEE_AUTHORITY_KEYPAIR=<path> node scripts/sweep-fees.js --network devnet          # report only
//   RPC_URL=<rpc> FEE_AUTHORITY_KEYPAIR=<path> node scripts/sweep-fees.js --network devnet --yes    # report + withdraw
//   options: --min <usd> skip pools whose fees are worth less (default 1, needs a price; unpriced tokens are always swept
//            when non-zero), --json (the report as JSON)
//
// Every pool on chain is covered (curated and permissionless), delisted ones included: their fees are still the protocol's.
// Mainnet: the fee authority should be the multisig (scripts/handover.js); then this prints the report and the amounts to
// propose, and signs nothing. With a plain key on mainnet it also needs --confirm-mainnet.
'use strict';
const fs = require('fs'); const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const N = require('./net.js');
const S = require('../sdk/veyl.js'); const { Veyl } = S;

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
function opt(rest, name) { const i = rest.indexOf(name); if (i >= 0) return rest[i + 1]; const e = rest.find((x) => x.startsWith(name + '=')); return e ? e.split('=').slice(1).join('=') : undefined; }

async function main() {
  const args = N.parseArgs(); const yes = args.rest.includes('--yes'); const minUsd = Number(opt(args.rest, '--min') || 1);
  const cfg = N.loadConfig(args.network); const rpc = process.env.RPC_URL || N.rpcOf(cfg);
  const depFile = N.deployFileOf(args.network); const dep = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, 'utf8')) : null;
  const g = await N.rpcCall(rpc, 'getGenesisHash'); if (!g.ok) { console.error('RPC unreachable: ' + g.error); process.exit(2); }
  const mainnet = g.result === MAINNET_GENESIS;
  if (mainnet !== (args.network === 'mainnet')) { console.error(`This RPC is ${mainnet ? '' : 'not '}mainnet but --network is ${args.network}: refusing.`); process.exit(2); }
  if (cfg.genesisHash && g.result !== cfg.genesisHash) { console.error(`This RPC is not ${args.network} (genesis ${g.result}): refusing.`); process.exit(2); }

  let key = null; const kf = process.env.FEE_AUTHORITY_KEYPAIR || process.env.DEPLOYER_KEYPAIR;
  if (kf) { const k = N.deployerKey({ DEPLOYER_KEYPAIR: kf }); if (k.error) { console.error(k.error.replace('DEPLOYER_KEYPAIR', 'FEE_AUTHORITY_KEYPAIR')); process.exit(2); } key = k.keypair; }
  const programs = (dep && dep.programs) || cfg.programs;
  const V = new Veyl({ rpc, programs, payer: key || undefined });
  const f = await V.factory(); if (!f) { console.error('No factory on this network.'); process.exit(2); }
  const canSign = !!key && key.publicKey.equals(f.feeAuthority);

  // token labels and prices: the deployment's tokens; anything else (pools listed since) by mint, with chain decimals
  const known = new Map(Object.entries((dep && dep.tokens) || {}).map(([sym, t]) => [t.mint, { sym, decimals: t.decimals, price: t.price || null }]));
  const tok = async (mint) => { const k = mint.toBase58(); if (known.has(k)) return known.get(k);
    let decimals = 0; try { const a = await V.conn.getParsedAccountInfo(mint); decimals = a.value.data.parsed.info.decimals; } catch {}
    const t = { sym: k.slice(0, 4) + '…', decimals, price: null }; known.set(k, t); return t; };
  const ui = (atoms, t) => Number(atoms) / 10 ** t.decimals;

  const pools = await V.binPools(); const rows = [];
  for (const p of pools) { if (p.protocolFeeX === 0n && p.protocolFeeY === 0n) continue;
    const tx = await tok(p.mintX), ty = await tok(p.mintY); const usd = (tx.price != null ? ui(p.protocolFeeX, tx) * tx.price : 0) + (ty.price != null ? ui(p.protocolFeeY, ty) * ty.price : 0);
    const priced = (p.protocolFeeX === 0n || tx.price != null) && (p.protocolFeeY === 0n || ty.price != null);
    rows.push({ pool: p.address.toBase58(), pair: tx.sym + '/' + ty.sym, x: p.protocolFeeX, y: p.protocolFeeY, tx, ty, usd, priced, delisted: p.delisted, sweep: !priced || usd >= minUsd }); }
  const totals = new Map(); for (const r of rows.filter((r) => r.sweep)) for (const [a, t] of [[r.x, r.tx], [r.y, r.ty]]) if (a > 0n) totals.set(t.sym, (totals.get(t.sym) || 0) + ui(a, t));

  if (args.json) console.log(JSON.stringify({ network: args.network, feeAuthority: f.feeAuthority.toBase58(), pools: rows.map((r) => ({ pool: r.pool, pair: r.pair, x: String(r.x), y: String(r.y), usd: r.usd, priced: r.priced, delisted: r.delisted, sweep: r.sweep })), totals: Object.fromEntries(totals) }, null, 1));
  else { console.log(`${args.network}: ${pools.length} pools, ${rows.length} holding protocol fees; fee authority ${f.feeAuthority.toBase58()}${canSign ? ' (this key)' : ''}`);
    for (const r of rows) console.log(`  ${r.sweep ? '•' : '·'} ${r.pair.padEnd(16)} ${ui(r.x, r.tx).toFixed(6).padStart(16)} ${r.tx.sym.padEnd(6)} ${ui(r.y, r.ty).toFixed(6).padStart(16)} ${r.ty.sym.padEnd(6)} ${r.priced ? ('$' + r.usd.toFixed(2)).padStart(10) : '  unpriced'}${r.delisted ? '  (delisted)' : ''}${r.sweep ? '' : '  below --min'}`);
    console.log('  to collect: ' + ([...totals].map(([s, v]) => `${v.toFixed(6)} ${s}`).join(', ') || 'nothing') + ` (~$${rows.filter((r) => r.sweep).reduce((a, r) => a + r.usd, 0).toFixed(2)} priced)`); }

  const todo = rows.filter((r) => r.sweep); if (!todo.length) return;
  if (!yes) { console.log('\nReport only. Add --yes to withdraw' + (canSign ? '.' : ' (needs FEE_AUTHORITY_KEYPAIR = the fee authority).')); return; }
  if (!canSign) { console.log(`\nThe fee authority is ${f.feeAuthority.toBase58()}${key ? ', not this key' : ''}: nothing signed. On mainnet propose one withdraw_protocol_fee per pool above from the multisig.`); return; }
  if (mainnet && !args.confirmMainnet) { console.error('Mainnet with a plain key: add --confirm-mainnet to withdraw.'); process.exit(2); }

  const me = key.publicKey; let done = 0, failed = 0;
  for (const r of todo) { const pool = new PublicKey(r.pool); const p = await V.binPool(pool);
    try { const pre = []; for (const [mint, prog] of [[p.mintX, p.tokenProgramX], [p.mintY, p.tokenProgramY]]) { const a = V.ata(mint, me, prog); if (!(await V.conn.getAccountInfo(a))) pre.push(V.createAtaIx ? V.createAtaIx(me, a, me, mint, prog) : require('@solana/spl-token').createAssociatedTokenAccountIdempotentInstruction(me, a, me, mint, prog)); }
      /* the amounts read now (a swap since the report only adds; the program refuses more than the pool holds) */
      const sig = await V.send([...pre, await V.withdrawProtocolFeeIx(me, pool, p.protocolFeeX, p.protocolFeeY)]); done++; console.log(`  withdrew ${r.pair}: ${sig}`); }
    catch (e) { failed++; console.error(`  ${r.pair} failed: ${String((e && e.message) || e).slice(0, 200)}`); } }
  console.log(`\n${done} pools swept${failed ? `, ${failed} failed` : ''}.`); if (failed) process.exit(1);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
