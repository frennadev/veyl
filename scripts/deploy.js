#!/usr/bin/env node
// The one deploy entrypoint:  npm run deploy -- --network <local|devnet|mainnet> [--dry-run] [--confirm-mainnet] [--upgrade]
//
//   DEPLOYER_KEYPAIR=<path to keypair.json>   the paying / upgrade-authority key. Read from that path only, never printed.
//   RPC_URL=<url>                             overrides config/<network>.json "rpc".
//   PROGRAM_KEYPAIR_DIR=<dir>                 program keypairs (default target/deploy, the repo's dev IDs). Mainnet: the fresh ones
//                                             `npm run keys:mainnet` made outside the repo (or MAINNET_KEYPAIR_DIR); the binaries
//                                             come from target/deploy-mainnet (`npm run build:mainnet`).
//   POSTMAN_PUBKEY / RELAYER_PUBKEY           approved-set publisher and relayer wallet (default: the deployer, local/devnet only).
//   PRIORITY_FEE_MICROLAMPORTS                optional compute-unit price for the program deploy transactions.
//
// Order: preflight -> the three programs (skipped when the on-chain bytes are identical) -> private pools -> factory ->
// bin pools -> entry + vaults -> relayer fee accounts -> lookup table -> deploy.<network>.json -> site/veyl.config.js ->
// Phase 3: the batch committee (from its DKG transcript: COMMITTEE_TRANSCRIPT or committee/transcript.<network>.json) and
// the sealed pools of config "sealed" (skipped, with a note, while there is no transcript).
// Re-running skips everything that is already there and says so. --dry-run builds nothing on chain and prints the plan + cost.
'use strict';
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const N = require('./net.js');

// Largest first: each program's write buffer is held on top of the rent already kept, so the big buffer goes up while little is kept.
const PROGRAMS = ['veyl_entry', 'veyl_bin', 'veyl_pool'];
const KEY_OF = { veyl_pool: 'pool', veyl_bin: 'bin', veyl_entry: 'entry' };
const solBin = () => { const d = process.env.SOLANA_BIN || '/opt/solana/bin'; return fs.existsSync(path.join(d, 'solana')) ? path.join(d, 'solana') : 'solana'; };
const fmtSol = (l) => (Number(l) / 1e9).toFixed(4) + ' SOL';

/// Account sizes in bytes (measured on a local validator), for the rent estimate. Update after a change to an account layout.
const SIZES = require('../config/account-sizes.json');

/// What the deploy would do, from the chain (or "unknown" when the RPC is unreachable), plus the cost.
async function plan({ cfg, network, rpc, deployerPk, programDir, tokens, binPools, existing }) {
  const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
  const reach = await N.rpcCall(rpc, 'getVersion');
  const conn = reach.ok ? new Connection(rpc, 'confirmed') : null;
  const rent = async (bytes) => { if (conn) { try { return await conn.getMinimumBalanceForRentExemption(bytes); } catch {} } return N.rentFormula(bytes); };
  const steps = []; let lamports = 0, maxBuffer = 0, peak = 0; const breakdown = [];
  for (const p of PROGRAMS) {
    const so = path.join(N.soDirOf(network), p + '.so');
    const len = fs.existsSync(so) ? fs.statSync(so).size : 0;
    if (!programDir) throw new Error('no program keypair directory (PROGRAM_KEYPAIR_DIR / MAINNET_KEYPAIR_DIR)');
    const id = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(programDir, p + '-keypair.json'), 'utf8')))).publicKey;
    let status = conn ? 'deploy' : 'deploy (chain unknown)'; let authority = null;
    if (conn) {
      const acc = await conn.getAccountInfo(id);
      if (acc) {
        const pdAddr = new PublicKey(acc.data.subarray(4, 36)); const pd = await conn.getAccountInfo(pdAddr);
        if (pd) { authority = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
          const bytes = pd.data.subarray(45); const local = fs.readFileSync(so);
          const same = bytes.length >= local.length && Buffer.compare(bytes.subarray(0, local.length), local) === 0 && bytes.subarray(local.length).every((b) => b === 0);
          status = same ? 'skip (identical bytes on chain)' : 'upgrade (on-chain bytes differ)'; }
      }
    }
    let cost = 0, held = 0;
    if (status.startsWith('deploy')) {
      // programdata (45-byte header + code) and the program account are kept; the write buffer (37 + code) is held
      // during the deploy and refunded: the deployer needs both at once (~2x rent). Fees: one write tx per ~1 KB.
      const keep = (await rent(45 + len)) + (await rent(36)); const buffer = await rent(37 + len); const fees = (Math.ceil(len / 1000) + 4) * 5000;
      cost = keep + fees; held = buffer; maxBuffer = Math.max(maxBuffer, buffer); breakdown.push([p, `rent(${45 + len}) + rent(36) kept ${fmtSol(keep)} + buffer rent(${37 + len}) ${fmtSol(buffer)} (refunded) + ~${Math.ceil(len / 1000) + 4} txs fees ${fmtSol(fees)}`]);
    } else if (status.startsWith('upgrade')) {
      const buffer = await rent(37 + len); const fees = (Math.ceil(len / 1000) + 4) * 5000; cost = fees; held = buffer; maxBuffer = Math.max(maxBuffer, buffer);
      breakdown.push([p, `upgrade buffer rent(${37 + len}) ${fmtSol(buffer)} (refunded) + fees ${fmtSol(fees)}`]);
    }
    peak = Math.max(peak, lamports + cost + held); lamports += cost; steps.push({ what: `program ${p} ${id.toBase58()} (${len} bytes)`, status, authority });
  }
  // accounts created by the initialisation (rent kept) + ~5000 lamports per transaction
  const acct = async (label, bytes, n = 1) => { const r = (await rent(bytes)) * n + 5000 * n; lamports += r; breakdown.push([label, `${n} x rent(${bytes}) + fees = ${fmtSol(r)}`]); };
  const nt = tokens.length, nb = binPools.length;
  await acct('private pools', SIZES.pool, nt); await acct('factory', SIZES.factory); await acct('bin pools', SIZES.binPool, nb);
  await acct('bin pool vaults', SIZES.tokenAccount, nb * 2); await acct('entry', SIZES.entry); await acct('entry vaults', SIZES.tokenAccount, nt);
  await acct('pool vaults', SIZES.tokenAccount, nt); await acct('relayer fee accounts', SIZES.tokenAccount, nt);
  if (!existing || !existing.lookupTable) for (let n = 9 + nt * 6 + nb * 9; n > 0; n -= 256) await acct('lookup table', 56 + 32 * Math.min(256, n));
  if (cfg.mockMints) await acct('mock mints', 82, nt);
  const ns = sealedPools(cfg).length; if (ns) { await acct('batch committee', SIZES.committee); await acct('sealed pools + first batches', SIZES.sealedPool + SIZES.batch, ns); }
  let balance = null;
  if (conn && deployerPk) { try { balance = await conn.getBalance(deployerPk); } catch {} }
  // programs are deployed one after another, so only one write buffer is held at a time, on top of what is kept so far
  return { reachable: reach.ok, rpcError: reach.error, steps, spent: lamports, maxBuffer, lamports: Math.max(peak, lamports), breakdown, balance };
}

/// Config "sealed": the bin pools that get sealed batches (ids), and their parameters in program units.
function sealedPools(cfg) { const s = cfg.sealed; if (!s || !Array.isArray(s.pools) || s.pools.some(N.isVerify)) return []; return s.pools.filter((id) => (cfg.binPools || []).includes(id)); }
function sealedParams(cfg, dep, id) { const s = cfg.sealed; const b = dep.binPools.find((x) => x.id === id); const t = dep.tokens; const atoms = (sym) => BigInt(Math.round(Number(s.minIn[sym] || 1) * 10 ** t[sym].decimals));
  return { epochSlots: BigInt(s.epochSlots), settleTimeout: BigInt(s.settleTimeout), minIn: [atoms(b.x), atoms(b.y)], kMin: Number(s.kMin), maxRollovers: Number(s.maxRollovers), maxDrift: Number(s.maxDrift) }; }
/// Phase 3 on chain: the committee from its transcript, then sealed pools (idempotent).
async function deploySealed({ cfg, network, rpc, keyFile, dep, log = console.log }) {
  const fs_ = require('fs'); const { Connection, PublicKey } = require('@solana/web3.js'); const { readKey } = require('./lib.js'); const { Veyl } = require('../sdk/veyl.js'); require('../sdk/shield.js'); require('../sdk/sealed.js');
  const D = require('../committee/dkg.js');
  const tf = process.env.COMMITTEE_TRANSCRIPT || path.join(N.ROOT, `committee/transcript.${network}.json`);
  if (!fs_.existsSync(tf)) { log(`no committee transcript (${path.relative(N.ROOT, tf)}): sealed swaps stay off. Run the committee's key generation (DEPLOY.md, "Batch committee"), then deploy again.`); return null; }
  const tr = JSON.parse(fs_.readFileSync(tf, 'utf8')); const v = D.verifyTranscript(tr); if (!v.ok) throw new Error('committee transcript does not verify: ' + v.errs.join(', '));
  const payer = readKey(keyFile); const V = new Veyl({ connection: new Connection(rpc, 'confirmed'), programs: dep.programs, payer }); V.lookupTable = new PublicKey(dep.lookupTable); V.lookupExtra = (dep.lookupTables || []).map((t) => new PublicKey(t));
  const reg = D.registration(tr, /^local-/.test(String(tr.session)) ? 0 : 1);
  if (!(await V.committee())) { await V.send([V.initCommitteeIx(payer.publicKey)]); log('created the committee account'); }
  const c = await V.committee(); if (!Buffer.from(c.transcript).equals(reg.transcript)) { await V.send([V.setCommitteeIx(payer.publicKey, reg)], [], 1_400_000); log(`registered the committee: ${tr.t} of ${tr.n}, transcript ${reg.transcript.toString('hex').slice(0, 16)}…`); } else log('skipped committee (already registered)');
  for (const id of sealedPools(cfg)) { const b = dep.binPools.find((x) => x.id === id); const have = !!(await V.sealed(new PublicKey(b.address)));
    if (!have) await V.send([V.initSealedPoolIx(payer.publicKey, new PublicKey(b.address), sealedParams(cfg, dep, id))]); log((have ? 'skipped' : 'created') + ' sealed pool ' + id + (have ? ' (already there)' : '')); }
  return { committee: reg.transcript.toString('hex'), sealed: sealedPools(cfg) };
}

function selectTokens(cfg) {
  const { TOKENS, BIN_POOLS } = require('./lib.js');
  const prices = Object.fromEntries(Object.entries(cfg.prices || {}).filter(([, v]) => typeof v === 'number'));
  // a catalog token without a price (none at launch, none built in) is skipped, and so is every pool that uses it
  const tokens0 = TOKENS.filter((t) => cfg.tokens.includes(t.sym)).map((t) => ({ ...t, price: prices[t.sym] ?? t.price })); const priced = new Set(tokens0.filter((t) => t.price > 0).map((t) => t.sym));
  const unpriced = tokens0.filter((t) => !priced.has(t.sym)).map((t) => t.sym); if (unpriced.length) console.log('  no price for ' + unpriced.join(', ') + ': those tokens and their pools are skipped');
  const minDep = (t) => (t.minDeposit > 0 ? t.minDeposit : Number((1 / t.price).toPrecision(2))); // about $1 when the catalog gives none
  const tokens = tokens0.filter((t) => priced.has(t.sym)).map((t) => ({ ...t, minDeposit: minDep(t) }));
  const px = Object.fromEntries(tokens.map((t) => [t.sym, t.price]));
  const binPools = BIN_POOLS.filter((b) => cfg.binPools.includes(b.id) && priced.has(b.x) && priced.has(b.y)).map((b) => ({ ...b, price: prices[b.x] !== undefined || prices[b.y] !== undefined ? px[b.x] / px[b.y] : b.price }));
  return { tokens, binPools };
}

async function main() {
  const args = N.parseArgs(); const network = args.network; const cfg = N.loadConfig(network); const rpc = N.rpcOf(cfg);
  const key = N.deployerKey();
  const programDir = N.programKeypairDir(network);
  const { tokens, binPools } = selectTokens(cfg); const existing = N.loadDeploy(network);
  console.log(`Veyl (Solana) deploy -> ${network}${args.dryRun ? '  [dry run: nothing is sent]' : ''}`);
  console.log(`RPC ${N.isVerify(rpc) ? '(unset: config still says VERIFY)' : rpc}`);
  console.log(`Deployer ${key.keypair ? key.keypair.publicKey.toBase58() : '(' + key.error + ')'}`);

  // preflight (always printed; red refuses a real deploy on every network)
  const { preflight } = require('./preflight.js');
  const pf = await preflight({ network, quiet: false });
  if (!args.dryRun && pf.red.length) { console.error(`\nPreflight is red (${pf.red.join('; ')}). Nothing was sent.`); process.exit(1); }

  const p = await plan({ cfg, network, rpc, deployerPk: key.keypair && key.keypair.publicKey, programDir, tokens, binPools, existing });
  console.log('\nPlan:');
  for (const s of p.steps) console.log(`  ${s.status.padEnd(34)} ${s.what}${s.authority ? '  upgrade authority ' + s.authority : ''}`);
  console.log(`  ${(existing ? 'reuse/skip what exists' : 'create').padEnd(34)} ${tokens.length} private pools (${tokens.map((t) => t.sym).join(', ')}), factory, ${binPools.length} bin pools (${binPools.map((b) => b.id).join(', ')}), entry + vaults, lookup table${cfg.mockMints ? ', mock mints' : ''}`);
  console.log('\nEstimated cost (upper bound; rent from ' + (p.reachable ? 'the RPC' : 'the formula (128 + bytes) x 6960 lamports, RPC unreachable') + '):');
  for (const [k, v] of p.breakdown) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log(`  ${'SPENT (kept as rent)'.padEnd(22)} ${fmtSol(p.spent)}`);
  console.log(`  ${'NEEDED (peak balance)'.padEnd(22)} ${fmtSol(p.lamports)}  = the most held at once: rent kept so far + the write buffer of the program going up (refunded after each, largest first)${p.balance !== null ? '\n  deployer balance       ' + fmtSol(p.balance) : ''}`);
  if (args.dryRun) { console.log('\nDry run: nothing was sent.'); return; }

  if (!p.reachable) { console.error('RPC unreachable: ' + p.rpcError); process.exit(1); }
  if (network === 'mainnet') {
    if (!args.confirmMainnet) { console.error('Mainnet needs --confirm-mainnet.'); process.exit(1); }
    const typed = await N.ask('Type the network name ("mainnet") to deploy with real SOL: ');
    if (typed !== 'mainnet') { console.error('Not confirmed. Nothing was sent.'); process.exit(1); }
  }
  const upgrades = p.steps.filter((s) => s.status.startsWith('upgrade'));
  if (upgrades.length && !args.upgrade) { console.error('\nOn-chain program bytes differ from target/deploy: ' + upgrades.map((s) => s.what).join(', ') + '. Re-run with --upgrade to upgrade them.'); process.exit(1); }

  // 1. programs
  const fee = process.env.PRIORITY_FEE_MICROLAMPORTS ? ['--with-compute-unit-price', process.env.PRIORITY_FEE_MICROLAMPORTS] : [];
  for (const [i, prog] of PROGRAMS.entries()) {
    const s = p.steps[i]; if (s.status.startsWith('skip')) { console.log('skipped program ' + prog + ' (identical bytes on chain)'); continue; }
    console.log((s.status.startsWith('upgrade') ? 'upgrading ' : 'deploying ') + prog + ' ...');
    execFileSync(solBin(), ['program', 'deploy', '-u', rpc, '-k', key.file, '--program-id', path.join(programDir, prog + '-keypair.json'), path.join(N.soDirOf(network), prog + '.so'), ...fee], { stdio: ['ignore', 'inherit', 'inherit'] });
  }
  // 2. everything else (idempotent)
  const { Keypair } = require('@solana/web3.js');
  const programs = Object.fromEntries(PROGRAMS.map((pr) => [KEY_OF[pr], Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(programDir, pr + '-keypair.json'), 'utf8')))).publicKey]));
  const pick = (envName, cfgVal) => process.env[envName] || (cfgVal && !N.isVerify(cfgVal) ? cfgVal : undefined);
  const postman = pick('POSTMAN_PUBKEY', cfg.postman), relayer = pick('RELAYER_PUBKEY', cfg.relayer);
  if (network === 'mainnet' && (!postman || !relayer)) { console.error('Mainnet needs the postman and relayer public keys (config/mainnet.json or POSTMAN_PUBKEY / RELAYER_PUBKEY).'); process.exit(1); }
  const mints = Object.fromEntries(Object.entries(cfg.mints || {}).filter(([, v]) => v && !N.isVerify(v)));
  const { deployAll } = require('./lib.js');
  if (cfg.protocolShareBps !== undefined && !(Number(cfg.protocolShareBps) >= 0 && Number(cfg.protocolShareBps) <= 2500)) { console.error('config protocolShareBps must be 0..2500 (bps of each swap fee)'); process.exit(1); }
  const { dep } = await deployAll({ rpc, payerFile: key.file, network, deploy: false, programs, mints, postman, relayer, tokens, binPools, existing, protocolShareBps: cfg.protocolShareBps, log: (m) => console.log(m) });
  // deploy.<network>.json is written by deployAll; then the site's runtime config from it
  const { makeConfig } = require('./make-config.js');
  const relayerUrl = process.env.RELAYER_URL || (N.isVerify(cfg.relayerUrl) ? undefined : cfg.relayerUrl);
  fs.writeFileSync(path.join(N.ROOT, 'site/veyl.config.js'), makeConfig(dep, { ...process.env, RELAYER_URL: relayerUrl, CHAIN_NAME: process.env.CHAIN_NAME || cfg.chainName, EXPLORER: process.env.EXPLORER || cfg.explorer }));
  console.log(`\nwrote deploy.${network}.json and site/veyl.config.js`);
  // 3. Phase 3: the batch committee and sealed pools
  const sealed = await deploySealed({ cfg, network, rpc, keyFile: key.file, dep });
  if (sealed) { dep.committeeTranscript = sealed.committee; dep.sealedPools = sealed.sealed; fs.writeFileSync(path.join(N.ROOT, `deploy.${network}.json`), JSON.stringify(dep, null, 2)); }
  console.log(JSON.stringify({ network: dep.network, slot: dep.slot, deployer: dep.deployer, programs: dep.programs, lookupTable: dep.lookupTable, pools: Object.keys(dep.tokens).length, binPools: dep.binPools.length }, null, 1));
  console.log(`\nNext: npm run build:site -- --network ${network}   (and start the relayer with this deploy file)`);
  if (network === 'mainnet') console.log(`Then move every role off the deployer key: npm run handover -- --network mainnet --to <multisig> --dry-run, then without --dry-run (preflight flags what is left).`);
}

module.exports = { plan, selectTokens, deploySealed, sealedPools, sealedParams };
if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
