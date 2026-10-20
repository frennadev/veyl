#!/usr/bin/env node
// One-off: brings the devnet deployment made before permissionless pools (old 137-byte factory, pools with a 10% protocol
// share) to the current veyl_bin rules, after veyl_bin was upgraded in place with a build that has `--features
// devnet-migrate` (scripts/build.sh dev profile; never the mainnet profile). Signed by the factory authority.
//   (a) migrate_factory if the factory still has its old size (treasury = authority, 1 SOL bond, 30-day lock, 0.2% fee)
//   (b) add_fee_tier for every tier of config/<network>.json "feeTiers" the factory does not have yet (in that order)
//   (c) migrate_pool for every pool of deploy.<network>.json binPools and every BinPool found on chain for the program
//   (d) delist_pool for the pools that use the old mock SOL mint (devnet now uses real wrapped SOL): exits keep working
//   (e) a summary
// Run it right after the upgrade: until a pool is migrated, its old protocol_share bytes (1000) read as a 10% protocol fee.
//
//   DEPLOYER_KEYPAIR=~/keys/veyl/deployer.json RPC_URL=<devnet RPC> node scripts/migrate-devnet.js --network devnet [--dry-run]
//   options: --deploy <file> (default deploy.<network>.json), --old-mint <mint> (default the old devnet mock SOL mint)
// Refuses mainnet (by name and by genesis hash). Idempotent: run it again and it only does what is left.
'use strict';
const fs = require('fs'); const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const N = require('./net.js');
const S = require('../sdk/veyl.js'); const { Veyl } = S;

const OLD_MOCK_SOL = '7SJ3fU6JFBDEP3rHJgexN7egg5Yp8d8sPZqpuCVY56Co';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const OLD_FACTORY_SIZE = 137;
const NEW_PROTOCOL_FEE_BPS = 20;
const POOLS_PER_TX = 8;

function opt(rest, name) { const i = rest.indexOf(name); if (i >= 0) return rest[i + 1]; const e = rest.find((x) => x.startsWith(name + '=')); return e ? e.split('=').slice(1).join('=') : undefined; }

async function main() {
  const args = N.parseArgs();
  if (args.network === 'mainnet') { console.error('migrate-devnet.js never runs on mainnet.'); process.exit(2); }
  const cfg = N.loadConfig(args.network); const rpc = N.rpcOf(cfg);
  const deployFile = opt(args.rest, '--deploy') || N.deployFileOf(args.network);
  const dep = fs.existsSync(deployFile) ? JSON.parse(fs.readFileSync(deployFile, 'utf8')) : null;
  const oldMint = new PublicKey(opt(args.rest, '--old-mint') || OLD_MOCK_SOL);
  const key = N.deployerKey(); if (key.error) { console.error(key.error); process.exit(2); }
  const g = await N.rpcCall(rpc, 'getGenesisHash');
  if (!g.ok) { console.error('RPC unreachable: ' + g.error); process.exit(2); }
  if (g.result === MAINNET_GENESIS) { console.error('This RPC is mainnet: refusing.'); process.exit(2); }
  if (cfg.genesisHash && g.result !== cfg.genesisHash) { console.error(`This RPC is not ${args.network} (genesis ${g.result}): refusing.`); process.exit(2); }

  const programs = (dep && dep.programs) || cfg.programs;
  const V = new Veyl({ rpc, programs, payer: key.keypair }); const me = key.keypair.publicKey; const dry = args.dryRun;
  const log = (...a) => console.log(...a);
  log(`${dry ? '[dry run] ' : ''}network ${args.network}, veyl_bin ${V.programs.bin.toBase58()}, authority ${me.toBase58()}`);
  const done = { factory: 'already migrated', tiersAdded: [], tiersKept: [], tierConflicts: [], migrated: [], alreadyOk: [], missing: [], noTier: [], delisted: [], alreadyDelisted: [] };

  // ---- (a) the factory
  const fpda = V.factoryPda(); const fa = await V.conn.getAccountInfo(fpda, 'confirmed');
  if (!fa) throw new Error('no factory at ' + fpda.toBase58() + ' (is this the right program / network?)');
  if (!fa.owner.equals(V.programs.bin)) throw new Error('the factory PDA is not owned by veyl_bin');
  const auth = new PublicKey(fa.data.subarray(8, 40));
  if (!auth.equals(me)) throw new Error('DEPLOYER_KEYPAIR is not the factory authority (' + auth.toBase58() + ')');
  if (fa.data.length === OLD_FACTORY_SIZE) {
    const need = Math.max(0, (await V.conn.getMinimumBalanceForRentExemption(S.SIZES.factory)) - fa.lamports);
    log(`(a) migrate_factory: ${OLD_FACTORY_SIZE} -> ${S.SIZES.factory} bytes, ${need} lamports extra rent`);
    if (dry) {
      const sim = await V.conn.simulateTransaction(await V.tx([V.migrateFactoryIx(me)], me, 200_000));
      if (sim.value.err) { log('    WARN simulated: FAILS (veyl_bin not upgraded to a devnet-migrate build yet?): ' + JSON.stringify(sim.value.err) + ' ' + (sim.value.logs || []).slice(-3).join(' | ')); done.factory = 'would migrate (simulation FAILED: upgrade veyl_bin first)'; }
      else { log('    simulated: ok'); done.factory = 'would migrate'; }
    } else { await V.send([V.migrateFactoryIx(me)], [], 200_000); done.factory = 'migrated'; }
  } else if (fa.data.length !== S.SIZES.factory) throw new Error('factory has an unexpected size ' + fa.data.length);
  else log('(a) factory already has the new layout');

  // ---- (b) fee tiers (when dry and the factory is still old, it has none yet)
  const f0 = fa.data.length === OLD_FACTORY_SIZE ? { tiers: [], treasury: me } : S.decodeFactory(fa.data);
  const tiers = f0.tiers.map((t) => ({ ...t }));
  for (const t of cfg.feeTiers || S.DEFAULT_FEE_TIERS) {
    const have = tiers.find((x) => x.binStep === Number(t.binStep));
    if (have) {
      if (have.baseFee !== Number(t.baseFee) || have.vfc !== BigInt(t.vfc)) done.tierConflicts.push(`bin step ${t.binStep}: on chain ${have.baseFee}/${have.vfc}, config ${t.baseFee}/${t.vfc} (tiers never change: left as is)`);
      else done.tiersKept.push(t.binStep); continue;
    }
    log(`(b) add_fee_tier bin step ${t.binStep}, base fee ${t.baseFee} pips, vfc ${t.vfc}`);
    if (!dry) await V.send([V.addFeeTierIx(me, t.binStep, t.baseFee, t.vfc)], [], 200_000);
    tiers.push({ index: tiers.length, binStep: Number(t.binStep), baseFee: Number(t.baseFee), vfc: BigInt(t.vfc), enabled: true }); done.tiersAdded.push(t.binStep);
  }
  const treasury = dry ? f0.treasury : (await V.factory()).treasury;

  // ---- (c) pools: the deployment's and every BinPool of the program on chain
  const chain = await V.binPools(); const byAddr = new Map(chain.map((p) => [p.address.toBase58(), p]));
  const listed = ((dep && dep.binPools) || []).map((b) => b.address).filter(Boolean);
  const names = new Map(((dep && dep.binPools) || []).map((b) => [b.address, b.id]));
  for (const a of listed) if (!byAddr.has(a)) done.missing.push(`${names.get(a) || ''} ${a}`.trim());
  const pools = [...byAddr.values()];
  const tierFor = (p) => { const keep = p.protocolFeeBps === NEW_PROTOCOL_FEE_BPS && tiers[p.feeTier] && tiers[p.feeTier].binStep === p.binStep;
    return keep ? tiers[p.feeTier] : tiers.find((t) => t.enabled && t.binStep === p.binStep); };
  const label = (p) => (names.get(p.address.toBase58()) || `${p.mintX.toBase58().slice(0, 6)}../${p.mintY.toBase58().slice(0, 6)}.. bs${p.binStep}`) + ' ' + p.address.toBase58();
  const todo = [];
  for (const p of pools) {
    if (!p.factory.equals(fpda)) continue;
    const t = tierFor(p); if (!t) { done.noTier.push(label(p) + ` (bin step ${p.binStep})`); continue; }
    const ok = p.protocolFeeBps === NEW_PROTOCOL_FEE_BPS && p.feeTier === t.index && p.baseFee === t.baseFee && p.variableFeeControl === t.vfc;
    if (ok) { done.alreadyOk.push(label(p)); continue; }
    todo.push(p);
    log(`(c) migrate_pool ${label(p)}: protocol ${p.protocolFeeBps} -> ${NEW_PROTOCOL_FEE_BPS} bps, tier ${t.index}, base fee ${p.baseFee} -> ${t.baseFee}, vfc ${p.variableFeeControl} -> ${t.vfc}`);
  }
  for (let i = 0; i < todo.length; i += POOLS_PER_TX) {
    const part = todo.slice(i, i + POOLS_PER_TX);
    if (!dry) await V.send(part.map((p) => V.migratePoolIx(me, p.address)), [], 50_000 * part.length);
    for (const p of part) done.migrated.push(label(p));
  }

  // ---- (d) delist the pools of the old mock SOL mint (exits and swaps keep working)
  for (const p of pools) {
    if (!p.factory.equals(fpda) || !(p.mintX.equals(oldMint) || p.mintY.equals(oldMint))) continue;
    if (p.delisted) { done.alreadyDelisted.push(label(p)); continue; }
    log(`(d) delist_pool ${label(p)} (old mock SOL mint)`);
    if (!dry) await V.send([V.binIx('delist_pool', [], [{ pubkey: me, isSigner: true, isWritable: false }, { pubkey: fpda, isSigner: false, isWritable: false }, { pubkey: p.address, isSigner: false, isWritable: true }, { pubkey: V.bondPda(p.address), isSigner: false, isWritable: true }, { pubkey: treasury, isSigner: false, isWritable: true }])], [], 100_000);
    done.delisted.push(label(p));
  }

  // ---- (e) summary
  const w = dry ? 'would be ' : '';
  log(`\n${dry ? '[dry run] ' : ''}summary (${args.network})`);
  log(`  factory: ${done.factory}`);
  log(`  fee tiers ${w}added: ${done.tiersAdded.join(', ') || 'none'}; already there: ${done.tiersKept.join(', ') || 'none'}`);
  for (const c of done.tierConflicts) log('  WARN tier conflict: ' + c);
  log(`  pools on chain: ${pools.length}; ${w}migrated: ${done.migrated.length}; already on the new rules: ${done.alreadyOk.length}`);
  for (const x of done.noTier) log('  WARN no enabled tier for ' + x + ' (not migrated)');
  for (const x of done.missing) log('  note: in the deploy file but not on chain: ' + x);
  log(`  ${w}delisted (old mock SOL ${oldMint.toBase58()}): ${done.delisted.length}${done.alreadyDelisted.length ? `; already delisted: ${done.alreadyDelisted.length}` : ''}`);
  for (const x of done.delisted) log('    ' + x);
  if (args.json) log(JSON.stringify(done));
  return done;
}

if (require.main === module) main().then(() => process.exit(0), (e) => { console.error('migrate-devnet: ' + (e.message || e) + (e.logs ? '\n' + e.logs.slice(-6).join('\n') : '')); process.exit(1); });
module.exports = { main, OLD_MOCK_SOL };
